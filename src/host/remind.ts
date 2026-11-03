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
 * @module @dsh-external/dsh-butler/host/remind
 */
import type { ScheduleService } from './ctx.ts'

/** A concrete reminder request, already past the clarity check. */
export interface ConcreteReminder {
  /** Required by the scheduler; a blank title is refused as `invalid_prompt`. */
  title: string
  /** Body delivered when the reminder fires. */
  prompt: string
  /** Confirmed instant: ISO with offset, or `YYYY-MM-DDTHH:mm`. */
  at: string
  /** IANA zone the wall-clock time is read in. */
  timeZone: string
}

/** Parse a confirmed time string into the scheduler's `at` form. */
function toAt(at: string, timeZone: string): string | { date: string; time: string; time_zone: string } {
  const offset = /[+-]\d{2}:?\d{2}$|Z$/.test(at)
  if (offset) return at
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(at)
  if (match === null) return at
  const [, date, time, seconds] = match
  return { date: date as string, time: seconds === undefined ? `${time}:00` : `${time}:${seconds}`, time_zone: timeZone }
}

/**
 * Create one reminder.
 * @param schedule - the scheduler service.
 * @param sessionId - session the reminder is bound to.
 * @param reminder - a confirmed reminder.
 * @returns the stored rule, including its id and committed target instant.
 */
export async function scheduleCreate(
  schedule: ScheduleService,
  sessionId: string,
  reminder: ConcreteReminder,
): Promise<{ id: string; scheduledAt?: string; raw: unknown }> {
  const record = await schedule.create(sessionId, {
    title: reminder.title,
    prompt: reminder.prompt,
    at: toAt(reminder.at, reminder.timeZone),
  })
  return {
    id: record.id,
    ...(record.scheduledAt === undefined ? {} : { scheduledAt: record.scheduledAt }),
    raw: record,
  }
}

/**
 * Cancel one reminder by id.
 *
 * The service addresses a reminder by (session, id) and never activates the
 * session, so the bound session id has to travel with the request.
 *
 * @param schedule - the scheduler service.
 * @param sessionId - session the reminder is bound to.
 * @param id - the reminder id.
 * @returns the service's delete result, including `deleted: false` when it missed.
 */
export async function scheduleDelete(
  schedule: ScheduleService,
  sessionId: string,
  id: string,
): Promise<{ id: string; deleted: boolean; code?: string }> {
  return schedule.delete({ sessionId, id })
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
