import test from 'node:test'
import assert from 'node:assert/strict'
const api = await import('../src/client/api.ts')
const model = await import('../src/client/workbench-model.ts').catch(() => ({}))
const core = { active: true, storage: { mode: 'healthy', degraded: false, diagnostics: [] },
  workflows: { active: true, nativeActionGuard: true, errors: {} }, executionContext: { active: true },
  toolLoading: { enabled: true, registered: true }, skillLoading: { enabled: true, registered: true } }
const budget = { taskId: 'run-one', sessionId: 'owner', kind: 'normal', startedAt: 1000, requests: 2, tokens: 30,
  reservedTokens: 40, pending: { pending: 40 }, failures: {} }

test('legacy runtime payloads leave remaining budget unknown instead of guessing a policy', () => {
  assert.equal(typeof model.runtimeView, 'function')
  const view = model.runtimeView({ ...core, taskBudgets: [budget] })
  assert.equal(view.budgets[0].runId, budget.taskId)
  assert.equal(view.budgets[0].remaining, undefined)
  assert.equal(view.budgets[0].reservedTokens, 40)
  assert.match(view.budgets[0].note, /未知|未提供/)
})

test('channels summary keeps callback returns, native mapping, connection and business completion distinct', () => {
  const raw = { ...core, channels: { active: true, enabled: true, configuredOwner: true, received: 3, accepted: 2, nativeMapped: 1, acceptedWithoutNative: 1,
    pending: 0, uncertain: 1, ownerId: 'PRIVATE-owner', chatId: 'PRIVATE-chat', senderId: 'PRIVATE-sender' } }
  const before = JSON.stringify(raw), view = model.runtimeView(raw)
  assert.equal(typeof view.channels?.summary, 'string')
  assert.match(view.channels.summary, /归因已配置/)
  assert.match(view.channels.summary, /回调返回 2/)
  assert.match(view.channels.summary, /关联原生 1/)
  assert.match(view.channels.summary, /返回未关联 1/)
  assert.match(view.channels.summary, /连接状态未知/)
  assert.match(view.channels.note, /可能是.*命令/)
  assert.match(view.channels.note, /任务.*完成.*核对/)
  assert.equal(view.channels.attention, true)
  assert.doesNotMatch(JSON.stringify(view.channels), /PRIVATE-|已连接|任务已完成/)
  assert.equal(JSON.stringify(raw), before)
  const command = model.runtimeView({ ...core, channels: { active: true, enabled: true, configuredOwner: true, accepted: 1, nativeMapped: 0, acceptedWithoutNative: 1, pending: 0, uncertain: 0 } })
  assert.equal(command.state, 'healthy', 'a returned command callback without native input is not a failure')
  assert.equal(command.channels.attention, false)
  assert.match(model.runtimeView(core).channels.summary, /未提供.*连接状态未知/)
  assert.match(model.runtimeView({ ...core, channels: { active: true } }).channels.summary, /关联原生 未知/)
})

test('workbench shows persisted stop reasons, real remaining policy and uncertain operations without restarting work', () => {
  assert.equal(typeof model.runtimeView, 'function')
  const raw = { ...core, budgetReports: [{ ...budget, blocked: '连续失败 3 次', inFlight: 1,
    limits: { maxRequests: 7, maxTokens: 1000, maxMs: 10000, maxOutputTokens: 50, maxFailures: 3 }, remaining: { requests: 0, tokens: 0, ms: 0 } }],
    reminderOperations: [{ action: 'create', state: 'uncertain', sourceSessionId: 'owner', taskId: 'business-task', reason: 'native response lost', executionKey: 'operation-1' }] }
  const before = JSON.stringify(raw), view = model.runtimeView(raw)
  assert.equal(view.budgets[0].state, 'stopped')
  assert.equal(view.budgets[0].stopReason, '连续失败 3 次')
  assert.deepEqual(view.budgets[0].remaining, { requests: 0, tokens: 0, ms: 0 })
  assert.ok(view.attention.some(row => row.reason.includes('native response lost')))
  assert.equal(JSON.stringify(raw), before)
})

