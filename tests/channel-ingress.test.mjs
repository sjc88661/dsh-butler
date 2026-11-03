import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, sep } from 'node:path'

// Retain all fixtures as local evidence. Nothing in this suite is recursively removed.
const fixtureParent = resolve('tests/.tmp')
fs.mkdirSync(fixtureParent, { recursive: true })
const fixture = fs.mkdtempSync(join(fixtureParent, 'channel-ingress-'))
assert.ok(fs.realpathSync(fixture).startsWith(fs.realpathSync(fixtureParent) + sep))
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts')
vault.ensureVault()
let ChannelIngress
try { ({ ChannelIngress } = await import('../src/host/channel-ingress.ts')) }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }

const binding = { accountId: 'app-A', senderId: 'ou-person', chatId: 'oc-direct', ownerId: 'owner-A' }
const other = { accountId: 'app-B', senderId: 'ou-other', chatId: 'oc-other', ownerId: 'owner-B' }
const inbound = (changes = {}) => ({ messageId: 'om-original', chatId: binding.chatId, senderId: binding.senderId, chatType: 'p2p', content: 'a private human request', ...changes })
const human = id => ({ id, source: { kind: 'user' } })
let sequence = 0
function make(bindings = [binding], file = vault.statePath(`ingress-${++sequence}.json`)) {
  assert.equal(typeof ChannelIngress, 'function', 'ChannelIngress must be implemented')
  return { file, ingress: new ChannelIngress({ file, bindings }) }
}
const gate = () => { let release; const promise = new Promise(done => { release = done }); return { promise, release } }
const hasCode = code => error => { assert.equal(error.code, code); return true }
const bytes = file => fs.readFileSync(file)

test('a bound message is pending before handling, accepted after handling, and duplicates run once', async () => {
  const { ingress, file } = make(); let calls = 0
  assert.deepEqual(await ingress.receive(binding.accountId, inbound(), () => {
    calls++
    assert.equal(new ChannelIngress({ file, bindings: [binding] }).status().pending, 1)
  }), { status: 'accepted' })
  const committed = bytes(file)
  assert.deepEqual(await ingress.receive(binding.accountId, inbound(), () => { calls++ }), { status: 'duplicate' })
  assert.equal(calls, 1)
  assert.deepEqual(bytes(file), committed)
  assert.deepEqual(ingress.status(), { active: true, received: 1, accepted: 1, nativeMapped: 0, acceptedWithoutNative: 1, pending: 0, uncertain: 0, bindings: 1 })
})

test('successful transport commands may finish without inserting a native message', async () => {
  const { ingress } = make()
  assert.deepEqual(await ingress.receive(binding.accountId, inbound({ content: '/status' }), async () => {}), { status: 'accepted' })
  assert.equal(ingress.originFor('unknown-session', 'unknown-message'), undefined)
})

test('channel status distinguishes exact native mappings from returned command callbacks without modifying state', async () => {
  const { ingress, file } = make()
  await ingress.receive(binding.accountId, inbound({ messageId: 'mapped' }), () => ingress.associate('native-session', human('native-input')))
  await ingress.receive(binding.accountId, inbound({ messageId: 'command', content: '/status' }), () => {})
  await assert.rejects(ingress.receive(binding.accountId, inbound({ messageId: 'uncertain' }), () => {
    ingress.associate('native-session', human('native-before-error')); throw Error('handler failed after native insert')
  }))
  const before = bytes(file), status = ingress.status()
  assert.equal(status.nativeMapped, 2)
  assert.equal(status.acceptedWithoutNative, 1)
  assert.equal(status.accepted, 2)
  assert.equal(status.uncertain, 1)
  assert.deepEqual(bytes(file), before)
})

test('a second instance sees an in-flight source as uncertain and never calls it again', async () => {
  const { ingress, file } = make(), wait = gate(); let calls = 0
  const first = ingress.receive(binding.accountId, inbound(), async () => { calls++; await wait.promise })
  const peer = new ChannelIngress({ file, bindings: [binding] })
  try {
    assert.deepEqual(await peer.receive(binding.accountId, inbound(), () => { calls++ }), { status: 'uncertain', code: 'PENDING' })
    assert.equal(calls, 1)
    assert.equal(peer.status().pending, 1)
  } finally { wait.release() }
  await first
  assert.deepEqual(await new ChannelIngress({ file, bindings: [binding] }).receive(binding.accountId, inbound(), () => { calls++ }), { status: 'duplicate' })
  assert.equal(calls, 1)
})

