/**
 * 自然语言时间 → 具体提醒时间。
 *
 * 管家的一条硬规矩：时间必须先确认成具体时刻，绝不让含糊说法进调度器。所以
 * 这里不做"猜一个大概"，而是清楚地分成三种结果：
 *
 * - `timing`：能唯一确定（一次性时刻 / 相对时长 / 每天 / 每周）；
 * - `ambiguous`：缺信息（"明天"没有时间、"上午"没有钟点）或已过去；
 * - 默认值：像单独给了 `20:00` 这种，按"最近的未来一次"解释，并标 `defaulted`
 *   让上层提示里可以说清楚。
 *
 * 时区按传入 IANA 时区解释墙上时间；返回的 `at` 是绝对时刻（UTC ISO），
 * `local` 保留日期/时间/时区，供调度器的 LocalAtInput 使用。
 *
 * @module @dsh-external/dsh-butler/host/time-parse
 */

/** 一次性触发：绝对时刻 + 原始墙上时间。 */
export interface AtTiming {
  kind: 'at'
  /** UTC ISO instant. */
  at: string
  /** Wall-clock form accepted by the scheduler's LocalAtInput. */
  local: { date: string; time: string; time_zone: string }
}

/** 相对时长触发。 */
export interface AfterTiming {
  kind: 'after'
  afterSeconds: number
}

/** 每天同一钟点。 */
export interface DailyTiming {
  kind: 'daily'
  time: string
  time_zone: string
}

/** 每周若干天（0=周日 … 6=周六，与 `Date.getDay()` 一致）。 */
export interface WeeklyTiming {
  kind: 'weekly'
  time: string
  weekdays: number[]
  time_zone: string
}

/** The timing union accepted by the reminder entry point. */
export type ButlerTiming = AtTiming | AfterTiming | DailyTiming | WeeklyTiming

/** Why a phrase could not be turned into one concrete time. */
export interface Ambiguity {
  /** Human-readable reason, safe to show back to the owner. */
  reason: string
  /** What the owner could add to disambiguate, e.g. `具体钟点`. */
  missing: string[]
}

/** Parse result. */
export interface ParsedTime {
  /** Present only when the phrase resolves to one concrete schedule. */
  timing?: ButlerTiming
  /** `defaulted` when a missing date was filled with the nearest future slot. */
  confidence: 'exact' | 'defaulted'
  /** Human-readable notes about defaults or normalisation, shown with the reminder. */
  notes: string[]
  /** Present when no single time can be derived. */
  ambiguous?: Ambiguity
}

/** Parse options. */
export interface ParseTimeOptions {
  /** Reference instant; defaults to `new Date()`. */
  now?: Date
  /** IANA zone the phrase is read in. */
  timeZone: string
}

const WEEKDAY_CHARS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 半: 0.5 }
const MAX_AHEAD_MS = 10 * 365 * 24 * 3600 * 1000

/** Convert a Chinese numeral (0-99) or Arabic digits; `undefined` when unreadable. */
export function parseNumberToken(token: string): number | undefined {
  const text = token.trim()
  if (text === '') return undefined
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (text === '半') return 0.5
  const ten = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(text)
  if (ten !== null) return (ten[1] === undefined ? 1 : CN_DIGITS[ten[1]]!) * 10 + (ten[2] === undefined ? 0 : CN_DIGITS[ten[2]]!)
  if (text.length === 1 && CN_DIGITS[text] !== undefined) return CN_DIGITS[text]
  return undefined
}

/** Full-width digits / colons → ASCII, trim, collapse spaces. */
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .trim()
}

interface WallClockParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** Wall-clock fields of one instant in a zone. */
function partsInZone(epochMs: number, timeZone: string): WallClockParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  const read = (type: string): number => {
    const value = parts.find(part => part.type === type)?.value ?? '0'
    return Number(value === '24' ? '0' : value)
  }
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') }
}

