import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Only native carrier services are substituted. All business state, tools,
// final-result hooks, budgets, evidence, memory and read APIs are production code.
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const fixture = mkdtempSync(join(base, 'workflow-'))
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
const { ensureVault, statePath, PROFILE_FILE, readText } = await import('../src/host/vault.ts')
const { addReceipt, getTask } = await import('../src/host/ledger.ts')
const { storageStatus } = await import('../src/host/store.ts')
const { TaskBudgets } = await import('../src/host/budget.ts')
const { installRuntimeControls } = await import('../src/host/runtime-controls.ts')
const { installExecutionContext } = await import('../src/host/execution-context.ts')
const { installBusinessWorkflows } = await import('../src/host/workflow-runtime.ts')
const { installUsageRecorder } = await import('../src/host/usage.ts')
const { registerButlerTools } = await import('../src/host/tools.ts')
const { registerButlerApi } = await import('../src/host/api.ts')
const { runtimeView, reminderView } = await import('../src/client/workbench-model.ts')
ensureVault()
const active = new Set()
after(() => {
  for (const e of active) e.stop()
  assert.ok(realpathSync(fixture).startsWith(realpathSync(base) + sep))
  rmSync(fixture, { recursive: true, force: true })
})

function scheduler() {
  const rows = [], deliveries = [], calls = { create: 0, delete: 0 }
  return { rows, deliveries, calls, service: {
    // 0.2.2: create(request, actorSessionId?) returns a catalog entry carrying `target`.
    async create(request, actorSessionId) {
      calls.create++
      const at = request.timing.at
      const row = { id: `native-${randomUUID()}`, kind: request.timing.kind, title: request.title, prompt: request.prompt,
        target: request.target, scheduledAt: typeof at === 'string' ? at : `${at.date}T${at.time}`, status: 'active' }
      rows.push(row)
      return row
    },
    // 0.2.2: cancellation is edit({ id, action: 'delete' }); ids are host-wide.
    async edit(request) { calls.delete++; rows.find(row => row.id === request.id).status = 'ended'; return { id: request.id, deleted: true } },
    catalog: () => structuredClone(rows),
    // 0.2.2 history is target-based: the rule id plus a page size.
    history: async request => ({ records: deliveries.filter(row => row.scheduleId === request.id).map(({ scheduleId, sessionId, ...row }) => row) }),
  } }
}

