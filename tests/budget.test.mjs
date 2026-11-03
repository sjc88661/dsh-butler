import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const { TaskBudgets } = await import('../src/host/budget.ts').catch(() => ({}))
const fixtureRoot = resolve('tests/.tmp')
mkdirSync(fixtureRoot, { recursive: true })
function removeFixture(dir) {
  assert.ok(realpathSync(dir).startsWith(realpathSync(fixtureRoot) + sep))
  rmSync(dir, { recursive: true, force: true })
}
function budgets(options = {}) {
  assert.equal(typeof TaskBudgets, 'function', 'task admission must enforce a real model-request budget')
  return new TaskBudgets(options)
}
function complete(store, session, input = 10, output = 2) {
  const lease = store.admit(session, input, output)
  store.finish(lease, input + output)
  return lease
}

test('halt persists the same task without changing hard limits or usage', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join, resolve, sep } = await import('node:path')
  const directory = mkdtempSync(join(process.cwd(), '.compaction-budget-'))
  try {
    const file = join(directory, 'budget.json'), budgets = new TaskBudgets({ file })
    const task = budgets.begin('dev', { humanMessageId: 'one' })
    const lease = budgets.admit('dev', 100, 10); budgets.finish(lease, 111)
    budgets.halt('dev', '[COMPACTION_FAILED] truncated', task.taskId)
    const reopened = new TaskBudgets({ file })
    assert.throws(() => reopened.check('dev'), /COMPACTION_FAILED/)
    assert.equal(reopened.status('dev').tokens, 111)
    assert.equal(reopened.status('dev').requests, 1)
    assert.equal(reopened.status('dev').reservedTokens, 0)
    reopened.begin('dev', { humanMessageId: 'two' })
    assert.doesNotThrow(() => reopened.check('dev'))
    assert.throws(() => reopened.admit('dev', 2_000_000, 1), /token/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(process.cwd()) + sep + '.compaction-budget-'))
    rmSync(directory, { recursive: true, force: true })
  }
})


test('a task admits 50 requests and blocks the 51st before dispatch', () => {
  const b = budgets()
  b.begin('dev', { humanMessageId: 'user-1' })
  for (let i = 0; i < 50; i++) complete(b, 'dev')
  assert.throws(() => b.admit('dev', 10, 2), /request|调用/)
  assert.equal(b.status('dev').requests, 50)
})

test('automatic continuations cannot reset the exhausted task', () => {
  const b = budgets({ normal: { maxRequests: 2 } })
  const first = b.begin('dev', { humanMessageId: 'human-a' })
  complete(b, 'dev'); complete(b, 'dev')
  assert.equal(b.begin('dev', {}).taskId, first.taskId)
  assert.throws(() => b.admit('dev', 1, 1))
  assert.equal(b.begin('dev', { humanMessageId: 'human-a' }).taskId, first.taskId)
  assert.notEqual(b.begin('dev', { humanMessageId: 'human-b' }).taskId, first.taskId)
  assert.doesNotThrow(() => complete(b, 'dev'))
})

test('a reminder occurrence has a five-request budget and a new occurrence has a new task', () => {
  const b = budgets()
  const task = b.begin('reminder', { scheduleMessageId: 'schedule-delivery-1' })
  for (let i = 0; i < 5; i++) complete(b, 'reminder')
  assert.throws(() => b.admit('reminder', 1, 1))
  assert.equal(b.begin('reminder', { scheduleMessageId: 'schedule-delivery-1' }).taskId, task.taskId)
  assert.notEqual(b.begin('reminder', { scheduleMessageId: 'schedule-delivery-2' }).taskId, task.taskId)
})

test('input and bounded output are reserved atomically across concurrent requests', () => {
  const b = budgets({ normal: { maxTokens: 100, maxOutputTokens: 40 } })
  b.begin('dev', { humanMessageId: '1' })
  const first = b.admit('dev', 50, 40)
  assert.throws(() => b.admit('dev', 11, 1), /token/)
  b.finish(first, 60)
  assert.equal(b.status('dev').tokens, 60)
  assert.equal(b.status('dev').reservedTokens, 0)
})

test('provider usage releases unused reservations; duplicate finishes cannot add credit', () => {
  const b = budgets({ normal: { maxTokens: 100 } })
  b.begin('dev', {})
  const lease = b.admit('dev', 40, 40)
  b.finish(lease, 20); b.finish(lease, 0)
  assert.equal(b.status('dev').tokens, 20)
  assert.equal(b.status('dev').reservedTokens, 0)
  assert.equal(b.admit('dev', 60, 40).maxOutputTokens, 20)
})

test('missing usage conservatively charges the reservation and failed calls still count', () => {
  const b = budgets({ normal: { maxTokens: 100 } })
  b.begin('dev', {})
  const lease = b.admit('dev', 40, 30)
  b.finish(lease)
  assert.equal(b.status('dev').tokens, 70)
  assert.equal(b.status('dev').requests, 1)
})

