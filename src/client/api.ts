/**
 * Client-side data access for the butler workbench.
 *
 * Everything here reads host state; the single exception is {@link taskAction},
 * which records the owner's own one-click bookkeeping (done/postpone/cancel) so
 * they do not have to open a conversation for routine housekeeping. It changes
 * only the local task ledger and never triggers an external action; anything
 * with consequences still travels through the agent's `butler_*` tools so the
 * ledger, receipts and evidence guard see it.
 *
 * @module @dsh-external/dsh-butler/client
 */

/** Read endpoint prefix, kept in sync with `API_PREFIX` in `src/host/api.ts`. */
export const API_PREFIX = '/dsh-butler/api'

/** These serialized ledger types are shared with the host; imports are type-only. */
export type TaskStatus = import('../host/ledger.ts').TaskStatus
export type Evidence = import('../host/ledger.ts').Evidence
export type Task = import('../shared/workbench.ts').TaskReadSnapshot
export type Receipt = import('../shared/workbench.ts').ReceiptReadSnapshot
export type PendingItem = import('../host/ledger.ts').PendingItem
export type Memo = import('../host/ledger.ts').Memo
export type RuntimeControlsSnapshot = import('../shared/workbench.ts').RuntimeControlsSnapshot
export type TaskDetail = import('../shared/workbench.ts').TaskDetail
export type BudgetReport = import('../host/budget.ts').BudgetReport
export type { HistoryKind, HistoryItems, HistoryPage, HistoryBudget } from '../shared/workbench.ts'
import type { HistoryKind, HistoryPage } from '../shared/workbench.ts'
export type MemoryStatus = ReturnType<typeof import('../host/memory.ts').readMemoryStatus>

/** One file inside the visible vault. */
export interface VaultFile {
  /** Vault-relative path. */
  path: string
  /** Size in bytes. */
  size: number
  /** Last modification instant, ISO. */
  modified: string
}

/** Provider-reported counts and unknown calls retain the host's exact semantics. */
export type UsageTotals = import('../host/ledger.ts').UsageTotals

export type UsageRecorderStatus = import('../host/usage.ts').UsageRecorderStatus

export type UsageBackfillState = Pick<import('../host/backfill.ts').UsageBackfillState, 'running' | 'added' | 'last' | 'problem'>

/** Everything the first screen needs, in one payload. */
export interface Overview {
  /** True when the host half answered. */
  ok: boolean
  /** When the payload was produced, ISO. */
  generatedAt: string
  /** IANA zone the ledger dates are written in. */
  timeZone: string
  /** Visible half of the runtime data. */
  vault: { home: string; files: VaultFile[] }
  /** Ledger snapshot. */
  ledger?: {
    open: Task[]
    pending: PendingItem[]
    proposedMemos: Memo[]
    recent: Receipt[]
    usage: UsageTotals
    interrupted: Task[]
  }
  ledgerError?: string
  /** Reminders, when the schedule service answered. */
  reminders: ReminderRecord[]
  /** False when the reminder list could not be read this time. */
  remindersAvailable: boolean
  /** Why the reminder list is missing - never silently dropped. */
  remindersError?: string
  /** The butler's own conversation, so the panel can offer a way into it. */
  session?: ButlerSession
  /** Why the host could not even attempt the conversation. */
  sessionError?: string
  /** Capability packs and whether each is on. */
  packs?: PackEntry[]
  /** Why the pack list could not be read at all, when that happened. */
  packsError?: string
  /** How the usage recorder is doing, so a zero total is never ambiguous. */
  usageRecorder?: UsageRecorderStatus
  /** What the startup backfill found, so recovered rows are not passed off as live ones. */
  usageBackfill?: UsageBackfillState
  runtimeControls?: RuntimeControlsSnapshot
  taskHistory?: { tasks: Task[]; total: number; limit: number }
  memory?: MemoryStatus
  memoryError?: string
}

