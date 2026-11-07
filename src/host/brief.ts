/**
 * 每日简报：早报 08:30、晚报 21:30，自动写进当天 daily 页。
 *
 * 设计取舍：
 * - 纯函数 `composeBrief` 只吃普通数据，任何时间都能单测；
 * - 写盘走 `appendDaily`，同一份 daily 里同标题只写一次（重启/多次 tick 幂等）；
 * - 只做"汇总 + 建议"，不调用模型、不产生外部动作，失败从不抛到宿主。
 *
 * 触发方式（{@link installDailyBrief}）：插件激活时先补一次，之后每 15 分钟
 * 检查。桌面端宿主常在运行；错过的时段按窗口补写（早报窗口到 13:00、晚报到
 * 23:59），窗口外不写，避免凌晨突然出现一份"早报"。
 *
 * @module @dsh-external/dsh-butler/host/brief
 */
import { appendDaily, listTasks, readDaily, type TaskStatus } from './ledger.ts'
import { archivedReminderKeys, archivedTaskIds } from './archive.ts'
import { localDate } from './vault.ts'

/** One of the two daily briefs. */
export type BriefKind = 'morning' | 'evening'

/** Where each brief lands and when it becomes due on the local clock. */
export interface BriefSlot {
  kind: BriefKind
  hour: number
  minute: number
  /** Ends the catch-up window so a late start never writes at night. */
  untilHour: number
  heading: string
  label: string
}

/** The two fixed slots the owner approved. */
export const BRIEF_SLOTS: readonly BriefSlot[] = [
  { kind: 'morning', hour: 8, minute: 30, untilHour: 14, heading: '管家早报 08:30', label: '早报' },
  { kind: 'evening', hour: 21, minute: 30, untilHour: 24, heading: '管家晚报 21:30', label: '晚报' },
]

/** The task shape the brief needs; deliberately narrower than the full Task. */
export interface BriefTask {
  id: string
  title: string
  status: TaskStatus
  kind?: string
  dueAt?: string
  updatedAt?: string
}

/** One upcoming reminder, as the host projects it. */
export interface BriefReminder {
  title: string
  scheduledAt?: string
  status?: string
}

/** Everything one brief is composed from. */
export interface BriefSource {
  now: Date
  timeZone: string
  tasks: BriefTask[]
  reminders: BriefReminder[]
}

/** What one composed brief contains. */
export interface Brief {
  kind: BriefKind
  heading: string
  /** Markdown section body, ready to append after the daily heading. */
  markdown: string
  counts: {
    dueToday: number
    overdue: number
    waiting: number
    doneToday: number
    open: number
    dueTomorrow: number
    reminders: number
  }
}

/** Local wall-clock fields for one instant in a zone. */
function localClock(at: Date, timeZone: string): { date: string; hour: number; minute: number; weekday: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const parts = formatter.formatToParts(at)
  const read = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  const hour = Number(read('hour') === '24' ? '0' : read('hour'))
  return { date: `${read('year')}-${read('month')}-${read('day')}`, hour, minute: Number(read('minute')), weekday: read('weekday') }
}

/** Next calendar day of a `YYYY-MM-DD` string. */
function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1))
  return next.toISOString().slice(0, 10)
}

/** A local calendar day for one stored instant; unparsable values are ignored. */
function localDateOf(value: string | undefined, timeZone: string): string | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return undefined
  return localDate(new Date(parsed), timeZone)
}

/** Short list of titles, capped so one brief cannot become a wall of text. */
function titles(tasks: BriefTask[], limit = 5): string {
  const shown = tasks.slice(0, limit).map(task => `「${task.title}」`)
  return shown.join('、') + (tasks.length > limit ? ` 等 ${tasks.length} 项` : '')
}

/** Open-ish statuses that still want the owner's attention. */
const WAITING_STATUSES = new Set<TaskStatus>(['waiting_review', 'interrupted'])
const OPEN_STATUSES = new Set<TaskStatus>(['pending', 'running', 'waiting_review', 'interrupted'])
const DONE_STATUSES = new Set<TaskStatus>(['done'])

/**
 * Compose one brief from plain data.
 * @param kind - morning or evening.
 * @param source - tasks, reminders and the clock to describe.
 * @returns the markdown section and its headline counts.
 */
