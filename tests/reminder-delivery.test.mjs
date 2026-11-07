import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'reminder-delivery-'))
process.env.DSH_BUTLER_HOME = join(root, 'state')
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
const { ensureVault } = await import('../src/host/vault.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { installBusinessWorkflows } = await import('../src/host/workflow-runtime.ts')
const ledger = await import('../src/host/ledger.ts')
ensureVault()

const destination = () => ({ provider: 'lark', ownerId: 'verified-owner', accountId: 'verified-account', chatId: 'verified-private-chat', senderId: 'verified-sender' })
const digest = text => createHash('sha256').update(text).digest('hex')
async function environment(settings = {}) {
  const prefix = crypto.randomUUID(), hooks = new Map(), sent = [], resolutions = [], users = [], historyRequests = []
  const target = { id: `session-butler-reminder-${prefix}`, inheritedEventCount: 0 }
  let currentDestination = destination(), liveService = true
  const service = { destinationFor(identity, user) { resolutions.push(structuredClone(identity)); users.push(structuredClone(user)); return settings.destination ?? currentDestination },
    async send(to, text, identity) { sent.push({ to, text, identity }); return settings.send ? settings.send(to, text, identity) : { messageId: 'lark-native-message', chunkIds: ['lark-native-message'] } }, ...settings.connection }
  const contexts = new ExecutionContexts({ file: join(root, 'state', `${prefix}-contexts.json`),
    runFor: id => `run:${id}`, resolveUserOrigin: () => ({ ownerId: 'verified-owner' }), resolveScheduleOwner: id => ledger.getTask(id)?.ownerId })
  const ctx = { on(name, fn) { hooks.set(name, fn); return () => { if (hooks.get(name) === fn) hooks.delete(name) } }, tools: {},
    get(name) { if (name === 'butlerReminderDelivery' && liveService && settings.enabled !== false) return service }, logger: { warn() {} } }
  const options = { contexts, timeZone: 'Asia/Shanghai', filePrefix: prefix, destination: async () => target.id,
    schedule: () => ({ async create(request) { return { id: `job-${prefix}`, kind: 'at', scheduledAt: '2030-01-02T03:04:00+08:00', target: request.target, status: 'active' } },
      async history(request) {
        historyRequests.push(request)
        return settings.history ? settings.history(request, historyRequests.length) : { records: [{ messageId: 'native-occurrence', deliveredAt: '2030-01-01T19:04:01Z' }] }
      } }) }
  let workflows = installBusinessWorkflows(ctx, options)
  const source = { id: `source-${prefix}` }
  contexts.bindUser(source, { id: `rpc-${prefix}`, source: { kind: 'user', rpcId: `native-rpc-${prefix}` }, content: [{ type: 'text', text: '飞书测试私聊 reminder nonce' }] })
  contexts.captureRequest(source, 1, 1)
  const created = await contexts.withExecution({ agent: source, callId: 'create-reminder', name: 'butler_remind' }, () => workflows.reminderOperations.create({
    identity: contexts.current(), reminder: { title: 'Safe reminder', prompt: 'Safe reminder body', at: '2030-01-02T03:04', timeZone: 'Asia/Shanghai' } }))
  let seq = 0
  const event = (type, data, session = target) => hooks.get('session/event')(session, { type, data, seq: ++seq, time: 1893524641000 })
  const begin = async (source = { kind: 'schedule' }, session = target) => {
    await event('turn/start', { turn: 1 }, session)
    await event('user/message', { id: 'native-occurrence', source, content: [{ type: 'text', text: 'Safe reminder body' }] }, session)
  }
  const assistant = (text = 'Safe reminder body', extra = {}) => event('assistant/message', { turn: 1, step: 1,
    message: { id: 'assistant-native-message', content: [{ type: 'text', text }] }, ...extra })
  const finish = (reason = { kind: 'completed' }) => event('turn/end', { turn: 1, reason })
  const outbound = () => workflows.reminderOperations.status({ recover: false })[0].outbound ?? []
  return { created, contexts, target, source, event, begin, assistant, finish, sent, resolutions, users, historyRequests, service, outbound,
    status: options => workflows.reminderOperations.status(options),
    recover: () => workflows.reminderOperations.recoverOutbound(),
    serviceEvent: () => hooks.get('internal/service')('butlerReminderDelivery'), enable() { liveService = true },
    operationsFile: join(root, 'state', `${prefix}-reminder-operations.json`), outboundFile: join(root, 'state', `${prefix}-reminder-outbound.json`),
    reload() { workflows.stop(); workflows = installBusinessWorkflows(ctx, options) },
    destination(value) { currentDestination = value }, disable() { liveService = false }, stop() { workflows.stop() } }
}

test('the host destination resolver receives only the exact native user input view', async () => {
  const e = await environment()
  const identity = e.resolutions[0]
  assert.deepEqual(e.users[0], e.contexts.readUserInputView(identity).user)
  assert.equal(e.users[0].rpcId.startsWith('native-rpc-'), true)
  assert.equal(e.users[0].messageId, identity.originMessageId)
  assert.equal(e.users[0].sessionId, identity.rootSessionId ?? identity.sessionId)
  assert.equal(e.users[0].text, '飞书测试私聊 reminder nonce')
  e.stop()
})

test('a native schedule occurrence sends only its final same-turn assistant body and stores a real receipt', async () => {
  const e = await environment()
  assert.equal(e.created.ok, true)
  assert.deepEqual(e.created.operation.outboundDestination, destination())
  assert.equal(ledger.getTask(e.created.taskId).ownerId, 'verified-owner')
  await e.begin()
  await e.assistant('Intermediate tool explanation', { message: { content: [{ type: 'text', text: 'Intermediate tool explanation' }, { type: 'tool-call', id: 'read-call', name: 'read', arguments: '{}' }] } })
  assert.equal(e.sent.length, 0)
  await e.event('tool/result', { turn: 1, step: 1, result: { isError: false } })
  await e.assistant()
  assert.equal(e.sent.length, 0)
  await e.finish()
  assert.equal(e.sent.length, 1, 'successful terminal assistant output must reach the trusted host delivery service')
  assert.deepEqual(e.sent[0].to, destination())
  assert.equal(e.sent[0].text, 'Safe reminder body')
  assert.equal(e.sent[0].identity.scheduleId, e.created.reminder.id)
  assert.equal(e.sent[0].identity.occurrenceMessageId, 'native-occurrence')
  assert.equal(e.sent[0].identity.taskId, e.created.taskId)
  assert.equal(e.sent[0].identity.sessionId, e.target.id)
  assert.equal(e.sent[0].identity.textSha256, digest('Safe reminder body'))
  const [receipt] = e.outbound()
  assert.equal(receipt.state, 'delivered')
  assert.equal(receipt.receipt.messageId, 'lark-native-message')
  assert.deepEqual(receipt.receipt.chunkIds, ['lark-native-message'])
  assert.equal(receipt.assistantEventSeq, e.sent[0].identity.assistantEventSeq)
  assert.equal(receipt.textSha256, digest('Safe reminder body'))
  assert.equal(ledger.getTask(e.created.taskId).reminder.lastDelivery.messageId, 'native-occurrence', 'native inbox receipt remains distinct')
  assert.notEqual(ledger.getTask(e.created.taskId).status, 'done')
  assert.equal(e.contexts.originUser(e.contexts.forAgent(e.target.id)), undefined)
  e.stop()
})

test('host service lifecycle and disposable readiness notifications recover a queue after the service reappears', async () => {
  let ready = false
  const listeners = new Set()
  const e = await environment({ connection: { isReady: () => ready,
    onReady(listener) { listeners.add(listener); return () => listeners.delete(listener) } } })
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 0)
  assert.equal(e.outbound()[0].state, 'waiting')
  assert.equal(listeners.size, 1)
  const old = [...listeners][0]
  e.disable(); await e.serviceEvent()
  assert.equal(listeners.size, 0)
  ready = true; old(); await e.recover()
  assert.equal(e.sent.length, 0)
  e.enable(); await e.serviceEvent()
  assert.equal(e.sent.length, 1)
  assert.equal(e.outbound()[0].state, 'delivered')
  e.stop(); assert.equal(listeners.size, 0)
})

