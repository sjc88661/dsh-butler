import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'tool-context-integration-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { registerButlerTools } = await import('../src/host/tools.ts')
const { receipts, getTask, addReceipt } = await import('../src/host/ledger.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')

function environment() {
  assert.equal(typeof ExecutionContexts, 'function', 'execution attribution must be implemented')
  const contexts = new ExecutionContexts({ file: join(home, 'state', `${crypto.randomUUID()}.json`), runFor: id => `run:${id}`, onReceipt: addReceipt })
  const registered = new Map()
  registerButlerTools({ tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } } }, {
    timeZone: 'Asia/Shanghai', mailto: 'test@localhost',
    sessionId: () => contexts.current()?.sessionId ?? 'unknown',
    currentTaskId: () => contexts.current()?.taskId,
    executionContext: contexts,
  })
  const agent = id => ({ id, session: { id } })
  const call = (a, name, args, id = crypto.randomUUID()) => registered.get(name).execute(args, { agent: a, id, name, arguments: args })
  return { contexts, agent, call, registered }
}

test('real butler task and note calls carry their own task, session, call, and output artifact', async () => {
  const e = environment(), a = e.agent('tool-context-A'), b = e.agent('tool-context-B')
  e.contexts.bindUser(a, { id: 'human-A', source: { kind: 'user' } })
  e.contexts.bindUser(b, { id: 'human-B', source: { kind: 'user' } })
  const first = await e.call(a, 'butler_task', { action: 'open', title: 'Task A' }, 'open-A')
  const second = await e.call(b, 'butler_task', { action: 'open', title: 'Task B' }, 'open-B')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(e.contexts.forAgent(a).taskId, first.task.id)
  assert.equal(e.contexts.forAgent(b).taskId, second.task.id)
  const output = await e.call(a, 'butler_note', { action: 'write', slug: 'attributed-note', title: 'Output A', markdown: 'Local output for A' }, 'note-A')
  assert.equal(output.ok, true)
  const row = receipts(100).find(r => r.callId === 'note-A')
  assert.ok(row, 'the real call should leave an identified receipt')
  assert.equal(row.taskId, first.task.id)
  assert.equal(row.sessionId, a.id)
  assert.equal(row.runId, `run:${a.id}`)
  assert.equal(row.originMessageId, 'human-A')
  assert.ok(row.artifacts?.length > 0, 'note output must be discoverable from its receipt')
  assert.equal(receipts(100).filter(r => r.callId === 'note-A').length, 1)
})

test('explicit task activation selects an existing business task without changing the budget run', async () => {
  const e = environment(), a = e.agent('activate-session')
  e.contexts.bindUser(a, { id: 'activate-human', source: { kind: 'user' } })
  const one = await e.call(a, 'butler_task', { action: 'open', title: 'First target' })
  const two = await e.call(a, 'butler_task', { action: 'open', title: 'Second target' })
  const result = await e.call(a, 'butler_task', { action: 'activate', id: one.task.id }, 'activate-call')
  assert.equal(result.ok, true)
  assert.equal(e.contexts.forAgent(a).taskId, one.task.id)
  assert.equal(e.contexts.forAgent(a).runId, 'run:activate-session')
  assert.notEqual(one.task.id, two.task.id)
  assert.equal(getTask(one.task.id).status, 'pending')
})

test('a failed real tool call remains associated with the current task', async () => {
  const e = environment(), a = e.agent('failed-tool-session')
  e.contexts.bindUser(a, { id: 'failure-human', source: { kind: 'user' } })
  const opened = await e.call(a, 'butler_task', { action: 'open', title: 'Fail visibly' })
  const result = await e.call(a, 'butler_note', { action: 'read', slug: 'does-not-exist' }, 'failed-read')
  assert.equal(result.ok, false)
  const row = receipts(100).find(r => r.callId === 'failed-read')
  assert.ok(row)
  assert.equal(row.ok, false)
  assert.equal(row.taskId, opened.task.id)
})

test('replaying a task open call does not create a second business task', async () => {
  const e = environment(), a = e.agent('replay-session')
  e.contexts.bindUser(a, { id: 'replay-human', source: { kind: 'user' } })
  const first = await e.call(a, 'butler_task', { action: 'open', title: 'Only one task' }, 'same-open')
  const again = await e.call(a, 'butler_task', { action: 'open', title: 'Only one task' }, 'same-open')
  assert.equal(again.ok, true)
  assert.equal(first.task.id, again.task.id)
})