/**
 * Interpret wall-clock fields in a zone as one absolute instant.
 *
 * Uses two offset probes so a DST edge either resolves to the requested wall
 * time or fails closed instead of silently landing an hour off.
 * @param wall - wall-clock fields.
 * @param timeZone - IANA zone.
 * @returns epoch milliseconds.
 */
function zonedToEpoch(wall: WallClockParts, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  let guess = asUtc
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const seen = partsInZone(guess, timeZone)
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second)
    // The zone offset at the guess; subtracting it from the requested wall-clock
    // (read as UTC) yields the epoch that displays that wall clock in the zone.
    const offset = seenAsUtc - guess
    const next = asUtc - offset
    if (next === guess) return guess
    guess = next
  }
  return guess
}

/** `YYYY-MM-DD` of a wall clock. */
function wallDate(wall: WallClockParts): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`
}

/** `HH:mm` of a wall clock. */
function wallTime(wall: WallClockParts): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(wall.hour)}:${pad(wall.minute)}`
}

/** Weekday of a calendar date, 0=Sunday. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** Days in a month. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Add days to a calendar date without timezone drift. */
function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

/** A date phrase resolved against the reference day. */
interface ResolvedDate {
  year: number
  month: number
  day: number
  /** How the date was obtained, for the note list. */
  via: 'explicit' | 'today' | 'tomorrow' | 'day-after' | 'weekday' | 'nearest'
  /** Days added by a weekday expression, used for past-checks. */
  adjusted?: boolean
}

const DAY_OFFSETS: Array<{ pattern: RegExp; offset: number; via: ResolvedDate['via'] }> = [
  { pattern: /(^|[^大小])后天/, offset: 2, via: 'day-after' },
  { pattern: /大后天/, offset: 3, via: 'day-after' },
  { pattern: /明天|明日|明早|明晚|明儿/, offset: 1, via: 'tomorrow' },
  { pattern: /今天|今日|今晚|今早|今儿/, offset: 0, via: 'today' },
]

/** Time-of-day defaults for dayparts that often appear without a clock. */
const DAYPART_DEFAULT: Array<{ pattern: RegExp; hour: number; minute: number; note: string }> = [
  { pattern: /凌晨/, hour: 5, minute: 0, note: '凌晨按 05:00' },
  { pattern: /早上|早晨|清晨|上午|明早|今早/, hour: 9, minute: 0, note: '上午按 09:00' },
  { pattern: /中午|正午/, hour: 12, minute: 0, note: '中午按 12:00' },
  { pattern: /下午/, hour: 14, minute: 0, note: '下午按 14:00' },
  { pattern: /傍晚/, hour: 18, minute: 0, note: '傍晚按 18:00' },
  { pattern: /晚上|晚间|夜里|夜晚|明晚|今晚|晚/, hour: 20, minute: 0, note: '晚上按 20:00' },
]

/** Timed clock expression. */
interface ResolvedClock {
  hour: number
  minute: number
  /** Explicit clock versus filled from a daypart default. */
  explicit: boolean
}

/**
 * Parse one clock expression from the phrase.
 * @param text - normalised phrase.
 * @returns the clock, when one was stated.
 */
function parseClock(text: string): ResolvedClock | undefined {
  // 20:30 / 8:05
  const colon = /(\d{1,2}):(\d{2})/.exec(text)
  if (colon !== null) {
    const hour = Number(colon[1]), minute = Number(colon[2])
    if (hour <= 23 && minute <= 59) return { hour, minute, explicit: true }
  }
  // 8点半 / 8点15分 / 8点 / 8时
  const dotted = /(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点時时]\s*(半|一刻|三刻|\d{1,2}|[一二两三四五六七八九十]{1,3})?\s*分?/.exec(text)
  if (dotted !== null) {
    const hour = parseNumberToken(dotted[1]!)
    if (hour !== undefined && hour <= 23) {
      const rest = dotted[2]
      let minute = 0
      if (rest === '半') minute = 30
      else if (rest === '一刻') minute = 15
      else if (rest === '三刻') minute = 45
      else if (rest !== undefined) {
        const parsed = parseNumberToken(rest)
        if (parsed === undefined || parsed > 59) return undefined
        minute = parsed
      }
      return { hour, minute, explicit: true }
    }
  }
  return undefined
}

