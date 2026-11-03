import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'workflow-runtime-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { ensureVault, PROFILE_FILE } = await import('../src/host/vault.ts')
const { upsertTask } = await import('../src/host/ledger.ts')
ensureVault()
const { installBusinessWorkflows } = await import('../src/host/workflow-runtime.ts').catch(() => ({}))

function environment(noGuard = false, settings = {}) {
  assert.equal(typeof installBusinessWorkflows, 'function', 'native workflow integration must exist')
  const hooks = new Map(), guards = []
  const contexts = new ExecutionContexts({ file: join(home, 'state', `${crypto.randomUUID()}.json`), runFor: id => `run:${id}` })
  const ctx = { on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name) },
    tools: noGuard ? {} : { guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) } }, get(name) { if (name === 'agents') return { list: () => settings.agents ?? [] } }, logger: { warn() {} } }
  const filePrefix = crypto.randomUUID()
  const workflows = installBusinessWorkflows(ctx, { contexts, timeZone: 'Asia/Shanghai', filePrefix, schedule: () => settings.schedule,
    appliesTo: settings.appliesTo, destination: settings.destination ?? (async () => { throw Error('not used') }) })
  const a = { id: `runtime-${crypto.randomUUID()}`, session: { inheritedEventCount: 0 } }
  contexts.bindUser(a, { id: 'trusted-user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Perform the requested task' }] })
  const task = upsertTask(`runtime-task-${crypto.randomUUID()}`, { title: 'Native execution' })
  contexts.activate(task.id, contexts.forAgent(a))
  const execute = (callId, args = { to: 'owner', body: 'Reviewed content' }) => ({ agent: a, callId, name: 'send_email', arguments: args })
  const event = (seq, type, data) => hooks.get('session/event')({ id: a.id, inheritedEventCount: 0 }, { type, seq, time: Date.now(), data })
  return { contexts, workflows, a, task, guards, hooks, execute, event, actionFile: join(home, 'state', `${filePrefix}-action-approvals.json`) }
}

test('native ask binds exact arguments and only a verified own allowed-once event passes the final guard', async () => {
  const e = environment(), exec = e.execute('native-action')
  const gate = await e.hooks.get('tools/pre-execute')(exec, async () => ({ kind: 'ask', reason: 'Host permission' }))
  assert.equal(gate.kind, 'ask')
  e.event(0, 'turn/start', { turn: 1 })
  e.event(1, 'approval/asked', { id: 'native-grant', toolName: exec.name, callId: exec.callId })
  e.event(2, 'approval/decided', { id: 'native-grant', outcome: 'allowed-once' })
  assert.equal(e.guards[0](exec), undefined)
  assert.match(e.guards[0](exec), /消费|执行|批准|授权/)
  e.workflows.stop()
  assert.equal(e.guards.length, 0)
})

test('unbound host policy is preserved and a missing monotonic guard cannot grant a business action', async () => {
  const e = environment(true), exec = e.execute('no-guard')
  const allow = await e.hooks.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
  assert.equal(allow.kind, 'allow')
  const ask = await e.hooks.get('tools/pre-execute')(exec, async () => ({ kind: 'ask', reason: 'Host permission' }))
  assert.equal(ask.kind, 'deny')
})

test('the final native result hook applies a real memory answer and confirms native receipt evidence', () => {
  const e = environment()
  const saved = e.workflows.memory.remember(`runtime-fact-${e.a.id}`, { identity: e.contexts.forAgent(e.a) })
  const exec = { agent: e.a, callId: 'native-memory', name: 'ask_user_question', arguments: { questions: [saved.proposal.question] } }
  e.hooks.get('tools/result')(exec, { value: { answers: [{ id: saved.proposal.question.id, selected: ['确认记住'] }] } })
  assert.ok(readFileSync(PROFILE_FILE(), 'utf8').includes(saved.memo.text))
  const work = { agent: e.a, callId: 'native-success', name: 'run_command', arguments: { command: 'local work' } }
  e.hooks.get('tools/result')(work, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'actual native output' }] })
  const evidence = e.workflows.evidence.listForTask(e.task.id)
  assert.ok(evidence.some(row => row.kind === 'receipt' && row.source_url === 'tool:run_command'))
})

