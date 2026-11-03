import test from 'node:test'
import assert from 'node:assert/strict'
const api = await import('../src/client/api.ts')
const model = await import('../src/client/workbench-model.ts')
const revision = 'a'.repeat(64)

test('history client preserves scope, revision and cancellation and rejects a foreign task page', async () => {
  assert.equal(typeof api.fetchHistory, 'function')
  const original = globalThis.fetch, controller = new AbortController(), taskId = 'task /中文?'
  try {
    globalThis.fetch = async (path, options) => {
      const url = new URL(path, 'http://test.invalid')
      assert.equal(url.pathname, '/dsh-butler/api/history')
      assert.equal(url.searchParams.get('taskId'), taskId)
      assert.equal(url.searchParams.get('kind'), 'receipts')
      assert.equal(url.searchParams.get('offset'), '100')
      assert.equal(url.searchParams.get('revision'), revision)
      assert.equal(options.signal, controller.signal)
      return new Response(JSON.stringify({ ok: true, kind: 'receipts', taskId, items: [{ tool: 'old', ok: false }], total: 101, offset: 100, limit: 100, revision }))
    }
    const page = await api.fetchHistory('receipts', { taskId, offset: 100, limit: 100, revision }, controller.signal)
    assert.equal(page.items[0].ok, false)
    globalThis.fetch = async () => new Response(JSON.stringify({ ...page, taskId: 'other' }))
    await assert.rejects(api.fetchHistory('receipts', { taskId, offset: 100, revision }), /身份|结构/)
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, code: 'HISTORY_CHANGED', error: '历史已变化，请刷新后重新翻页' }), { status: 409 })
    await assert.rejects(api.fetchHistory('receipts', { taskId, offset: 100, revision }), /409.*刷新/)
  } finally { globalThis.fetch = original }
})

test('historical budgets keep saved stop/failure/reservation facts without inventing an old policy or truncating at twelve', () => {
  assert.equal(typeof model.budgetViews, 'function')
  const entries = Array.from({ length: 15 }, (_, index) => ({ taskId: `old-${index}`, sessionId: 'owner', current: false, kind: 'normal', startedAt: 1000 + index,
    requests: index, tokens: 20, reservedTokens: 7, pending: { interrupted: 7 }, failures: { native: 3 }, blocked: '原运行已停止' }))
  const before = JSON.stringify(entries), rows = model.budgetViews(entries)
  assert.equal(rows.length, 15)
  assert.ok(rows.every(row => row.remaining === undefined && row.limits === undefined && row.current === false))
  assert.deepEqual(rows[0].failures, { native: 3 })
  assert.equal(rows[0].stopReason, '原运行已停止')
  assert.equal(rows[0].reservedTokens, 7)
  assert.match(rows[0].note, /旧运行.*未知/)
  assert.equal(JSON.stringify(entries), before)
})

const operation = (changes = {}) => ({ action: 'create', executionKey: 'execution-one', state: 'committed', taskId: 'task-one', sourceSessionId: 'owner',
  scheduleId: 'rule', destinationSessionId: 'session-butler-reminder-one', request: { title: '记得看结果', at: '2026-10-21T10:00:00+08:00' },
  createdAt: '2026-10-20T02:00:00Z', updatedAt: '2026-10-20T02:00:03Z', actualReceipt: { id: 'rule', scheduledAt: '2026-10-21T02:00:00Z' }, ...changes })

test('local reminder snapshots expose actual receipts and delivery independently of unavailable native history', () => {
  assert.equal(typeof model.reminderOperationView, 'function')
  const row = operation({ lastDelivery: { messageId: 'actual-message', deliveredAt: '2026-10-21T02:00:01Z' }, deliveryState: 'delivered' })
  const before = JSON.stringify(row), view = model.reminderOperationView(row)
  assert.equal(view.label, '已取得创建回执')
  assert.equal(view.requestedAt, row.createdAt)
  assert.equal(view.plannedAt, row.request.at)
  assert.match(view.receiptText, /未单列接受时间/)
  assert.equal(view.delivery.messageId, 'actual-message')
  assert.match(view.completion, /未核实/)
  assert.match(view.external, /未核实/)
  assert.equal(JSON.stringify(row), before)
})

test('uncertain, refused and unsuccessful cancellation never become successful cancellation or assistant completion', () => {
  assert.equal(typeof model.reminderOperationView, 'function')
  assert.equal(model.reminderOperationView(operation({ state: 'uncertain', reason: 'response lost', actualReceipt: undefined })).label, '待核对')
  const failed = model.reminderOperationView(operation({ action: 'cancel', actualReceipt: { id: 'rule', deleted: false, code: 'NOT_FOUND' } }))
  assert.equal(failed.label, '取消未成功'); assert.match(failed.receiptText, /deleted=false/)
  assert.equal(model.reminderOperationView(operation({ action: 'cancel', actualReceipt: { id: 'rule', deleted: true } })).label, '已取消')
  const refused = model.reminderOperationView(operation({ action: 'cancel', actualReceipt: undefined, refusal: { code: 'OWNERSHIP', reason: '不属于本任务' } }))
  assert.equal(refused.label, '取消被拒绝'); assert.match(refused.reason, /不属于本任务/)
  const old = model.reminderOperationView(operation({ actualReceipt: undefined, lastDelivery: { scheduledAt: '2026-10-21T02:00:00Z' } }))
  assert.equal(old.delivery, undefined)
  assert.match(old.receiptText, /未记录/)
})