function environment(key = randomUUID(), native = scheduler()) {
  const hooks = new Map(), tools = new Map(), guards = [], agents = new Map(), routes = new Map()
  let initiator
  const ctx = {
    on(name, listener, options) {
      const list = hooks.get(name) ?? []; options?.prepend ? list.unshift(listener) : list.push(listener); hooks.set(name, list)
      return () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1) }
    },
    get(name) { if (name === 'agents') return { list: () => [...agents.values()], currentInitiator: () => initiator, isOwnedBy: () => false } },
    tools: {
      register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) },
    },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    logger: { warn() {} },
  }
  const emit = (name, ...args) => { for (const fn of [...(hooks.get(name) ?? [])]) fn(...args) }
  const waterfall = (name, args, end) => {
    const list = [...(hooks.get(name) ?? [])]
    const next = i => i >= list.length ? end() : list[i](...args, () => next(i + 1))
    return next(0)
  }
  const budgets = new TaskBudgets({ file: statePath(`${key}-budgets.json`), normal: { maxFailures: 2 } })
  const controls = installRuntimeControls(ctx, { budgets })
  const contexts = installExecutionContext(ctx, { file: statePath(`${key}-contexts.json`), runFor: id => budgets.status(id)?.taskId, onReceipt: addReceipt })
  const workflows = installBusinessWorkflows(ctx, { contexts, timeZone: 'UTC', schedule: () => native.service,
    destination: async () => `session-butler-reminder-${randomUUID()}` })
  const recorder = installUsageRecorder(ctx, { context: (id, turn, step) => contexts.forCall(id, turn, step) })
  const disposeTools = registerButlerTools(ctx, { timeZone: 'UTC', mailto: 'isolated@localhost', schedule: native.service,
    sessionId: () => contexts.current()?.sessionId ?? 'unknown', currentTaskId: () => contexts.current()?.taskId,
    executionContext: contexts, evidence: workflows.evidence, memory: workflows.memory, reminderOperations: workflows.reminderOperations, receiptsByRuntime: true })
  const status = () => ({ ...controls.status(), storage: storageStatus(), workflows: workflows.status(), executionContext: contexts.status() })
  const disposeApi = registerButlerApi(ctx, { timeZone: 'UTC', schedule: native.service, runtimeControls: status,
    reminderOperations: () => workflows.reminderOperations.status(), usage: () => recorder.status() })
  function agent(id = `owner-${key}`) { if (!agents.has(id)) agents.set(id, { id, session: { id, inheritedEventCount: 0 } }); return agents.get(id) }
  async function input(a, text, id = randomUUID(), kind = 'user', scheduleId) {
    const message = { id, source: { kind, ...(scheduleId ? { scheduleId } : {}) }, content: [{ type: 'text', text }] }
    emit('agent/inbox/claimed', { agent: a, message })
    await waterfall('agent/pre-step', [{ agent: a, messages: [message], step: 1 }], () => ({ kind: 'continue', messages: [message] }))
    return message
  }
  async function call(a, name, args, callId = randomUUID()) {
    const exec = { agent: a, name, arguments: args, callId }
    const gate = await waterfall('tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    if (gate.kind === 'deny') return { denied: true, reason: gate.reason }
    for (const guard of guards) { const reason = guard(exec); if (reason) return { denied: true, reason } }
    const value = await tools.get(name).execute(args, exec)
    const result = { value, isError: value.ok === false }
    await waterfall('tools/post-execute', [exec, result], () => ({ kind: 'allow', ...result }))
    emit('tools/result', exec, result)
    return value
  }
  async function read(path) {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: path })
    let response
    await routes.get(path.split('?')[0])(req, { statusCode: 200, setHeader() {}, end(body) { response = { status: this.statusCode, body: JSON.parse(body) } } })
    return response
  }
  const e = { key, native, ctx, emit, waterfall, budgets, controls, contexts, workflows, recorder, status, agent, input, call, read,
    async modelEvent(a, turn, step, seq, usage) {
      await waterfall('agent/request', [{ agent: a, turn, step }], () => ({ maxTokens: 20 }))
      initiator = a
      try {
        const stream = waterfall('llm/stream', [{ sessionId: a.id, maxTokens: 20, messages: [] }], async function* () { if (usage) yield { type: 'usage', usage } })
        for await (const chunk of stream) assert.equal(chunk.type, 'usage')
      } finally { initiator = undefined }
      emit('session/event', a.session, { type: 'assistant/message', seq, time: Date.now(), data: { turn, step, provider: 'synthetic-unpriced', model: 'synthetic-unpriced', ...(usage ? { usage } : {}) } })
    },
    stop() { if (!active.delete(e)) return; disposeApi(); disposeTools(); recorder.stop(); workflows.stop(); contexts.stop(); controls.stop() },
  }
  active.add(e)
  return e
}

test('a bound native answer confirms a preference once and a reloaded workbench recalls its source', async () => {
  const e = environment(), a = e.agent()
  await e.input(a, '整理偏好，先提议再确认')
  const proposed = await e.call(a, 'butler_remember', { text: '我偏好中文交流', source: 'user', approved: true })
  assert.equal(proposed.memo.status, 'proposed')
  assert.doesNotMatch(readText(PROFILE_FILE()) ?? '', /我偏好中文交流/)
  const exec = { agent: a, callId: 'native-confirm-memory', name: 'ask_user_question', arguments: { questions: [proposed.proposal.question] } }
  await e.waterfall('tools/pre-execute', [exec], () => ({ kind: 'allow' }))
  e.emit('tools/result', exec, { value: { answers: [{ id: proposed.proposal.question.id, selected: ['确认记住'] }] } })
  e.stop()
  const reloaded = environment(e.key, e.native)
  const recall = reloaded.workflows.memory.retrieve('交流偏好', { maxBytes: 1200 })
  assert.match(recall.text, /我偏好中文交流/)
  assert.equal(readFileSync(PROFILE_FILE(), 'utf8').split('我偏好中文交流').length - 1, 1)
  const overview = await reloaded.read('/dsh-butler/api/overview')
  const memo = overview.body.memory.entries.find(row => row.id === proposed.memo.id)
  assert.equal(memo.status, 'confirmed'); assert.equal(memo.provenance.kind, 'native-question')
  reloaded.stop()
})

