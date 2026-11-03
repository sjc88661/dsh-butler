import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { contextHarness } from './helpers/task-context.mjs'

const parent = resolve('tests/.tmp'); fs.mkdirSync(parent, { recursive: true })
const home = fs.mkdtempSync(join(parent, 'execution-duplicate-user-'))
process.env.DSH_BUTLER_HOME = join(home, 'state'); process.env.DSH_BUTLER_VAULT = join(home, 'vault')
after(() => {
  assert.ok(fs.realpathSync(home).startsWith(fs.realpathSync(parent) + sep))
  fs.rmSync(home, { recursive: true, force: true })
})
const { ExecutionContexts, installExecutionContext } = await import('../src/host/execution-context.ts')
const vault = await import('../src/host/vault.ts'); vault.ensureVault()
const { storageStatus } = await import('../src/host/store.ts')
const journal = vault.statePath('store-operations.jsonl')
const human = id => ({ id, source: { kind: 'user', rpcId: 'rpc-' + id }, content: [{ type: 'text', text: 'exact user text ' + id + '。' }] })
let sequence = 0
const nextFile = () => vault.statePath('duplicate-contexts-' + ++sequence + '.json')
const journalBytes = () => fs.readFileSync(journal)
const updates = file => journalBytes().toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  .filter(row => row.phase === 'prepared' && row.kind === 'execution-context.update' && row.targetId === file)

/** Counts real complete WAL reads and syncs without replacing their underlying work. */
async function withIo(file, action) {
  const names = ['openSync', 'closeSync', 'readSync', 'readFileSync', 'fsyncSync']
  const original = Object.fromEntries(names.map(name => [name, fs[name]])), fds = new Map()
  const metrics = { scans: [], contextReads: 0, journalSyncs: 0 }
  fs.openSync = (path, ...args) => {
    const fd = original.openSync(path, ...args)
    fds.set(fd, { journal: typeof path === 'string' && resolve(path) === journal, bytes: 0 })
    return fd
  }
  fs.closeSync = fd => { try { return original.closeSync(fd) } finally { fds.delete(fd) } }
  fs.readSync = (fd, buffer, offset, length, position) => {
    const count = original.readSync(fd, buffer, offset, length, position), entry = fds.get(fd)
    if (entry?.journal && position === null) { entry.bytes += count; if (count === 0) metrics.scans.push(entry.bytes) }
    return count
  }
  fs.readFileSync = (path, ...args) => { if (path === file) metrics.contextReads++; return original.readFileSync(path, ...args) }
  fs.fsyncSync = fd => { const result = original.fsyncSync(fd); if (fds.get(fd)?.journal) metrics.journalSyncs++; return result }
  syncBuiltinESMExports()
  try { return { value: await action(), metrics } }
  finally { for (const name of names) fs[name] = original[name]; syncBuiltinESMExports() }
}

test('a fresh exact duplicate user binding appends no transaction but keeps two complete fresh WAL fences', async t => {
  const file = nextFile(), agent = { id: 'owner' }, contexts = new ExecutionContexts({ file, runFor: () => 'run-owner' }), message = human('origin')
  contexts.bindUser(agent, message, 'run-owner')
  contexts.activate('business-task', contexts.forAgent(agent)); contexts.captureRequest(agent, 3, 2)
  const before = journalBytes(), business = fs.readFileSync(file), count = updates(file).length
  const observed = await withIo(file, () => contexts.bindUser(agent, structuredClone(message)))
  t.diagnostic(JSON.stringify({ beforeBytes: before.length, afterBytes: journalBytes().length, newCommits: updates(file).length - count, ...observed.metrics }))
  assert.ok(journalBytes().equals(before), 'The complete WAL must be byte-identical for an exact duplicate')
  assert.deepEqual(fs.readFileSync(file), business)
  assert.deepEqual(observed.metrics, { scans: [before.length, before.length], contextReads: 2, journalSyncs: 0 })
  assert.deepEqual(observed.value, { sessionId: agent.id, rootSessionId: agent.id, runId: 'run-owner', originMessageId: message.id, taskId: 'business-task', turn: 3, step: 2 })
})