test('the same provider callId in a later model step creates a different business task', async () => {
  const e = environment(), a = e.agent('step-reuse-session')
  e.contexts.bindUser(a, { id: 'step-reuse-human', source: { kind: 'user' } })
  e.contexts.captureRequest(a, 1, 1)
  const first = await e.call(a, 'butler_task', { action: 'open', title: 'Step one' }, 'provider-reused-id')
  e.contexts.captureRequest(a, 1, 2)
  const later = await e.call(a, 'butler_task', { action: 'open', title: 'Step two' }, 'provider-reused-id')
  assert.equal(first.ok, true)
  assert.equal(later.ok, true)
  assert.notEqual(first.task.id, later.task.id)
})

test('a terminal task can only reopen after a fresh human work input', async () => {
  const e = environment(), a = e.agent('transition-session')
  e.contexts.bindUser(a, { id: 'transition-human-1', source: { kind: 'user' } })
  const opened = await e.call(a, 'butler_task', { action: 'open', title: 'Explicit reopening' })
  await e.call(a, 'butler_task', { action: 'update', id: opened.task.id, status: 'cancelled' })
  const automatic = await e.call(a, 'butler_task', { action: 'update', id: opened.task.id, status: 'running' })
  assert.equal(automatic.ok, false)
  assert.equal(getTask(opened.task.id).status, 'cancelled')
  e.contexts.bindUser(a, { id: 'transition-human-2', source: { kind: 'user' } })
  const reopened = await e.call(a, 'butler_task', { action: 'update', id: opened.task.id, status: 'running' })
  assert.equal(reopened.ok, true)
  assert.equal(getTask(opened.task.id).status, 'running')
})

test('completion under a later human origin cannot reopen itself in the same continuation', async () => {
  const e = environment(), a = e.agent('completed-transition-session')
  e.contexts.bindUser(a, { id: 'completed-human-A', source: { kind: 'user' } })
  const opened = await e.call(a, 'butler_task', { action: 'open', title: 'Completed in a later turn' })
  e.contexts.bindUser(a, { id: 'completed-human-B', source: { kind: 'user' } })
  await e.call(a, 'butler_task', { action: 'activate', id: opened.task.id })
  const output = await e.call(a, 'butler_note', { action: 'write', slug: 'completed-in-later-turn', markdown: 'Actual completion output' })
  const done = await e.call(a, 'butler_task', { action: 'update', id: opened.task.id, status: 'done', evidenceIds: output.evidenceIds })
  assert.equal(done.ok, true)
  const reopened = await e.call(a, 'butler_task', { action: 'update', id: opened.task.id, status: 'running' })
  assert.equal(reopened.ok, false)
  assert.equal(getTask(opened.task.id).status, 'done')
})

test('the butler wrapper preserves the exact native execution while a new user origin arrives', async () => {
  const e = environment(), a = e.agent('held-execution-session')
  e.contexts.bindUser(a, { id: 'held-human-A', source: { kind: 'user' } })
  const opened = await e.call(a, 'butler_task', { action: 'open', title: 'Held execution' })
  const exec = { agent: a, callId: 'held-native-call', name: 'butler_note' }
  e.contexts.withExecution(exec, () => undefined)
  e.contexts.bindUser(a, { id: 'held-human-B', source: { kind: 'user' } })
  const output = await e.registered.get('butler_note').execute({ action: 'write', slug: 'held-note', title: 'Held', markdown: 'Captured old task' }, exec)
  assert.equal(output.ok, true)
  const row = receipts(100).find(r => r.callId === exec.callId)
  assert.equal(row.taskId, opened.task.id)
  assert.equal(row.originMessageId, 'held-human-A')
  assert.equal(e.contexts.forAgent(a).taskId, undefined)
})

test('an older captured task call cannot reopen a task ended by the current human origin', async () => {
  const e = environment(), a = e.agent('old-reopen-session')
  e.contexts.bindUser(a, { id: 'old-reopen-A', source: { kind: 'user' } })
  const opened = await e.call(a, 'butler_task', { action: 'open', title: 'Keep the newer decision' })
  const exec = { agent: a, callId: 'older-reopen-call', name: 'butler_task' }
  e.contexts.withExecution(exec, () => undefined)
  e.contexts.bindUser(a, { id: 'old-reopen-B', source: { kind: 'user' } })
  await e.call(a, 'butler_task', { action: 'update', id: opened.task.id, status: 'cancelled' })
  const old = await e.registered.get('butler_task').execute({ action: 'update', id: opened.task.id, status: 'running' }, exec)
  assert.equal(old.ok, false)
  assert.equal(getTask(opened.task.id).status, 'cancelled')
})
