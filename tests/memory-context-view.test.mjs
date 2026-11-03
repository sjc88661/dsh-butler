import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'

const parent = resolve('tests/.tmp')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(join(parent, 'memory-context-view-'))
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { MemoryService } = await import('../src/host/memory.ts')
const contextsFile = vault.statePath('contexts.json')
const pendingFile = vault.statePath('pending.json')
const memosFile = vault.statePath('memos.json')
const profileFile = vault.PROFILE_FILE()

function removeOwned(path) {
  if (!fs.existsSync(path)) return
  const absolute = resolve(path), actual = fs.realpathSync(path)
  assert.ok(absolute === fixture || absolute.startsWith(fixture + sep))
  assert.ok(actual.startsWith(fs.realpathSync(parent) + sep))
  fs.rmSync(absolute, { recursive: true, force: true })
}
beforeEach(() => {
  removeOwned(vault.STATE_HOME); removeOwned(vault.VAULT_HOME)
  vault.ensureVault()
  fs.writeFileSync(profileFile, '# 用户档案\n\n- 保留手写内容\n')
})
after(() => removeOwned(fixture))

const human = (id, text) => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
function input(h, text, id = 'origin') {
  h.contexts.bindUser(h.agent, human(id, text))
  return { ...h.contexts.activate('business', h.contexts.forAgent(h.agent)), callId: `call-${id}` }
}
function setup(text = '帮我整理偏好', options = {}) {
  const h = { contexts: new ExecutionContexts({ file: contextsFile, ...options }), agent: { id: 'owner' } }
  h.memory = new MemoryService({ contexts: h.contexts })
  h.identity = input(h, text)
  return h
}
function countContexts(action) {
  const original = fs.readFileSync; let reads = 0
  fs.readFileSync = function (path, ...args) {
    if (path === contextsFile) reads++
    return Reflect.apply(original, this, [path, ...args])
  }
  syncBuiltinESMExports()
  try { return { result: action(), reads: () => reads } }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
}
const profile = () => fs.readFileSync(profileFile, 'utf8')

test('direct remember validates source from one context snapshot and retains the exact original text', () => {
  const fact = '我偏好详细回复。', h = setup(fact)
  const { result, reads } = countContexts(() => h.memory.remember(fact, { identity: h.identity }))
  assert.equal(result.memo.status, 'confirmed'); assert.equal(result.memo.text, fact)
  assert.equal(result.memo.origin.messageId, 'origin'); assert.match(profile(), /保留手写内容/)
  assert.equal(reads(), 1, 'One fresh caller/root/user view must replace the three separate context reads')
})

test('a decision reuses the same caller view for task checks and retains unknown memo/proposal fields', () => {
  const h = setup(), proposal = h.memory.propose('我偏好详细回复。', { identity: h.identity })
  const memos = JSON.parse(fs.readFileSync(memosFile)); memos[0].futureMemo = { keep: true }
  const pending = JSON.parse(fs.readFileSync(pendingFile)); pending[0].futureProposal = ['keep']
  fs.writeFileSync(memosFile, JSON.stringify(memos) + '\n'); fs.writeFileSync(pendingFile, JSON.stringify(pending) + '\n')
  const identity = input(h, `确认 ${proposal.proposal.id}`, 'decision')
  const { result, reads } = countContexts(() => h.memory.decide(proposal.proposal.id, 'approved', {}, identity))
  assert.equal(result.memo.status, 'confirmed'); assert.equal(result.proposal.status, 'approved')
  assert.equal(reads(), 1, 'A decision must not refresh again solely to inspect the same caller task')
  assert.deepEqual(JSON.parse(fs.readFileSync(memosFile))[0].futureMemo, { keep: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingFile))[0].futureProposal, ['keep'])
})

test('a later public call sees peer source changes instead of retaining a prior user view', () => {
  const fact = '我偏好详细回复。', h = setup(fact)
  assert.equal(h.memory.remember(fact, { identity: h.identity }).memo.status, 'confirmed')
  const before = profile(), peer = new ExecutionContexts({ file: contextsFile })
  peer.bindUser('owner', human('peer-origin', '暂缓任何新的记忆决定'))
  const peerBytes = fs.readFileSync(contextsFile)
  const result = h.memory.remember('我偏好简短回复。', { identity: h.identity, source: 'user', approved: true })
  assert.equal(result.memo.status, 'proposed'); assert.equal(result.proposal.status, 'pending')
  assert.equal(profile(), before); assert.deepEqual(fs.readFileSync(contextsFile), peerBytes)
})