test('committed reminders keep pending and uncertain external delivery visible in global attention', () => {
  for (const state of ['pending', 'uncertain', 'delivered']) {
    const operation = { action: 'create', executionKey: 'external-operation', state: 'committed', taskId: 'external-task', request: { title: 'External reminder' },
      outbound: [{ key: 'external-record', provider: 'lark', state, createdAt: '2026-10-21T03:00:00Z', updatedAt: '2026-10-21T03:00:01Z', ...(state === 'delivered' ? { receipt: { messageId: 'platform-receipt' } } : {}) }] }
    const raw = { ...core, reminderOperations: [operation] }, before = JSON.stringify(raw), view = model.runtimeView(raw)
    assert.equal(view.attention.length, state === 'delivered' ? 0 : 1, `${state} external state must be shown independently of committed creation`)
    if (state !== 'delivered') {
      assert.equal(view.attention[0].taskId, 'external-task')
      assert.equal(view.attention[0].state, state)
      assert.match(view.attention[0].reason, state === 'pending' ? /外发处理中/ : /外发.*待核对/)
    }
    assert.equal(JSON.stringify(raw), before)
  }
})

test('protection failures and missing runtime state remain visible instead of a healthy empty dashboard', () => {
  assert.equal(typeof model.runtimeView, 'function')
  assert.equal(model.runtimeView(undefined).state, 'unknown')
  const view = model.runtimeView({ ...core, storage: { mode: 'degraded', degraded: true, diagnostics: [{ path: 'tasks.jsonl', message: 'bad line', blocking: true }] },
    workflows: { active: false, error: 'workflow unavailable' } })
  assert.equal(view.state, 'degraded')
  assert.ok(view.problems.some(text => text.includes('bad line')))
  assert.ok(view.problems.some(text => text.includes('workflow unavailable')))
})

test('reported usage, unknown calls and unpriced money are distinct from budget reservations', () => {
  assert.equal(typeof model.usageView, 'function')
  const view = model.usageView({ calls: 2, withoutUsage: 1, totalTokens: 30, pricedCalls: 0, cost: 0 })
  assert.match(view.tokenText, /30/); assert.match(view.tokenText, /未知/)
  assert.equal(view.costText, '未计价')
  assert.equal(model.usageView({ calls: 1, withoutUsage: 1, totalTokens: 0, pricedCalls: 0, cost: 0 }).tokenText, '未知')
})

test('native delivery is not presented as an assistant completion, and unavailable history stays unknown', () => {
  assert.equal(typeof model.reminderView, 'function')
  const delivered = model.reminderView({ link: { creationState: 'committed', deliveryState: 'delivered' }, history: { available: true, deliveryState: 'delivered', records: [{ messageId: 'native' }] } })
  assert.equal(delivered.label, '已入提醒会话')
  assert.match(delivered.completion, /未核实/)
  const unavailable = model.reminderView({ link: { creationState: 'committed', deliveryState: 'delivered' }, history: { available: false, deliveryState: 'unknown', reason: 'offline' } })
  assert.equal(unavailable.label, '历史未知')
  assert.match(unavailable.reason, /offline/)
})

test('external delivery distinguishes platform receipts from native inbox and assistant completion', () => {
  const base = { link: { creationState: 'committed', deliveryState: 'delivered' }, history: { available: true, deliveryState: 'delivered', records: [{ messageId: 'inbox-only' }] } }
  const native = model.reminderView(base)
  assert.equal(typeof native.external, 'string', 'External delivery status must be explicit')
  assert.match(native.external, /未核实/)
  assert.match(native.completion, /未核实/)
  const delivered = model.reminderView({ ...base, outbound: [{ key: 'outbound-one', provider: 'lark', state: 'delivered', createdAt: '2026-10-21T03:00:01Z', updatedAt: '2026-10-21T03:00:02Z', receipt: { messageId: 'platform-only' } }] })
  assert.match(delivered.external, /飞书平台已收到/)
  assert.match(delivered.external, /已读未核实/)
  assert.equal(delivered.completion, '已记录助手完成')
  assert.equal(delivered.outbound[0].messageId, 'platform-only')
  assert.equal(delivered.outbound[0].receiptAt, '2026-10-21T03:00:02Z')
  for (const state of ['pending', 'uncertain']) {
    const view = model.reminderView({ ...base, outbound: [{ key: state, provider: 'lark', state, createdAt: '2026-10-21T03:00:01Z', updatedAt: '2026-10-21T03:00:02Z' }] })
    assert.doesNotMatch(view.external, /平台已收到/)
    assert.match(view.external, state === 'pending' ? /处理中/ : /待核对/)
    assert.equal(view.outbound[0].messageId, undefined)
  }
})

