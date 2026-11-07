/**
 * The HTTP surface the workbench panel reads.
 *
 * The panel is a browser client, so it cannot call the plugin's host code the
 * way the agent's tools do; it needs an HTTP route. Four routes are registered:
 *
 * - `GET  /dsh-butler/api/overview` — one read of the ledger, the scheduled
 *   reminders, and the vault directory listing, which is everything the panel
 *   paints on first frame.
 * - `POST /dsh-butler/api/note`     — open one note (or list the notes) for
 *   the detail drawer's text view.
 * - `GET  /dsh-butler/api/task?id=…` — exact-task receipts, evidence, usage,
 *   recorded runs, and read-only native reminder delivery history.
 * - `GET  /dsh-butler/api/history?kind=…` — revision-bound pages of saved history.
 *
 * Deliberately read-only. Every control that changes state goes through the
 * agent's tools so the ledger, the receipts, and the guard see it; a panel that
 * could approve work by itself would be a second door around the owner's rule
 * that an external action never runs without a decision on the record.
 *
 * @module @dsh-external/dsh-butler/host/api
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ButlerContext, ButlerReminderSummary, ScheduleCatalogEntry, ScheduleService, ScheduleDeliveryReceipt } from './ctx.ts'
import { projectReminder } from './remind.ts'
import type { UsageBackfillState } from './backfill.ts'
import { decideMemo, getTask, listMemos, listTasks, receipts, setButlerSessionId, setTaskStatus, snapshot, upsertTask, usageRecords, usageTotals } from './ledger.ts'
import { EvidenceStore } from './evidence-store.ts'
import { storageStatus } from './store.ts'
import { searchAll } from './search.ts'
import { archivedReminderKeys, archivedTaskIds } from './archive.ts'
import type { ArtifactSnapshot, HistoryBudget, HistoryItems, HistoryKind, HistoryPage, RuntimeControlsSnapshot, TaskDetail, TaskReadSnapshot, TaskReminderSnapshot, ReminderOperationSnapshot } from '../shared/workbench.ts'
import type { Task } from './ledger.ts'
import type { ReminderOperation } from './reminder-operations.ts'
import { projectTaskRead, readTaskBudgets, reminderLinkSnapshot, taskRunIds } from './task-projection.ts'
import { readMemoryStatus } from './memory.ts'
import { packsSummary } from './packs.ts'
import type { ButlerSessionInfo } from './session.ts'
import type { UsageRecorderStatus } from './usage.ts'
import { VAULT_HOME, listFiles, readText, vaultPath } from './vault.ts'

/** The slice of the host's HTTP service these routes need. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
  }): () => void
}

/** Context the API routes need: the HTTP carrier and the butler's own services. */
export type ButlerApiContext = Omit<ButlerContext, 'webServer'> & { webServer: WebServerLike }

/** The request slice the handlers read. */
export interface HttpRequestLike {
  method?: string
  url?: string
  /** Lower-cased header bag as Node's IncomingMessage provides it. */
  headers?: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: unknown) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

/** The response slice the handlers write. */
export interface HttpResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
  writeHead?(status: number, headers: Record<string, string>): void
}

/** Everything the routes read from the plugin. */
export interface ButlerApiDeps {
  /** Confirmed time zone, echoed so the panel can label times honestly. */
  timeZone: string
  /** Live scheduler access; absent means the panel reports it as unavailable. */
  schedule?: {
    catalog(): Promise<ScheduleCatalogEntry[]> | ScheduleCatalogEntry[]
    history?: ScheduleService['history']
    /** Mutating scheduler entry point, used only by the reminder action route. */
    edit?: ScheduleService['edit']
  }
  /**
   * Which borrowed services resolved on this request.
   *
   * Diagnostics for the panel: "reminders unavailable" is only useful when it
   * also says whether `web` and `schedule` were reachable at that moment.
   */
  resolved?: () => string[]
  /**
   * The butler's own conversation, created or resumed on demand.
   *
   * Read on every poll on purpose: the first activation can lose a race with
   * the agent factory coming up, and a poll is the cheapest moment to try again
   * — the panel is the thing the owner is looking at when it matters.
   */
  session?: () => Promise<ButlerSessionInfo>
  /**
   * Health of the usage recorder.
   *
   * The footer shows token totals, and a total of zero has two very different
   * meanings: "nothing was recorded yet" and "the recorder never attached".
   * This is what tells them apart in the panel instead of leaving the owner to
   * guess.
   */
  usage?: () => UsageRecorderStatus
  /**
   * The startup backfill that fills the seams the live feed missed.
   *
   * Shown next to the totals because the ledger is not only live data: some rows
   * were read back out of the session logs at startup, and the panel says how
   * many rather than presenting them as if the feed had caught them.
   */
  usageBackfill?: () => UsageBackfillState
  /** Optional Feishu self-reminder push status; absent means not configured. */
  feishu?: () => {
    enabled: boolean
    configured: boolean
    sent?: number
    failed?: number
    gaveUp?: number
    lastError?: string
    lastTickAt?: string
  }
  runtimeControls?: () => RuntimeControlsSnapshot
  reminderOperations?: () => ReminderOperation[]
  /** Every saved run, including superseded runs; no current-policy reconstruction. */
  budgetHistory?: () => HistoryBudget[]
}

/** Route prefix; the client half builds its URLs from the same literal. */
export const API_PREFIX = '/dsh-butler/api'