test('native finalized note evidence supports completion and remains inspectable with reversible revisions', async () => {
  const e = environment(), a = e.agent()
  await e.input(a, '保存这份本地材料并整理笔记')
  const opened = await e.call(a, 'butler_task', { action: 'open', title: 'Keep a traceable local note' })
  const first = await e.call(a, 'butler_note', { action: 'write', slug: `source-${e.key}`, markdown: 'Original local material', sources: ['Local material supplied in this test'] })
  const original = readFileSync(first.path, 'utf8')
  await e.call(a, 'butler_note', { action: 'append', slug: first.slug, markdown: 'A later supplement' })
  const restored = await e.call(a, 'butler_note', { action: 'restore', slug: first.slug, revision: 1 })
  assert.equal(restored.rev, 3)
  assert.equal((await e.call(a, 'butler_note', { action: 'read', slug: first.slug, revision: 1 })).body, original)
  const done = await e.call(a, 'butler_task', { action: 'update', id: opened.task.id, status: 'done', evidenceIds: restored.evidenceIds })
  assert.equal(done.ok, true, JSON.stringify(done))
  await e.modelEvent(a, 1, 1, 101, { inputTokens: 21, outputTokens: 9, totalTokens: 30 })
  await e.modelEvent(a, 1, 2, 102)
  const detail = (await e.read(`/dsh-butler/api/task?id=${opened.task.id}`)).body
  assert.equal(detail.task.status, 'done'); assert.equal(detail.evidenceAvailable, true)
  assert.ok(detail.evidence.some(row => restored.evidenceIds.includes(row.evidenceId)))
  assert.ok(detail.artifacts.some(row => row.path === first.path))
  assert.equal(detail.usage.totalTokens, 30); assert.equal(detail.usage.withoutUsage, 1); assert.equal(detail.usage.pricedCalls, 0)
  assert.equal(detail.budgets[0].requests, 2)
  assert.ok(detail.budgets[0].tokens > detail.usage.totalTokens, 'An unknown response is conservatively budgeted, never called reported provider usage')
  e.stop()
})

test('replayed reminder, native delivery and cancellation keep separate business states visible', async () => {
  const e = environment(), a = e.agent()
  await e.input(a, '明天提醒我读这篇笔记')
  const args = { action: 'create', title: 'Read a note', prompt: 'Read only this note', at: '2030-01-02T03:04:00Z' }
  const created = await e.call(a, 'butler_remind', args, 'same-native-create')
  const replay = await e.call(a, 'butler_remind', args, 'same-native-create')
  assert.equal(created.ok, true, JSON.stringify(created)); assert.equal(replay.taskId, created.taskId); assert.equal(e.native.calls.create, 1)
  const link = getTask(created.taskId).reminder
  e.native.deliveries.push({ sessionId: link.destinationSessionId, scheduleId: link.scheduleId, scheduledAt: args.at, deliveredAt: '2030-01-02T03:04:01Z', messageId: 'native-scheduled-message' })
  const target = e.agent(link.destinationSessionId)
  e.emit('session/event', target.session, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'native-scheduled-message', source: { kind: 'schedule', scheduleId: link.scheduleId } } })
  await e.input(target, args.prompt, 'native-scheduled-message', 'schedule', link.scheduleId)
  assert.equal(e.contexts.forAgent(target).taskId, created.taskId)
  assert.notEqual(e.contexts.forAgent(target).runId, e.contexts.forAgent(a).runId)
  const detail = (await e.read(`/dsh-butler/api/task?id=${created.taskId}`)).body
  assert.equal(detail.reminder.history.deliveryState, 'delivered')
  assert.equal(reminderView(detail.reminder).completion, '助手完成未核实')
  assert.notEqual(detail.task.status, 'done')
  const cancelled = await e.call(a, 'butler_remind', { action: 'cancel', id: link.scheduleId })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.equal((await e.read(`/dsh-butler/api/task?id=${created.taskId}`)).body.task.status, 'cancelled')
  assert.equal(e.native.calls.delete, 1)
  e.stop()
})