test('all three native user input hooks remain installed and duplicate hooks preserve task and exact position', async t => {
  const file = nextFile(), runtime = contextHarness(), agent = runtime.agent('hook-owner'), calls = { rootFor: 0, runFor: 0 }
  const contexts = installExecutionContext(runtime.ctx, { file, rootFor: value => { calls.rootFor++; return value }, runFor: () => { calls.runFor++; return 'hook-run' } })
  t.after(() => contexts.stop())
  const message = human('hook-origin')
  await runtime.emit('agent/inbox/claimed', { agent, message })
  contexts.activate('hook-task', contexts.forAgent(agent)); contexts.captureRequest(agent, 4, 5)
  const before = journalBytes(), counts = { ...calls }
  await runtime.dispatch('agent/pre-step', [{ agent, messages: [structuredClone(message)] }], () => ({ kind: 'enter' }))
  await runtime.emit('session/event', agent.session, { type: 'user/message', data: structuredClone(message) })
  assert.ok(journalBytes().equals(before), 'No new WAL operation is allowed')
  assert.equal(calls.rootFor - counts.rootFor, 3, 'stale-child ownership plus both existing binding callbacks remain')
  assert.equal(calls.runFor - counts.runFor, 2)
  assert.equal(contexts.forCall(agent.id, 4, 5).originMessageId, message.id)
  const identity = contexts.forAgent(agent)
  assert.equal(identity.taskId, 'hook-task'); assert.equal(identity.turn, 4); assert.equal(identity.step, 5)
})

for (const change of ['message', 'text', 'rpc', 'explicit-run']) test('a changed ' + change + ' remains a durable binding transaction', () => {
  const file = nextFile(), contexts = new ExecutionContexts({ file }), message = human('origin'), first = contexts.bindUser('owner', message, 'original-run')
  contexts.activate('old-task', first)
  const count = updates(file).length, changed = structuredClone(message)
  if (change === 'message') { changed.id = 'new-origin'; changed.source.rpcId = 'new-rpc' }
  if (change === 'text') changed.content[0].text += ' changed'
  if (change === 'rpc') changed.source.rpcId = 'another-rpc'
  const result = contexts.bindUser('owner', changed, change === 'explicit-run' ? 'new-run' : undefined)
  assert.equal(updates(file).length - count, 1)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).sessions.owner
  assert.deepEqual(saved, result)
  assert.equal(contexts.originUser(result).text, changed.content[0].text)
  if (change === 'message') { assert.equal(result.originMessageId, 'new-origin'); assert.equal(result.taskId, undefined); assert.equal(result.runId, undefined) }
  else assert.equal(result.taskId, 'old-task')
  if (change === 'explicit-run') assert.equal(result.runId, 'new-run')
})

test('fresh peer task/position changes survive an exact duplicate and non-user sources never replace native user evidence', () => {
  const file = nextFile(), contexts = new ExecutionContexts({ file }), peer = new ExecutionContexts({ file }), agent = { id: 'owner' }, message = human('origin')
  contexts.bindUser(agent, message)
  peer.activate('peer-task', peer.forAgent(agent)); peer.captureRequest(agent, 8, 6)
  const before = journalBytes(), result = contexts.bindUser(agent, structuredClone(message))
  assert.ok(journalBytes().equals(before), 'No new WAL operation is allowed')
  assert.equal(result.taskId, 'peer-task'); assert.equal(result.turn, 8); assert.equal(result.step, 6)
  for (const kind of ['runtime-context', 'model', 'schedule']) contexts.bindUser(agent, { ...message, source: { kind }, content: [{ type: 'text', text: 'not human' }] })
  assert.ok(journalBytes().equals(before), 'No new WAL operation is allowed')
  assert.equal(contexts.originUser(result).text, message.content[0].text)
  contexts.bindUser(agent, { id: message.id, source: { kind: 'user' }, content: [] })
  assert.deepEqual(journalBytes(), before, 'Empty blocks keep the existing exact observed user evidence')
})

test('child input cannot rebind its parent and a former child becoming an independent root still commits ownership and new source', () => {
  const file = nextFile(), root = { id: 'root' }, child = { id: 'child', parent: root }
  const contexts = new ExecutionContexts({ file, rootFor: agent => agent.parent ?? agent })
  contexts.bindUser(root, human('root-origin')); contexts.activate('root-task', contexts.forAgent(root)); contexts.forAgent(child)
  const before = journalBytes(), inherited = contexts.bindUser(child, human('invented-child-user'))
  assert.ok(journalBytes().equals(before), 'No new WAL operation is allowed'); assert.equal(inherited.originMessageId, 'root-origin'); assert.equal(inherited.taskId, 'root-task')
  child.parent = undefined
  const count = updates(file).length, independent = contexts.bindUser(child, human('independent-origin'))
  assert.equal(updates(file).length - count, 2, 'Ownership reset and actual new user binding remain distinct original commits')
  assert.equal(independent.rootSessionId, child.id); assert.equal(independent.originMessageId, 'independent-origin'); assert.equal(independent.taskId, undefined)
  assert.equal(contexts.forAgent(root).taskId, 'root-task')
})