test('the complete native host metadata sequence preserves its occurrence without accepting other sources or forms', async () => {
  const scheduled = await environment()
  await scheduled.event('turn/start', { turn: 1 })
  await scheduled.event('step/start', { turn: 1, step: 1 })
  await scheduled.event('system/message', { turn: 1, step: 1 })
  await scheduled.event('user/message', { id: 'native-occurrence', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'Safe reminder body' }] })
  await scheduled.event('user/message', { id: 'native-runtime-context', source: { kind: 'runtime-context' },
    content: [{ type: 'text', text: 'Current runtime context: native host snapshot.' }] })
  await scheduled.event('user/message', { id: 'native-skill-catalog', source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
    content: [{ type: 'text', text: 'Native skill catalog.' }] })
  await scheduled.event('user/message', { id: 'native-time-context', source: { kind: 'time-context', form: 'snapshot', sections: [] },
    content: [{ type: 'text', text: 'Native time snapshot.' }] })
  await scheduled.event('request/header', { reason: 'initial', header: {} })
  await scheduled.event('request/context', { turn: 1, step: 1 })
  await scheduled.event('session-log-deepseek/delivery-accepted', { turn: 1, step: 1 })
  await scheduled.assistant()
  await scheduled.event('step/end', { turn: 1, step: 1 })
  await scheduled.finish()
  assert.equal(scheduled.sent.length, 1)
  assert.equal(scheduled.sent[0].identity.occurrenceMessageId, 'native-occurrence')
  assert.equal(scheduled.outbound()[0].state, 'delivered')
  assert.equal(scheduled.contexts.originUser(scheduled.contexts.forAgent(scheduled.target.id)), undefined)
  scheduled.stop()

  for (const source of [{ kind: 'user' }, { kind: 'skill-catalog', form: 'snapshot' }, { kind: 'time-context', form: 'catalog' }, { kind: 'other-host-context', form: 'snapshot' }]) {
    const interrupted = await environment()
    await interrupted.begin()
    await interrupted.event('user/message', { id: 'later-input', source, content: [{ type: 'text', text: 'A different input.' }] })
    await interrupted.event('user/message', { id: 'later-native-catalog', source: { kind: 'skill-catalog', form: 'catalog' }, content: [] })
    await interrupted.event('user/message', { id: 'later-native-time', source: { kind: 'time-context', form: 'snapshot' }, content: [] })
    await interrupted.assistant(); await interrupted.finish()
    assert.equal(interrupted.sent.length, 0)
    assert.deepEqual(interrupted.outbound(), [])
    interrupted.stop()
  }
})