test('concurrent different sources keep their own native associations across awaits', async () => {
  const { ingress, file } = make([binding, other]), firstGate = gate(), secondGate = gate()
  const first = ingress.receive(binding.accountId, inbound({ threadId: 'omt-thread-A' }), async () => {
    await firstGate.promise
    ingress.associate('native-session-A', human('native-message-A'))
  })
  const second = ingress.receive(other.accountId, inbound({ ...other, messageId: 'om-B', threadId: 'omt-thread-B' }), async () => {
    await secondGate.promise
    ingress.associate('native-session-B', human('native-message-B'))
  })
  secondGate.release(); await second; firstGate.release(); await first
  const reload = new ChannelIngress({ file, bindings: [binding, other] })
  assert.deepEqual(reload.originFor('native-session-A', 'native-message-A'), { ...binding, provider: 'lark', messageId: 'om-original', threadId: 'omt-thread-A', nativeMessageId: 'native-message-A', sessionId: 'native-session-A' })
  assert.deepEqual(reload.originFor('native-session-B', 'native-message-B'), { ...other, provider: 'lark', messageId: 'om-B', threadId: 'omt-thread-B', nativeMessageId: 'native-message-B', sessionId: 'native-session-B' })
  assert.equal(reload.originFor('native-session-A', 'native-message-B'), undefined)
})

test('the same platform message id on different accounts is independent', async () => {
  const sameSenderOtherAccount = { ...binding, accountId: 'another-app' }
  const { ingress } = make([binding, sameSenderOtherAccount]); let calls = 0
  for (const account of [binding.accountId, sameSenderOtherAccount.accountId]) {
    assert.deepEqual(await ingress.receive(account, inbound(), () => { calls++ }), { status: 'accepted' })
  }
  assert.equal(calls, 2)
  assert.equal(ingress.status().accepted, 2)
})

for (const [field, value] of [['senderId', 'changed-sender'], ['chatId', 'changed-chat'], ['content', 'different text'], ['threadId', 'another-thread']]) {
  test(`the same source id with changed ${field} is rejected without replacing its receipt`, async () => {
    const extra = { ...binding, [field]: value }, { ingress, file } = make(field === 'senderId' || field === 'chatId' ? [binding, extra] : [binding])
    await ingress.receive(binding.accountId, inbound(), () => {})
    const before = bytes(file); let calls = 0
    assert.deepEqual(await ingress.receive(binding.accountId, inbound({ [field]: value }), () => { calls++ }), { status: 'rejected', code: 'SOURCE_CONFLICT' })
    assert.equal(calls, 0); assert.deepEqual(bytes(file), before)
  })
}

test('handler failure preserves the original error, stores uncertainty, and never retries on reload', async () => {
  const { ingress, file } = make(), failure = new Error('SECRET callback failure credentials'); let calls = 0
  await assert.rejects(ingress.receive(binding.accountId, inbound(), () => { calls++; throw failure }), error => error === failure)
  const reload = new ChannelIngress({ file, bindings: [binding] })
  assert.deepEqual(await reload.receive(binding.accountId, inbound(), () => { calls++ }), { status: 'uncertain', code: 'HANDLER_FAILED' })
  assert.equal(calls, 1); assert.equal(reload.status().uncertain, 1)
  assert.equal(bytes(file).includes(Buffer.from('SECRET')), false)
})

test('a pending receipt remains non-retryable when its original worker exits', async () => {
  const { file } = make()
  const source = new URL('../src/host/channel-ingress.ts', import.meta.url).href
  const program = `import { ChannelIngress } from ${JSON.stringify(source)}; const ingress = new ChannelIngress(${JSON.stringify({ file, bindings: [binding] })}); await ingress.receive(${JSON.stringify(binding.accountId)}, ${JSON.stringify(inbound())}, () => process.exit(79));`
  const result = await runChild(program)
  assert.equal(result.code, 79, result.stderr)
  const reload = new ChannelIngress({ file, bindings: [binding] }); let calls = 0
  assert.deepEqual(await reload.receive(binding.accountId, inbound(), () => { calls++ }), { status: 'uncertain', code: 'PENDING' })
  assert.equal(calls, 0); assert.equal(reload.status().pending, 1)
})