test('a caller missing its persisted binding cannot borrow the root user as direct proof', () => {
  const fact = '我偏好详细回复。', h = setup(fact), before = profile()
  const result = h.memory.remember(fact, { identity: { ...h.identity, sessionId: 'missing-child', rootSessionId: 'owner' }, source: 'user', approved: true })
  assert.equal(result.memo.status, 'proposed'); assert.equal(result.proposal.status, 'pending')
  assert.equal(profile(), before)
})

test('a persisted native child binding still uses its real root input without changing provenance', () => {
  const fact = '我偏好详细回复。', h = setup(fact, { rootFor: agent => agent.id === 'child' ? { id: 'owner' } : agent })
  const identity = { ...h.contexts.forAgent({ id: 'child' }), callId: 'child-memory' }
  const { result, reads } = countContexts(() => h.memory.remember(fact, { identity }))
  assert.equal(result.memo.status, 'confirmed'); assert.equal(result.memo.origin.sessionId, 'owner')
  assert.equal(result.memo.origin.executionSessionId, 'child'); assert.equal(reads(), 1)
})

test('direct correction obtains a new source view after the proposal commit', () => {
  const first = '我偏好简短回复。', fact = '我偏好详细回复。', h = setup(first)
  const original = h.memory.remember(first, { identity: h.identity })
  const identity = input(h, `更正 ${original.memo.id}：${fact}`, 'correction')
  const { result, reads } = countContexts(() => h.memory.correct(original.memo.id, fact, { identity }))
  assert.equal(result.memo.status, 'confirmed'); assert.equal(result.memo.supersedes, original.memo.id)
  assert.equal(reads(), 2, 'Proposal creation and post-commit decision each require their own fresh source view')
  assert.equal(h.memory.read(original.memo.id).memo.status, 'retracted')
})

test('peer input between correction proposal and decision prevents approval and preserves the old value', () => {
  const first = '我偏好简短回复。', fact = '我偏好详细回复。', h = setup(first)
  const original = h.memory.remember(first, { identity: h.identity }), before = profile()
  const identity = input(h, `更正 ${original.memo.id}：${fact}`, 'correction')
  const peer = new ExecutionContexts({ file: contextsFile }), decide = h.memory.decide.bind(h.memory)
  let peerBytes, entered = 0
  h.memory.decide = (...args) => {
    entered++; peer.bindUser('owner', human('peer-origin', '暂缓更正'))
    peerBytes = fs.readFileSync(contextsFile)
    return decide(...args)
  }
  assert.throws(() => h.memory.correct(original.memo.id, fact, { identity }), /凭据|匹配|确认|用户/)
  assert.equal(entered, 1); assert.equal(profile(), before)
  assert.equal(h.memory.read(original.memo.id).memo.status, 'confirmed')
  assert.deepEqual(fs.readFileSync(contextsFile), peerBytes)
})

test('peer task changes during decision file reads are checked by the later fresh source view', () => {
  const h = setup(), proposed = h.memory.propose('我偏好详细回复。', { identity: h.identity })
  const identity = input(h, `确认 ${proposed.proposal.id}`, 'decision'), before = profile()
  const peer = new ExecutionContexts({ file: contextsFile }), original = fs.readFileSync
  let armed = true, peerBytes
  fs.readFileSync = function (path, ...args) {
    const bytes = Reflect.apply(original, this, [path, ...args])
    if (path === pendingFile && armed) {
      armed = false; peer.activate('another-business', identity)
      peerBytes = Reflect.apply(original, this, [contextsFile])
    }
    return bytes
  }
  syncBuiltinESMExports()
  try { assert.throws(() => h.memory.decide(proposed.proposal.id, 'approved', {}, identity), /凭据|匹配|确认|用户/) }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
  assert.equal(armed, false); assert.equal(profile(), before)
  assert.deepEqual(fs.readFileSync(contextsFile), peerBytes)
})

test('corrupt pending state still blocks a direct remember even though it would not write pending', () => {
  const fact = '我偏好详细回复。', h = setup(fact), before = profile()
  fs.writeFileSync(pendingFile, '[{}]\n')
  assert.throws(() => h.memory.remember(fact, { identity: h.identity }))
  assert.equal(profile(), before); assert.equal(fs.existsSync(memosFile), false)
})
