/**
 * 用量与费用日报（按天聚合）。
 *
 * 口径写死在这里，避免页面各自解释：
 * - tokens 以 provider 上报的 `totalTokens` 为准，缺失时用 input+output 兜底；
 * - 费用只用账本里已计价行求和，并在 `coverage` 里明确"已计价/未计价/无用量"
 *   三类调用数 —— 估算不冒充账单；
 * - 按本地时区切日（和 daily 页一致），最多 90 天，缺失的日期补 0 行。
 *
 * @module @dsh-external/dsh-butler/host/usage-report
 */
import { usageRecords, type Usage } from './ledger.ts'
import { localDate } from './vault.ts'

/** One day of usage. */
export interface UsageDay {
  date: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Sum of priced rows only. */
  cost: number
  pricedCalls: number
  /** Rows carrying priceable usage but no cost. */
  unpricedCalls: number
  /** Rows without any usage payload (unknown, not zero). */
  missingCalls: number
}

/** A complete report. */
export interface UsageReport {
  days: number
  fromDate: string
  toDate: string
  timeZone: string
  /** Oldest → newest, one row per day (zero-filled). */
  daily: UsageDay[]
  totals: UsageDay
  coverage: { priced: number; unpriced: number; missing: number }
  note: string
}

/** Whether a row carries any usage amount at all. */
function hasUsage(row: Usage): boolean {
  return [row.inputTokens, row.outputTokens, row.totalTokens, row.cacheReadTokens, row.cacheWriteTokens]
    .some(value => typeof value === 'number' && Number.isFinite(value))
}

/** Build one zero day. */
function emptyDay(date: string): UsageDay {
  return { date, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, pricedCalls: 0, unpricedCalls: 0, missingCalls: 0 }
}

/** Add one ledger row into a day bucket. */
function addRow(day: UsageDay, row: Usage): void {
  day.calls += 1
  day.inputTokens += row.inputTokens ?? 0
  day.outputTokens += row.outputTokens ?? 0
  day.totalTokens += row.totalTokens ?? ((row.inputTokens ?? 0) + (row.outputTokens ?? 0))
  if (row.cost !== undefined) {
    day.cost += row.cost
    day.pricedCalls += 1
  } else if (hasUsage(row)) {
    day.unpricedCalls += 1
  } else {
    day.missingCalls += 1
  }
}

/** Shift a `YYYY-MM-DD` string by whole days. */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10)
}

/** Sum day buckets into the report totals. */
function sumDays(days: UsageDay[]): UsageDay {
  const total = emptyDay('total')
  for (const day of days) {
    total.calls += day.calls
    total.inputTokens += day.inputTokens
    total.outputTokens += day.outputTokens
    total.totalTokens += day.totalTokens
    total.cost += day.cost
    total.pricedCalls += day.pricedCalls
    total.unpricedCalls += day.unpricedCalls
    total.missingCalls += day.missingCalls
  }
  return total
}

/**
 * Build a daily usage/cost report.
 * @param options - window size, time zone and clock.
 * @returns daily rows (zero-filled), totals and explicit cost coverage.
 */
export function usageReport(options: { days?: number; timeZone?: string; now?: Date } = {}): UsageReport {
  const days = Math.max(1, Math.min(90, Math.floor(options.days ?? 14)))
  const timeZone = options.timeZone ?? 'Asia/Shanghai'
  const now = options.now ?? new Date()
  const toDate = localDate(now, timeZone)
  const fromDate = shiftDate(toDate, -(days - 1))
  const buckets = new Map<string, UsageDay>()
  for (let offset = 0; offset < days; offset += 1) {
    const date = shiftDate(fromDate, offset)
    buckets.set(date, emptyDay(date))
  }
  for (const row of usageRecords()) {
    const at = Date.parse(row.at)
    if (!Number.isFinite(at)) continue
    const date = localDate(new Date(at), timeZone)
    const bucket = buckets.get(date)
    if (bucket === undefined) continue
    addRow(bucket, row)
  }
  const daily = [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date))
  const totals = sumDays(daily)
  return {
    days, fromDate, toDate, timeZone, daily, totals,
    coverage: { priced: totals.pricedCalls, unpriced: totals.unpricedCalls, missing: totals.missingCalls },
    note: '费用按本机已发布价格表估算，不是账单；未计价/无用量调用只计调用数，不计费用。',
  }
}