test('unrecorded task usage stays unknown and execution summary comes only from budget counters', () => {
  assert.match(model.usageView({ calls: 0, withoutUsage: 0, totalTokens: 0, pricedCalls: 0, cost: 0 }).tokenText, /未记录|未知/)
  const usage = { calls: 2, withoutUsage: 1, totalTokens: 30, pricedCalls: 0, cost: 0 }
  const text = model.taskMetricsView({ usage, execution: { available: true, runCount: 3, requests: 7 } })
  assert.match(text, /30/); assert.match(text, /未知/); assert.match(text, /3 次执行/); assert.match(text, /7 次预算请求/)
  assert.match(model.taskMetricsView({ usage, execution: { available: false, reason: 'budget unavailable' } }), /执行.*未知/)
})

test('waiting and reconciliation history remain visible without exposing a raw failure or body', () => {
  const at = '2026-10-21T03:00:01Z', base = { history: { available: true, deliveryState: 'delivered' } }
  const waiting = { key: 'safe-record', state: 'waiting', createdAt: at, updatedAt: at, audit: [{ at, kind: 'queued' }] }
  const view = model.reminderView({ ...base, outbound: [waiting] })
  assert.equal(view.outbound[0].state, 'waiting')
  assert.match(view.external, /等待连接/)
  assert.match(view.outbound[0].label, /尚未调用发送/)
  const attention = model.runtimeView({ ...core, reminderOperations: [{ action: 'create', state: 'committed', taskId: 'task', outbound: [waiting] }] })
  assert.equal(attention.attention[0].state, 'waiting')
  const repaired = model.reminderView({ ...base, outbound: [{ ...waiting, state: 'delivered', receipt: { messageId: 'verified-platform' },
    failure: { at, kind: 'send-failed' }, audit: [{ at, kind: 'send-failed' }, { at, kind: 'reconcile-verified' }] }] }).outbound[0]
  assert.match(repaired.originalFailure, /原失败|原始失败/)
  assert.match(repaired.originalFailure, /safe-record/)
  assert.match(repaired.audit.at(-1).label, /只读核对.*匹配/)
})

test('client fetches one exact task and passes cancellation through the shared read endpoint', async () => {
  assert.equal(typeof api.fetchTask, 'function')
  const original = globalThis.fetch, id = 'task /?中文', controller = new AbortController()
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `/dsh-butler/api/task?id=${encodeURIComponent(id)}`)
      assert.equal(options.signal, controller.signal)
      return new Response(JSON.stringify({ ok: true, task: { id, title: 'Actual selected task' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const task = await api.fetchTask(id, controller.signal)
    assert.equal(task.task.id, id)
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, task: { id: 'different' } }), { status: 200 })
    await assert.rejects(api.fetchTask(id), /任务|结构|身份/)
    globalThis.fetch = async () => new Response('{}', { status: 404 })
    await assert.rejects(api.fetchTask(id), /404/)
  } finally { globalThis.fetch = original }
})


test('dedicated-layer budget policy is explicit without hiding reminder records or runtime failures', () => {
  const raw = { ...core, controlScope: 'isolated-reminders-only',
    layer: { mode: 'dedicated-layer', normalTokenBudget: null, normalExecutionPolicy: 'native', toolRegistration: 'agent-scoped', toolCount: 8, sessions: ['butler'] },
    blocked: true, error: 'reminder budget unavailable', taskBudgets: [{ ...budget, kind: 'reminder' }] }
  const view = model.runtimeView(raw)
  assert.equal(view.budgetPolicy, '普通管家不设 token 硬预算；仅统计实际消耗。提醒会话保留隔离限额。')
  assert.equal(view.state, 'degraded')
  assert.ok(view.problems.includes('reminder budget unavailable'))
  assert.equal(view.budgets[0].kind, 'reminder')
  assert.equal(view.budgetCount, 1)
  for (const controls of [undefined, core, { ...core, layer: { mode: 'dedicated-layer' } }]) {
    assert.match(model.runtimeView(controls).budgetPolicy, /未提供/)
    assert.doesNotMatch(model.runtimeView(controls).budgetPolicy, /不设.*硬预算|保留隔离限额/)
  }
})
