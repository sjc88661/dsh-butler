import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join, resolve, sep } from 'node:path'

const parent = resolve('tests/.tmp')
fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(join(parent, 'approval-'))
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const approval = await import('../src/host/action-approval.ts').catch(() => ({}))
function removeOwned(path) {
  if (!fs.existsSync(path)) return
  assert.ok(fs.realpathSync(path).startsWith(fs.realpathSync(parent) + sep))
  fs.rmSync(path, { recursive: true, force: true })
}
beforeEach(() => { removeOwned(vault.STATE_HOME); removeOwned(vault.VAULT_HOME); vault.ensureVault() })
after(() => removeOwned(fixture))
function setup(options = {}) {
  assert.equal(typeof approval.ActionApprovalService, 'function', '外部动作需要可信一次性审批服务')
  const contexts = new ExecutionContexts({ file: vault.statePath('execution-contexts.json') })
  contexts.bindUser('owner', { id: 'input', source: { kind: 'user' }, content: [{ type: 'text', text: '准备发送这封邮件，先给我确认' }] })
  const identity = { ...contexts.activate('send-mail', contexts.forAgent('owner')), callId: 'send-call' }
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 0 } }]
  const session = { id: 'owner' }
  const args = { recipient: 'owner@example.invalid', subject: '草稿', text: '待批准的内容' }
  const exec = { agent: { id: 'owner', session }, name: 'send_email', callId: 'send-call', arguments: args }
  contexts.capture(exec)
  let clock = Date.parse('2026-10-15T03:00:00.000Z')
  const config = { contexts, now: () => clock, sessionQuery: { async readSession(id) {
    if (id !== session.id) return undefined
    return { events: structuredClone(events), inheritedEventCount: 0 }
  } }, ...options }
  const service = new approval.ActionApprovalService(config)
  const target = { toolName: exec.name, argsDigest: approval.actionArgumentsDigest(args), taskId: identity.taskId, callId: exec.callId }
  return { service, contexts, identity, events, session, exec, target, config, tick: ms => { clock += ms } }
}
function nativeDecision(h, outcome = 'allowed-once', requestId = 'request-1', changes = {}) {
  h.events.push({ seq: h.events.length, type: 'approval/asked', data: { id: requestId, toolName: h.exec.name, callId: h.exec.callId, ...changes } })
  h.events.push({ seq: h.events.length, type: 'approval/decided', data: { id: requestId, outcome } })
  return { requestId }
}
function propose(h, fields = {}) { return h.service.propose({ ...h.target, ...fields }, h.identity) }

test('argument digests bind complete JSON values with stable object ordering', () => {
  assert.equal(typeof approval.actionArgumentsDigest, 'function')
  const hash = approval.actionArgumentsDigest
  assert.equal(hash({ a: 1, b: ['x'] }), hash({ b: ['x'], a: 1 }))
  assert.notEqual(hash({ recipient: 'a', amount: 1 }), hash({ recipient: 'b', amount: 1 }))
  assert.notEqual(hash({ recipient: 'a', amount: 1 }), hash({ recipient: 'a', amount: 2 }))
  for (const value of [undefined, { x: undefined }, { x: Infinity }, { x: () => 1 }]) assert.throws(() => hash(value), /JSON|参数/)
})

test('proposals are typed, session/task/call bound and do not execute actions', async () => {
  const h = setup(), proposal = await propose(h)
  assert.equal(proposal.kind, 'external-action')
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.identity.sessionId, 'owner')
  assert.equal(proposal.identity.taskId, 'send-mail')
  assert.equal(proposal.callId, h.exec.callId)
  assert.equal(proposal.argsDigest, h.target.argsDigest)
  assert.equal(h.events.length, 1)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
  assert.equal((await propose(h)).id, proposal.id)
})