/**
 * One capability pack, as the host summarises it.
 *
 * `source` says whether it is an `user` file under `vault/packs/` (which the
 * owner can edit) or a `builtin` default; `broken` is set when the pack file
 * exists but could not be parsed, so the panel can show a pack that is present
 * but not doing anything rather than pretending it is fine.
 */
export type PackEntry = import('../shared/packs.ts').PackSummary

/**
 * The butler's own conversation as the host reports it.
 *
 * `state` is what the host actually did on this poll - `live` when it was
 * already open, `resumed` when a stored one was reopened, `created` when a new
 * one was made, `failed` when none of that worked. `note` carries the reason
 * whenever something was not ideal, and is shown rather than hidden.
 */
export interface ButlerSession {
  /** Session id the owner's chat with the butler happens in. */
  id: string
  /** Title pinned on it. */
  title: string
  /** What the host did to reach it. */
  state: 'live' | 'created' | 'resumed' | 'failed'
  /** Working directory it was filed under, when known. */
  cwd?: string
  /** Anything worth telling the owner. */
  note?: string
  /** Whether the title is pinned as the owner's own. */
  titlePinned: boolean
  /** When the host answered. */
  at: string
  /** Native durability and workspace membership acknowledged for this exact id. */
  ready?: import('../host/session.ts').ButlerSessionReadiness
}

/** A scheduled reminder as the catalog reports it. */
export interface ReminderRecord {
  /** Schedule id. */
  id: string
  /** Reminder title. */
  title?: string
  /** Prompt delivered when it fires. */
  prompt?: string
  /** Next fire instant, ISO. */
  scheduledAt?: string
  /** Whether it is still armed. */
  status?: 'active' | 'inactive'
  /** Native 0.2.2 rule kind (at/daily/weekly/...), kept so the UI can tell one-shots from recurrences. */
  kind?: string
  /** Native status before the host normalised it. */
  rawStatus?: string
  /** Delivery destination derived from the native target. */
  sessionId?: string
  /** Last delivery receipt, when it already fired. */
  lastDelivery?: { scheduledAt: string; deliveredAt: string; messageId: string }
}

/** One row of the notes listing. */
export interface NoteEntry {
  /** Vault-relative path. */
  path: string
  /** Size in bytes. */
  size: number
  /** Last modification instant, ISO. */
  modified: string
}

/** Result of the note endpoint. */
export type NoteResult =
  | { kind: 'list'; notes: NoteEntry[] }
  | { kind: 'note'; slug: string; path: string; text: string }
  | { kind: 'error'; message: string }

/** Last payload per path, so a 304 answer reuses the exact same reference. */
const readCache = new Map<string, { etag: string; value: unknown }>()

/**
 * Fetch JSON from the butler read API, revalidating with its ETag.
 * @param path - absolute path under {@link API_PREFIX}.
 * @param signal - abort signal for the caller's lifetime.
 * @returns the decoded payload; the previous value when the host answers 304.
 */
async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const cached = readCache.get(path)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (cached !== undefined) headers['if-none-match'] = cached.etag
  const response = await fetch(path, { signal, headers })
  if (response.status === 304 && cached !== undefined) return cached.value
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    throw new Error(`HTTP ${response.status} ${response.statusText}${typeof detail?.error === 'string' ? `：${detail.error}` : ''}`)
  }
  const value = await response.json()
  try {
    const etag = response.headers?.get?.('etag')
    if (typeof etag === 'string' && etag !== '') readCache.set(path, { etag, value })
    else readCache.delete(path)
  } catch {
    // Header access is optional (test doubles and old shells omit it).
  }
  return value
}

/** One due reminder as the frame-wide overlay consumes it. */
export interface DueReminder {
  id: string
  title: string
  scheduledAt?: string
  kind?: string
  lastDelivery?: { scheduledAt?: string; deliveredAt?: string; messageId?: string; targetSessionId?: string }
}

/** The small pollable slice returned by `GET /api/due`. */
export interface DueReminderPayload {
  ok: boolean
  available: boolean
  generatedAt: string
  timeZone: string
  count: number
  due: DueReminder[]
  reason?: string
}

