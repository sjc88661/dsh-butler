import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'execution-read-cost-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
after(() => rmSync(home, { recursive: true, force: true }))
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { ensureVault } = await import('../src/host/vault.ts'); ensureVault()
const fs = createRequire(import.meta.url)('node:fs')
const human = id => ({ id, source: { kind: 'user', rpcId: 'rpc-' + id }, content: [{ type: 'text', text: 'exact user text ' + id + '。' }] })
let sequence = 0
const nextFile = () => join(process.env.DSH_BUTLER_HOME, 'contexts-' + ++sequence + '.json')

function countReads(file, fn) {
  const original = fs.readFileSync; let reads = 0, result
  fs.readFileSync = function (path, ...args) { if (path === file) reads++; return Reflect.apply(original, this, [path, ...args]) }
  syncBuiltinESMExports()
  try { result = fn() }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
  return { reads, result }
}

for (const explicitAgent of [false, true]) test('unknown capture reads one canonical context snapshot (' + (explicitAgent ? 'explicit' : 'resolved') + ' agent)', () => {
  const file = nextFile(), agent = { id: 'owner' }, contexts = new ExecutionContexts({ file, agentFor: () => agent })
  contexts.bindUser(agent, human('origin'))
  const execution = { ...(explicitAgent ? { agent } : {}), callId: 'first-capture', name: 'local-read' }
  const observed = countReads(file, () => contexts.capture(execution))
  assert.equal(observed.result[1].identity.originMessageId, 'origin')
  assert.equal(observed.reads, 3, 'one canonical read plus unchanged commit before-image and pre-replacement reads')
  assert.equal(countReads(file, () => contexts.capture(execution)).reads, 1, 'known execution still gets an independent fresh read')
})

for (const sameInstance of [false, true]) test('agentFor reentry is observed by the canonical capture snapshot (' + (sameInstance ? 'same' : 'peer') + ' instance)', () => {
  const file = nextFile(), agent = { id: 'owner' }; let armed = false, peer
  const contexts = new ExecutionContexts({ file, agentFor() {
    if (armed) { armed = false; peer.bindUser(agent, human('new-source')) }
    return agent
  } })
  peer = sameInstance ? contexts : new ExecutionContexts({ file })
  contexts.bindUser(agent, human('old-source')); armed = true
  const [, call] = contexts.capture({ callId: 'callback-capture', name: 'local-read' })
  assert.equal(call.identity.originMessageId, 'new-source')
  assert.equal(new ExecutionContexts({ file }).originUser(call.identity).text, human('new-source').content[0].text)
})

test('known execution and cached receipt still reject corrupted context bytes', () => {
  const file = nextFile(), contexts = new ExecutionContexts({ file }), agent = { id: 'owner' }
  contexts.bindUser(agent, human('origin'))
  const execution = { agent, callId: 'known', name: 'local-read' }
  contexts.capture(execution); contexts.receipt(execution, { value: { ok: true } })
  writeFileSync(file, '{broken')
  assert.throws(() => contexts.capture(execution), /context.*storage|执行.*上下文|存储/)
  assert.throws(() => contexts.receipt(execution, { value: { ok: true } }), /context.*storage|执行.*上下文|存储/)
  assert.equal(readFileSync(file, 'utf8'), '{broken')
})