for (const reason of [{ kind: 'error' }, { kind: 'aborted', reason: { kind: 'user' } }, { kind: 'max-tokens' }, { kind: 'max_tokens' }, { kind: 'blocked' }, 'completed']) {
  test(`terminal reason ${JSON.stringify(reason)} cannot send or claim external delivery`, async () => {
    const e = await environment()
    await e.begin(); await e.assistant('Incomplete'); await e.finish(reason)
    assert.equal(e.sent.length, 0)
    assert.deepEqual(e.outbound(), [])
    e.stop()
  })
}

test('missing service and missing final assistant body never fabricate an external delivery', async () => {
  const disabled = await environment({ enabled: false })
  await disabled.begin(); await disabled.assistant(); await disabled.finish()
  assert.equal(disabled.created.operation.outboundDestination, undefined)
  assert.equal(disabled.sent.length, 0)
  disabled.stop()
  const empty = await environment()
  await empty.begin(); await empty.finish()
  assert.equal(empty.sent.length, 0)
  assert.deepEqual(empty.outbound(), [])
  empty.stop()
})

for (const invalid of ['wrong-owner', 'wrong-job', 'wrong-session', 'non-schedule', 'wrong-history', 'wrong-task', 'changed-target', 'wrong-native-target', 'inherited', 'wrong-turn', 'flat-assistant']) {
  test(`${invalid} cannot reach a trusted external target`, async () => {
    const e = await environment(invalid === 'wrong-owner' ? { destination: { ...destination(), ownerId: 'another-owner' } }
      : invalid === 'wrong-history' ? { history: () => ({ records: [{ messageId: 'another-native-occurrence' }] }) } : {})
    if (e.created.ok) {
      if (invalid === 'wrong-task') ledger.upsertTask(e.created.taskId, { ownerId: 'another-owner' })
      if (invalid === 'changed-target' || invalid === 'wrong-native-target') {
        const data = JSON.parse(readFileSync(e.operationsFile, 'utf8'))
        const operation = Object.values(data.operations)[0]
        if (invalid === 'changed-target') operation.outboundDestination.chatId = 'different-private-chat'
        // 0.2.2 receipts name the delivery destination under `target`.
        else operation.actualReceipt.target = { kind: 'session', sessionId: 'different-native-session' }
        writeFileSync(e.operationsFile, JSON.stringify(data))
      }
      const source = invalid === 'wrong-job' ? { kind: 'schedule', scheduleId: 'another-job' }
        : invalid === 'non-schedule' ? { kind: 'user' }
          : { kind: 'schedule', scheduleId: e.created.reminder.id }
      const session = invalid === 'wrong-session' ? { id: 'another-session', inheritedEventCount: 0 }
        : invalid === 'inherited' ? { ...e.target, inheritedEventCount: 1000 } : e.target
      await e.begin(source, session)
      if (invalid === 'flat-assistant') await e.event('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'Untrusted flat message' }] })
      else await e.assistant('Safe reminder body', invalid === 'wrong-turn' ? { turn: 2 } : {})
      await e.finish()
    }
    assert.equal(e.sent.length, 0)
    e.stop()
  })
}

test('same occurrence and native events never send again after a completed receipt or a reload', async () => {
  const e = await environment()
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 1)
  await e.begin(); await e.assistant(); await e.finish()
  e.reload()
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 1)
  assert.equal(e.outbound().length, 1)
  assert.equal(e.resolutions.length, 1, 'the target resolver is only used at reminder creation')
  e.stop()
})