export function composeBrief(kind: BriefKind, source: BriefSource): Brief {
  const slot = BRIEF_SLOTS.find(entry => entry.kind === kind)!
  const today = localClock(source.now, source.timeZone).date
  const tomorrow = nextDate(today)
  const tasks = source.tasks
  const open = tasks.filter(task => OPEN_STATUSES.has(task.status))
  const overdue = open.filter(task => {
    const due = localDateOf(task.dueAt, source.timeZone)
    return due !== undefined && due < today
  })
  const dueToday = open.filter(task => localDateOf(task.dueAt, source.timeZone) === today)
  const dueTomorrow = open.filter(task => localDateOf(task.dueAt, source.timeZone) === tomorrow)
  const waiting = tasks.filter(task => WAITING_STATUSES.has(task.status))
  const doneToday = tasks.filter(task => DONE_STATUSES.has(task.status) && localDateOf(task.updatedAt, source.timeZone) === today)
  const reminders = source.reminders
    .filter(row => row.status !== 'inactive')
    .slice()
    .sort((left, right) => (left.scheduledAt ?? '').localeCompare(right.scheduledAt ?? ''))

  const counts = {
    dueToday: dueToday.length, overdue: overdue.length, waiting: waiting.length,
    doneToday: doneToday.length, open: open.length, dueTomorrow: dueTomorrow.length, reminders: reminders.length,
  }
  const weekday = localClock(source.now, source.timeZone).weekday
  const lines: string[] = [`- 日期：${today}（${weekday}）`]
  const suggestions: string[] = []

  if (kind === 'morning') {
    lines.push(`- 今天到期：${counts.dueToday === 0 ? '无' : `${counts.dueToday} 项 — ${titles(dueToday)}`}`)
    lines.push(`- 已逾期：${counts.overdue === 0 ? '无' : `${counts.overdue} 项 — ${titles(overdue)}`}`)
    lines.push(`- 等你决定：${counts.waiting === 0 ? '无' : `${counts.waiting} 项 — ${titles(waiting)}`}`)
    lines.push(`- 提醒：${counts.reminders === 0 ? '无' : `${counts.reminders} 条 — ${reminders.slice(0, 5).map(row => row.scheduledAt === undefined ? row.title : `${row.title}（${row.scheduledAt}）`).join('、')}`}`)
    if (counts.overdue > 0) suggestions.push('先把逾期项改期、完成或取消，别让它们继续滚。')
    if (counts.waiting > 0) suggestions.push('"等你决定"里的事项给出一个结论，管家好继续。')
    if (counts.dueToday > 0) suggestions.push('今天到期的先做最小可交付版本。')
    if (suggestions.length === 0) suggestions.push('今天没有硬性待办：推进一件长期目标，或补一条笔记。')
  } else {
    lines.push(`- 今天完成：${counts.doneToday === 0 ? '无' : `${counts.doneToday} 项 — ${titles(doneToday)}`}`)
    lines.push(`- 仍未完成：${counts.open === 0 ? '无' : `${counts.open} 项${counts.overdue > 0 ? `（其中逾期 ${counts.overdue}）` : ''} — ${titles(open)}`}`)
    lines.push(`- 明天到期：${counts.dueTomorrow === 0 ? '无' : `${counts.dueTomorrow} 项 — ${titles(dueTomorrow)}`}`)
    lines.push(`- 等你决定：${counts.waiting === 0 ? '无' : `${counts.waiting} 项 — ${titles(waiting)}`}`)
    if (counts.doneToday > 0) suggestions.push(`把今天完成的 ${counts.doneToday} 项收尾成记录（证据/笔记），别只停在"做完"。`)
    if (counts.overdue > 0) suggestions.push('逾期项今晚给一个明确结论，或改到真实可做的日期。')
    if (counts.dueTomorrow > 0) suggestions.push(`明天到期 ${counts.dueTomorrow} 项：今晚先准备材料，明早直接开工。`)
    if (suggestions.length === 0) suggestions.push('今天没有必须收尾的事：早点休息，明天再推。')
  }
  lines.push(`- 建议：${suggestions.join(' ')}`)
  const markdown = `\n## ${slot.heading}\n\n${lines.join('\n')}\n`
  return { kind, heading: slot.heading, markdown, counts }
}

/**
 * Whether one slot is due on the local clock right now.
 * @param kind - morning or evening.
 * @param now - reference instant.
 * @param timeZone - IANA zone.
 * @returns true inside the slot's catch-up window.
 */
export function briefDue(kind: BriefKind, now: Date, timeZone: string): boolean {
  const slot = BRIEF_SLOTS.find(entry => entry.kind === kind)!
  const clock = localClock(now, timeZone)
  const minutes = clock.hour * 60 + clock.minute
  return minutes >= slot.hour * 60 + slot.minute && minutes < slot.untilHour * 60
}

/**
 * Whether today's daily page already contains this brief.
 * @param kind - morning or evening.
 * @param dailyText - the current daily page, if any.
 * @returns true when the exact heading is present.
 */
export function briefAlreadyWritten(kind: BriefKind, dailyText: string | undefined): boolean {
  if (dailyText === undefined) return false
  const slot = BRIEF_SLOTS.find(entry => entry.kind === kind)!
  return dailyText.includes(`## ${slot.heading}`)
}