/** One panel payload. */
interface OverviewPayload {
  ok: true
  generatedAt: string
  timeZone: string
  vault: { home: string; files: ReturnType<typeof listFiles> }
  ledger?: Omit<ReturnType<typeof snapshot>, 'open' | 'interrupted'> & { open: TaskReadSnapshot[]; interrupted: TaskReadSnapshot[] }
  /** A damaged ledger is unavailable, never an invented empty task list. */
  ledgerError?: string
  /** Normalized host projection: native `paused`/`ended` read as inactive for the client. */
  reminders: ButlerReminderSummary[]
  remindersAvailable: boolean
  remindersError?: string
  /** Borrowed services that answered on this request, for honest diagnostics. */
  services?: string[]
  /**
   * The butler's own conversation, so the panel can offer a way into it.
   *
   * The client cannot create this — only the host can reach `agents` — so the
   * panel asks the host on every poll and shows what it is told, including a
   * failure to create it.
   */
  session?: ButlerSessionInfo
  /** Why the session is missing, when the host could not even attempt it. */
  sessionError?: string
  /**
   * The capability packs and whether each is on.
   *
   * Bounded declarative workflows/evidence/guidance, without raw user file
   * paths. These fields never assert live permission grants or hard budgets.
   */
  packs: ReturnType<typeof packsSummary>
  /** Why the pack list could not be read at all, when that happened. */
  packsError?: string
  /** How the usage recorder is doing, so a zero total is never ambiguous. */
  usageRecorder?: UsageRecorderStatus
  /** What the startup backfill found, so log-recovered rows are not passed off as live ones. */
  usageBackfill?: UsageBackfillState
  /** Feishu self-reminder status, when the host exposes it. */
  feishu?: ReturnType<NonNullable<ButlerApiDeps['feishu']>>
  runtimeControls?: RuntimeControlsSnapshot
  taskHistory?: { tasks: TaskReadSnapshot[]; total: number; limit: number }
  memory?: ReturnType<typeof readMemoryStatus>
  memoryError?: string
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function channelSafe<T extends { ownerId?: string; channelOrigin?: unknown }>(row: T): Omit<T, 'ownerId' | 'channelOrigin'> {
  const { ownerId: _owner, channelOrigin: _origin, ...visible } = row
  return visible
}

function operationProjection(row: ReminderOperation | ReminderOperationSnapshot): ReminderOperationSnapshot {
  const { outboundDestination: _destination, outbound: _outbound, task: _task, identity, ...visible } = row as ReminderOperation
  return { ...visible, identity: channelSafe(identity), ...(row.outbound === undefined ? {} : { outbound: row.outbound.map(item => ({ key: item.key, state: item.state,
    createdAt: item.createdAt, updatedAt: item.updatedAt, provider: 'destination' in item ? item.destination.provider : item.provider,
    ...(item.receipt ? { receipt: { messageId: item.receipt.messageId, ...(item.receipt.chunkIds ? { chunkIds: [...item.receipt.chunkIds] } : {}) } } : {}),
    ...(item.audit ? { audit: item.audit.map(entry => ({ at: entry.at, kind: entry.kind })) } : {}),
    ...('failure' in item && item.failure ? { failure: { kind: item.failure.kind, at: item.failure.at } }
      : ('reason' in item && item.reason) || item.audit?.some(entry => entry.kind === 'send-failed')
        ? { failure: { kind: item.audit?.some(entry => entry.kind === 'send-failed') ? 'send-failed' as const : 'legacy-unknown' as const,
          at: item.audit?.find(entry => entry.kind === 'send-failed')?.at ?? item.createdAt } } : {}),
  })) }) }
}

function operationSnapshot(deps: ButlerApiDeps, controls?: RuntimeControlsSnapshot): { available: true; items: ReminderOperationSnapshot[] } | { available: false; error: string } {
  try {
    if (deps.reminderOperations) {
      const items = deps.reminderOperations()
      if (!Array.isArray(items)) throw new Error('提醒操作来源未返回有效记录')
      return { available: true, items: items.map(operationProjection) }
    }
    if (controls?.reminderOperationsError) throw new Error(controls.reminderOperationsError)
    if (Array.isArray(controls?.reminderOperations)) return { available: true, items: controls.reminderOperations.map(operationProjection) }
    throw new Error('本地提醒操作记录不可用')
  } catch (error) { return { available: false, error: errorText(error) } }
}

function runtimeSnapshot(deps: ButlerApiDeps, includeOperations = true): RuntimeControlsSnapshot | undefined {
  let snapshot: RuntimeControlsSnapshot | undefined
  try { snapshot = deps.runtimeControls?.() }
  catch (error) { snapshot = { active: false, unavailable: true, blocked: true, error: `运行控制状态读取失败：${errorText(error)}`, taskBudgets: [] } }
  if (snapshot?.reminderOperations) snapshot = { ...snapshot, reminderOperations: snapshot.reminderOperations.map(operationProjection) }
  if (!includeOperations || !snapshot || !deps.reminderOperations) return snapshot
  const operations = operationSnapshot(deps, snapshot)
  return operations.available ? { ...snapshot, reminderOperations: operations.items }
    : { ...snapshot, reminderOperationsError: operations.error }
}

/** Only saved snapshots are read here; dashboard requests never recover the WAL. */
const READ_ONLY = { recover: false } as const

function taskArtifacts(allReceipts: ReturnType<typeof receipts>, evidence: ReturnType<EvidenceStore['listForTask']>): ArtifactSnapshot[] {
  const artifacts = new Map<string, Map<string, ArtifactSnapshot>>()
  const order: Array<{ revisions: Map<string, ArtifactSnapshot>; hash: string }> = []
  const localPath = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/
  const add = (row: ArtifactSnapshot) => {
    if (!row.path && !row.reference) return
    const path = row.path ?? (row.kind === 'file' && localPath.test(row.reference ?? '') ? row.reference : undefined)
    const key = JSON.stringify(path === undefined ? ['reference', row.reference] : ['path', path])
    const revisions = artifacts.get(key) ?? new Map<string, ArtifactSnapshot>(), hash = row.sha256 ?? ''
    if (!revisions.has(hash)) order.push({ revisions, hash })
    revisions.set(hash, { ...revisions.get(hash), ...row })
    artifacts.set(key, revisions)
  }
  for (const row of allReceipts) for (const artifact of row.artifacts ?? []) add(artifact)
  for (const item of evidence) if (item.kind === 'file') add({ kind: 'file', evidenceId: item.evidenceId, sha256: item.sha256,
    ...(localPath.test(item.source_url) ? { path: item.source_url } : { reference: item.source_url }) })
  // Preserve global first-seen revision order, dropping only absorbed hashless entries.
  return order.filter(({ revisions, hash }) => hash !== '' || revisions.size === 1)
    .map(({ revisions, hash }) => ({ ...revisions.get(''), ...revisions.get(hash) }))
}

function savedBudgets(deps: ButlerApiDeps): HistoryBudget[] {
  if (!deps.budgetHistory) throw new Error('保存的预算历史不可用')
  const items = deps.budgetHistory()
  if (!Array.isArray(items)) throw new Error('预算历史来源未返回有效记录')
  return items
}

function readableAppendSource(path: string): void {
  const issues = storageStatus([path]).diagnostics
  if (issues.length) throw new Error(`历史来源不可用：${issues.map(issue => `${issue.path}${issue.line === undefined ? '' : `:${issue.line}`} ${issue.message}`).join('；')}`)
}

function historyReceipts(id?: string): ReturnType<typeof receipts> {
  const rows = receipts(Number.MAX_SAFE_INTEGER).filter(row => id === undefined || row.taskId === id)
  readableAppendSource(vaultPath('ledger', 'receipts.jsonl'))
  return rows.map(channelSafe)
}

function historyUsage(id: string): ReturnType<typeof usageRecords> {
  const rows = usageRecords().filter(row => row.taskId === id)
  readableAppendSource(vaultPath('ledger', 'usage.jsonl'))
  return rows.map(channelSafe)
}

const HISTORY_KINDS: readonly HistoryKind[] = ['tasks', 'budgets', 'recentReceipts', 'receipts', 'usageRecords', 'evidence', 'artifacts', 'taskBudgets', 'reminderOperations']

interface HistoryQuery { kind: HistoryKind; taskId?: string; offset: number; limit: number; revision?: string }

function historyQuery(url: string): HistoryQuery {
  const params = new URL(url, 'http://localhost').searchParams
  for (const key of ['kind', 'taskId', 'offset', 'limit', 'revision']) {
    if (params.getAll(key).length > 1) throw new Error(`历史参数 ${key} 不能重复`)
  }
  const kind = params.get('kind') as HistoryKind
  if (!HISTORY_KINDS.includes(kind)) throw new Error('请指定有效的历史类型')
  const global = kind === 'tasks' || kind === 'budgets' || kind === 'recentReceipts', taskId = params.get('taskId')
  if (!global && (!taskId?.trim() || taskId.length > 256)) throw new Error('请指定有效的任务 ID')
  if (global && taskId !== null) throw new Error('全局历史不接受任务 ID')
  const integer = (key: string, fallback: number, minimum: number, maximum: number): number => {
    const raw = params.get(key)
    if (raw === null) return fallback
    if (!/^\d+$/.test(raw)) throw new Error(`历史参数 ${key} 必须是整数`)
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`历史参数 ${key} 超出范围`)
    return value
  }
  const offset = integer('offset', 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = integer('limit', kind === 'tasks' ? 50 : kind === 'budgets' ? 12 : 100, 1, 100)
  const revision = params.get('revision')
  if (revision !== null && !/^[a-f0-9]{64}$/.test(revision)) throw new Error('历史 revision 无效')
  if (offset > 0 && revision === null) throw new Error('非首屏历史必须带 revision')
  return { kind, offset, limit, ...(global ? {} : { taskId: taskId! }), ...(revision === null ? {} : { revision }) }
}

/** Canonical object keys keep revisions stable across equivalent saved projections. */
function stableValue(value: unknown, omitTransient = false): unknown {
  if (Array.isArray(value)) return value.map(item => stableValue(item, omitTransient))
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(row).sort().filter(key => !omitTransient || key !== 'generatedAt' && key !== 'remaining')
      .map(key => [key, stableValue(row[key], omitTransient)]))
  }
  return value
}