test('model booleans and claimed approval outcomes cannot replace native audit records', async () => {
  const h = setup(), proposal = await propose(h)
  await assert.rejects(() => h.service.recordNativeDecision(proposal.id, { requestId: 'invented', approved: true, outcome: 'allowed-once', source: 'user' }, h.exec), /原生|审批|audit|批准/)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

test('only a paired native allowed-once decision grants one exact execution', async () => {
  const h = setup(), proposal = await propose(h), proof = nativeDecision(h)
  const decided = await h.service.recordNativeDecision(proposal.id, proof, h.exec)
  assert.equal(decided.status, 'approved')
  assert.equal(decided.decision.source, 'native-approval')
  const grant = h.service.authorize(proposal.id, h.exec)
  assert.equal(grant.allowed, true)
  assert.equal(grant.callId, h.exec.callId)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

for (const outcome of ['rejected', 'cancelled', 'unavailable']) test(`native ${outcome} never grants an action`, async () => {
  const h = setup(), proposal = await propose(h)
  await h.service.recordNativeDecision(proposal.id, nativeDecision(h, outcome), h.exec)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

test('approval cannot be reused after arguments, target, tool, call or task changes', async () => {
  const h = setup(), proposal = await propose(h)
  await h.service.recordNativeDecision(proposal.id, nativeDecision(h), h.exec)
  for (const exec of [
    { ...h.exec, arguments: { ...h.exec.arguments, recipient: 'someone-else@example.invalid' } },
    { ...h.exec, arguments: { ...h.exec.arguments, text: '更改后的内容' } },
    { ...h.exec, name: 'delete_email' },
    { ...h.exec, callId: 'another-call' },
    { ...h.exec, agent: { id: 'other', session: { id: 'other' } } },
  ]) assert.equal(h.service.authorize(proposal.id, exec).allowed, false)
  h.contexts.activate('other-task', h.contexts.forAgent('owner'))
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

test('one native call cannot create a second target proposal to reuse its approval', async () => {
  const h = setup(), proposal = await propose(h)
  await assert.rejects(() => propose(h, { argsDigest: approval.actionArgumentsDigest({ recipient: 'another-target' }) }), /调用|参数|target|绑定/)
  await assert.rejects(() => propose(h, { toolName: 'different_tool' }), /调用|参数|target|绑定/)
  await h.service.recordNativeDecision(proposal.id, nativeDecision(h), h.exec)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, true)
})

test('a repeated provider call id in another step cannot consume an earlier execution approval', async () => {
  const h = setup()
  h.contexts.captureRequest(h.exec.agent, 1, 1)
  h.exec = { ...h.exec }
  h.identity = { ...h.contexts.capture(h.exec)[1].identity }
  h.events[0].data.turn = 1
  const proposal = await propose(h)
  await h.service.recordNativeDecision(proposal.id, nativeDecision(h), h.exec)
  const original = h.exec
  h.contexts.captureRequest(h.exec.agent, 1, 2)
  const later = { ...h.exec }
  h.contexts.capture(later)
  assert.equal(h.service.authorize(proposal.id, later).allowed, false, '完整执行键必须包含 step，不能只比 session/task/callId')
  await assert.rejects(() => h.service.recordNativeDecision(proposal.id, { requestId: 'request-1' }, later), /会话|调用|原生/)
  await h.service.recordNativeDecision(proposal.id, { requestId: 'request-1' }, original)
  assert.equal(h.service.authorize(proposal.id, original).allowed, true)
})

test('a repeated provider call id in another turn cannot consume an earlier execution approval', async () => {
  const h = setup()
  h.contexts.captureRequest(h.exec.agent, 1, 1)
  h.exec = { ...h.exec }
  h.identity = { ...h.contexts.capture(h.exec)[1].identity }
  h.events[0].data.turn = 1
  const proposal = await propose(h)
  await h.service.recordNativeDecision(proposal.id, nativeDecision(h), h.exec)
  h.contexts.captureRequest(h.exec.agent, 2, 1)
  const later = { ...h.exec }
  h.contexts.capture(later)
  assert.equal(h.service.authorize(proposal.id, later).allowed, false, '完整执行键必须包含 turn')
})

test('native own turn metadata must match the positioned execution being approved', async () => {
  const h = setup()
  h.contexts.captureRequest(h.exec.agent, 1, 1)
  h.exec = { ...h.exec }
  h.identity = { ...h.contexts.capture(h.exec)[1].identity }
  h.events[0].data.turn = 2
  const proposal = await propose(h)
  const proof = nativeDecision(h)
  await assert.rejects(() => h.service.recordNativeDecision(proposal.id, proof, h.exec), /原生|turn|审批/)
  for (const event of h.events) h.service.observeSessionEvent(h.session, event, { inheritedEventCount: 0 })
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

test('an expired approval never grants and cannot gain a fresh expiry by reproposing', async () => {
  const h = setup(), proposal = await propose(h, { expiresAt: '2026-10-15T03:00:01.000Z' })
  await h.service.recordNativeDecision(proposal.id, nativeDecision(h), h.exec)
  h.tick(1001)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
  assert.equal((await propose(h, { expiresAt: '2026-10-16T00:00:00.000Z' })).expiresAt, proposal.expiresAt)
})

test('native audit proof is invalid in a wrong session or after a new user origin', async () => {
  const h = setup(), proposal = await propose(h)
  const proof = nativeDecision(h)
  const wrongExec = { ...h.exec, agent: { id: 'other', session: { id: 'other' } } }
  await assert.rejects(() => h.service.recordNativeDecision(proposal.id, proof, wrongExec), /会话|session|原生/)
  await h.service.recordNativeDecision(proposal.id, proof, h.exec)
  h.contexts.bindUser('owner', { id: 'new-input', source: { kind: 'user' }, content: [{ type: 'text', text: '改为处理另一件事' }] })
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

test('an old native decision and malformed audit pairs cannot be repurposed', async () => {
  for (const variant of ['old', 'wrong-tool', 'wrong-call', 'duplicate', 'between-turns', 'missing']) {
    const h = setup()
    if (variant === 'old') nativeDecision(h)
    const proposal = await propose(h)
    if (variant === 'wrong-tool') nativeDecision(h, 'allowed-once', 'request-1', { toolName: 'another' })
    else if (variant === 'wrong-call') nativeDecision(h, 'allowed-once', 'request-1', { callId: 'another' })
    else if (variant === 'duplicate') { nativeDecision(h); h.events.push({ type: 'approval/decided', data: { id: 'request-1', outcome: 'allowed-once' } }) }
    else if (variant === 'between-turns') { h.events.push({ type: 'turn/end', data: {} }); nativeDecision(h) }
    else if (variant !== 'old' && variant !== 'missing') nativeDecision(h)
    await assert.rejects(() => h.service.recordNativeDecision(proposal.id, { requestId: 'request-1' }, h.exec), /原生|审批|audit|turn|批准/)
    removeOwned(vault.STATE_HOME); removeOwned(vault.VAULT_HOME); vault.ensureVault()
  }
})

test('service reload revalidates native records and persists one-time consumption', async () => {
  const h = setup(), proposal = await propose(h), proof = nativeDecision(h)
  await h.service.recordNativeDecision(proposal.id, proof, h.exec)
  const reloaded = new approval.ActionApprovalService(h.config)
  assert.equal((await reloaded.recordNativeDecision(proposal.id, proof, h.exec)).status, 'approved')
  assert.equal(reloaded.authorize(proposal.id, h.exec).allowed, true)
  assert.equal(new approval.ActionApprovalService(h.config).authorize(proposal.id, h.exec).allowed, false)
})

test('removing or modifying a previously verified native audit prevents authorization after reload', async () => {
  const h = setup(), proposal = await propose(h), proof = nativeDecision(h)
  await h.service.recordNativeDecision(proposal.id, proof, h.exec)
  h.events[2] = { type: 'approval/decided', data: { id: proof.requestId, outcome: 'rejected' } }
  const reloaded = new approval.ActionApprovalService(h.config)
  await assert.rejects(() => reloaded.recordNativeDecision(proposal.id, proof, h.exec), /审批|原生|变化/)
  assert.equal(reloaded.authorize(proposal.id, h.exec).allowed, false)
})

test('the native gate bridge asks for bound actions and the monotonic guard verifies the result', async () => {
  const h = setup(), proposal = await propose(h)
  assert.equal(h.service.gate(h.exec).kind, 'ask')
  assert.match(h.service.guard(h.exec), /审批|批准|原生/)
  nativeDecision(h)
  for (const event of h.events) h.service.observeSessionEvent(h.session, event, { inheritedEventCount: 0 })
  assert.equal(h.service.guard(h.exec), undefined)
  assert.match(h.service.guard(h.exec), /一次|消费|used|consumed/)
  assert.equal(h.service.gate({ ...h.exec, callId: 'ordinary-local', name: 'read_file', arguments: { path: 'README.md' } }), undefined)
  assert.equal(h.service.guard({ ...h.exec, callId: 'ordinary-local', name: 'read_file', arguments: { path: 'README.md' } }), undefined)
  assert.equal(proposal.status, 'pending', '返回的提案快照不会被内部隐式改写')
})

test('without a real native session audit the bridge fails closed and identifies the missing host', async () => {
  const h = setup({ sessionQuery: undefined }), proposal = await propose(h)
  nativeDecision(h)
  const exec = { ...h.exec, agent: { id: 'owner', session: { id: 'owner' } } }
  await assert.rejects(() => h.service.recordNativeDecision(proposal.id, { requestId: 'request-1' }, exec), /宿主|原生.*不可用|host/)
  assert.equal(h.service.authorize(proposal.id, exec).allowed, false)
})

test('inherited approval events cannot authorize a child through query or live observation', async () => {
  const h = setup(), proposal = await propose(h), proof = nativeDecision(h)
  h.config.sessionQuery.readSession = async () => ({ events: structuredClone(h.events), inheritedEventCount: h.events.length })
  await assert.rejects(() => h.service.recordNativeDecision(proposal.id, proof, h.exec), /原生|审批|own|继承/)
  for (const event of h.events) h.service.observeSessionEvent(h.session, event, { inheritedEventCount: h.events.length })
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

test('a trusted live native observer verifies decisions before synchronous guard consumption', async () => {
  const h = setup({ sessionQuery: undefined })
  h.service.observeSessionEvent(h.session, h.events[0], { inheritedEventCount: 0 })
  const proposal = await propose(h)
  nativeDecision(h)
  for (const event of h.events.slice(1)) h.service.observeSessionEvent(h.session, event, { inheritedEventCount: 0 })
  assert.equal(h.service.guard(h.exec), undefined)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})