/** What one scheduler tick did, for logging and tests. */
export interface DailyBriefTick {
  written: BriefKind[]
  skipped: Array<{ kind: BriefKind; reason: 'not-due' | 'already-written' }>
}

/** Options accepted by {@link installDailyBrief}. */
export interface DailyBriefOptions {
  timeZone: string
  /** Read the tasks/reminders the brief summarizes; failures mean "no data". */
  collect: () => Promise<{ tasks: BriefTask[]; reminders: BriefReminder[] }> | { tasks: BriefTask[]; reminders: BriefReminder[] }
  /** Reference clock, for tests. */
  now?: () => Date
  /** Check cadence; the default is 15 minutes. */
  intervalMs?: number
  logger?: { info?: (message: string, ...args: unknown[]) => void; warn?: (message: string, ...args: unknown[]) => void }
}

/** Run one brief tick immediately (used by tests and by {@link installDailyBrief}). */
export async function runDailyBriefOnce(options: DailyBriefOptions): Promise<DailyBriefTick> {
  const now = options.now?.() ?? new Date()
  const tick: DailyBriefTick = { written: [], skipped: [] }
  for (const slot of BRIEF_SLOTS) {
    if (!briefDue(slot.kind, now, options.timeZone)) { tick.skipped.push({ kind: slot.kind, reason: 'not-due' }); continue }
    let daily: string | undefined
    try { daily = readDaily(options.timeZone) } catch { daily = undefined }
    if (briefAlreadyWritten(slot.kind, daily)) { tick.skipped.push({ kind: slot.kind, reason: 'already-written' }); continue }
    let source: { tasks: BriefTask[]; reminders: BriefReminder[] }
    try { source = await options.collect() } catch (error) {
      options.logger?.warn?.('[dsh-butler] 日报数据读取失败，本次不写：%s', String(error))
      continue
    }
    const brief = composeBrief(slot.kind, { now, timeZone: options.timeZone, tasks: source.tasks, reminders: source.reminders })
    try {
      appendDaily(options.timeZone, brief.markdown.trimEnd())
      tick.written.push(slot.kind)
      options.logger?.info?.('[dsh-butler] %s已写入 daily（今天到期 %d / 逾期 %d / 等你决定 %d）',
        slot.label, brief.counts.dueToday, brief.counts.overdue, brief.counts.waiting)
    } catch (error) {
      options.logger?.warn?.('[dsh-butler] %s写入 daily 失败：%s', slot.label, String(error))
    }
  }
  return tick
}

/**
 * Install the periodic brief writer; returns the disposer.
 * @param options - clock, data source and logger.
 * @returns disposal callback that clears the timer.
 */
export function installDailyBrief(options: DailyBriefOptions): () => void {
  const logger = options.logger
  const tick = (): void => {
    void runDailyBriefOnce({ ...options, logger }).catch(error => logger?.warn?.('[dsh-butler] 日报检查失败：%s', String(error)))
  }
  tick()
  const timer = setInterval(tick, options.intervalMs ?? 15 * 60 * 1000)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Collect the brief source from the live ledger and scheduler.
 *
 * Kept here (not inside {@link runDailyBriefOnce}) so the pure composer and the
 * host wiring stay independently testable.
 * @param schedule - live schedule catalog accessor, if available.
 * @returns tasks and projected reminders.
 */
export async function collectBriefSource(schedule?: { catalog(): Promise<Array<{ id?: string; title?: string; scheduledAt?: string; status?: string }>> }): Promise<{ tasks: BriefTask[]; reminders: BriefReminder[] }> {
  // Archived October fixtures stay in the ledger as evidence but never enter the
  // owner's brief: it is a "what needs me today" page, not a test report.
  const hiddenTasks = archivedTaskIds()
  const hiddenReminders = archivedReminderKeys()
  const tasks: BriefTask[] = listTasks({ recover: false }).filter(task => !hiddenTasks.has(task.id)).map(task => ({
    id: task.id, title: task.title, status: task.status,
    ...(task.kind === undefined ? {} : { kind: task.kind }),
    ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
    ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
  }))
  let reminders: BriefReminder[] = []
  try {
    if (schedule !== undefined) reminders = (await schedule.catalog()).filter(row => row.id === undefined || !hiddenReminders.has(row.id)).map(row => ({
      title: typeof row.title === 'string' && row.title !== '' ? row.title : '（未命名提醒）',
      ...(row.scheduledAt === undefined ? {} : { scheduledAt: row.scheduledAt }),
      ...(row.status === undefined ? {} : { status: row.status }),
    }))
  } catch { /* an unavailable scheduler means the brief simply has no reminder lines */ }
  return { tasks, reminders }
}