function stableRows<T>(rows: T[], compare: (a: T, b: T) => number): T[] {
  return rows.map(row => ({ row, key: JSON.stringify(stableValue(row)) }))
    .sort((a, b) => compare(a.row, b.row) || a.key.localeCompare(b.key)).map(entry => entry.row)
}

function sortedBudgetHistory(rows: HistoryBudget[]): HistoryBudget[] {
  return stableRows(rows, (a, b) => b.startedAt - a.startedAt || a.taskId.localeCompare(b.taskId))
}

function historyRows(query: HistoryQuery, task: Task | undefined, deps: ButlerApiDeps): HistoryItems[HistoryKind][] {
  const id = query.taskId!
  switch (query.kind) {
    case 'tasks': {
      const budgets = readTaskBudgets(deps.budgetHistory)
      return stableRows(listTasks(READ_ONLY).map(task => projectTaskRead(task, budgets)), (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    }
    case 'budgets': return sortedBudgetHistory(savedBudgets(deps))
    case 'recentReceipts': return stableRows(historyReceipts(), (a, b) => b.at.localeCompare(a.at))
    case 'receipts': return stableRows(historyReceipts(id), (a, b) => b.at.localeCompare(a.at))
    case 'usageRecords': return stableRows(historyUsage(id), (a, b) => b.at.localeCompare(a.at))
    case 'evidence': return stableRows(new EvidenceStore(READ_ONLY).listForTask(id), (a, b) => b.provenance.at.localeCompare(a.provenance.at) || a.evidenceId.localeCompare(b.evidenceId))
    case 'artifacts': {
      const allReceipts = stableRows(historyReceipts(id), (a, b) => b.at.localeCompare(a.at))
      const evidence = stableRows(new EvidenceStore(READ_ONLY).listForTask(id), (a, b) => a.evidenceId.localeCompare(b.evidenceId))
      return stableRows(taskArtifacts(allReceipts, evidence), (a, b) => (a.path ?? a.reference ?? '').localeCompare(b.path ?? b.reference ?? '') || (a.sha256 ?? '').localeCompare(b.sha256 ?? ''))
    }
    case 'taskBudgets': {
      const runIds = taskRunIds(task!, historyReceipts(id), historyUsage(id))
      return sortedBudgetHistory(savedBudgets(deps).filter(row => runIds.has(row.taskId)))
    }
    case 'reminderOperations': {
      const operations = operationSnapshot(deps, deps.reminderOperations ? undefined : runtimeSnapshot(deps, false))
      if (!operations.available) throw new Error(operations.error)
      return stableRows(operations.items.filter(row => row.taskId === id), (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.executionKey.localeCompare(b.executionKey))
    }
  }
}

function historyPage(query: HistoryQuery, rows: HistoryItems[HistoryKind][]): HistoryPage {
  const { kind, taskId, offset, limit } = query
  const revision = createHash('sha256').update(JSON.stringify(stableValue({ kind, taskId, rows }, true))).digest('hex')
  const nextOffset = offset + limit < rows.length ? offset + limit : undefined
  return { ok: true, kind, ...(taskId === undefined ? {} : { taskId }), items: rows.slice(offset, offset + limit),
    total: rows.length, offset, limit, revision, ...(nextOffset === undefined ? {} : { nextOffset }) }
}

/** Native history is read directly: the business history method also updates the ledger. */
async function reminderSnapshot(task: NonNullable<ReturnType<typeof getTask>>, deps: ButlerApiDeps): Promise<TaskReminderSnapshot | undefined> {
  const link = reminderLinkSnapshot(task.reminder)
  if (!link && task.kind !== 'reminder') return undefined
  const unavailable = (reason: string): TaskReminderSnapshot => ({ ...(link ? { link } : {}), history: { available: false, deliveryState: 'unknown', reason } })
  if (!link?.scheduleId || !link.destinationSessionId) return unavailable('旧任务没有结构化的调度与目标会话身份，送达状态未知')
  if (!deps.schedule?.history) return unavailable('宿主未提供原生送达历史')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // DSH 0.2.2: target-based history, explicit page size, no session id.
    const result = await Promise.race([deps.schedule.history({ id: link.scheduleId, limit: 20 }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('原生送达历史查询超时')), 3000); timer.unref?.() })])
    // 0.2.2 returns a history page or a typed miss; only a page carries records.
    if (!('records' in result) || !Array.isArray(result.records) || !result.records.every(row => row && typeof row === 'object'
      && ['scheduledAt', 'deliveredAt', 'messageId'].every(key => row[key as keyof ScheduleDeliveryReceipt] === undefined || typeof row[key as keyof ScheduleDeliveryReceipt] === 'string'))) return unavailable('宿主没有返回有效的原生送达历史')
    const records = result.records.slice(-20)
    const delivered = records.some(row => (typeof row.messageId === 'string' && row.messageId.length > 0)
      || (typeof row.deliveredAt === 'string' && Number.isFinite(Date.parse(row.deliveredAt))))
    const scheduled = records.some(row => typeof row.scheduledAt === 'string' && Number.isFinite(Date.parse(row.scheduledAt)))
    return { link, history: { available: true, deliveryState: delivered ? 'delivered' : scheduled ? 'scheduled' : 'unknown', records } }
  } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