/** Apply 上午/下午/晚上 to a 12-hour clock reading. */
function applyDaypart(hour: number, text: string): number {
  if (/下午|傍晚|晚上|晚间|夜里|夜晚|晚/.test(text) && hour < 12) return hour + 12
  if (/凌晨/.test(text) && hour === 12) return 0
  if (/中午/.test(text) && hour < 11) return hour + 12
  return hour
}

/** Resolve the date part of the phrase. */
function parseDate(text: string, now: WallClockParts): ResolvedDate | undefined {
  // 2026-12-01 / 2026/12/01
  const iso = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text)
  if (iso !== null) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), via: 'explicit' }
  // 11月8日 / 11月8号
  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text)
  if (monthDay !== null) {
    const month = Number(monthDay[1]), day = Number(monthDay[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(now.year, month)) return { year: now.year, month, day, via: 'explicit' }
    return undefined
  }
  // 25号 (within the current month; rolls to next month when already past)
  const dayOnly = /(^|[^\d月])(\d{1,2})\s*[日号]/.exec(text)
  if (dayOnly !== null) {
    const day = Number(dayOnly[2])
    if (day >= 1) {
      if (day >= now.day && day <= daysInMonth(now.year, now.month)) return { year: now.year, month: now.month, day, via: 'explicit' }
      const next = addDays({ year: now.year, month: now.month, day: 1 }, daysInMonth(now.year, now.month))
      if (day <= daysInMonth(next.year, next.month)) return { year: next.year, month: next.month, day, via: 'explicit' }
    }
    return undefined
  }
  // 周X / 星期X / 礼拜X, with optional 下/本/这
  const weekday = /(下|本|这)?(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text)
  if (weekday !== null) {
    const target = WEEKDAY_CHARS[weekday[2]!]!
    const today = weekdayOf(now.year, now.month, now.day)
    const prefix = weekday[1]
    let delta: number
    if (prefix === '下') {
      // 下一自然周（周一为一周之始）里的目标星期。
      const daysToNextMonday = (1 - today + 7) % 7
      delta = daysToNextMonday + (target === 0 ? 6 : target - 1)
    } else {
      delta = (target - today + 7) % 7
    }
    const date = addDays({ year: now.year, month: now.month, day: now.day }, delta)
    return { ...date, via: 'weekday' }
  }
  for (const entry of DAY_OFFSETS) {
    if (entry.pattern.test(text)) {
      const date = addDays({ year: now.year, month: now.month, day: now.day }, entry.offset)
      return { ...date, via: entry.via }
    }
  }
  return undefined
}

/** One-shot wall-clock target plus a note about how the date was chosen. */
interface OneShotTarget {
  wall: WallClockParts
  notes: string[]
  confidence: ParsedTime['confidence']
  /** How the date was obtained; a bare weekday may roll forward when past. */
  via?: ResolvedDate['via']
}

