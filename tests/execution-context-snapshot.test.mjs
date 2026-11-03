import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'execution-snapshot-'))
process.env.DSH_BUTLER_HOME = join(home, 'state'); process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { ensureVault } = await import('../src/host/vault.ts'); ensureVault()
const fs = createRequire(import.meta.url)('node:fs')
const human = id => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: 'work ' + id }] })
let sequence = 0
const nextFile = () => join(process.env.DSH_BUTLER_HOME, 'contexts-' + ++sequence + '.json')

test('one attribution snapshot is read once before the unchanged commitFiles file checks', () => {
  const file = nextFile(), contexts = new ExecutionContexts({ file })
  contexts.bindUser('owner', human('origin'))
  const original = fs.readFileSync; let reads = 0
  fs.readFileSync = function (path, ...args) { if (path === file) reads++; return Reflect.apply(original, this, [path, ...args]) }; syncBuiltinESMExports()
  try { contexts.activate('task', { sessionId: 'owner', rootSessionId: 'owner' }) }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
  assert.equal(reads, 3, 'One business snapshot plus commitFiles before-image and pre-replacement checks; save must not re-readSnapshot')
})

for (const callback of ['rootFor', 'runFor']) for (const sameInstance of [false, true]) test(callback + ' ' + (sameInstance ? 'same-instance' : 'peer') + ' updates reject the outer stale snapshot without losing peer data', () => {
  const file = nextFile(); let armed = false, peerBytes, peer
  const contexts = new ExecutionContexts({ file, [callback]: value => {
    if (armed) { armed = false; peer.bindUser('peer', human('peer-' + callback)); peerBytes = readFileSync(file) }
    return callback === 'rootFor' ? value : 'run'
  } })
  peer = sameInstance ? contexts : new ExecutionContexts({ file })
  const agent = { id: 'owner' }; contexts.bindUser(agent, human('first')); armed = true
  assert.throws(() => contexts.bindUser(agent, human('second')), /冲突|snapshot|changed/i)
  assert.deepEqual(readFileSync(file), peerBytes)
  assert.equal(new ExecutionContexts({ file }).forAgent('peer').originMessageId, 'peer-' + callback)
})

test('capture keeps the fresh forAgent read after an agentFor callback publishes a peer update', () => {
  const file = nextFile(), peer = new ExecutionContexts({ file }), agent = { id: 'owner' }; let armed = false
  const contexts = new ExecutionContexts({ file, agentFor() { if (armed) { armed = false; peer.bindUser('peer', human('callback-peer')) }; return agent } })
  contexts.bindUser(agent, human('origin')); armed = true
  contexts.capture({ callId: 'callback-capture', name: 'local-read' })
  assert.equal(new ExecutionContexts({ file }).forAgent('peer').originMessageId, 'callback-peer')
})

for (const sameInstance of [false, true]) test('onReceipt reentry (' + (sameInstance ? 'same' : 'peer') + ' instance) cannot replace a peer snapshot', () => {
  const file = nextFile(); let peer, peerBytes, armed = false
  const contexts = new ExecutionContexts({ file, onReceipt() {
    if (armed) { armed = false; peer.bindUser('peer', human('receipt-peer')); peerBytes = readFileSync(file) }
  } })
  peer = sameInstance ? contexts : new ExecutionContexts({ file })
  contexts.bindUser('owner', human('origin'))
  const exec = { agent: { id: 'owner' }, callId: 'receipt-call', name: 'local-read' }; contexts.capture(exec); armed = true
  assert.throws(() => contexts.receipt(exec, { isError: false, value: { ok: true } }), /冲突|snapshot|changed/i)
  assert.deepEqual(readFileSync(file), peerBytes)
  assert.equal(new ExecutionContexts({ file }).forAgent('peer').originMessageId, 'receipt-peer')
})

test('successful inherited binding returns a fresh local token and retains unknown persisted fields', () => {
  const file = nextFile(), parent = { id: 'root' }, child = { id: 'child' }
  const contexts = new ExecutionContexts({ file, rootFor: agent => agent.id === child.id ? parent : agent })
  contexts.bindUser(parent, human('root-origin'))
  const data = JSON.parse(readFileSync(file, 'utf8')); data.futureRoot = { opaque: [1, 2] }; data.sessions.root.futureIdentity = 'keep'
  writeFileSync(file, JSON.stringify(data) + '\n')
  const exec = { agent: child, callId: 'child-call', name: 'local-read' }
  const [key] = contexts.capture(exec)
  const receipt = contexts.receipt(exec, { isError: false, value: { ok: true } })
  assert.equal(receipt.rootSessionId, parent.id); assert.equal(contexts.capture(exec)[0], key)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).futureRoot, { opaque: [1, 2] })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.root.futureIdentity, 'keep')
})
