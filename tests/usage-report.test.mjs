/**
 * 用量日报：本地时区切日、窗口补零、已计价/未计价/无用量三类覆盖、窗口裁剪。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'usage-report-'))
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
process.env.DSH_BUTLER_HOME = join(root, 'state')

const { ensureVault } = await import('../src/host/vault.ts')
const { addUsage } = await import('../src/host/ledger.ts')
const { usageReport } = await import('../src/host/usage-report.ts')
ensureVault()

after(() => {
  assert.ok(realpathSync(root).startsWith(realpathSync(base) + sep))
  rmSync(root, { recursive: true, force: true })
})

test('daily buckets use the local zone and classify cost coverage honestly', () => {
  addUsage({ at: '2026-11-07T03:00:00.000Z', callId: 'c-today-priced', inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.01 })
  addUsage({ at: '2026-11-07T04:00:00.000Z', callId: 'c-today-unpriced', inputTokens: 2, outputTokens: 1 })
  addUsage({ at: '2026-11-06T03:00:00.000Z', callId: 'c-yesterday-missing' })
  addUsage({ at: '2026-11-01T03:00:00.000Z', callId: 'c-old', inputTokens: 99, outputTokens: 1, cost: 9.99 })

  const report = usageReport({ days: 3, timeZone: 'Asia/Shanghai', now: new Date('2026-11-07T12:00:00+08:00') })
  assert.equal(report.days, 3)
  assert.equal(report.fromDate, '2026-11-05')
  assert.equal(report.toDate, '2026-11-07')
  assert.deepEqual(report.daily.map(day => day.date), ['2026-11-05', '2026-11-06', '2026-11-07'])
  assert.equal(report.daily[0].calls, 0, 'empty days are zero-filled')

  const today = report.daily[2]
  assert.equal(today.calls, 2)
  assert.equal(today.totalTokens, 18)
  assert.equal(today.pricedCalls, 1)
  assert.equal(today.unpricedCalls, 1)
  assert.equal(today.cost, 0.01)
  assert.equal(report.daily[1].missingCalls, 1)
  assert.equal(report.daily[1].calls, 1)

  assert.equal(report.totals.calls, 3)
  assert.equal(report.totals.cost, 0.01)
  assert.deepEqual(report.coverage, { priced: 1, unpriced: 1, missing: 1 })
  assert.match(report.note, /不是账单/)
})

test('the window is clamped to 1..90 days', () => {
  const long = usageReport({ days: 999, timeZone: 'Asia/Shanghai', now: new Date('2026-11-07T12:00:00+08:00') })
  assert.equal(long.days, 90)
  assert.equal(long.daily.length, 90)
  const short = usageReport({ days: 0, timeZone: 'Asia/Shanghai', now: new Date('2026-11-07T12:00:00+08:00') })
  assert.equal(short.days, 1)
  assert.equal(short.daily.length, 1)
  assert.equal(short.daily[0].date, '2026-11-07')
})
