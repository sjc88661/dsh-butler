/**
 * Reminder plumbing over DSH's own scheduler.
 *
 * No reminder engine is built here on purpose: the harness already has a
 * `schedule` service with persisted rules, delivery receipts, and cancellation,
 * and it keeps firing while no browser is open. Re-implementing that would add a
 * second source of truth for "did the reminder actually arrive", which is the
 * one thing the owner asked to be able to check.
 *
 * What this module adds is only the part the owner's checklist is strict about:
 * times must be confirmed, so an ambiguous phrase never reaches the scheduler.
 *
 * DSH 0.2.2 reshaped the service: `create(request, actorSessionId?)` with one
 * tagged `timing`, a catalog-wide `target`, `edit({ action: 'delete' })`
 * cancellation and target-based delivery history. The small adapters below keep
 * that contract in one place instead of repeating it across the reminder code.
 *
 * @module @dsh-external/dsh-butler/host/remind
 */
import type {
  ButlerReminderSummary,
  ScheduleCatalogEntry,
  ScheduleDeleteResult,
  ScheduleDeliveryReceipt,
  ScheduleDeliveryRetention,
  ScheduleService,
  ScheduleStatus,
  ScheduleTarget,
  ScheduleTiming,
  ScheduleTargetRequest,
} from './ctx.ts'

/** A concrete reminder request, already past the clarity check. */
export interface ConcreteReminder {
  /** Required by the scheduler; a blank title is refused as `invalid_prompt`. */
  title: string
  /** Body delivered when the reminder fires. */
  prompt: string
  /**
   * Legacy confirmed one-shot instant: ISO with offset, or `YYYY-MM-DDTHH:mm`.
   * Required unless {@link timing} is supplied; when both are present `timing`
   * wins (the reminder-operations entrance rejects that combination anyway).
   */
  at?: string
  /** IANA zone the wall-clock time is read in. */
  timeZone: string
  /**
   * 0.2.2 tagged timing rule. Supports one-shot (`at`, `after`) and recurring
   * (`daily`, `weekly`, plus the other service variants) rules so P1 can pass
   * an explicit repeat without another contract change.
   */
  timing?: ScheduleTiming
}

/** The host-side slice of `schedule.create`'s result the butler records. */
export interface ReminderReceipt {
  id: string
  scheduledAt?: string
  /** Native kind/status kept verbatim so the rule shape is never lost. */
  kind?: string
  status?: ScheduleStatus
  raw: ScheduleCatalogEntry
}

/** The host-side slice of `schedule.edit`'s delete result the butler records. */
export interface ReminderDeleteReceipt {
  id: string
  deleted: boolean
  code?: string
}

const OFFSET = /[+-]\d{2}:?\d{2}$|Z$/
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/
const WALL_CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * Whether a string is a concrete calendar instant the butler can commit to.
 *
 * Ambiguous phrases never reach the scheduler, so "tomorrow" fails here; the
 * parse is deliberately strict about real calendar days (no Feb 30) because a
 * silent rollover would schedule the wrong day.
 */
export function concreteTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const [, year, month, day, hour, minute, second] = match
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days
    && Number(hour) <= 23 && Number(minute) <= 59 && (second === undefined || Number(second) <= 59)
}

/** Whether an IANA zone name is usable by the host clock formatting. */
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
}

const positiveSeconds = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(value * 1000)
const wallClock = (value: unknown): boolean => typeof value === 'string' && WALL_CLOCK.test(value)

/**
 * Whether a value is one of the 0.2.2 timing variants.
 *
 * Validation mirrors what the scheduler refuses so an obviously invalid rule
 * never becomes an "uncertain create"; the scheduler stays the final authority.
 */
