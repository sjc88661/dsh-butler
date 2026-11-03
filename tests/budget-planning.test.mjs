import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskBudgets } from '../src/host/budget.ts'
const { planBudget } = await import('../src/host/budget-planning.ts').catch(() => ({}))
const limits = Object.freeze({ maxRequests: 6, maxTokens: 160000, maxMs: 180000, maxOutputTokens: 8192, maxFailures: 3 })
const state = (extra = {}) => ({ requests: 0, tokens: 0, reservedTokens: 0, ...extra })

test('oversized next input finalizes without weakening hard admission', () => {
  const b = new TaskBudgets({ normal: limits })
  b.begin('s', {})
  const lease = b.admit('s', 100000, 8192)
  b.finish(lease, 101744)
  const p = planBudget(b.status('s'), limits, 107023)
  assert.equal(p.remainingRequests, 5)
  assert.equal(p.remainingTokens, 58256)
  assert.equal(p.finalize, true)
  assert.equal(p.allowSummary, false)
  assert.match(p.notice, /现有证据.*最终答复/)
  assert.throws(() => b.admit('s', 107023, 8192, { requireFullOutput: true }), /预检/)
})

test('ample budget allows summary, with native pressure threshold only', () => {
  const s = Object.freeze(state())
  const p = planBudget(s, limits, 0)
  assert.deepEqual([p.remainingRequests, p.remainingTokens, p.finalize, p.allowSummary, p.inputTarget], [6,160000,false,true,20000])
  assert.match(p.notice, /摘要.*计入/)
  assert.match(p.notice, /足够证据.*立即答复/)
  assert.deepEqual(s, state())
})

test('concurrent reservations count, then actual finish releases unused tokens', () => {
  const b = new TaskBudgets({ normal: limits }); b.begin('s', {})
  const a = b.admit('s', 20000, 8192), c = b.admit('s', 20000, 8192)
  const before = planBudget(b.status('s'), limits, 1000)
  assert.equal(before.remainingTokens, 103616)
  assert.equal(before.remainingRequests, 4)
  b.finish(a, 1000)
  const after = planBudget(b.status('s'), limits, 1000)
  assert.equal(after.remainingTokens, 130808)
  assert.equal(after.remainingRequests, 4)
  b.finish(c, 1000)
  assert.equal(planBudget(b.status('s'), limits, 1000).remainingTokens, 158000)
})

test('last two requests forbid paid summary and demand final answer after query', () => {
  const p = planBudget(state({ requests: 4 }), limits, 0)
  assert.equal(p.allowSummary, false)
  assert.equal(p.finalize, false)
  assert.match(p.notice, /最后一轮查询后必须答复/)
  assert.equal(planBudget(state({ requests: 5 }), limits, 0).finalize, true)
})

test('exhaustion and blocked tasks never grant new credit', () => {
  for (const s of [state({ requests: 6, tokens: 160000 }), state({ blocked: 'stop' })]) {
    const p = planBudget(s, limits, 0)
    assert.equal(p.finalize, true); assert.equal(p.allowSummary, false)
    assert.equal(p.remainingRequests, 0); assert.equal(p.remainingTokens, 0)
    assert.equal(p.inputTarget, 1)
  }
  assert.match(planBudget(state({ blocked: 'stop' }), limits, 0).notice, /已停止/)
})

test('invalid numeric inputs are rejected, zero input accepted', () => {
  for (const n of [-1, NaN, Infinity]) {
    assert.throws(() => planBudget(state(), limits, n), /invalid/)
    for (const key of ['requests', 'tokens', 'reservedTokens']) assert.throws(() => planBudget(state({ [key]: n }), limits, 0), /invalid/)
  }
  assert.doesNotThrow(() => planBudget(state(), limits, 0))
})

test('conservative thresholds are strict for finalization and inclusive for summary', () => {
  const nextCost = 1000 + limits.maxOutputTokens + 4096
  assert.equal(planBudget(state({ tokens: limits.maxTokens - 2 * nextCost }), limits, 1000).finalize, false)
  assert.equal(planBudget(state({ tokens: limits.maxTokens - 2 * nextCost + 1 }), limits, 1000).finalize, true)
  assert.equal(planBudget(state({ tokens: limits.maxTokens - 3 * nextCost, requests: 3 }), limits, 1000).allowSummary, true)
  assert.equal(planBudget(state({ tokens: limits.maxTokens - 3 * nextCost + 1 }), limits, 1000).allowSummary, false)
})