/** One memory-proposal decision the workbench may record. */
export type MemoActionName = 'confirm' | 'reject'

/** What one memo decision changed. */
export interface MemoActionResult {
  ok: boolean
  action?: string
  memo?: { id: string; status: string; text: string }
  error?: string
}

/**
 * Confirm or reject one proposed memory entry.
 *
 * This records the same durable decision the conversation memory tool records;
 * the host writes an operation id so the provenance stays auditable.
 * @param action - confirm or reject.
 * @param id - memo id.
 * @param signal - abort signal for the caller's lifetime.
 * @returns the decided memo, or the host's refusal reason.
 */
export async function memoAction(action: MemoActionName, id: string, signal?: AbortSignal): Promise<MemoActionResult> {
  const response = await fetch(`${API_PREFIX}/memo-action`, {
    method: 'POST', signal,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ action, id }),
  })
  let payload: unknown
  try { payload = await response.json() } catch { payload = undefined }
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  if (!response.ok || record?.['ok'] !== true) {
    return { ok: false, error: typeof record?.['error'] === 'string' ? record['error'] : `HTTP ${response.status}` }
  }
  return record as unknown as MemoActionResult
}

/** One reminder rule change the overlay/banner may request. */
export type ReminderActionName = 'snooze' | 'reschedule' | 'complete' | 'cancel' | 'pause' | 'resume'

/** What one reminder action changed. */
export interface ReminderActionResult {
  ok: boolean
  action?: string
  scheduleId?: string
  schedule?: unknown
  task?: { id: string; title: string; status: string } | null
  error?: string
  code?: string
}

/**
 * Change one reminder rule (snooze/reschedule/complete/cancel/pause/resume).
 *
 * The scheduler stays the authority; the host mirrors the change into the linked
 * ledger task. This never sends messages or spends money.
 * @param action - the rule change.
 * @param id - native schedule id.
 * @param options - snooze minutes or an ISO instant for reschedule.
 * @param signal - abort signal for the caller's lifetime.
 * @returns the host's answer, including a refusal reason.
 */
export async function reminderAction(action: ReminderActionName, id: string,
  options: { minutes?: number; at?: string } = {}, signal?: AbortSignal): Promise<ReminderActionResult> {
  const response = await fetch(`${API_PREFIX}/reminder-action`, {
    method: 'POST', signal,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ action, id, ...(options.minutes === undefined ? {} : { minutes: options.minutes }), ...(options.at === undefined ? {} : { at: options.at }) }),
  })
  let payload: unknown
  try { payload = await response.json() } catch { payload = undefined }
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  if (!response.ok || record?.['ok'] !== true) {
    return { ok: false, error: typeof record?.['error'] === 'string' ? record['error'] : `HTTP ${response.status}`, ...(typeof record?.['code'] === 'string' ? { code: record['code'] } : {}) }
  }
  return record as unknown as ReminderActionResult
}

/**
 * Read the due-reminder slice for the frame-wide overlay.
 * @param signal - abort signal for the caller's lifetime.
 * @returns the due reminders, or an explicit unavailability reason.
 */
export async function fetchDueReminders(signal?: AbortSignal): Promise<DueReminderPayload> {
  return await getJson(`${API_PREFIX}/due`, signal) as DueReminderPayload
}

/**
 * Read the whole workbench snapshot.
 * @param signal - abort signal for the caller's lifetime.
 * @returns the overview payload.
 */
export async function fetchOverview(signal?: AbortSignal): Promise<Overview> {
  return await getJson(`${API_PREFIX}/overview`, signal) as Overview
}

/** Fetch only the selected business task; an unrelated response cannot replace it. */
export async function fetchTask(id: string, signal?: AbortSignal): Promise<TaskDetail> {
  const payload = await getJson(`${API_PREFIX}/task?id=${encodeURIComponent(id)}`, signal) as Partial<TaskDetail>
  if (payload.ok !== true || payload.task?.id !== id) throw new Error('任务详情结构或身份不匹配')
  return payload as TaskDetail
}