export function validTiming(value: unknown): value is ScheduleTiming {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const timing = value as Record<string, unknown>
  switch (timing['kind']) {
    case 'after': return positiveSeconds(timing['after_seconds'])
    case 'every': return positiveSeconds(timing['every_seconds'])
    case 'at': {
      const at = timing['at']
      if (typeof at === 'string') return concreteTime(at)
      if (at === null || typeof at !== 'object' || Array.isArray(at)) return false
      const local = at as Record<string, unknown>
      return typeof local['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(local['date'])
        && wallClock(local['time']) && validTimeZone(local['time_zone'])
    }
    case 'daily': {
      const daily = timing['daily']
      return daily !== null && typeof daily === 'object' && !Array.isArray(daily)
        && wallClock((daily as Record<string, unknown>)['time']) && validTimeZone((daily as Record<string, unknown>)['time_zone'])
    }
    case 'weekly': {
      const weekly = timing['weekly']
      if (weekly === null || typeof weekly !== 'object' || Array.isArray(weekly)) return false
      const rule = weekly as Record<string, unknown>
      return wallClock(rule['time']) && validTimeZone(rule['time_zone']) && Array.isArray(rule['weekdays'])
        && rule['weekdays'].length > 0 && rule['weekdays'].every(day => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 7)
    }
    case 'cron': {
      const cron = timing['cron']
      return cron !== null && typeof cron === 'object' && !Array.isArray(cron)
        && typeof (cron as Record<string, unknown>)['expression'] === 'string'
        && String((cron as Record<string, unknown>)['expression']).trim() !== ''
        && validTimeZone((cron as Record<string, unknown>)['time_zone'])
    }
    case 'rrule': return typeof timing['rrule'] === 'string' && timing['rrule'].trim() !== ''
    default: return false
  }
}

/** Parse a confirmed time string into the scheduler's `at` form. */
function toAt(at: string, timeZone: string): string | { date: string; time: string; time_zone: string } {
  if (OFFSET.test(at)) return at
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(at)
  if (match === null) return at
  const [, date, time, seconds] = match
  return { date: date as string, time: seconds === undefined ? `${time}:00` : `${time}:${seconds}`, time_zone: timeZone }
}

/** Map a butler reminder (legacy `at` or explicit `timing`) onto one 0.2.2 timing. */
export function reminderTiming(reminder: ConcreteReminder): ScheduleTiming {
  if (reminder.timing !== undefined) return structuredClone(reminder.timing)
  return { kind: 'at', at: toAt(reminder.at ?? '', reminder.timeZone) }
}

/**
 * Create one reminder through the 0.2.2 contract.
 *
 * @param schedule - the scheduler service.
 * @param actorSessionId - the butler conversation that asked (recorded as an
 *   involved Session by the scheduler); `undefined` for a host-only caller.
 * @param targetSessionId - the existing isolated reminder session deliveries go to.
 * @param reminder - a confirmed reminder.
 * @returns the stored rule, including its id, committed target instant and raw receipt.
 */
export async function scheduleCreate(
  schedule: ScheduleService,
  actorSessionId: string | undefined,
  targetSessionId: string,
  reminder: ConcreteReminder,
): Promise<ReminderReceipt> {
  const target: ScheduleTargetRequest = { kind: 'session', sessionId: targetSessionId }
  const record = await schedule.create({
    title: reminder.title,
    prompt: reminder.prompt,
    timing: reminderTiming(reminder),
    target,
  }, actorSessionId)
  return {
    id: record.id,
    ...(record.scheduledAt === undefined ? {} : { scheduledAt: record.scheduledAt }),
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    ...(record.status === undefined ? {} : { status: record.status }),
    raw: record,
  }
}

/**
 * Decide whether an `edit` answer is a delete outcome rather than an updated
 * task or a miss/conflict; only the delete branch carries `deleted`.
 */
function isDeleteResult(value: unknown): value is ScheduleDeleteResult {
  return value !== null && typeof value === 'object' && 'deleted' in value
}

/**
 * Cancel one reminder by id through `schedule.edit({ action: 'delete' })`.
 *
 * DSH 0.2.2 task ids are host-wide and deletion no longer takes a session id.
 *
 * @param schedule - the scheduler service.
 * @param id - the reminder id.
 * @returns the service's delete result, including `deleted: false` when it missed.
 */
export async function scheduleDelete(
  schedule: Pick<ScheduleService, 'edit'>,
  id: string,
): Promise<ReminderDeleteReceipt> {
  const result = await schedule.edit({ id, action: 'delete' })
  if (isDeleteResult(result)) {
    return { id: result.id, deleted: result.deleted === true, ...(result.deleted === false ? { code: result.code } : {}) }
  }
  return { id, deleted: false, code: 'schedule_edit_unexpected' }
}

/**
 * The session a reminder delivers into, derived from the 0.2.2 `target`.
 *
 * `session` and `new_once` both carry the destination id; `new` creates the
 * session at delivery time and therefore has none. The legacy `sessionId` field
 * is read only for rows persisted by older builds.
 */
export function reminderTargetSession(entry: { target?: ScheduleTarget | ScheduleTargetRequest; sessionId?: string }): string | undefined {
  const target = entry.target
  const id = target !== undefined && 'sessionId' in target ? target.sessionId : undefined
  if (typeof id === 'string' && id !== '') return id
  return typeof entry.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : undefined
}

/**
 * Project one native catalog entry for the butler's existing client/tools.
 *
 * Kept host-side on purpose: the client and the API payload still declare the
 * historical `'active' | 'inactive'` status, so `paused`/`ended` must not leak
 * through as "still armed". Every native field is preserved; `rawStatus` keeps
 * the exact 0.2.2 status and `sessionId` is derived from `target`.
 */
export function projectReminder(entry: ScheduleCatalogEntry): ButlerReminderSummary {
  const { status, ...rest } = entry
  const sessionId = reminderTargetSession(entry)
  return {
    ...rest,
    status: status === 'active' ? 'active' : 'inactive',
    ...(status === undefined ? {} : { rawStatus: status }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(entry.target?.kind === undefined ? {} : { targetKind: entry.target.kind }),
  }
}

/** Project a whole catalog page/snapshot with {@link projectReminder}. */
export function projectReminderCatalog(entries: readonly ScheduleCatalogEntry[]): ButlerReminderSummary[] {
  return entries.map(entry => projectReminder(entry))
}

/** Map one native delivery record onto the butler's internal receipt shape. */
export function reminderDeliveryReceipt(record: ScheduleDeliveryReceipt): ScheduleDeliveryReceipt {
  return {
    ...(record.scheduledAt === undefined ? {} : { scheduledAt: record.scheduledAt }),
    ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
    ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
    ...(record.targetSessionId === undefined ? {} : { targetSessionId: record.targetSessionId }),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
  }
}

/** Retention/limit facts 0.2.2 history returns alongside its records. */
export interface ReminderHistoryLimits {
  earlierRecordsUnavailable?: boolean
  earlierRecordsPruned?: boolean
  retention?: ScheduleDeliveryRetention
  nextBefore?: string
}

/** Extract the non-record history facts, dropping anything malformed. */
export function reminderHistoryLimits(page: {
  earlierRecordsUnavailable?: unknown
  earlierRecordsPruned?: unknown
  retention?: unknown
  nextBefore?: unknown
}): ReminderHistoryLimits {
  const retention = page.retention
  const days = retention !== null && typeof retention === 'object' ? (retention as Record<string, unknown>)['days'] : undefined
  const records = retention !== null && typeof retention === 'object' ? (retention as Record<string, unknown>)['records'] : undefined
  return {
    ...(typeof page.earlierRecordsUnavailable === 'boolean' ? { earlierRecordsUnavailable: page.earlierRecordsUnavailable } : {}),
    ...(typeof page.earlierRecordsPruned === 'boolean' ? { earlierRecordsPruned: page.earlierRecordsPruned } : {}),
    ...(typeof days === 'number' || typeof records === 'number'
      ? { retention: { ...(typeof days === 'number' ? { days } : {}), ...(typeof records === 'number' ? { records } : {}) } }
      : {}),
    ...(typeof page.nextBefore === 'string' && page.nextBefore !== '' ? { nextBefore: page.nextBefore } : {}),
  }
}

/**
 * Whether a confirmed time is in the future.
 * @param at - confirmed instant.
 * @returns false when the time already passed, which the scheduler would refuse.
 */
export function isFuture(at: string): boolean {
  const parsed = Date.parse(at)
  return !Number.isNaN(parsed) && parsed > Date.now()
}