test('persisted intent precedes send, and an exception stays uncertain across reload with no retry', async () => {
  let e
  e = await environment({ async send(_to, _text, identity) {
    const rows = Object.values(JSON.parse(readFileSync(e.outboundFile, 'utf8')).deliveries)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'pending')
    assert.equal(rows[0].textSha256, identity.textSha256)
    throw Error('platform response lost')
  } })
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 1)
  assert.equal(e.outbound()[0].state, 'uncertain')
  assert.equal(e.outbound()[0].receipt, undefined)
  e.reload()
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 1)
  assert.equal(e.outbound()[0].state, 'uncertain')
  e.stop()
})

test('a reload while the trusted send is pending cannot claim or send the occurrence twice', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const e = await environment({ async send() { await gate; return { messageId: 'platform-receipt-after-reload' } } })
  await e.begin(); await e.assistant()
  const delivery = e.finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(e.outbound()[0].state, 'pending')
  e.reload()
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 1)
  release(); await delivery
  assert.equal(e.outbound()[0].receipt.messageId, 'platform-receipt-after-reload')
  e.stop()
})

test('a destination changed in the host resolver cannot retarget a saved reminder', async () => {
  const e = await environment()
  e.destination({ ...destination(), chatId: 'different-private-chat' })
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 1)
  assert.deepEqual(e.sent[0].to, destination())
  e.stop()
})

test('native history is checked against the exact job and can settle after the terminal event', async () => {
  const e = await environment({ history: (_request, attempt) => ({ records: attempt < 2 ? [] : [{ messageId: 'native-occurrence' }] }) })
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 1)
  assert.equal(e.historyRequests.length, 2)
  assert.deepEqual(e.historyRequests[0], { id: e.created.reminder.id, limit: 100 })
  e.stop()
})

for (const receipt of [{}, { chunkIds: ['only-a-chunk'] }, { messageId: '' }]) {
  test(`an invalid platform receipt ${JSON.stringify(receipt)} stays uncertain without a delivered claim`, async () => {
    const e = await environment({ send: async () => receipt })
    await e.begin(); await e.assistant(); await e.finish()
    assert.equal(e.sent.length, 1)
    assert.equal(e.outbound()[0].state, 'uncertain')
    assert.equal(e.outbound()[0].receipt, undefined)
    e.reload()
    await e.begin(); await e.assistant(); await e.finish()
    assert.equal(e.sent.length, 1)
    e.stop()
  })
}

test('a task owner changing while native history is checked cannot pass the final send gate', async () => {
  let e
  e = await environment({ history() {
    ledger.upsertTask(e.created.taskId, { ownerId: 'different-owner' })
    return { records: [{ messageId: 'native-occurrence' }] }
  } })
  await e.begin(); await e.assistant(); await e.finish()
  assert.equal(e.sent.length, 0)
  assert.deepEqual(e.outbound(), [])
  e.stop()
})

test('read-only reminder status leaves an unrelated pending WAL operation and its bytes untouched', async () => {
  const e = await environment()
  await e.begin(); await e.assistant(); await e.finish()
  const journal = join(root, 'state', 'store-operations.jsonl'), target = join(root, 'state', 'readonly-sentinel.txt')
  const journalBefore = readFileSync(journal, 'utf8'), original = 'original snapshot\n', changed = 'pending snapshot\n'
  writeFileSync(target, original)
  const pending = { version: 1, phase: 'prepared', operationId: `readonly-${crypto.randomUUID()}`, kind: 'test.readonly', targetId: target,
    time: '2026-10-21T00:00:00.000Z', writes: [{ path: target, content: changed, format: 'text', beforeSha256: digest(original), afterSha256: digest(changed) }] }
  const withPending = journalBefore + JSON.stringify(pending) + '\n'
  writeFileSync(journal, withPending)
  try {
    assert.equal(e.status()[0].outbound[0].state, 'delivered')
    assert.equal(readFileSync(target, 'utf8'), original)
    assert.equal(readFileSync(journal, 'utf8'), withPending)
  } finally {
    writeFileSync(journal, journalBefore)
    writeFileSync(target, original)
    e.stop()
  }
})