test('two processes can invoke a source handler at most once', async () => {
  const { file } = make(), marker = vault.statePath(`callbacks-${++sequence}.txt`), release = vault.statePath(`release-${sequence}`)
  const source = new URL('../src/host/channel-ingress.ts', import.meta.url).href
  const program = `import fs from 'node:fs'; import { ChannelIngress } from ${JSON.stringify(source)};
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(done => setTimeout(done, 5));
    try { const ingress = new ChannelIngress(${JSON.stringify({ file, bindings: [binding] })});
      const result = await ingress.receive(${JSON.stringify(binding.accountId)}, ${JSON.stringify(inbound())}, async () => { fs.appendFileSync(${JSON.stringify(marker)}, 'callback\\n'); await new Promise(done => setTimeout(done, 25)); }); console.log(JSON.stringify(result));
    } catch (error) { if (error.code !== 'STORAGE_BUSY' && !/冲突/.test(error.message)) throw error; console.log(JSON.stringify({ status: 'blocked' })); }`
  const workers = [runChild(program), runChild(program)]
  fs.writeFileSync(release, 'go')
  const results = await Promise.all(workers)
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'callback\n')
  assert.equal(new ChannelIngress({ file, bindings: [binding] }).status().accepted, 1)
})

for (const [name, accountId, change] of [
  ['unbound account', 'unknown-app', {}], ['unbound sender', binding.accountId, { senderId: 'stranger' }],
  ['unbound chat', binding.accountId, { chatId: 'other-chat' }], ['bot', binding.accountId, { senderIsBot: true }],
  ['group', binding.accountId, { chatType: 'group' }], ['missing source id', binding.accountId, { messageId: undefined }],
  ['blank sender', binding.accountId, { senderId: '   ' }], ['non-string chat', binding.accountId, { chatId: 7 }],
  ['non-string content', binding.accountId, { content: { text: 'unsafe' } }], ['malformed thread', binding.accountId, { threadId: '' }],
  ['malformed bot flag', binding.accountId, { senderIsBot: 'false' }], ['control in id', binding.accountId, { messageId: 'om\nunsafe' }],
]) test(`${name} input fails closed without any handler or receipt`, async () => {
  const { ingress, file } = make(); let calls = 0
  assert.equal((await ingress.receive(accountId, inbound(change), () => { calls++ })).status, 'rejected')
  assert.equal(calls, 0); assert.equal(ingress.status().received, 0)
  assert.equal(fs.existsSync(file), false)
})

test('ambiguous exact bindings fail closed', async () => {
  const { ingress } = make([binding, { ...binding, ownerId: 'another-owner' }]); let calls = 0
  assert.deepEqual(await ingress.receive(binding.accountId, inbound(), () => { calls++ }), { status: 'rejected', code: 'AMBIGUOUS_BINDING' })
  assert.equal(calls, 0)
})

test('invalid configured binding is refused before any ingress can run', () => {
  assert.throws(() => make([{ ...binding, ownerId: '' }]), hasCode('INVALID_BINDING'))
})

test('exact native and platform ids are durable before the callback can wake native work', async () => {
  const exotic = { accountId: 'App/大写', senderId: 'OU:Exact', chatId: 'OC:Exact', ownerId: '__proto__' }
  const { ingress, file } = make([exotic]), message = inbound({ ...exotic, messageId: 'OM/Exact', threadId: 'Thread/Exact' })
  assert.equal(ingress.associate('outside', human('outside')), undefined)
  await ingress.receive(exotic.accountId, message, () => {
    const origin = ingress.associate('__proto__', human('Native/Exact'))
    const reload = new ChannelIngress({ file, bindings: [exotic] })
    assert.deepEqual(reload.originFor('__proto__', 'Native/Exact'), origin)
    assert.equal(reload.status().pending, 1)
    assert.equal(reload.ownerForSession('__proto__'), exotic.ownerId)
    assert.equal(reload.originFor('__proto__', 'Native/exact'), undefined)
    origin.ownerId = 'caller-mutation'
    assert.equal(reload.originFor('__proto__', 'Native/Exact').ownerId, exotic.ownerId)
  })
  assert.equal(ingress.originFor('__proto__', 'Native/Exact').messageId, 'OM/Exact')
})

test('multiple messages in the same owner session preserve every exact native alias', async () => {
  const { ingress, file } = make()
  for (let index = 0; index < 2; index++) await ingress.receive(binding.accountId, inbound({ messageId: `source-${index}` }), () => ingress.associate('stable-session', human(`native-${index}`)))
  const reload = new ChannelIngress({ file, bindings: [binding] })
  assert.equal(reload.originFor('stable-session', 'native-0').messageId, 'source-0')
  assert.equal(reload.originFor('stable-session', 'native-1').messageId, 'source-1')
  assert.equal(reload.originFor('stable-session', 'missing'), undefined)
})