test('readUserInputView reads caller, root and exact native user text once without callbacks and returns copies', () => {
  const file = nextFile(), root = { id: 'root' }, child = { id: 'child', parent: root }; let armed = false
  const callback = value => { assert.equal(armed, false, 'view must not enter live authority callbacks'); return value }
  const contexts = new ExecutionContexts({ file, agentFor: () => callback(child), rootFor: agent => callback(agent.parent ?? agent), runFor: id => { callback(id); return 'run-' + id } })
  contexts.bindUser(root, human('root-origin'))
  contexts.activate('root-task', contexts.forAgent(root))
  const identity = contexts.forAgent(child)
  assert.equal(typeof contexts.readUserInputView, 'function', 'one fresh context view is a public read operation')
  const bytesBefore = readFileSync(file), expectedBefore = createHash('sha256').update(bytesBefore).digest('hex')
  armed = true
  const observed = countReads(file, () => contexts.readUserInputView(identity))
  assert.equal(observed.reads, 1)
  assert.deepEqual(observed.result, { caller: identity, root: { sessionId: root.id, rootSessionId: root.id, runId: 'run-root', originMessageId: 'root-origin', taskId: 'root-task' },
    user: { sessionId: root.id, messageId: 'root-origin', source: 'user', text: human('root-origin').content[0].text, rpcId: 'rpc-root-origin' }, expectedBefore })
  assert.deepEqual(readFileSync(file), bytesBefore, 'a proof view never commits a binding')
  observed.result.caller.taskId = 'forged'; observed.result.root.originMessageId = 'forged'; observed.result.user.text = 'forged'
  const fresh = contexts.readUserInputView(identity)
  assert.equal(fresh.caller.taskId, 'root-task'); assert.equal(fresh.root.originMessageId, 'root-origin')
  assert.equal(fresh.user.text, human('root-origin').content[0].text)
})

test('readUserInputView never invents missing child ownership and rejects stale peer origins', () => {
  const file = nextFile(), contexts = new ExecutionContexts({ file }), peer = new ExecutionContexts({ file })
  const identity = contexts.bindUser('owner', human('old-origin'))
  assert.equal(typeof contexts.readUserInputView, 'function')
  assert.equal(contexts.readUserInputView({ ...identity, sessionId: 'missing-child' }), undefined)
  assert.equal(contexts.readUserInputView({ ...identity, rootSessionId: 'missing-root' }), undefined)
  const first = contexts.readUserInputView(identity)
  peer.bindUser('owner', human('new-origin'))
  assert.equal(contexts.readUserInputView(identity), undefined, 'an earlier returned view is never an entry cache')
  assert.equal(first.user.text, human('old-origin').content[0].text, 'previous returned data remains its own copy')
  const current = peer.forAgent('owner')
  assert.equal(contexts.readUserInputView(current).user.messageId, 'new-origin')
})

test('readUserInputView fails closed on inconsistent persisted ownership or user record identity', () => {
  const file = nextFile(), root = { id: 'root' }, child = { id: 'child', parent: root }
  const contexts = new ExecutionContexts({ file, rootFor: agent => agent.parent ?? agent })
  contexts.bindUser(root, human('origin')); const identity = contexts.forAgent(child)
  assert.equal(typeof contexts.readUserInputView, 'function')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  data.sessions.child.rootSessionId = 'another-root'; writeFileSync(file, JSON.stringify(data) + '\n')
  assert.equal(contexts.readUserInputView(identity), undefined)
  data.sessions.child.rootSessionId = 'root'; data.users[JSON.stringify(['root', 'origin'])].sessionId = 'another-root'
  writeFileSync(file, JSON.stringify(data) + '\n')
  assert.equal(contexts.readUserInputView(identity), undefined)
})

test('readUserInputView supports in-memory bindings without creating human evidence for runtime input', () => {
  const contexts = new ExecutionContexts(), identity = contexts.bindUser('owner', human('origin'))
  assert.equal(typeof contexts.readUserInputView, 'function')
  assert.equal(contexts.readUserInputView(identity).user.source, 'user')
  assert.equal(contexts.readUserInputView(identity).expectedBefore, undefined)
  assert.equal(contexts.readUserInputView({ sessionId: 'runtime', rootSessionId: 'runtime' }), undefined)
  const noText = contexts.bindUser('empty', { id: 'empty-origin', source: { kind: 'user' } })
  assert.equal(contexts.readUserInputView(noText).user, undefined)
})

test('readUserInputView resolves explicit identity getters before its one fresh snapshot', () => {
  const file = nextFile(), contexts = new ExecutionContexts({ file }), peer = new ExecutionContexts({ file })
  contexts.bindUser('owner', human('old-origin'))
  assert.equal(typeof contexts.readUserInputView, 'function')
  const identity = { sessionId: 'owner', rootSessionId: 'owner', get originMessageId() {
    peer.bindUser('owner', human('new-origin'))
    return 'new-origin'
  } }
  assert.equal(contexts.readUserInputView(identity).user.messageId, 'new-origin')
})