test('a genuine schedule delivery binds the isolated reminder task while preserving its separate run', async () => {
  const destination = `session-butler-reminder-${crypto.randomUUID()}`
  const e = environment(false, { destination: async () => destination,
    schedule: { async create() { return { id: 'delivered-rule', scheduledAt: '2026-10-16T10:00:00+08:00' } } } })
  const create = { agent: e.a, callId: 'create-delivery', name: 'butler_remind', arguments: {} }
  const made = await e.contexts.withExecution(create, () => e.workflows.reminderOperations.create({ identity: e.contexts.current(),
    reminder: { title: 'Task-linked delivery', prompt: 'Read a local result', at: '2026-10-16T10:00:00+08:00', timeZone: 'Asia/Shanghai' } }))
  const target = { id: destination, session: { inheritedEventCount: 0 } }
  e.contexts.bindUser(target, { id: 'old-human-in-reminder', source: { kind: 'user' }, content: [{ type: 'text', text: 'Old independent input' }] })
  e.contexts.activate(e.task.id, e.contexts.forAgent(target))
  const message = { id: 'trusted-schedule-message', source: { kind: 'schedule', scheduleId: made.reminder.id }, content: [{ type: 'text', text: 'Read a local result' }] }
  e.hooks.get('session/event')({ id: destination, inheritedEventCount: 0 }, { type: 'user/message', seq: 1, time: Date.now(), data: message })
  await e.hooks.get('agent/pre-step')({ agent: target, messages: [message] }, async () => ({ kind: 'continue', messages: [message] }))
  const identity = e.contexts.forAgent(target)
  assert.equal(identity.taskId, made.task.id)
  assert.equal(identity.runId, `run:${destination}`)
  assert.notEqual(identity.runId, e.contexts.forAgent(e.a).runId)
  assert.equal(e.contexts.originUser(identity), undefined, 'scheduler text is never human approval')
  e.contexts.captureRequest(target, 1, 1)
  const exec = { agent: target, callId: 'reminder-read', name: 'read', arguments: {} }
  e.hooks.get('tools/result')(exec, { value: { text: 'actual read' }, isError: false })
  assert.ok(e.workflows.evidence.listForTask(made.task.id).some(row => row.kind === 'receipt'))
  assert.equal(e.contexts.forCall(destination, 1, 1).taskId, made.task.id)
})

test('a different schedule ID in the claimed inbox cannot inherit another rule task', async () => {
  const destination = `session-butler-reminder-${crypto.randomUUID()}`
  const e = environment(false, { destination: async () => destination, schedule: { async create() { return { id: 'expected-rule' } } } })
  const create = { agent: e.a, callId: 'create-expected', name: 'butler_remind', arguments: {} }
  await e.contexts.withExecution(create, () => e.workflows.reminderOperations.create({ identity: e.contexts.current(),
    reminder: { title: 'Expected rule', prompt: 'Expected input', at: '2026-10-16T10:00:00+08:00', timeZone: 'Asia/Shanghai' } }))
  const target = { id: destination, session: { inheritedEventCount: 0 } }
  const message = { id: 'unrelated-delivery', source: { kind: 'schedule', scheduleId: 'another-rule' } }
  await e.hooks.get('agent/pre-step')({ agent: target, messages: [message] }, async () => ({ kind: 'continue', messages: [message] }))
  assert.equal(e.contexts.forAgent(target).taskId, undefined)
})

test('corrupt action approval state blocks bound actions while ordinary native reads retain host policy', async () => {
  const e = environment(), bound = e.execute('corrupt-bound')
  const decision = await e.hooks.get('tools/pre-execute')(bound, async () => ({ kind: 'ask', reason: 'Host permission' }))
  assert.equal(decision.kind, 'ask')
  writeFileSync(e.actionFile, '{broken')
  assert.equal(e.guards[0]({ agent: e.a, callId: 'ordinary-read', name: 'read', arguments: {} }), undefined)
  assert.match(e.guards[0](bound), /核验失败|未执行/)
  assert.equal(readFileSync(e.actionFile, 'utf8'), '{broken')
})

for (const id of ['external', 'external-child']) test(`workflow hooks bypass ${id} even with historical task bindings and failed results`, async () => {
  const external = { id }, agents = [external]
  const e = environment(false, { agents, appliesTo: agent => agent.id.startsWith('runtime-') })
  agents.push(e.a)
  e.contexts.bindUser(external, { id: 'old', source: { kind: 'user' } })
  e.contexts.activate(e.task.id, e.contexts.forAgent(external))
  const exec = { agent: external, callId: 'outside', name: 'send_email', arguments: {} }
  const before = e.contexts.status(), native = { kind: 'ask', reason: 'native approval' }
  assert.equal(await e.hooks.get('tools/pre-execute')(exec, async () => native), native)
  assert.equal(e.guards[0](exec), undefined)
  e.hooks.get('tools/result')(exec, { isError: true })
  await assert.rejects(e.hooks.get('tools/pre-execute')(exec, async () => { throw Error('native failure') }), /native failure/)
  const step = { kind: 'continue', messages: [] }
  assert.equal(await e.hooks.get('agent/pre-step')({ agent: external, messages: [] }, async () => step), step)
  e.hooks.get('session/event')({ id }, { type: 'user/message', data: { id: 'new', source: { kind: 'user' } } })
  e.hooks.get('session/event')({ id: 'missing' }, { type: 'user/message', data: {} })
  assert.deepEqual(e.contexts.status(), before)
  assert.deepEqual(e.workflows.evidence.listForTask(e.task.id), [])
  const managed = e.execute('managed-failure')
  e.hooks.get('tools/result')(managed, { isError: true })
  assert.equal(e.contexts.status().executions, before.executions + 1)
  e.workflows.stop()
})

test('a previously bound native guard stops applying when its live agent leaves the butler scope', async () => {
  let enabled = true
  const e = environment(false, { appliesTo: () => enabled })
  const exec = e.execute('old-bound')
  assert.equal((await e.hooks.get('tools/pre-execute')(exec, async () => ({ kind: 'ask' }))).kind, 'ask')
  enabled = false
  writeFileSync(e.actionFile, '{broken')
  assert.equal(e.guards[0](exec), undefined, 'historical native binding must not activate external action checks')
  const before = e.contexts.status()
  e.hooks.get('tools/result')(exec, { isError: true })
  assert.deepEqual(e.contexts.status(), before)
  e.workflows.stop()
})