test('a lost native response remains uncertain across reload and is shown without another create', async () => {
  const native = scheduler(), create = native.service.create
  native.service.create = async (...args) => { await create(...args); throw Error('native response lost after acceptance') }
  const e = environment(randomUUID(), native), a = e.agent()
  await e.input(a, '建立一条提醒')
  const args = { action: 'create', title: 'An uncertain operation', prompt: 'Wait for confirmation', at: '2030-01-02T03:04:00Z' }
  const created = await e.call(a, 'butler_remind', args, 'lost-native-response')
  assert.equal(created.state, 'uncertain')
  e.stop()
  const reloaded = environment(e.key, native)
  const replay = await reloaded.call(reloaded.agent(), 'butler_remind', args, 'lost-native-response')
  assert.equal(replay.state, 'uncertain'); assert.equal(native.calls.create, 1)
  const overview = (await reloaded.read('/dsh-butler/api/overview')).body
  assert.ok(runtimeView(overview.runtimeControls).attention.some(row => row.taskId === created.taskId && row.state === 'uncertain'))
  assert.notEqual(getTask(created.taskId).status, 'done')
  reloaded.stop()
})

test('repeated real tool failures stop native execution, persist across reload, and remain visible beside damaged state', async () => {
  const e = environment(), a = e.agent()
  await e.input(a, '检查缺失笔记并保留失败记录')
  const opened = await e.call(a, 'butler_task', { action: 'open', title: 'Failure stays attributed' })
  for (let i = 0; i < 2; i++) assert.equal((await e.call(a, 'butler_note', { action: 'read', slug: `missing-${e.key}` })).ok, false)
  const denied = await e.call(a, 'butler_note', { action: 'write', slug: `must-not-run-${e.key}`, markdown: 'No side effect' })
  assert.equal(denied.denied, true); assert.match(denied.reason, /连续失败 2 次/)
  const before = readFileSync(statePath(`${e.key}-budgets.json`))
  e.stop()
  const reloaded = environment(e.key, e.native)
  const detail = (await reloaded.read(`/dsh-butler/api/task?id=${opened.task.id}`)).body
  assert.equal(detail.receipts.filter(row => row.tool === 'butler_note' && !row.ok).length, 2)
  assert.match(detail.budgets[0].blocked, /连续失败 2 次/)
  assert.deepEqual(detail.budgets[0].remaining, { requests: 0, tokens: 0, ms: 0 })
  assert.deepEqual(readFileSync(statePath(`${e.key}-budgets.json`)), before, 'Reopening the workbench never resets a stopped run')
  const memoFile = statePath('memos.json'), original = readFileSync(memoFile)
  writeFileSync(memoFile, '{damaged-memory')
  try {
    const overview = (await reloaded.read('/dsh-butler/api/overview')).body
    assert.equal(overview.memory, undefined); assert.ok(overview.memoryError)
    assert.equal(runtimeView(overview.runtimeControls).state, 'degraded')
    assert.ok(overview.taskHistory.tasks.some(row => row.id === opened.task.id))
    assert.equal(readFileSync(memoFile, 'utf8'), '{damaged-memory')
  } finally { writeFileSync(memoFile, original); reloaded.stop() }
})
