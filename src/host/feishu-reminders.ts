/**
 * 到期提醒 → 飞书推送的看门狗。
 *
 * 只推送**管家自己的提醒**（目标是隔离提醒会话 `session-butler-reminder-*`），
 * 避免把 DSH 原生定时任务重复推一遍。同一个 occurrence（`id@scheduledAt`）
 * 只发一次，成功/失败都落盘：失败最多重试 3 次后放弃并留下原因，既不静默
 * 也绝不变成刷屏循环。
 *
 * @module @dsh-external/dsh-butler/host/feishu-reminders
 */
import { existsSync, readFileSync } from 'node:fs'
import { formatDueReminderText, type FeishuSendResult, type FeishuSender } from './feishu.ts'
import { statePath, writeText } from './vault.ts'

/** The scheduling row shape the watcher reads; a subset of the native catalog entry. */
export interface FeishuReminderRow {
  id: string
  title?: string
  scheduledAt?: string
  status?: string
  target?: { kind?: string; sessionId?: string }
}

/** One sent-or-failed occurrence. */
export interface FeishuOccurrence {
  key: string
  reminderId: string
  scheduledAt?: string
  status: 'sent' | 'failed' | 'gave-up'
  attempts: number
  lastAttemptAt: string
  messageId?: string
  error?: string
}

interface WatchState {
  version: 1
  occurrences: Record<string, FeishuOccurrence>
}

/** Outcome of one watcher tick. */
export interface FeishuWatchTick {
  sent: string[]
  failed: Array<{ id: string; error: string }>
  skipped: number
}

/** Options accepted by the watcher. */
export interface FeishuWatcherOptions {
  sender: FeishuSender
  /** Read the native schedule catalog. */
  catalog: () => Promise<FeishuReminderRow[]>
  /** Persisted occurrence log; defaults to `state/feishu-reminders.json`. */
  stateFile?: string
  now?: () => Date
  intervalMs?: number
  /** Never flood the phone with one huge backlog. */
  maxPerTick?: number
  logger?: { info?: (message: string, ...args: unknown[]) => void; warn?: (message: string, ...args: unknown[]) => void }
}

/** The watcher handle. */
export interface FeishuReminderWatcher {
  tick(): Promise<FeishuWatchTick>
  install(): () => void
  status(): { sent: number; failed: number; gaveUp: number; lastError?: string; lastTickAt?: string }
}

/** Prefix of the isolated sessions the butler binds reminders to. */
const REMINDER_SESSION_PREFIX = 'session-butler-reminder-'
const MAX_ATTEMPTS = 3
const MAX_OCCURRENCES = 500

/** Stable occurrence key. */
export function occurrenceKey(reminderId: string, scheduledAt: string | undefined): string {
  return `${reminderId}@${scheduledAt ?? ''}`
}

/** Whether a catalog row is a butler-owned reminder delivery. */
export function butlerReminderTarget(row: FeishuReminderRow): boolean {
  return typeof row.target?.sessionId === 'string' && row.target.sessionId.startsWith(REMINDER_SESSION_PREFIX)
}

/** Keep only the newest occurrences so the state file cannot grow without bound. */
function pruneOccurrences(occurrences: Record<string, FeishuOccurrence>): Record<string, FeishuOccurrence> {
  const entries = Object.entries(occurrences)
  if (entries.length <= MAX_OCCURRENCES) return occurrences
  entries.sort((left, right) => right[1].lastAttemptAt.localeCompare(left[1].lastAttemptAt))
  return Object.fromEntries(entries.slice(0, MAX_OCCURRENCES))
}

/** Read the occurrence log; a damaged file means "nothing sent yet". */
function readState(file: string): WatchState {
  try {
    if (!existsSync(file)) return { version: 1, occurrences: {} }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { version: 1, occurrences: {} }
    const raw = (parsed as { occurrences?: unknown }).occurrences
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, occurrences: {} }
    const occurrences: Record<string, FeishuOccurrence> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      const status = row['status']
      if (status !== 'sent' && status !== 'failed' && status !== 'gave-up') continue
      occurrences[key] = {
        key, reminderId: String(row['reminderId'] ?? ''), status, attempts: Number(row['attempts'] ?? 1), lastAttemptAt: String(row['lastAttemptAt'] ?? ''),
        ...(typeof row['scheduledAt'] === 'string' ? { scheduledAt: row['scheduledAt'] } : {}),
        ...(typeof row['messageId'] === 'string' ? { messageId: row['messageId'] } : {}),
        ...(typeof row['error'] === 'string' ? { error: row['error'] } : {}),
      }
    }
    return { version: 1, occurrences }
  } catch {
    return { version: 1, occurrences: {} }
  }
}