/** Build one concrete instant from date + clock info. */
function oneShot(date: ResolvedDate | undefined, clock: ResolvedClock | undefined, text: string, now: WallClockParts): OneShotTarget | undefined {
  const notes: string[] = []
  let confidence: ParsedTime['confidence'] = 'exact'
  let resolved = date
  let chosenClock = clock
  if (chosenClock !== undefined) {
    const adjusted = applyDaypart(chosenClock.hour, text)
    if (adjusted !== chosenClock.hour) chosenClock = { ...chosenClock, hour: adjusted }
  }
  if (resolved === undefined) {
    // No date stated: if a clock was stated, take the nearest future slot.
    if (chosenClock === undefined) return undefined
    confidence = 'defaulted'
    notes.push('未给日期，按最近一次的未来时间')
    resolved = { year: now.year, month: now.month, day: now.day, via: 'nearest' }
  }
  if (chosenClock === undefined) {
    // No clock stated: a daypart default is allowed but marked.
    const daypart = DAYPART_DEFAULT.find(entry => entry.pattern.test(text))
    if (daypart === undefined) return undefined
    chosenClock = { hour: daypart.hour, minute: daypart.minute, explicit: false }
    confidence = 'defaulted'
    notes.push(`${daypart.note}（未给具体钟点）`)
  }
  return {
    wall: { year: resolved.year, month: resolved.month, day: resolved.day, hour: chosenClock.hour, minute: chosenClock.minute, second: 0 },
    notes,
    confidence,
    via: resolved.via,
  }
}

/** Convert one wall clock to a one-shot timing, refusing past instants. */
function toAtTiming(target: OneShotTarget, now: Date, timeZone: string): { timing?: AtTiming; notes?: string[]; reason?: string } {
  const epoch = zonedToEpoch(target.wall, timeZone)
  if (epoch <= now.getTime()) {
    // A bare weekday that already passed, or a clock-only phrase earlier today,
    // rolls forward once instead of failing: both were meant as "the next one".
    const rollDays = target.notes.some(note => note.includes('最近一次')) ? 1 : target.via === 'weekday' ? 7 : 0
    if (rollDays > 0) {
      const next = { ...target.wall, ...addDays({ year: target.wall.year, month: target.wall.month, day: target.wall.day }, rollDays) }
      const rolled = zonedToEpoch(next, timeZone)
      return {
        timing: { kind: 'at', at: new Date(rolled).toISOString(), local: { date: wallDate(next), time: wallTime(next), time_zone: timeZone } },
        notes: [rollDays === 7 ? '该星期已过，按下一个周期' : '今天该时刻已过，按明天'],
      }
    }
    return { reason: '这个时间已经过去了' }
  }
  if (epoch - now.getTime() > MAX_AHEAD_MS) return { reason: '时间太远了（超过 10 年）' }
  return { timing: { kind: 'at', at: new Date(epoch).toISOString(), local: { date: wallDate(target.wall), time: wallTime(target.wall), time_zone: timeZone } } }
}

/** Parse the relative-duration forms: 20分钟后 / 2小时之后 / 3天后. */
function parseAfter(text: string): AfterTiming | undefined {
  const match = /(半|[一二两三四五六七八九十]+|\d+(?:\.\d+)?)\s*(分钟|分|个小时|小时|钟头|天|周|星期)\s*(?:之后|以后|后)/.exec(text)
  if (match === null) return undefined
  const amount = parseNumberToken(match[1]!)
  if (amount === undefined) return undefined
  const unit = match[2]!
  const seconds = unit === '分钟' || unit === '分' ? amount * 60
    : unit === '个小时' || unit === '小时' || unit === '钟头' ? amount * 3600
      : unit === '天' ? amount * 86400
        : amount * 7 * 86400
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return { kind: 'after', afterSeconds: Math.round(seconds) }
}

/** Parse a weekly recurrence: 每周一三五 20:00. */
function parseWeekly(text: string, timeZone: string): WeeklyTiming | Ambiguity | undefined {
  const match = /每\s*(?:周|星期|礼拜)\s*([一二三四五六日天0-9]+)/.exec(text)
  if (match === null) return undefined
  const weekdays = new Set<number>()
  for (const char of match[1]!) {
    if (/\d/.test(char)) {
      const value = Number(char)
      if (value >= 0 && value <= 6) weekdays.add(value === 7 ? 0 : value)
    } else if (WEEKDAY_CHARS[char] !== undefined) weekdays.add(WEEKDAY_CHARS[char]!)
  }
  if (weekdays.size === 0) return { reason: '没看懂每周几', missing: ['周几（例如 周一、周三）'] }
  const clock = parseClock(text)
  if (clock === undefined) return { reason: '每周提醒缺具体钟点', missing: ['具体钟点（例如 每周一 20:00）'] }
  const hour = applyDaypart(clock.hour, text)
  return { kind: 'weekly', time: `${String(hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`, weekdays: [...weekdays].sort((a, b) => a - b), time_zone: timeZone }
}