async function taskDetail(id: string, deps: ButlerApiDeps): Promise<TaskDetail | undefined> {
  const task = getTask(id, READ_ONLY)
  if (!task) return undefined
  const allReceipts = receipts(Number.MAX_SAFE_INTEGER).filter(row => row.taskId === id)
  const calls = usageRecords().filter(row => row.taskId === id).sort((a, b) => b.at.localeCompare(a.at))
  const runIds = taskRunIds(task, allReceipts, calls)
  const controls = runtimeSnapshot(deps, false)
  const operations = operationSnapshot(deps, controls)
  let budgetHistory: HistoryBudget[] | undefined, budgetHistoryError: string | undefined
  try { budgetHistory = savedBudgets(deps).filter(row => runIds.has(row.taskId)) }
  catch (error) { budgetHistoryError = errorText(error) }
  let evidence: ReturnType<EvidenceStore['listForTask']> | undefined, evidenceError: string | undefined
  try { evidence = new EvidenceStore(READ_ONLY).listForTask(id) }
  catch (error) { evidenceError = error instanceof Error ? error.message : String(error) }
  const artifacts = taskArtifacts(allReceipts, evidence ?? [])
  const nativeReminder = await reminderSnapshot(task, deps)
  const reminder = nativeReminder ? { ...nativeReminder, ...(operations.available
    ? { outbound: operations.items.filter(row => row.taskId === id && row.action === 'create').flatMap(row => row.outbound ?? []) }
    : { outboundError: operations.error }) } : undefined
  return { ok: true, generatedAt: new Date().toISOString(), task: projectTaskRead(task, { items: budgetHistory, error: budgetHistoryError }, allReceipts, calls),
    receipts: allReceipts.slice(0, 100).map(channelSafe), receiptCount: allReceipts.length,
    evidenceAvailable: evidence !== undefined, ...(evidence === undefined ? { evidenceError } : { evidence: evidence.slice(-100), evidenceCount: evidence.length }),
    artifacts: artifacts.slice(0, 100), artifactCount: artifacts.length,
    usage: usageTotals(id), usageRecords: calls.slice(0, 100).map(channelSafe), usageRecordCount: calls.length,
    budgets: (controls?.budgetReports ?? []).filter(row => runIds.has(row.taskId)),
    ...(budgetHistory === undefined ? { budgetHistoryError } : { budgetHistory }),
    ...(controls === undefined || controls.unavailable ? { controlsError: controls?.error ?? '运行控制快照未提供，历史预算保持未知' } : {}),
    reminderOperations: operations.available ? operations.items.filter(row => row.taskId === id) : [],
    reminderOperationsAvailable: operations.available,
    ...(operations.available ? {} : { reminderOperationsError: operations.error }),
    ...(reminder === undefined ? {} : { reminder }),
    storage: storageStatus(), limits: { receipts: 100, usageRecords: 100, evidence: 100, artifacts: 100 } }
}