/**
 * Create the due-reminder → Feishu watcher.
 * @param options - sender, catalog reader and persistence.
 * @returns the watcher handle.
 */
export function createFeishuReminderWatcher(options: FeishuWatcherOptions): FeishuReminderWatcher {
  const stateFile = options.stateFile ?? statePath('feishu-reminders.json')
  const now = options.now ?? (() => new Date())
  const maxPerTick = Math.max(1, Math.min(10, options.maxPerTick ?? 3))
  let state = readState(stateFile)
  let lastError: string | undefined
  let lastTickAt: string | undefined

  function persist(): void {
    try {
      state = { version: 1, occurrences: pruneOccurrences(state.occurrences) }
      writeText(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    } catch (error) {
      options.logger?.warn?.('[dsh-butler] 飞书提醒记录写入失败：%s', String(error))
    }
  }

  async function tick(): Promise<FeishuWatchTick> {
    const result: FeishuWatchTick = { sent: [], failed: [], skipped: 0 }
    lastTickAt = now().toISOString()
    let rows: FeishuReminderRow[]
    try { rows = await options.catalog() } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      options.logger?.warn?.('[dsh-butler] 飞书提醒读取调度目录失败：%s', lastError)
      return result
    }
    const current = now().getTime()
    const due = rows.filter(row => row.status === 'active' && butlerReminderTarget(row)
      && typeof row.scheduledAt === 'string' && Number.isFinite(Date.parse(row.scheduledAt)) && Date.parse(row.scheduledAt) <= current)
      .sort((left, right) => (left.scheduledAt ?? '').localeCompare(right.scheduledAt ?? ''))
    let sentThisTick = 0
    for (const row of due) {
      const key = occurrenceKey(row.id, row.scheduledAt)
      const previous = state.occurrences[key]
      if (previous?.status === 'sent' || previous?.status === 'gave-up') { result.skipped += 1; continue }
      if (sentThisTick >= maxPerTick) { result.skipped += 1; continue }
      const attempts = (previous?.attempts ?? 0) + 1
      let outcome: FeishuSendResult
      try {
        outcome = await options.sender.sendText(formatDueReminderText({ title: row.title, scheduledAt: row.scheduledAt }, now()))
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      const lastAttemptAt = now().toISOString()
      if (outcome.ok) {
        state.occurrences[key] = { key, reminderId: row.id, status: 'sent', attempts, lastAttemptAt,
          ...(row.scheduledAt === undefined ? {} : { scheduledAt: row.scheduledAt }), ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }) }
        result.sent.push(row.id)
        sentThisTick += 1
        options.logger?.info?.('[dsh-butler] 已推送提醒到飞书：%s（%s）', row.title ?? row.id, key)
      } else {
        const gaveUp = attempts >= MAX_ATTEMPTS
        state.occurrences[key] = { key, reminderId: row.id, status: gaveUp ? 'gave-up' : 'failed', attempts, lastAttemptAt,
          ...(row.scheduledAt === undefined ? {} : { scheduledAt: row.scheduledAt }), ...(outcome.error === undefined ? {} : { error: outcome.error }) }
        result.failed.push({ id: row.id, error: outcome.error ?? '未知原因' })
        lastError = outcome.error ?? '未知原因'
        if (!gaveUp) options.logger?.warn?.('[dsh-butler] 飞书提醒发送失败（第 %d 次）：%s', attempts, lastError)
      }
      persist()
    }
    return result
  }

  return {
    tick,
    install(): () => void {
      const run = (): void => { void tick().catch(error => options.logger?.warn?.('[dsh-butler] 飞书提醒检查失败：%s', String(error))) }
      run()
      const timer = setInterval(run, options.intervalMs ?? 60_000)
      timer.unref?.()
      return () => clearInterval(timer)
    },
    status() {
      const occurrences = Object.values(state.occurrences)
      return {
        sent: occurrences.filter(row => row.status === 'sent').length,
        failed: occurrences.filter(row => row.status === 'failed').length,
        gaveUp: occurrences.filter(row => row.status === 'gave-up').length,
        ...(lastError === undefined ? {} : { lastError }),
        ...(lastTickAt === undefined ? {} : { lastTickAt }),
      }
    },
  }
}
