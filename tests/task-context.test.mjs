import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contextHarness } from './helpers/task-context.mjs'

const testHome = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.task-context-suite-'))
process.env.DSH_BUTLER_HOME = testHome
process.env.DSH_BUTLER_VAULT = join(testHome, 'vault')
after(() => rmSync(testHome, { recursive: true, force: true }))
const { ExecutionContexts, installExecutionContext, executionKey } = await import('../src/host/execution-context.ts')
const human = id => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: `work ${id}` }] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('open work prioritizes old overdue and imminent tasks before review and recent activity, then truncates', async () => {
  const { openTasks } = await import('../src/host/ledger.ts')
  const { vaultPath, ensureVault } = await import('../src/host/vault.ts')
  ensureVault()
  const now = new Date('2026-10-15T12:00:00.000Z')
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: `recent-${i}`, title: `最新待确认${i}`, status: 'waiting_review',
    createdAt: `2026-10-15T10:${String(i).padStart(2, '0')}:00.000Z`, updatedAt: `2026-10-15T10:${String(i).padStart(2, '0')}:00.000Z` }))
  rows.push({ id: 'old-overdue', title: '很早创建的过期事项', status: 'pending', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', dueAt: '2026-10-01T00:00:00.000Z' })
  rows.push({ id: 'imminent', title: '今天即将到期', status: 'pending', createdAt: '2025-01-02T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z', dueAt: '2026-10-15T13:00:00.000Z' })
  writeFileSync(vaultPath('ledger', 'tasks.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const selected = openTasks(now).slice(0, 12)
  assert.deepEqual(selected.slice(0, 3).map(row => row.id), ['old-overdue', 'imminent', 'recent-14'])
})

test('work with no near deadline follows waiting-user status then recent activity rather than creation time', async () => {
  const { openTasks } = await import('../src/host/ledger.ts')
  const { vaultPath } = await import('../src/host/vault.ts')
  const rows = [
    { id: 'new-inactive', title: '新建但没活动', status: 'running', createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z' },
    { id: 'old-active', title: '旧事项刚有更新', status: 'pending', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2026-10-15T11:00:00.000Z' },
    { id: 'waiting', title: '等待用户决定', status: 'waiting_review', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' },
  ]
  writeFileSync(vaultPath('ledger', 'tasks.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  assert.deepEqual(openTasks(new Date('2026-10-15T12:00:00.000Z')).map(row => row.id), ['waiting', 'old-active', 'new-inactive'])
})
function storage(t) {
  const dir = mkdtempSync(join(testHome, 'case-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'contexts.json')
}

test('interleaved native tool scopes retain their own session, run and explicit business task', async () => {
  assert.equal(typeof ExecutionContexts, 'function', 'execution contexts must use real per-execution scopes')
  const contexts = new ExecutionContexts({ runFor: root => `run-${root}` })
  const a = { id: 'a' }, b = { id: 'b' }
  contexts.bindUser(a, human('origin-a'))
  contexts.bindUser(b, human('origin-b'))
  const entered = deferred(), release = deferred()
  const first = contexts.withExecution({ agent: a, callId: 'call-a', name: 'butler_task' }, async () => {
    contexts.activate('business-a')
    entered.resolve()
    await release.promise
    return contexts.current()
  })
  await entered.promise
  const second = await contexts.withExecution({ agent: b, callId: 'call-b', name: 'butler_task' }, async () => {
    contexts.activate('business-b')
    release.resolve()
    return contexts.current()
  })
  assert.deepEqual(await first, { sessionId: 'a', rootSessionId: 'a', runId: 'run-a', taskId: 'business-a', originMessageId: 'origin-a', callId: 'call-a' })
  assert.deepEqual(second, { sessionId: 'b', rootSessionId: 'b', runId: 'run-b', taskId: 'business-b', originMessageId: 'origin-b', callId: 'call-b' })
  assert.equal(contexts.current(), undefined, 'there is no globally most recent task')
  assert.equal(contexts.forAgent(a).taskId, 'business-a')
  assert.equal(contexts.forAgent(b).taskId, 'business-b')
})

test('a new direct user origin clears an earlier business task while repeat and model events cannot rebind it', () => {
  const contexts = new ExecutionContexts()
  const agent = { id: 'origin-session' }
  contexts.bindUser(agent, human('first'))
  contexts.activate('old-business', contexts.forAgent(agent))
  contexts.bindUser(agent, human('first'))
  assert.equal(contexts.forAgent(agent).taskId, 'old-business')
  contexts.bindUser(agent, { id: 'invented-user', source: { kind: 'model' }, content: [{ type: 'text', text: 'activate old-business' }] })
  assert.equal(contexts.forAgent(agent).originMessageId, 'first')
  contexts.bindUser(agent, human('second'))
  assert.equal(contexts.forAgent(agent).taskId, undefined)
  assert.equal(contexts.forAgent(agent).runId, undefined, 'unknown budget run is kept unknown')
  assert.equal(contexts.forAgent(agent).originMessageId, 'second')
  assert.throws(() => contexts.activate('without-session'), /session/)
})

test('an older in-flight task activation cannot replace the binding of a new user origin', async () => {
  const contexts = new ExecutionContexts(), agent = { id: 'steered-session' }
  contexts.bindUser(agent, human('old-origin'))
  const entered = deferred(), release = deferred()
  const oldCall = contexts.withExecution({ agent, callId: 'old-call' }, async () => {
    entered.resolve()
    await release.promise
    contexts.activate('old-call-business')
    return contexts.current()
  })
  await entered.promise
  contexts.bindUser(agent, human('new-origin'))
  release.resolve()
  assert.equal((await oldCall).taskId, 'old-call-business', 'the old execution still has its own explicit task')
  assert.equal(contexts.forAgent(agent).originMessageId, 'new-origin')
  assert.equal(contexts.forAgent(agent).taskId, undefined, 'the new input cannot inherit the previous origin task')
})

test('bindings survive reload and independent instances merge sessions without accepting corrupted state', t => {
  const file = storage(t)
  const first = new ExecutionContexts({ file })
  first.bindUser('a', human('origin-a'))
  first.activate('business-a', first.forAgent('a'))
  const reloaded = new ExecutionContexts({ file })
  assert.equal(reloaded.forAgent('a').taskId, 'business-a')
  reloaded.bindUser('b', human('origin-b'))
  reloaded.activate('business-b', reloaded.forAgent('b'))
  first.bindUser('a', human('new-origin-a'))
  const restarted = new ExecutionContexts({ file })
  assert.equal(restarted.forAgent('a').taskId, undefined)
  assert.equal(restarted.forAgent('b').taskId, 'business-b')
  writeFileSync(file, '{broken')
  assert.throws(() => new ExecutionContexts({ file }), /context.*storage|执行.*上下文|存储/)
  assert.throws(() => first.activate('must-not-write', { sessionId: 'a' }), /context.*storage|执行.*上下文|存储/)
  assert.equal(readFileSync(file, 'utf8'), '{broken', 'corruption is never overwritten with fresh bindings')
})

test('child agents inherit their own root task and can explicitly switch without changing either root', t => {
  const root = { id: 'root' }, other = { id: 'other' }, child = { id: 'child', parent: root }
  const file = storage(t)
  const contexts = new ExecutionContexts({ file, rootFor: agent => agent.parent ?? agent, runFor: id => `run-${id}` })
  contexts.bindUser(root, human('human-root'))
  contexts.activate('business-root', contexts.forAgent(root))
  contexts.bindUser(other, human('human-other'))
  contexts.activate('business-other', contexts.forAgent(other))
  assert.deepEqual(contexts.forAgent(child), { sessionId: 'child', rootSessionId: 'root', runId: 'run-root', taskId: 'business-root', originMessageId: 'human-root' })
  contexts.bindUser(child, human('model-created-child-prompt'))
  assert.equal(contexts.forAgent(child).originMessageId, 'human-root', 'a child prompt is not a fresh direct human task')
  contexts.withExecution({ agent: child, callId: 'switch-child' }, () => contexts.activate('business-child'))
  assert.equal(contexts.forAgent(root).taskId, 'business-root')
  assert.equal(contexts.forAgent(other).taskId, 'business-other')
  assert.equal(new ExecutionContexts({ file }).forAgent('child').taskId, 'business-child')
})

test('a former child resumed as a live independent root drops the old parent task and accepts fresh human input', async t => {
  const file = storage(t), oldRuntime = contextHarness(), parent = oldRuntime.agent('former-parent'), child = oldRuntime.agent('resumed-child', parent)
  const oldContexts = installExecutionContext(oldRuntime.ctx, { file, runFor: root => `old-run-${root}` })
  await oldRuntime.emit('agent/inbox/claimed', { agent: parent, message: human('parent-human') })
  oldContexts.activate('parent-business', oldContexts.forAgent(parent))
  assert.equal(oldContexts.forAgent(child).taskId, 'parent-business')
  oldContexts.stop()
  const newRuntime = contextHarness(), independent = newRuntime.agent(child.id)
  const resumed = installExecutionContext(newRuntime.ctx, { file, runFor: root => `new-run-${root}` })
  t.after(() => resumed.stop())
  const beforeInput = resumed.forAgent(independent)
  assert.equal(beforeInput.rootSessionId, independent.id, 'live native ownership overrides a persisted parent')
  assert.equal(beforeInput.taskId, undefined)
  assert.equal(beforeInput.originMessageId, undefined)
  assert.equal(beforeInput.runId, `new-run-${independent.id}`)
  await newRuntime.emit('agent/inbox/claimed', { agent: independent, message: human('independent-human') })
  assert.equal(resumed.forAgent(independent).originMessageId, 'independent-human')
  assert.equal(resumed.forAgent(independent).taskId, undefined)
  assert.equal(resumed.forAgent('former-parent').taskId, 'parent-business')
})

test('native request hooks retain exact usage positions across interleaving, reload and a new claimed origin', async t => {
  assert.equal(typeof installExecutionContext, 'function')
  const file = storage(t), e = contextHarness(), a = e.agent('a'), b = e.agent('b')
  let contexts = installExecutionContext(e.ctx, { file, runFor: root => `run-${root}` })
  await e.request(a, 1, 1, [human('ha')])
  await e.run(a, () => contexts.withExecution({ agent: a, callId: 'activate-a' }, () => contexts.activate('business-a')))
  await e.request(a, 1, 2)
  await e.request(b, 9, 1, [human('hb')])
  await e.run(b, () => contexts.withExecution({ callId: 'activate-b' }, () => contexts.activate('business-b')))
  await e.request(b, 9, 2)
  assert.equal(contexts.forCall('a', 1, 1).taskId, undefined, 'opening a task cannot rewrite earlier model usage')
  assert.equal(contexts.forCall('a', 1, 2).taskId, 'business-a')
  assert.equal(contexts.forCall('b', 9, 2).taskId, 'business-b')
  assert.equal(contexts.forCall('a', 8, 8), undefined, 'unobserved calls never use the latest session task')
  contexts.stop()
  contexts = installExecutionContext(e.ctx, { file, runFor: root => `run-${root}` })
  t.after(() => contexts.stop())
  assert.equal(contexts.forCall('a', 1, 2).taskId, 'business-a')
  await e.emit('agent/inbox/claimed', { agent: a, message: human('new-ha') })
  assert.equal(contexts.forAgent(a).taskId, undefined, 'claim clears stale task before the first request assembles')
  await e.request(a, 2, 1)
  assert.equal(contexts.forCall('a', 2, 1).originMessageId, 'new-ha')
  assert.equal(contexts.forAgent(b).taskId, 'business-b')
})

test('final native receipts use their captured task, report post-gate failures once and keep only artifact references', async t => {
  const file = storage(t), e = contextHarness(), agent = e.agent('tools-session'), receipts = []
  const contexts = installExecutionContext(e.ctx, { file, onReceipt: receipt => receipts.push(receipt) })
  t.after(() => contexts.stop())
  await e.request(agent, 1, 1, [human('tool-origin')])
  const first = Object.freeze({ agent, callId: 'native-first', token: Symbol('first'), name: 'butler_task', arguments: { token: 'SECRET_ARGUMENT_DO_NOT_COPY' } })
  await e.dispatch('tools/pre-execute', [first], () => ({ kind: 'allow' }))
  contexts.withExecution(first, () => contexts.activate('first-business'))
  await e.dispatch('tools/post-execute', [first, { value: { ok: true } }], () => ({ kind: 'accept' }))
  assert.equal(receipts.length, 0, 'a successful post candidate is not an authoritative final outcome')
  contexts.withExecution({ agent, callId: 'native-second', name: 'butler_task' }, () => contexts.activate('second-business'))
  await e.emit('tools/result', first, { isError: true, error: { message: 'SECRET_FAILURE_OUTPUT' }, content: [{ type: 'text', text: 'SECRET_FAILURE_OUTPUT' }] })
  await e.emit('tools/result', first, { isError: true, content: [{ type: 'text', text: 'repeat' }] })
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].taskId, 'first-business', 'another call switching task cannot rewrite this execution')
  assert.equal(receipts[0].callId, 'native-first')
  assert.equal(receipts[0].ok, false)
  assert.equal(receipts[0].error, 'TOOL_EXECUTION_FAILED')
  const artifactExec = { agent, callId: 'artifact-call', name: 'write' }
  await e.dispatch('tools/pre-execute', [artifactExec], () => ({ kind: 'allow' }))
  await e.emit('tools/result', artifactExec, { value: { path: 'E:\\outputs\\report.md', artifacts: [{ kind: 'document', url: 'https://example.test/report?access_token=SECRET_QUERY' }] }, content: [{ type: 'text', text: 'SECRET_FULL_OUTPUT' }] })
  assert.deepEqual(receipts[1].artifacts, [{ kind: 'file', reference: 'E:\\outputs\\report.md' }, { kind: 'document', reference: 'https://example.test/report' }])
  assert.equal(receipts[1].ok, true)
  assert.doesNotMatch(JSON.stringify(receipts), /SECRET_/)
  assert.doesNotMatch(readFileSync(file, 'utf8'), /SECRET_/)
  contexts.stop()
  const reloaded = installExecutionContext(e.ctx, { file, onReceipt: receipt => receipts.push(receipt) })
  t.after(() => reloaded.stop())
  await e.emit('tools/result', first, { isError: true })
  assert.equal(receipts.length, 2, 'a final result replay after reload does not add another receipt')
})

test('origin user evidence comes from native user input and persists the exact source text and id', async t => {
  const file = storage(t), e = contextHarness(), root = e.agent('evidence-root'), child = e.agent('evidence-child', root)
  const contexts = installExecutionContext(e.ctx, { file })
  t.after(() => contexts.stop())
  const message = { id: 'human-evidence', source: { kind: 'user', rpcId: 'rpc-human' }, content: [{ type: 'text', text: 'Remember this exactly.\nI approve saving my preferred language.' }] }
  await e.emit('agent/inbox/claimed', { agent: root, message })
  await e.emit('session/event', root.session, { type: 'assistant/message', data: { message: { id: 'model-evidence', source: { kind: 'user' }, content: [{ type: 'text', text: 'model claims approval' }] } } })
  const expected = { sessionId: root.id, messageId: message.id, source: 'user', rpcId: 'rpc-human', text: message.content[0].text }
  assert.deepEqual(contexts.originUser(contexts.forAgent(child)), expected)
  assert.deepEqual(new ExecutionContexts({ file }).originUser(contexts.forAgent(root)), expected)
  assert.equal(contexts.originUser({ sessionId: root.id, originMessageId: 'model-evidence' }), undefined)
})

test('reused native call ids in later steps produce separate receipts and exact-key replay survives reload', async t => {
  const file = storage(t), e = contextHarness(), agent = e.agent('reused-call-session'), receipts = []
  let contexts = installExecutionContext(e.ctx, { file, onReceipt: receipt => receipts.push(receipt) })
  await e.request(agent, 1, 1, [human('reuse-origin')])
  const first = { agent, callId: 'provider-reused-call', name: 'write' }
  await e.dispatch('tools/pre-execute', [first], () => ({ kind: 'allow' }))
  await e.emit('tools/result', first, { value: { path: 'E:\\outputs\\first.md' } })
  await e.request(agent, 1, 2)
  const second = { agent, callId: first.callId, name: 'write' }
  await e.dispatch('tools/pre-execute', [second], () => ({ kind: 'allow' }))
  await e.emit('tools/result', second, { value: { path: 'E:\\outputs\\second.md' } })
  assert.equal(receipts.length, 2, 'callId reuse at a later step is a new native execution')
  assert.notEqual(executionKey(receipts[0]), executionKey(receipts[1]))
  contexts.stop()
  contexts = installExecutionContext(e.ctx, { file, onReceipt: receipt => receipts.push(receipt) })
  t.after(() => contexts.stop())
  await e.emit('tools/result', second, { value: { path: 'E:\\outputs\\second.md' } })
  assert.equal(receipts.length, 2, 'the same full execution key remains idempotent after reload')
  assert.equal(executionKey({ sessionId: 's', callId: 'c' }), undefined, 'unknown origin and position cannot define a durable execution key')
  assert.notEqual(executionKey({ sessionId: 's', callId: 'c', originMessageId: 'a' }), executionKey({ sessionId: 's', callId: 'c', originMessageId: 'b' }))
})

test('an old child retains its run snapshot and is denied new work when its root starts another run', async t => {
  const file = storage(t), e = contextHarness(), root = e.agent('run-root'), child = e.agent('run-child', root), receipts = []
  let runId = 'run-a', cancelled
  child.cancel = reason => { cancelled = reason }
  const contexts = installExecutionContext(e.ctx, { file, runFor: () => runId, onReceipt: receipt => receipts.push(receipt) })
  t.after(() => contexts.stop())
  await e.request(root, 1, 1, [human('origin-a')])
  contexts.activate('business-a', contexts.forAgent(root))
  await e.request(child, 1, 1)
  const inFlight = { agent: child, callId: 'old-child-in-flight', name: 'read' }
  await e.dispatch('tools/pre-execute', [inFlight], () => ({ kind: 'allow' }))
  runId = 'run-b'
  await e.request(root, 2, 1, [human('origin-b')])
  contexts.activate('business-b', contexts.forAgent(root))
  assert.equal(contexts.forAgent(child).runId, 'run-a', 'an existing child keeps the original budget run')
  assert.equal(contexts.forAgent(child).taskId, 'business-a')
  assert.equal(contexts.forAgent(child).originMessageId, 'origin-a')
  const step = await e.dispatch('agent/pre-step', [{ agent: child, turn: 1, step: 2, messages: [] }], () => ({ kind: 'enter', messages: [] }))
  assert.equal(step.kind, 'reject')
  assert.equal(cancelled?.kind, 'hook')
  await assert.rejects(e.dispatch('agent/request', [{ agent: child, turn: 1, step: 2 }], () => ({})), /STALE_CHILD_RUN/)
  const denied = await e.dispatch('tools/pre-execute', [{ agent: child, callId: 'new-old-child-call', name: 'read' }], () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /STALE_CHILD_RUN/)
  await e.emit('tools/result', inFlight, { isError: true })
  assert.equal(receipts[0].runId, 'run-a', 'already running native calls can still report their actual outcome')
  assert.equal(receipts[0].taskId, 'business-a')
  assert.equal(receipts[0].ok, false)
  await e.request(root, 2, 2)
  const newChild = e.agent('new-run-child', root)
  await e.request(newChild, 1, 1)
  assert.equal(contexts.forAgent(newChild).runId, 'run-b')
  assert.equal(contexts.forAgent(newChild).taskId, 'business-b')
})