for (const [name, sessionId, message] of [
  ['model', 'session', { id: 'native', source: { kind: 'model' } }],
  ['missing kind', 'session', { id: 'native' }], ['missing id', 'session', { source: { kind: 'user' } }],
  ['missing session', '', human('native')],
]) test(`invalid ${name} native association poisons the receipt even if the handler catches it`, async () => {
  const { ingress, file } = make(); let original
  await assert.rejects(ingress.receive(binding.accountId, inbound(), () => {
    try { ingress.associate(sessionId, message) } catch (error) { original = error }
  }), error => error === original && error.code === 'INVALID_NATIVE_SOURCE')
  const reload = new ChannelIngress({ file, bindings: [binding] })
  assert.deepEqual(await reload.receive(binding.accountId, inbound(), () => assert.fail('must not retry')), { status: 'uncertain', code: 'INVALID_NATIVE_SOURCE' })
  assert.equal(reload.originFor('session', 'native'), undefined)
})

test('repeated exact association is idempotent but a second native pair is refused', async () => {
  const { ingress } = make()
  await assert.rejects(ingress.receive(binding.accountId, inbound(), () => {
    const first = ingress.associate('session', human('native-1'))
    assert.deepEqual(ingress.associate('session', human('native-1')), first)
    ingress.associate('session', human('native-2'))
  }), hasCode('SOURCE_NATIVE_CONFLICT'))
  assert.equal(ingress.originFor('session', 'native-1').messageId, 'om-original')
  assert.equal(ingress.originFor('session', 'native-2'), undefined)
  assert.equal(ingress.status().uncertain, 1)
})

test('a session cannot change owners and an existing native pair cannot change source', async () => {
  const { ingress, file } = make([binding, other])
  await ingress.receive(binding.accountId, inbound(), () => ingress.associate('session', human('native')))
  await assert.rejects(ingress.receive(other.accountId, inbound({ ...other, messageId: 'other-source' }), () => ingress.associate('session', human('different-native'))), hasCode('SESSION_OWNER_CONFLICT'))
  await assert.rejects(ingress.receive(binding.accountId, inbound({ messageId: 'same-owner-other-source' }), () => ingress.associate('session', human('native'))), hasCode('NATIVE_SOURCE_CONFLICT'))
  const reload = new ChannelIngress({ file, bindings: [binding, other] })
  assert.equal(reload.ownerForSession('session'), binding.ownerId)
  assert.equal(reload.originFor('session', 'native').messageId, 'om-original')
  assert.equal(reload.originFor('session', 'different-native'), undefined)
})

test('task ownership survives reload, permits exact repeats, and refuses owner replacement', () => {
  const { ingress, file } = make()
  assert.equal(ingress.ownerForTask('unbound-task'), undefined)
  ingress.bindTask('__proto__', binding.ownerId)
  const before = bytes(file)
  ingress.bindTask('__proto__', binding.ownerId)
  assert.deepEqual(bytes(file), before)
  const reload = new ChannelIngress({ file, bindings: [binding] })
  assert.equal(reload.ownerForTask('__proto__'), binding.ownerId)
  assert.throws(() => reload.bindTask('__proto__', other.ownerId), hasCode('TASK_OWNER_CONFLICT'))
  assert.throws(() => reload.bindTask('', binding.ownerId), hasCode('INVALID_TASK_BINDING'))
  assert.equal(reload.ownerForTask('__proto__'), binding.ownerId)
})

test('bindings are copied and owner changes cannot transfer a previously received source', async () => {
  const mutable = { ...binding }, { ingress, file } = make([mutable])
  mutable.ownerId = 'untrusted-mutation'
  await ingress.receive(binding.accountId, inbound(), () => ingress.associate('session', human('native')))
  assert.equal(ingress.ownerForSession('session'), binding.ownerId)
  const changed = new ChannelIngress({ file, bindings: [{ ...binding, ownerId: 'new-owner' }] })
  assert.deepEqual(await changed.receive(binding.accountId, inbound(), () => assert.fail('must not transfer')), { status: 'rejected', code: 'SOURCE_CONFLICT' })
})

test('detached async work cannot attach an origin after the transport handler finishes', async () => {
  const { ingress } = make(), wait = gate(); let detached
  await ingress.receive(binding.accountId, inbound(), () => {
    detached = (async () => { await wait.promise; return ingress.associate('late-session', human('late-native')) })()
  })
  wait.release()
  await assert.rejects(detached, hasCode('INGRESS_SCOPE_CLOSED'))
  assert.equal(ingress.originFor('late-session', 'late-native'), undefined)
})