/** Parse a daily recurrence: 每天 20:00 / 每晚8点. */
function parseDaily(text: string, timeZone: string): DailyTiming | Ambiguity | undefined {
  if (!/每\s*(?:天|日|晚|早|上午|中午|下午|晚上|早上)/.test(text)) return undefined
  let clock = parseClock(text)
  if (clock === undefined) {
    const daypart = DAYPART_DEFAULT.find(entry => entry.pattern.test(text))
    if (daypart !== undefined) clock = { hour: daypart.hour, minute: daypart.minute, explicit: false }
  }
  if (clock === undefined) return { reason: '每天提醒缺具体钟点', missing: ['具体钟点（例如 每天 20:00）'] }
  const hour = applyDaypart(clock.hour, text)
  return { kind: 'daily', time: `${String(hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`, time_zone: timeZone }
}

/**
 * Parse one reminder phrase into a concrete timing, or explain what is missing.
 * @param text - owner phrase, e.g. `明早8点半提醒我吃药`.
 * @param options - reference instant and zone.
 * @returns parsed timing or an ambiguity explanation.
 */
export function parseReminderTime(text: string, options: ParseTimeOptions): ParsedTime {
  const raw = typeof text === 'string' ? normalize(text) : ''
  if (raw === '') return { confidence: 'defaulted', notes: [], ambiguous: { reason: '没有时间信息', missing: ['日期与钟点'] } }
  const now = options.now ?? new Date()
  const nowWall = partsInZone(now.getTime(), options.timeZone)

  // 过去的时间不能静默改成"最近的未来"：说清原因让上层追问。
  if (/昨天|昨日|前天|前日|上周|上个?星期|上个?礼拜|去年|前年/.test(raw)) {
    return { confidence: 'defaulted', notes: [], ambiguous: { reason: '这是过去的时间', missing: ['未来的日期与钟点'] } }
  }

  const after = parseAfter(raw)
  if (after !== undefined) return { timing: after, confidence: 'exact', notes: [] }

  const daily = parseDaily(raw, options.timeZone)
  if (daily !== undefined) return 'reason' in daily ? { confidence: 'defaulted', notes: [], ambiguous: daily } : { timing: daily, confidence: 'exact', notes: [] }

  const weekly = parseWeekly(raw, options.timeZone)
  if (weekly !== undefined) return 'reason' in weekly ? { confidence: 'defaulted', notes: [], ambiguous: weekly } : { timing: weekly, confidence: 'exact', notes: [] }

  if (/每\s*(?:个)?月/.test(raw)) return { confidence: 'defaulted', notes: [], ambiguous: { reason: '暂不支持每月重复', missing: ['改用具体日期或每周重复'] } }

  const date = parseDate(raw, nowWall)
  const clock = parseClock(raw)
  const target = oneShot(date, clock, raw, nowWall)
  if (target === undefined) {
    return { confidence: 'defaulted', notes: [], ambiguous: { reason: '缺日期或钟点，无法确定具体时间', missing: date === undefined ? ['日期（今天/明天/周几/几号）', '钟点'] : ['钟点'] } }
  }
  const at = toAtTiming(target, now, options.timeZone)
  if (at.timing === undefined) {
    return { confidence: 'defaulted', notes: target.notes, ambiguous: { reason: at.reason ?? '时间已过去', missing: ['未来的日期与钟点'] } }
  }
  const notes = [...target.notes, ...(at.notes ?? [])]
  return { timing: at.timing, confidence: notes.length === 0 ? target.confidence : 'defaulted', notes }
}