/** One-click local bookkeeping the workbench may perform on a task. */
export type TaskActionName = 'done' | 'postpone' | 'cancel'

/** What one task action changed. */
export interface TaskActionResult {
  ok: boolean
  task?: { id: string; title: string; status: TaskStatus; updatedAt: string; dueAt?: string }
  error?: string
}

/**
 * Change one task's status or due date from the workbench.
 *
 * This is the only mutation the client performs: it records the owner's own
 * decision in the local ledger (audited by an operation id) and never sends a
 * message, spends money or runs an external action.
 * @param action - done, postpone (default: +24h) or cancel.
 * @param id - ledger task id.
 * @param options - explicit due date (ISO) or a note.
 * @param signal - abort signal for the caller's lifetime.
 * @returns the updated task, or the host's refusal message.
 */
export async function taskAction(action: TaskActionName, id: string,
  options: { dueAt?: string; note?: string } = {}, signal?: AbortSignal): Promise<TaskActionResult> {
  const dueAt = action === 'postpone' ? options.dueAt ?? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : options.dueAt
  const response = await fetch(`${API_PREFIX}/action`, {
    method: 'POST', signal,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ action: `task-${action}`, id, ...(dueAt === undefined ? {} : { dueAt }), ...(options.note === undefined ? {} : { note: options.note }) }),
  })
  let payload: unknown
  try { payload = await response.json() } catch { payload = undefined }
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  if (!response.ok || record?.['ok'] !== true) {
    const message = typeof record?.['error'] === 'string' ? record['error'] : `HTTP ${response.status}`
    return { ok: false, error: message }
  }
  return record as unknown as TaskActionResult
}

/** Browse one immutable projection revision, scoped to the exact selected task. */
export async function fetchHistory<K extends HistoryKind>(kind: K, options: {
  taskId?: string; offset?: number; limit?: number; revision?: string
} = {}, signal?: AbortSignal): Promise<HistoryPage<K>> {
  const query = new URLSearchParams({ kind })
  for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value))
  const page = await getJson(`${API_PREFIX}/history?${query}`, signal) as Partial<HistoryPage<K>>
  const offset = options.offset ?? 0
  if (page.ok !== true || page.kind !== kind || page.taskId !== options.taskId
    || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total! < 0
    || page.offset !== offset || !Number.isSafeInteger(page.limit) || page.limit! < 1 || page.limit! > 100
    || (options.limit !== undefined && page.limit !== options.limit)
    || page.items.length > page.limit! || page.items.length !== Math.min(page.limit!, Math.max(0, page.total! - offset))
    || typeof page.revision !== 'string' || !/^[a-f0-9]{64}$/.test(page.revision)
    || (options.revision !== undefined && page.revision !== options.revision)
    || page.nextOffset !== (offset + page.items.length < page.total! ? offset + page.items.length : undefined)) {
    throw new Error('历史分页结构或任务身份不匹配，请刷新后重读')
  }
  return page as HistoryPage<K>
}

/**
 * List the notes, or read one note's markdown.
 * @param slug - note slug without `.md`; omit to list.
 * @param signal - abort signal for the caller's lifetime.
 * @returns the listing, the note, or a surfaced error.
 */
export async function fetchNote(slug?: string, signal?: AbortSignal): Promise<NoteResult> {
  const query = slug === undefined ? '' : `?slug=${encodeURIComponent(slug)}`
  try {
    const payload = await getJson(`${API_PREFIX}/note${query}`, signal) as Record<string, unknown>
    if (Array.isArray(payload['notes'])) {
      return { kind: 'list', notes: payload['notes'] as NoteEntry[] }
    }
    if (typeof payload['text'] === 'string') {
      return {
        kind: 'note',
        slug: String(payload['slug'] ?? slug ?? ''),
        path: String(payload['path'] ?? ''),
        text: payload['text'],
      }
    }
    return { kind: 'error', message: '管家接口返回了无法识别的笔记结构' }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}