for (const callback of ['rootFor', 'runFor']) for (const sameInstance of [false, true]) test('an exact duplicate rejects ' + callback + ' ' + (sameInstance ? 'same-instance' : 'peer') + ' writes after its original snapshot', () => {
  const file = nextFile(), agent = { id: 'owner' }, message = human('origin'); let armed = false, peer, peerBytes, peerJournal
  const contexts = new ExecutionContexts({ file, rootFor: value => {
    if (callback === 'rootFor' && armed) publish()
    return value
  }, runFor: id => { if (callback === 'runFor' && armed) publish(); return 'run-' + id } })
  function publish() { armed = false; peer.bindUser('peer', human('peer-source')); peerBytes = fs.readFileSync(file); peerJournal = journalBytes() }
  peer = sameInstance ? contexts : new ExecutionContexts({ file })
  contexts.bindUser(agent, message, 'run-owner'); armed = true
  assert.throws(() => contexts.bindUser(agent, structuredClone(message)), /冲突|snapshot|changed/i)
  assert.deepEqual(fs.readFileSync(file), peerBytes); assert.ok(journalBytes().equals(peerJournal), 'Peer journal must remain unchanged')
  assert.equal(storageStatus([file]).degraded, true); assert.equal(storageStatus([file]).diagnostics[0].kind, 'recovery')
  assert.equal(new ExecutionContexts({ file }).forAgent('peer').originMessageId, 'peer-source')
})

for (const callback of ['rootFor', 'runFor']) test('an exact duplicate rejects same-length restored-mtime context edits in ' + callback, () => {
  const file = nextFile(), message = human('origin'), agent = { id: 'owner' }; let armed = false, altered
  const contexts = new ExecutionContexts({ file, rootFor: value => { if (callback === 'rootFor' && armed) edit(); return value },
    runFor: () => { if (callback === 'runFor' && armed) edit(); return 'run-owner' } })
  function edit() {
    armed = false; const stamp = fs.statSync(file), before = fs.readFileSync(file)
    altered = Buffer.from(before.toString('utf8').replace('exact user text', 'other user text'))
    assert.equal(altered.length, before.length); fs.writeFileSync(file, altered); fs.utimesSync(file, stamp.atime, stamp.mtime)
  }
  contexts.bindUser(agent, message, 'run-owner'); const before = journalBytes(); armed = true
  assert.throws(() => contexts.bindUser(agent, structuredClone(message)), /冲突|snapshot|changed/i)
  assert.deepEqual(fs.readFileSync(file), altered); assert.ok(journalBytes().equals(before), 'No new WAL operation is allowed')
  assert.equal(storageStatus([file]).degraded, true); assert.equal(storageStatus([file]).diagnostics[0].kind, 'recovery')
})

for (const callback of ['rootFor', 'runFor']) test('an exact duplicate still detects same-length restored-mtime WAL damage in ' + callback, () => {
  const file = nextFile(), message = human('origin'), agent = { id: 'owner' }; let armed = false, altered
  const contexts = new ExecutionContexts({ file, rootFor: value => { if (callback === 'rootFor' && armed) edit(); return value },
    runFor: () => { if (callback === 'runFor' && armed) edit(); return 'run-owner' } })
  function edit() { armed = false; const stamp = fs.statSync(journal); altered = Buffer.from(journalBytes()); altered[0] = 91; fs.writeFileSync(journal, altered); fs.utimesSync(journal, stamp.atime, stamp.mtime) }
  contexts.bindUser(agent, message, 'run-owner'); const before = journalBytes(), business = fs.readFileSync(file), stamp = fs.statSync(journal); armed = true
  try {
    assert.throws(() => contexts.bindUser(agent, structuredClone(message)), error => error.name === 'StorageError')
    assert.ok(journalBytes().equals(altered), 'Product must preserve the damaged WAL bytes'); assert.deepEqual(fs.readFileSync(file), business)
    assert.equal(storageStatus([journal]).degraded, true)
  } finally {
    // Test-owned isolation only; product must preserve damaged bytes until an explicit repair.
    fs.writeFileSync(journal, before); fs.utimesSync(journal, stamp.atime, stamp.mtime)
  }
})