test('a task deadline blocks model and tool admission', () => {
  let time = 100
  const b = budgets({ now: () => time, normal: { maxMs: 1000 } })
  b.begin('dev', {})
  time = 1100
  assert.throws(() => b.check('dev'), /time|时长/)
  assert.throws(() => b.admit('dev', 1, 1), /time|时长/)
})

test('three failures of a tool fence the task even when arguments change', () => {
  const b = budgets()
  b.begin('dev', {})
  b.observeTool('dev', 'pwsh', false)
  b.observeTool('dev', 'pwsh', false)
  b.observeTool('dev', 'pwsh', false)
  assert.throws(() => b.check('dev'), /pwsh/)
})

test('a successful tool outcome resets that tool failure streak', () => {
  const b = budgets()
  b.begin('dev', {})
  b.observeTool('dev', 'pwsh', false)
  b.observeTool('dev', 'pwsh', true)
  b.observeTool('dev', 'pwsh', false)
  b.observeTool('dev', 'pwsh', false)
  assert.doesNotThrow(() => b.check('dev'))
})

test('reload preserves request and token budget; in-flight reservations remain charged', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'budget-'))
  try {
    const file = join(dir, 'budget.json')
    const b = budgets({ file, normal: { maxRequests: 1 } })
    b.begin('dev', { humanMessageId: 'persisted-human' })
    b.admit('dev', 40, 30)
    const restored = budgets({ file, normal: { maxRequests: 1 } })
    restored.begin('dev', { humanMessageId: 'persisted-human' })
    assert.equal(restored.status('dev').requests, 1)
    assert.equal(restored.status('dev').reservedTokens, 70)
    assert.throws(() => restored.admit('dev', 1, 1))
  } finally { removeFixture(dir) }
})

test('a corrupt persisted budget fails closed instead of silently granting new credit', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'corrupt-'))
  try {
    const file = join(dir, 'budget.json')
    writeFileSync(file, '{invalid')
    assert.throws(() => budgets({ file }), /budget|预算/)
  } finally { removeFixture(dir) }
})

test('an old in-flight finish cannot overwrite counters written by a reloaded instance', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'overlap-'))
  try {
    const file = join(dir, 'budget.json')
    const old = budgets({ file })
    old.begin('dev', { humanMessageId: '1' })
    const lease = old.admit('dev', 10, 10)
    const current = budgets({ file })
    complete(current, 'dev')
    old.finish(lease, 15)
    const restored = budgets({ file })
    assert.equal(restored.status('dev').requests, 2)
    assert.equal(restored.status('dev').tokens, 27)
  } finally { removeFixture(dir) }
})

test('history retains old stopped runs after same-session replacement and reload without changing current credit or saved bytes', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'history-'))
  try {
    const file = join(dir, 'budget.json'), store = budgets({ file, now: () => 1000, normal: { maxRequests: 7 } })
    const old = store.begin('shared', { humanMessageId: 'old-human' })
    complete(store, 'shared', 10, 2)
    store.halt('shared', 'preserved stop', old.taskId)
    const current = store.begin('shared', { humanMessageId: 'new-human' })
    store.admit('shared', 20, 3)
    const before = readFileSync(file), pointer = JSON.parse(before).sessions.shared
    const restored = budgets({ file, now: () => 999999, normal: { maxRequests: 2 } })
    assert.equal(typeof restored.history, 'function', 'Saved runs need an independent read-only history accessor')
    const history = restored.history()
    assert.deepEqual(new Set(history.map(row => row.taskId)), new Set([old.taskId, current.taskId]))
    const historical = history.find(row => row.taskId === old.taskId), active = history.find(row => row.taskId === current.taskId)
    assert.equal(historical.current, false); assert.equal(historical.blocked, 'preserved stop')
    assert.equal(historical.tokens, 12); assert.equal(historical.requests, 1)
    assert.equal(active.current, true); assert.equal(active.reservedTokens, 23)
    for (const row of history) {
      assert.equal(row.limits, undefined, 'An unsaved old policy must stay unknown')
      assert.equal(row.remaining, undefined, 'Elapsed time is not historical remaining capacity')
      assert.equal(row.endedAt, undefined)
    }
    historical.failures.changed = 4; active.pending.changed = 9
    assert.equal(restored.history().find(row => row.taskId === old.taskId).failures.changed, undefined)
    assert.equal(restored.history().find(row => row.taskId === current.taskId).pending.changed, undefined)
    assert.deepEqual(restored.all().map(row => row.taskId), [current.taskId])
    assert.deepEqual(restored.reports().map(row => row.taskId), [current.taskId])
    assert.equal(restored.status('shared').taskId, current.taskId)
    assert.equal(JSON.parse(readFileSync(file)).sessions.shared, pointer)
    assert.deepEqual(readFileSync(file), before, 'History reads must not migrate or rewrite the budget file')
  } finally { removeFixture(dir) }
})