/** Write one JSON response. */
function sendJson(res: HttpResponseLike, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Read a whole request body, with a hard cap so a stray client cannot grow memory. */
async function readBody(req: HttpRequestLike, limit = 64 * 1024): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: string[] = []
    req.on('data', (chunk) => {
      size += typeof chunk === 'string' ? chunk.length : 1024
      if (size > limit) {
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    })
    req.on('end', () => resolve(chunks.join('')))
    req.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
  })
}

/** The note path a slug maps to, or undefined when the slug escapes `notes/`. */
function noteFile(slug: string): string | undefined {
  if (slug.trim() === '') return undefined
  const safe = slug.replace(/[\\/:*?"<>|]+/g, '-').trim()
  if (safe === '' || safe.includes('..')) return undefined
  return vaultPath('notes', `${safe}.md`)
}

/**
 * Register the workbench routes.
 * @param ctx - host context carrying `webServer`.
 * @param deps - the plugin's read accessors.
 * @returns a disposer removing the four routes.
 */
export function registerButlerApi(ctx: ButlerApiContext, deps: ButlerApiDeps): () => void {
  const server = ctx.webServer
  const disposers = [
    server.register({
      kind: 'exact',
      path: `${API_PREFIX}/overview`,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          sendJson(res, 405, { ok: false, error: '只支持 GET' })
          return
        }
        let reminders: ButlerReminderSummary[] = []
        let remindersAvailable = false
        let remindersError: string | undefined
        const services = deps.resolved?.() ?? []
        try {
          if (deps.schedule !== undefined) {
            // Host-side status normalization: paused/ended ⇒ inactive, raw status kept.
            reminders = (await deps.schedule.catalog()).map(projectReminder)
            remindersAvailable = true
          } else {
            remindersError = `调度服务这次没有解析到（已解析：${services.join(', ') || '无'}）：提醒列表读不到，不代表没有提醒。`
          }
        } catch (error) {
          remindersError = error instanceof Error ? error.message : String(error)
        }
        let session: ButlerSessionInfo | undefined
        let sessionError: string | undefined
        try {
          session = await deps.session?.()
          // The panel polls this route, so this is also where the usage roll-up
          // learns which session is the butler's own (for the butler/owner split).
          if (session !== undefined && session.state !== 'failed') setButlerSessionId(session.id)
        } catch (error) {
          sessionError = error instanceof Error ? error.message : String(error)
        }
        // The pack list is a directory read; a broken file is reported per pack
        // by `packsSummary`, but a hard failure still must not blank the panel.
        let packs: ReturnType<typeof packsSummary> = []
        let packsError: string | undefined
        try {
          packs = packsSummary()
        } catch (error) {
          packsError = error instanceof Error ? error.message : String(error)
        }
        let ledger: OverviewPayload['ledger']
        let ledgerError: string | undefined
        let taskHistory: OverviewPayload['taskHistory']
        const budgets = readTaskBudgets(deps.budgetHistory)
        // October acceptance fixture ids are archived, never deleted: the ledger
        // keeps every byte, the dashboard hides what the archive index names.
        const hiddenTasks = archivedTaskIds(), hiddenReminders = archivedReminderKeys()
        const visibleTask = (id: string | undefined): boolean => id === undefined || !hiddenTasks.has(id)
        const visibleOperation = (row: { taskId?: string; scheduleId?: string; executionKey: string }): boolean =>
          visibleTask(row.taskId) && !(row.scheduleId !== undefined && hiddenReminders.has(row.scheduleId)) && !hiddenReminders.has(row.executionKey)
        try {
          const raw = snapshot(READ_ONLY)
          ledger = { ...raw,
            open: raw.open.filter(task => visibleTask(task.id)).map(task => projectTaskRead(task, budgets)),
            interrupted: raw.interrupted.filter(task => visibleTask(task.id)).map(task => projectTaskRead(task, budgets)),
            recent: raw.recent.filter(row => visibleTask(row.taskId)).map(channelSafe) }
        }
        catch (error) { ledgerError = error instanceof Error ? error.message : String(error) }
        try {
          const all = listTasks(READ_ONLY).filter(task => visibleTask(task.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
          taskHistory = { tasks: all.slice(0, 50).map(task => projectTaskRead(task, budgets)), total: all.length, limit: 50 }
        }
        catch (error) { ledgerError ??= error instanceof Error ? error.message : String(error) }
        let memory: ReturnType<typeof readMemoryStatus> | undefined, memoryError: string | undefined
        try { memory = readMemoryStatus(50, READ_ONLY) }
        catch (error) { memoryError = error instanceof Error ? error.message : String(error) }
        // Host-read controls also carry reminder operations; hide archived ones
        // without deleting their persisted records.
        const rawControls = runtimeSnapshot(deps)
        const controls = rawControls === undefined ? undefined : {
          ...rawControls,
          ...(rawControls.reminderOperations === undefined ? {} : {
            reminderOperations: rawControls.reminderOperations.filter(row => visibleOperation(row as { taskId?: string; scheduleId?: string; executionKey: string })),
          }),
        }
        const payload: OverviewPayload = {
          ok: true,
          generatedAt: new Date().toISOString(),
          timeZone: deps.timeZone,
          vault: { home: VAULT_HOME, files: listFiles(undefined, 200) },
          ...(ledger === undefined ? { ledgerError } : { ledger }),
          ...(taskHistory === undefined ? {} : { taskHistory }),
          ...(memory === undefined ? { memoryError } : { memory }),
          reminders,
          remindersAvailable,
          services,
          packs,
          ...(packsError === undefined ? {} : { packsError }),
          ...(remindersError === undefined ? {} : { remindersError }),
          ...(session === undefined ? {} : { session }),
          ...(sessionError === undefined ? {} : { sessionError }),
          ...(deps.usage === undefined ? {} : { usageRecorder: deps.usage() }),
          ...(deps.usageBackfill === undefined ? {} : { usageBackfill: deps.usageBackfill() }),
          ...(deps.feishu === undefined ? {} : { feishu: deps.feishu() }),
          ...(deps.runtimeControls === undefined ? {} : { runtimeControls: controls }),
        }
        // Conditional GET: the payload is big, and the panel polls it. The ETag
        // covers the stable content only (not `generatedAt`), so an unchanged
        // dashboard answers 304 with no body instead of re-sending everything.
        const stable = { ...payload, generatedAt: '',
          // `session.at` is the last-check timestamp; it moves on every read and
          // would defeat revalidation without telling anyone anything new.
          ...(payload.session === undefined ? {} : { session: { ...payload.session, at: '' } }) }
        const etag = `"${createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 32)}"`
        const requested = req.headers?.['if-none-match']
        const offered = typeof requested === 'string' ? requested : Array.isArray(requested) ? requested.join(',') : ''
        if (offered.split(',').some(value => value.trim() === etag)) {
          res.statusCode = 304
          res.setHeader('etag', etag)
          res.end()
          return
        }
        res.setHeader('etag', etag)
        sendJson(res, 200, payload)
      },
    }),
    server.register({
      // Small, pollable slice for the frame-wide reminder overlay: due rules only,
      // so the overlay does not re-download the whole dashboard on every tick.
      kind: 'exact',
      path: `${API_PREFIX}/due`,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') { sendJson(res, 405, { ok: false, error: '到期提醒只支持 GET' }); return }
        const now = Date.now()
        if (deps.schedule === undefined) {
          sendJson(res, 200, { ok: true, available: false, generatedAt: new Date(now).toISOString(), timeZone: deps.timeZone, count: 0, due: [],
            reason: '调度服务不可用；这不代表没有提醒。' })
          return
        }
        try {
          const due = (await deps.schedule.catalog()).map(projectReminder)
            .filter(row => row.status === 'active' && typeof row.scheduledAt === 'string' && Number.isFinite(Date.parse(row.scheduledAt))
              && Date.parse(row.scheduledAt) <= now)
            .sort((left, right) => (left.scheduledAt ?? '').localeCompare(right.scheduledAt ?? ''))
            .map(row => ({ id: row.id, title: row.title ?? row.prompt ?? row.id, scheduledAt: row.scheduledAt,
              ...(row.kind === undefined ? {} : { kind: row.kind }),
              ...(row.lastDelivery === undefined ? {} : { lastDelivery: row.lastDelivery }) }))
          sendJson(res, 200, { ok: true, available: true, generatedAt: new Date(now).toISOString(), timeZone: deps.timeZone, count: due.length, due })
        } catch (error) {
          sendJson(res, 200, { ok: true, available: false, generatedAt: new Date(now).toISOString(), timeZone: deps.timeZone, count: 0, due: [],
            reason: errorText(error) })
        }
      },
    }),
    server.register({
      // The workbench's one-click bookkeeping. Deliberately narrow: status and
      // due-date changes on the owner's own ledger, audited by an operation id.
      // External actions (messages, payments) never travel through this route.
      kind: 'exact',
      path: `${API_PREFIX}/action`,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: '任务操作只支持 POST' }); return }
        let raw: unknown
        try { raw = JSON.parse(await readBody(req)) } catch (error) {
          sendJson(res, 400, { ok: false, error: `请求体不是有效 JSON：${errorText(error)}` }); return
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { sendJson(res, 400, { ok: false, error: '请求体必须是对象' }); return }
        const body = raw as Record<string, unknown>
        const action = typeof body.action === 'string' ? body.action : ''
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : undefined
        const allowed = new Set(['task-done', 'task-cancel', 'task-reopen', 'task-postpone'])
        if (!allowed.has(action)) { sendJson(res, 400, { ok: false, error: `不支持的 action：${action || '(空)'}` }); return }
        if (id === '' || id.length > 256) { sendJson(res, 400, { ok: false, error: '任务 ID 无效' }); return }
        if (archivedTaskIds().has(id)) { sendJson(res, 409, { ok: false, error: '这是已归档的验收 fixture，工作台不修改它。' }); return }
        if (getTask(id, READ_ONLY) === undefined) { sendJson(res, 404, { ok: false, error: '没有这个任务' }); return }
        const operation = { operationId: `web-${action}-${id}-${randomUUID()}` }
        try {
          let updated
          if (action === 'task-postpone') {
            const requested = typeof body.dueAt === 'string' ? Date.parse(body.dueAt) : Number.NaN
            const dueAt = Number.isFinite(requested) ? new Date(requested).toISOString() : new Date(Date.now() + 24 * 3600 * 1000).toISOString()
            updated = upsertTask(id, { status: 'pending', dueAt }, operation)
          } else {
            const status = action === 'task-done' ? 'done' : action === 'task-cancel' ? 'cancelled' : 'pending'
            const fallback = action === 'task-done' ? '工作台一键完成（未附证据）' : action === 'task-cancel' ? '工作台取消' : '工作台重新打开'
            updated = setTaskStatus(id, status, note ?? fallback, deps.timeZone, operation)
          }
          if (updated === undefined) { sendJson(res, 404, { ok: false, error: '没有这个任务' }); return }
          sendJson(res, 200, { ok: true, action, task: {
            id: updated.id, title: updated.title, status: updated.status, updatedAt: updated.updatedAt,
            ...(updated.dueAt === undefined ? {} : { dueAt: updated.dueAt }),
          } })
        } catch (error) { sendJson(res, 503, { ok: false, error: errorText(error) }) }
      },
    }),
    server.register({
      // Reminder rule changes requested from the overlay/banner. The scheduler is
      // the authority on the rule; the linked ledger task is mirrored so the
      // workbench stays truthful. One-shot rules may be snoozed/rescheduled;
      // recurring rules only allow pause/resume/complete (their timing is a
      // recurrence, not a single instant).
      kind: 'exact',
      path: `${API_PREFIX}/reminder-action`,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: '提醒操作只支持 POST' }); return }
        let raw: unknown
        try { raw = JSON.parse(await readBody(req)) } catch (error) {
          sendJson(res, 400, { ok: false, error: `请求体不是有效 JSON：${errorText(error)}` }); return
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { sendJson(res, 400, { ok: false, error: '请求体必须是对象' }); return }
        const body = raw as Record<string, unknown>
        const action = typeof body.action === 'string' ? body.action : ''
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const allowed = new Set(['snooze', 'reschedule', 'complete', 'cancel', 'pause', 'resume'])
        if (!allowed.has(action)) { sendJson(res, 400, { ok: false, error: `不支持的提醒操作：${action || '(空)'}` }); return }
        if (id === '' || id.length > 256) { sendJson(res, 400, { ok: false, error: '提醒 ID 无效' }); return }
        if (archivedReminderKeys().has(id)) { sendJson(res, 409, { ok: false, error: '这是已归档的验收 fixture，工作台不修改它。' }); return }
        if (deps.schedule === undefined || deps.schedule.edit === undefined) {
          sendJson(res, 503, { ok: false, error: '宿主未提供 schedule.edit，无法修改提醒（提醒本身不受影响）' }); return
        }
        try {
          const row = (await deps.schedule.catalog()).find(entry => entry.id === id)
          if (row === undefined) { sendJson(res, 404, { ok: false, error: '没有这条提醒' }); return }
          const recurring = row.kind === 'daily' || row.kind === 'weekly' || row.kind === 'cron' || row.kind === 'rrule'
          const expectedUpdatedAt = row.updatedAt
          let dueAt: string | undefined
          let result: unknown
          if (action === 'snooze') {
            if (recurring) { sendJson(res, 409, { ok: false, error: '这是重复提醒：不能单次推迟；请改期或先停用/完成。' }); return }
            const minutes = typeof body.minutes === 'number' && Number.isFinite(body.minutes) ? Math.min(1440, Math.max(1, Math.floor(body.minutes))) : 10
            dueAt = new Date(Date.now() + minutes * 60000).toISOString()
            result = await deps.schedule.edit({ id, action: 'update', patch: { timing: { kind: 'at', at: dueAt } }, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) })
          } else if (action === 'reschedule') {
            if (recurring) { sendJson(res, 409, { ok: false, error: '这是重复提醒：不能改成单次时间；请改它的重复规则或先完成。' }); return }
            const requested = typeof body.at === 'string' ? Date.parse(body.at) : Number.NaN
            if (!Number.isFinite(requested)) { sendJson(res, 400, { ok: false, error: 'reschedule 需要有效 at（ISO 时间）' }); return }
            dueAt = new Date(requested).toISOString()
            result = await deps.schedule.edit({ id, action: 'update', patch: { timing: { kind: 'at', at: dueAt } }, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) })
          } else if (action === 'complete' || action === 'cancel') {
            result = await deps.schedule.edit({ id, action: 'delete', ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) })
          } else {
            result = await deps.schedule.edit({ id, action: 'update', patch: { active: action === 'resume' }, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) })
          }
          const record = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {}
          if (typeof record['code'] === 'string') {
            sendJson(res, 409, { ok: false, error: record['code'] === 'schedule_conflict'
              ? '提醒已被别处修改，请刷新后重试。' : '宿主讲这条提醒不存在，可能已被删除。', code: record['code'] })
            return
          }
          if (record['deleted'] === false) { sendJson(res, 409, { ok: false, error: '宿主讲提醒不存在，可能已被删除。', code: 'schedule_not_found' }); return }
          // Mirror the rule change into the linked task row (if any).
          const linked = listTasks(READ_ONLY).find(task => task.reminder?.scheduleId === id)
          let task: unknown = null
          if (linked !== undefined) {
            const operation = { operationId: `web-reminder-${action}-${id}-${randomUUID()}` }
            if (action === 'complete') task = setTaskStatus(linked.id, 'done', '提醒已完成（工作台删除规则）', deps.timeZone, operation)
            else if (action === 'cancel') task = setTaskStatus(linked.id, 'cancelled', '提醒已取消（工作台删除规则）', deps.timeZone, operation)
            else if (action === 'pause') task = setTaskStatus(linked.id, 'waiting_review', '提醒已停用（可在工作台恢复）', deps.timeZone, operation)
            else if (action === 'snooze' || action === 'reschedule') {
              task = upsertTask(linked.id, { status: 'pending', ...(dueAt === undefined ? {} : { dueAt }) }, operation)
            }
          }
          sendJson(res, 200, { ok: true, action, scheduleId: id, schedule: record, task: task === null ? null : {
            id: (task as { id: string }).id, title: (task as { title: string }).title, status: (task as { status: string }).status,
          } })
        } catch (error) { sendJson(res, 503, { ok: false, error: errorText(error) }) }
      },
    }),
    server.register({
      // Memory proposals are the owner's own decisions; approving from the
      // workbench is the same durable decision the conversation tool records,
      // with an operation id so "who confirmed this memory" stays auditable.
      kind: 'exact',
      path: `${API_PREFIX}/memo-action`,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: '记忆操作只支持 POST' }); return }
        let raw: unknown
        try { raw = JSON.parse(await readBody(req)) } catch (error) {
          sendJson(res, 400, { ok: false, error: `请求体不是有效 JSON：${errorText(error)}` }); return
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { sendJson(res, 400, { ok: false, error: '请求体必须是对象' }); return }
        const body = raw as Record<string, unknown>
        const action = typeof body.action === 'string' ? body.action : ''
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (action !== 'confirm' && action !== 'reject') { sendJson(res, 400, { ok: false, error: `不支持的记忆操作：${action || '(空)'}` }); return }
        if (id === '' || id.length > 256) { sendJson(res, 400, { ok: false, error: '记忆提案 ID 无效' }); return }
        try {
          const existing = listMemos(READ_ONLY).find(memo => memo.id === id)
          if (existing === undefined) { sendJson(res, 404, { ok: false, error: '没有这条记忆提案' }); return }
          if (existing.status !== 'proposed') { sendJson(res, 409, { ok: false, error: `这条记忆提案已是 ${existing.status}，不再重复处理。` }); return }
          const decided = decideMemo(id, action === 'confirm' ? 'confirmed' : 'rejected',
            { operationId: `web-memo-${action}-${id}-${randomUUID()}` })
          if (decided === undefined) { sendJson(res, 404, { ok: false, error: '没有这条记忆提案' }); return }
          sendJson(res, 200, { ok: true, action, memo: { id: decided.id, status: decided.status, text: decided.text } })
        } catch (error) { sendJson(res, 503, { ok: false, error: errorText(error) }) }
      },
    }),
    server.register({
      // One read-only entry point across notes, tasks and memory. Small caps and
      // explicit truncation: this feeds a small result list, not an export.
      kind: 'exact',
      path: `${API_PREFIX}/search`,
      handler: (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') { sendJson(res, 405, { ok: false, error: '搜索只支持 GET' }); return }
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const query = (params.get('q') ?? '').trim()
        if (query === '') { sendJson(res, 400, { ok: false, error: '需要 q 参数（搜索关键词）' }); return }
        if (query.length > 200) { sendJson(res, 400, { ok: false, error: '关键词过长（上限 200 字符）' }); return }
        const requested = Number(params.get('limit'))
        const limit = Number.isSafeInteger(requested) ? Math.min(20, Math.max(1, requested)) : 8
        try { sendJson(res, 200, { ok: true, ...searchAll(query, { limit }) }) }
        catch (error) { sendJson(res, 503, { ok: false, error: errorText(error) }) }
      },
    }),
    server.register({
      kind: 'exact',
      path: `${API_PREFIX}/history`,
      handler: (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') { sendJson(res, 405, { ok: false, error: '历史只支持 GET' }); return }
        let query: HistoryQuery
        try { query = historyQuery(req.url ?? '/') }
        catch (error) { sendJson(res, 400, { ok: false, error: errorText(error) }); return }
        try {
          const task = query.taskId === undefined ? undefined : getTask(query.taskId, READ_ONLY)
          if (query.taskId !== undefined && !task) { sendJson(res, 404, { ok: false, error: '没有这个任务；未推测关联记录' }); return }
          const page = historyPage(query, historyRows(query, task, deps))
          if (query.revision !== undefined && query.revision !== page.revision) {
            sendJson(res, 409, { ok: false, code: 'HISTORY_CHANGED', error: '历史已变化，请刷新后重新翻页' }); return
          }
          sendJson(res, 200, page)
        } catch (error) { sendJson(res, 503, { ok: false, error: errorText(error) }) }
      },
    }),
    server.register({
      kind: 'exact',
      path: `${API_PREFIX}/task`,
      handler: async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') { sendJson(res, 405, { ok: false, error: '任务详情只支持 GET' }); return }
        const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id')
        if (!id?.trim() || id.length > 256) { sendJson(res, 400, { ok: false, error: '请指定有效的任务 ID' }); return }
        try {
          const detail = await taskDetail(id, deps)
          if (!detail) { sendJson(res, 404, { ok: false, error: '没有这个任务；未推测关联记录' }); return }
          sendJson(res, 200, detail)
        } catch (error) { sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
      },
    }),
    server.register({
      kind: 'exact',
      path: `${API_PREFIX}/note`,
      handler: async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase()
        try {
          if (method === 'GET') {
            const slug = new URL(req.url ?? '/', 'http://localhost').searchParams.get('slug')
            if (slug === null) {
              sendJson(res, 200, {
                ok: true,
                // Apply the note quota after excluding migration/backup metadata.
                // Every displayed slug must round-trip through the existing reader.
                notes: listFiles('notes', Number.MAX_SAFE_INTEGER)
                  .filter((file) => /^notes\/[^/]+\.md$/.test(file.path)
                    && noteFile(file.path.slice('notes/'.length, -3)) === vaultPath(file.path))
                  .slice(0, 200)
                  .map((file) => ({ path: file.path, size: file.size, modified: file.modified })),
              })
              return
            }
            const path = noteFile(slug)
            if (path === undefined) {
              sendJson(res, 400, { ok: false, error: 'slug 不合法' })
              return
            }
            const text = readText(path)
            if (text === undefined) {
              sendJson(res, 404, { ok: false, error: `没有这个笔记：notes/${slug}.md` })
              return
            }
            sendJson(res, 200, { ok: true, slug, path, text })
            return
          }
          if (method === 'POST') {
            const body = await readBody(req)
            const parsed = body.trim() === '' ? {} : (JSON.parse(body) as { slug?: unknown })
            const slug = typeof parsed.slug === 'string' ? parsed.slug : ''
            const path = noteFile(slug)
            if (path === undefined) {
              sendJson(res, 400, { ok: false, error: 'slug 不合法' })
              return
            }
            const text = readText(path)
            if (text === undefined) {
              sendJson(res, 404, { ok: false, error: `没有这个笔记：notes/${slug}.md` })
              return
            }
            sendJson(res, 200, { ok: true, slug, path, text })
            return
          }
          sendJson(res, 405, { ok: false, error: '只支持 GET 与 POST' })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