for (const [name, invalid] of [
  ['malformed JSON', Buffer.from('{broken')], ['invalid UTF-8', Buffer.from([0xff, 0xfe])],
  ['invalid schema', Buffer.from(JSON.stringify({ version: 1, entries: {}, sessions: {}, aliases: {}, tasks: [], hidden: 'bad' }))],
]) test(`${name} bytes are preserved and never replaced`, async () => {
  const { ingress, file } = make()
  fs.writeFileSync(file, invalid)
  assert.throws(() => new ChannelIngress({ file, bindings: [binding] }))
  await assert.rejects(ingress.receive(binding.accountId, inbound(), () => assert.fail('must not run')))
  assert.deepEqual(bytes(file), invalid)
})

test('persisted alias corruption is refused instead of resolving a guessed origin', async () => {
  const { ingress, file } = make()
  await ingress.receive(binding.accountId, inbound(), () => ingress.associate('session', human('native')))
  const saved = JSON.parse(bytes(file).toString('utf8'))
  saved.aliases[Object.keys(saved.aliases)[0]] = 'nonexistent-source'
  const invalid = Buffer.from(JSON.stringify(saved)); fs.writeFileSync(file, invalid)
  assert.throws(() => ingress.originFor('session', 'native'))
  assert.deepEqual(bytes(file), invalid)
})

test('message text, extra credentials, and exception contents never enter state or its WAL', async () => {
  const { ingress, file } = make(), secret = `SECRET_NEVER_PERSIST_${Date.now()}`
  await ingress.receive(binding.accountId, inbound({ content: secret, credentials: { token: secret }, arbitrary: secret }), () => ingress.associate('safe-session', human('safe-native')))
  const journal = fs.readFileSync(vault.statePath('store-operations.jsonl'), 'utf8')
  assert.equal(bytes(file).toString('utf8').includes(secret), false)
  assert.equal(journal.includes(secret), false)
  assert.equal(JSON.stringify(ingress.status()).includes(binding.senderId), false)
  assert.equal(JSON.stringify(ingress.status()).includes(binding.ownerId), false)
})

test('read-only ingress snapshots preserve a pending WAL without applying it', async () => {
  const { ingress, file } = make()
  await ingress.receive(binding.accountId, inbound(), () => ingress.associate('session', human('native')))
  ingress.bindTask('known-task', binding.ownerId)
  const before = bytes(file), journal = vault.statePath('store-operations.jsonl')
  const storeUrl = new URL('../src/host/store.ts', import.meta.url).href
  // Crash a real store commit after its prepared WAL row but before replacing the target.
  const program = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    import { commitFiles, readSnapshot } from ${JSON.stringify(storeUrl)};
    const file = ${JSON.stringify(file)}, snapshot = readSnapshot({path:file,format:'json',fallback:{}});
    snapshot.value.tasks['pending-task'] = ${JSON.stringify(binding.ownerId)};
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === file) process.exit(79); return rename(from, to); };
    syncBuiltinESMExports();
    commitFiles({kind:'test.channel.pending',targetId:file,writes:[{path:file,format:'json',content:JSON.stringify(snapshot.value)+'\\n',expectedBefore:snapshot.expectedBefore}]});`
  const child = await runChild(program)
  assert.equal(child.code, 79, child.stderr)
  const pendingJournal = bytes(journal)
  assert.equal(JSON.parse(pendingJournal.toString('utf8').trim().split('\n').at(-1)).phase, 'prepared')
  assert.deepEqual(bytes(file), before)
  const reload = new ChannelIngress({ file, bindings: [binding] })
  assert.equal(reload.status().accepted, 1)
  assert.equal(reload.originFor('session', 'native').messageId, 'om-original')
  assert.equal(reload.ownerForSession('session'), binding.ownerId)
  assert.equal(reload.ownerForTask('known-task'), binding.ownerId)
  assert.equal(reload.ownerForTask('pending-task'), undefined)
  assert.deepEqual(bytes(file), before)
  assert.deepEqual(bytes(journal), pendingJournal)
  // An explicit mutation still performs recovery and preserves its recovered ownership.
  reload.bindTask('new-task', binding.ownerId)
  assert.equal(reload.ownerForTask('pending-task'), binding.ownerId)
  assert.equal(reload.ownerForTask('new-task'), binding.ownerId)
})

function runChild(program) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('exit', code => done({ code, stdout, stderr }))
  })
}
