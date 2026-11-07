/**
 * The butler's ledger: durable task state, receipts, usage, and the running
 * memory the workbench reads.
 *
 * Why a ledger rather than "just the session": a chat transcript is a fine
 * record of what was said and a terrible record of what actually happened. The
 * ledger is the other half - every task with a stable id and a state machine,
 * every tool call with the result that proves it, every failure with its reason,
 * every model call with its tokens. It survives restarts, and it is what makes
 * "完成声明对应实际工具结果" checkable instead of aspirational.
 *
 * Discipline (borrowed from OpenMuse): a restart restores STATE, never actions.
 * Nothing here re-runs an external step on its own; a task that was running when
 * the process died is marked `interrupted` and waits for a human or for the next
 * turn to pick it up, because an uncertain external write must not be retried
 * behind the owner's back.
 *
 * @module @dsh-external/dsh-butler/host/ledger
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { estimateSpend, isPriced, isPricedModel, priceBasis } from './pricing.ts'
import { appendLine, localDate, readText, statePath, vaultPath, writeText } from './vault.ts'
import { commitFiles, commitState, readJsonLinesLenient, readJsonLinesStrict, readSnapshot, readState, type OperationMetadata, type ReadOptions } from './store.ts'
import { maybeRotateUsageLedger, readUsageArchive } from './usage-rotation.ts'

export type { OperationMetadata } from './store.ts'

/** Task lifecycle. `interrupted` is the honest state of work killed mid-flight. */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** How well the butler actually knows a source. */
export type ReadLevel = 'abstract' | 'fulltext'

/** Provenance of one claim. */
export interface Evidence {
  evidenceId?: string
  /** Canonical locator: DOI URL, page URL, or file path. */
  source_url?: string
  /** What kind of thing it is. */
  source_type?: 'journal' | 'preprint' | 'web' | 'file' | 'book' | 'other'
  /** Retrieval date, `YYYY-MM-DD`. */
  retrieved_at?: string
  /** What verified it: a provider name, a checksum, or a human. */
  verified_by?: string
  /** Did the butler read the abstract or the whole document? Never guess upward. */
  read_level?: ReadLevel
  /** Short hash of the stored original, when one exists. */
  sha256?: string
  /** Page or section anchors the conclusions were drawn from. */
  anchors?: string[]
}

/** One tracked piece of work. */
export interface Task {
  ownerId?: string
  channelOrigin?: import('./channel-ingress.ts').ChannelOrigin
  reminder?: import('./reminder-operations.ts').ReminderTaskLink
  sessionId?: string
  rootSessionId?: string
  runId?: string
  originMessageId?: string
  lastTransitionOriginId?: string
  /** Stable id (also the idempotency key for any external effect). */
  id: string
  /** What the owner asked for, in their words. */
  title: string
  /** Lifecycle state. */
  status: TaskStatus
  /** Creation instant, ISO. */
  createdAt: string
  /** Last mutation instant, ISO. */
  updatedAt: string
  /** Due instant when the task is time-bound, ISO. */
  dueAt?: string
  /** Coarse bucket the workbench groups by. */
  kind?: 'todo' | 'reminder' | 'research' | 'note' | 'pdf' | 'digest' | 'other'
  /** One-line outcome or refusal reason. */
  note?: string
  /** Claims this task produced, each with its provenance. */
  evidence?: Evidence[]
  evidenceVerification?: 'host-registered' | 'legacy-unverified'
  /** Model tokens attributed to this task. */
  modelTokens?: number
  /** Cost when the provider reports one. */
  cost?: number
  /** Tool calls that produced the result. */
  tools?: string[]
  /** Retry counter; the retry policy refuses past the cap. */
  attempts?: number
}

/** One tool invocation, recorded whether it succeeded or not. */
export interface Receipt {
  ownerId?: string
  channelOrigin?: import('./channel-ingress.ts').ChannelOrigin
  sessionId?: string
  rootSessionId?: string
  runId?: string
  originMessageId?: string
  callId?: string
  turn?: number
  step?: number
  artifacts?: Array<{ kind?: string; reference?: string; path?: string; sha256?: string }>
  /** When the call finished, ISO. */
  at: string
  /** Tool name. */
  tool: string
  /** Task the call belonged to, when known. */
  taskId?: string
  /** Whether the call succeeded. */
  ok: boolean
  /** Milliseconds spent. */
  ms?: number
  /** One-line summary of what came back. */
  summary?: string
  /** Failure text, verbatim, when it failed. */
  error?: string
}

/**
 * Token/cost record for one model call.
 *
 * The token numbers come from DSH's own `assistant/message` session event,
 * whose payload carries a `TokenUsage` (`inputTokens`, `outputTokens`,
 * `totalTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?`).
 * DSH exposes no price anywhere, so `cost` is an *estimate*: it is priced with
 * the published table in `./pricing.ts` and carries the `costBasis` naming the
 * table, the row and the peak/off-peak column that produced it. An estimate with
 * a provenance can be checked; a bare number that looks like a bill cannot.
 */
export interface Usage {
  ownerId?: string
  channelOrigin?: import('./channel-ingress.ts').ChannelOrigin
  /** Append-only migration alias for a legacy session/turn/step record. */
  replacesKey?: string
  eventSeq?: number
  usageState?: 'reported' | 'unknown'
  scopeKind?: 'normal' | 'reminder' | 'child' | 'other'
  rootSessionId?: string
  runId?: string
  originMessageId?: string
  callId?: string
  /** Omitted on historical assistant rows; auxiliary calls have their own callId namespace. */
  callKind?: 'assistant' | 'auxiliary'
  /** Native request purpose, independent of assistant turn/step positions. */
  purpose?: UsagePurpose
  outcome?: 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** When the call finished, ISO. */
  at: string
  /** Task the call belonged to, when known. */
  taskId?: string
  /** Session the call happened in, when known. */
  sessionId?: string
  /** Turn number inside that session, when known. */
  turn?: number
  /** Step number inside that turn, when known. */
  step?: number
  /** Provider name. */
  provider?: string
  /** Model id. */
  model?: string
  /** Prompt tokens. */
  inputTokens?: number
  /** Completion tokens. */
  outputTokens?: number
  /** Total tokens, when the provider reported it. */
  totalTokens?: number
  /** Prompt tokens served from cache. */
  cacheReadTokens?: number
  /** Prompt tokens written to cache. */
  cacheWriteTokens?: number
  /** Reasoning tokens, when the provider separates them. */
  reasoningTokens?: number
  /** Estimated cost in CNY, priced from the published table. Not a bill. */
  cost?: number
  /** Which table/row/column produced `cost`, e.g. `official-2026-09-10/flash/offPeak`. */
  costBasis?: string
  /** Where the row came from: the live event feed, or a session-log backfill. */
  origin?: 'live' | 'backfill'
  /**
   * Whose call it was: the butler's own session, or any other session on this
   * machine. The ledger reads every session's log, so without this the panel
   * would charge the butler for work the owner did themselves.
   */
  scope?: 'butler' | 'other'
}

export type UsagePurpose = 'assistant' | 'session-title' | 'compaction' | 'unknown'

/** Coverage for one purpose. Missing usage and reported-but-unpriced calls are disjoint. */
export interface UsagePurposeTotals {
  calls: number
  totalTokens: number
  withoutUsage: number
  pricedCalls: number
  unpricedCalls: number
  cost: number
  failedCalls: number
  cancelledCalls: number
}

/** Why a recorded call has no known amount; missing usage stays separate from unpriced usage. */
export type UsageUnknownCostReason = 'missing-usage' | 'provider-no-price' | 'model-no-price' | 'incomplete-usage' | 'no-estimate'

/** Read-only cost coverage for the exact provider/model reported by each call. */
export interface UsageProviderModelTotals extends UsagePurposeTotals {
  provider?: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Distinct stored or derived bases; historical estimates keep their original basis. */
  costBases: string[]
  unknownCostReasons: Partial<Record<UsageUnknownCostReason, number>>
}

/**
 * Roll-up over usage records.
 *
 * Two token totals are reported on purpose, because they answer different
 * questions and conflating them is what makes usage "look" enormous:
 * `totalTokens` is what the provider counted for every call (in a long session
 * that is mostly prompt re-sent each step, ~97% of it served from cache), while
 * `newTokens` is the part that is actually new content (uncached input plus
 * output).
 */
export interface UsageTotals {
  /** Uncached prompt tokens, summed. */
  inputTokens: number
  /** Completion tokens, reasoning included, summed. */
  outputTokens: number
  /** What the provider counted in total (`input + cacheRead + output` over calls). */
  totalTokens: number
  /** Prompt tokens served from cache. */
  cacheReadTokens: number
  /** Prompt tokens written to cache. */
  cacheWriteTokens: number
  /** Reasoning tokens, where the provider separates them (inside `outputTokens`). */
  reasoningTokens: number
  /** Uncached input plus output: the tokens that are genuinely new work. */
  newTokens: number
  /** `cacheReadTokens / (inputTokens + cacheReadTokens)`, 0 when there is no prompt. */
  cacheHitRate: number
  /** Estimated cost in CNY, summed over priced calls. */
  cost: number
  /** Which price table the estimate came from. */
  costBasis: string
  /** Calls that carried a priceable token count. */
  pricedCalls: number
  /**
   * Of those, how many were priced at roll-up time because the row itself had no
   * stored `cost` (rows written before the price table existed, or by a version
   * that did not price). Recomputing is honest - the tokens are the row's own and
   * the table is published - but the panel says how many were recomputed.
   */
  derivedCalls: number
  /** Calls that had no usage payload at all: unknown, never counted as zero tokens. */
  withoutUsage: number
  /** Calls recorded, priced or not. */
  calls: number
  /** Historical rows without a callKind remain assistant calls. */
  assistantCalls: number
  auxiliaryCalls: number
  /** Calls with reported usage whose price is unknown; excludes missing usage. */
  unpricedCalls: number
  byPurpose: Record<UsagePurpose, UsagePurposeTotals>
  /** Optional for compatibility with hosts that predate provider/model cost review. */
  byProviderModel?: UsageProviderModelTotals[]
  /** Calls the live event feed caught as they happened. */
  liveCalls: number
  /** Calls recovered from the session logs at startup (the reload seams). */
  backfilledCalls: number
  /** How many distinct sessions the records came from. */
  sessions: number
  /** Calls attributed to the butler's own session. */
  butlerCalls: number
  /** New tokens (uncached input plus output) spent by the butler's own session. */
  butlerNewTokens: number
  /** Estimated CNY spent by the butler's own session. */
  butlerCost: number
  /** Calls whose session could not be attributed to either side (unknown, not zero). */
  scopeUnknown: number
  /** Most recent record's instant, ISO. */
  lastAt?: string
}

/** A pending proposal awaiting the owner's yes/no. */
export interface PendingItem {
  /** Stable id. */
  id: string
  /** What is being proposed. */
  title: string
  /** Why it needs a decision. */
  reason: string
  /** Which task it belongs to. */
  taskId?: string
  /** Creation instant, ISO. */
  createdAt: string
  /** `pending` until the owner answers. */
  status: 'pending' | 'approved' | 'declined'
}

/** A durable note about the owner, awaiting or holding their confirmation. */
export interface Memo {
  /** Stable id. */
  id: string
  /** The fact. */
  text: string
  /** Who said so. */
  source: 'user' | 'butler'
  /** Creation instant, ISO. */
  createdAt: string
  /** `proposed` never reaches the profile; only `confirmed` does. */
  status: 'proposed' | 'confirmed' | 'rejected' | 'retracted'
}

/** Everything the workbench needs to paint its first screen. */
export interface LedgerSnapshot {
  /** Open work, most urgent first. */
  open: Task[]
  /** Proposals waiting for a decision. */
  pending: PendingItem[]
  /** Facts awaiting confirmation. */
  proposedMemos: Memo[]
  /** Newest receipts, newest first. */
  recent: Receipt[]
  /** Usage roll-up. */
  usage: UsageTotals
  /** Tasks that were interrupted by a restart. */
  interrupted: Task[]
}

/** Ledger file names. Tasks are rewritten in place; the rest only append. */
const TASKS_FILE = (): string => vaultPath('ledger', 'tasks.jsonl')
const RECEIPTS_FILE = (): string => vaultPath('ledger', 'receipts.jsonl')
const USAGE_FILE = (): string => vaultPath('ledger', 'usage.jsonl')
const PENDING_FILE = (): string => statePath('pending.json')
const MEMOS_FILE = (): string => statePath('memos.json')
const FAILURES_FILE = (): string => statePath('tool-failures.json')

/** Maximum consecutive failures of the same tool before it is refused. */
export const FAILURE_LIMIT = 10

/** Maximum attempts for one task before a retry is refused. */
export const ATTEMPT_LIMIT = 3

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isInstant = (value: unknown): boolean => isString(value) && Number.isFinite(Date.parse(value))
const TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'waiting_review', 'done', 'failed', 'cancelled', 'interrupted']
const isTask = (value: unknown): boolean => isRecord(value) && isString(value.id) && typeof value.title === 'string'
  && TASK_STATUSES.includes(value.status as TaskStatus) && isInstant(value.createdAt) && isInstant(value.updatedAt)
const isPending = (value: unknown): boolean => isRecord(value) && isString(value.id) && typeof value.title === 'string'
  && typeof value.reason === 'string' && isInstant(value.createdAt) && ['pending', 'approved', 'declined'].includes(String(value.status))
const isMemo = (value: unknown): boolean => isRecord(value) && isString(value.id) && typeof value.text === 'string'
  && isInstant(value.createdAt) && ['user', 'butler'].includes(String(value.source)) && ['proposed', 'confirmed', 'rejected', 'retracted'].includes(String(value.status))
const rowsOf = (check: (value: unknown) => boolean) => (value: unknown): boolean => Array.isArray(value) && value.every(check)
const tasksSpec = () => ({ path: TASKS_FILE(), format: 'jsonl' as const, fallback: [] as Task[], validate: rowsOf(isTask), validateRow: isTask })
const pendingSpec = () => ({ path: PENDING_FILE(), format: 'json' as const, fallback: [] as PendingItem[], validate: rowsOf(isPending) })
const memosSpec = () => ({ path: MEMOS_FILE(), format: 'json' as const, fallback: [] as Memo[], validate: rowsOf(isMemo) })

/** Serialize a JSON state file atomically. */
function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Retain the owner-readable legacy JSONL snapshot format. */
function taskText(tasks: Task[]): string {
  const body = tasks.map((task) => JSON.stringify(task)).join('\n')
  return body === '' ? '' : `${body}\n`
}

/** All tasks, newest first. */
export function listTasks(options: { recover?: boolean } = {}): Task[] {
  return readJsonLinesStrict<Task>(TASKS_FILE(), isTask, options)
    .map(task => task.evidence?.length && task.evidenceVerification === undefined ? { ...task, evidenceVerification: 'legacy-unverified' as const } : task)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** Tasks in one state. */
export function tasksByStatus(...statuses: TaskStatus[]): Task[] {
  return listTasks().filter((task) => statuses.includes(task.status))
}

/** One task by id. */
export function getTask(id: string, options: { recover?: boolean } = {}): Task | undefined {
  return listTasks(options).find((task) => task.id === id)
}

/**
 * Create or update a task.
 *
 * `id` and `createdAt` are owned by the ledger and never taken from the patch,
 * so a caller cannot accidentally renumber a task or reset its age.
 * @param id - stable id.
 * @param patch - fields to set; `title` is required when creating.
 * @returns the stored task, or undefined when the id is unknown and no title was given.
 */
export function upsertTask(id: string, patch: Partial<Task> & { title?: string }, operation?: OperationMetadata): Task | undefined {
  const now = operation?.time ?? new Date().toISOString()
  return commitState(tasksSpec(), { ...operation, time: now, kind: 'task.upsert', targetId: id }, tasks => {
    const index = tasks.findIndex(task => task.id === id)
    const { id: _ignoredId, createdAt: _ignoredCreatedAt, ...fields } = patch
    if (index < 0) {
      const title = fields.title
      if (title === undefined) return { value: tasks, result: undefined }
      const created: Task = { ...fields, id, title, status: fields.status ?? 'pending', createdAt: now, updatedAt: now }
      return { value: [created, ...tasks], result: created }
    }
    const existing = tasks[index] as Task
    const next: Task = { ...existing, ...fields, id: existing.id, createdAt: existing.createdAt, updatedAt: now }
    tasks[index] = next
    return { value: tasks, result: next }
  })
}

/**
 * Append a receipt for one tool call.
 * @param receipt - the call's outcome.
 */
export function addReceipt(receipt: Omit<Receipt, 'at'> & { at?: string }): void {
  const row: Receipt = { ...receipt, at: receipt.at ?? new Date().toISOString() }
  appendLine(RECEIPTS_FILE(), JSON.stringify(row))
}

/** Most recent receipts, newest first. */
export function receipts(limit = 30): Receipt[] {
  return readJsonLinesLenient<Receipt>(RECEIPTS_FILE(), value => isRecord(value) && isInstant(value.at) && isString(value.tool) && typeof value.ok === 'boolean').slice(-limit).reverse()
}

/**
 * Append a usage record for one model call.
 * @param usage - the call's token/cost numbers.
 */
export function addUsage(usage: Omit<Usage, 'at'> & { at?: string }): void {
  addUsageBatch([usage])
}

export interface UsageBatchWrite {
  row: Usage
  previous?: Usage
  appended: boolean
}

/** Reconcile a bounded batch against the current live index, then durably append once. */
export function addUsageBatch(
  usages: readonly (Omit<Usage, 'at'> & { at?: string })[],
  prepare?: (row: Usage) => Usage,
): UsageBatchWrite[] {
  if (usages.length === 0) return []
  const index = currentUsageIndex()
  const lines: string[] = []
  const writes: UsageBatchWrite[] = []
  try {
    for (const usage of usages) {
      let row: Usage = { ...usage, at: usage.at ?? new Date().toISOString() }
      const key = usageIdentity(row)
      let previous = key === undefined ? undefined : index.calls.get(key)
      if (!previous && row.callKind !== 'auxiliary' && row.eventSeq !== undefined && row.sessionId && row.turn !== undefined && row.step !== undefined) {
        const legacyKey = usageKey(row.sessionId, row.turn, row.step, undefined, row.at)
        const legacy = index.calls.get(legacyKey)
        if (legacy !== undefined && legacy.callKind !== 'auxiliary' && legacy.eventSeq === undefined) {
          previous = legacy
          row = { ...row, replacesKey: legacyKey }
        }
      }
      const merged = previous === undefined ? row : mergeUsage(previous, row)
      const next = prepare === undefined ? merged : prepare(merged)
      const appended = previous === undefined || JSON.stringify(next) !== JSON.stringify(previous)
      writes.push({ row: { ...next }, previous, appended })
      if (!appended) continue
      lines.push(JSON.stringify(next))
      indexUsage(index, next)
    }
    if (lines.length === 0) return writes
    const path = USAGE_FILE()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${index.needsSeparator ? '\n' : ''}${lines.join('\n')}\n`, { encoding: 'utf8', flush: true })
    index.needsSeparator = false
    index.signature = usageSignature(path).signature
    return writes
  } catch (error) {
    // A failed/partial append must be read back before the next writer proceeds.
    cachedUsage = undefined
    throw error
  }
}

/** The identity of one model call: its session, turn and step. */
export function usageKey(sessionId: string, turn: number, step: number, eventSeq?: number, at?: string): string {
  return eventSeq === undefined ? `${sessionId}#${turn}#${step}${at === undefined ? '' : `#at:${at}`}` : `${sessionId}#seq:${eventSeq}`
}

export function hasReportedUsage(row: Usage): boolean {
  return row.usageState !== 'unknown' && [row.inputTokens, row.outputTokens, row.totalTokens, row.cacheReadTokens, row.cacheWriteTokens].some(value => value !== undefined)
}

/** A missing input/output count is unknown, never an implicit zero for pricing. */
export function hasPriceableUsage(row: Pick<Usage, 'inputTokens' | 'outputTokens' | 'usageState'>): boolean {
  return row.usageState !== 'unknown' && [row.inputTokens, row.outputTokens]
    .every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

/** Position alone cannot identify old calls: a native event must also match its stored instant. */
export function legacyUsageMatches(rows: Usage[], incoming: Pick<Usage, 'sessionId' | 'turn' | 'step' | 'at'>): Usage[] {
  return rows.filter(entry => entry.callKind !== 'auxiliary' && entry.eventSeq === undefined && entry.sessionId === incoming.sessionId && entry.turn === incoming.turn
    && entry.step === incoming.step && entry.at === incoming.at)
}

function usageIdentity(row: Usage): string | undefined {
  // Auxiliary requests can precede an agent turn and can retry at one position.
  // Never let a native assistant event or legacy alias claim this namespace.
  if (row.callKind === 'auxiliary') return row.callId ? `auxiliary:${row.callId}` : undefined
  if (!row.sessionId) return undefined
  if (row.eventSeq !== undefined) return `${row.sessionId}#seq:${row.eventSeq}`
  return row.turn === undefined || row.step === undefined ? undefined : usageKey(row.sessionId, row.turn, row.step, undefined, row.at)
}

function mergeUsage(previous: Usage, incoming: Usage): Usage {
  const next = hasReportedUsage(previous) && !hasReportedUsage(incoming)
    ? { ...incoming, ...previous, eventSeq: incoming.eventSeq ?? previous.eventSeq, replacesKey: incoming.replacesKey ?? previous.replacesKey }
    : { ...previous, ...incoming }
  // A live call can arrive between background batches. Its attribution remains
  // authoritative when the recovered event supplies tokens or pricing later.
  if (incoming.origin === 'backfill') {
    for (const key of ['taskId', 'rootSessionId', 'runId', 'originMessageId', 'callId', 'scope', 'scopeKind', 'ownerId', 'channelOrigin'] as const) {
      if (previous[key] !== undefined) Object.assign(next, { [key]: previous[key] })
    }
  }
  return { ...next, origin: previous.origin ?? incoming.origin,
    ...(previous.cost === undefined ? {} : { cost: previous.cost, costBasis: previous.costBasis }),
    at: incoming.origin === 'backfill' ? incoming.at : previous.at }
}

interface UsageIndex {
  signature: string
  calls: Map<string, Usage>
  unattributed: number
  needsSeparator: boolean
}

let cachedUsage: UsageIndex | undefined

function usageSignature(path: string): { signature: string; size: number } {
  try {
    const stat = statSync(path, { bigint: true })
    return { signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, size: Number(stat.size) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { signature: 'missing', size: 0 }
    throw error
  }
}

function indexUsage(index: UsageIndex, row: Usage): void {
  const key = usageIdentity(row) ?? `unattributed:${index.unattributed++}`
  const candidate = row.callKind !== 'auxiliary' && row.eventSeq !== undefined && row.replacesKey ? index.calls.get(row.replacesKey) : undefined
  const replaced = candidate && candidate.callKind !== 'auxiliary' && candidate.eventSeq === undefined && candidate.sessionId === row.sessionId
    && candidate.turn === row.turn && candidate.step === row.step && candidate.at === row.at ? candidate : undefined
  if (replaced) index.calls.delete(row.replacesKey!)
  const previous = index.calls.get(key) ?? replaced
  index.calls.set(key, previous ? mergeUsage(previous, row) : row)
}

/** One usage row as the lenient reader accepts it; shared with the archive reader. */
const usageRowValid = (value: unknown): boolean => isRecord(value) && isInstant(value.at)
  && ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'eventSeq']
    .every(key => value[key] === undefined || Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)

/** Archived rows that could not be read; empty when the archive is healthy. */
let usageArchiveProblems: string[] = []

/**
 * Explicit diagnostics for the usage archive: a read failure never silently
 * drops archived calls from the totals, it is reported here.
 * @returns the last read's problems, verbatim.
 */
export function usageArchiveDiagnostics(): string[] {
  return [...usageArchiveProblems]
}

function currentUsageIndex(): UsageIndex {
  const path = USAGE_FILE()
  let observed = usageSignature(path)
  // Rotation keeps the hot append-only file bounded. It is maintenance, never a
  // precondition: a failed pass leaves the bytes alone and the read still runs.
  if (maybeRotateUsageLedger({ path, observedBytes: observed.size })?.applied === true) observed = usageSignature(path)
  if (cachedUsage?.signature === observed.signature) return cachedUsage
  // Archived years stay part of the ledger: totals and per-session attribution
  // are computed over hot + archive rows exactly as they were before rotation.
  // Archive damage is surfaced through usageArchiveDiagnostics(), never hidden.
  const archived = readUsageArchive<Usage>(usageRowValid)
  usageArchiveProblems = archived.problems
  // Keep the store's lenient parser so damaged rows remain visible in storage
  // diagnostics. External edits/replacements invalidate this projection.
  const rows = [...archived.rows, ...readJsonLinesLenient<Usage>(path, usageRowValid)]
  const index: UsageIndex = { signature: observed.signature, calls: new Map(), unattributed: 0, needsSeparator: false }
  for (const row of rows) indexUsage(index, row)
  if (observed.size > 0) {
    const fd = openSync(path, 'r')
    try {
      const tail = Buffer.alloc(1)
      readSync(fd, tail, 0, 1, observed.size - 1)
      index.needsSeparator = tail[0] !== 0x0a
    } finally { closeSync(fd) }
  }
  cachedUsage = index
  return index
}

/** Every projected usage record, oldest first; callers receive independent copies. */
export function usageRecords(): Usage[] {
  return [...currentUsageIndex().calls.values()].map(row => ({ ...row }))
}

/**
 * The calls already in the ledger, as identity keys.
 * A backfill reads the same calls out of the session logs, so it needs to know
 * which ones are already recorded instead of writing a second row for them.
 * @param rows - records to index; defaults to the whole file.
 * @returns the key set.
 */
export function usageKeys(rows: Usage[] = usageRecords()): Set<string> {
  const keys = new Set<string>()
  for (const row of rows) {
    const key = usageIdentity(row)
    if (key) keys.add(key)
  }
  return keys
}

/**
 * The butler's own session id, once it is known.
 *
 * Module-level on purpose: the workbench asks for totals on every poll from code
 * that holds no session handle, and "which session is mine" is a fact about this
 * process rather than about any single row. Rows written before the id was known
 * carry no `scope`, so the roll-up derives it from the row's own `sessionId` -
 * re-derived from stored data, never guessed.
 */
let butlerOwnSessionId: string | undefined
let butlerManagedSessionIds = new Set<string>()

/** Register managed chat roots in memory; existing usage rows stay untouched. */
export function setButlerSessionIds(ids: readonly string[]): void {
  butlerManagedSessionIds = new Set(ids.filter(id => typeof id === 'string' && id.length > 0))
}

/** Remember which session belongs to the butler itself. */
export function setButlerSessionId(id: string | undefined): void {
  if (id !== undefined && id.length > 0) butlerOwnSessionId = id
}

/** The butler's own session id, or undefined while it is still unknown. */
export function butlerSessionId(): string | undefined {
  return butlerOwnSessionId
}

/** Whose call a row is, derived from its own session id when it carries no `scope`. */
export function usageScope(row: Pick<Usage, 'sessionId' | 'rootSessionId'>, butlerId = butlerOwnSessionId): Pick<Usage, 'scope' | 'scopeKind'> {
  if (row.sessionId?.startsWith('session-butler-reminder-') || row.rootSessionId?.startsWith('session-butler-reminder-')) return { scope: 'butler', scopeKind: 'reminder' }
  if (!row.sessionId || !butlerId && butlerManagedSessionIds.size === 0) return {}
  if (row.sessionId === butlerId || butlerManagedSessionIds.has(row.sessionId)) return { scope: 'butler', scopeKind: 'normal' }
  if (butlerId !== undefined && row.rootSessionId === butlerId || row.rootSessionId !== undefined && butlerManagedSessionIds.has(row.rootSessionId)) return { scope: 'butler', scopeKind: 'child' }
  return { scope: 'other', scopeKind: 'other' }
}

/** Roll up usage, optionally for one task. */
export function usageTotals(taskId?: string): UsageTotals {
  return rollupUsage(usageRecords().filter((row) => taskId === undefined || row.taskId === taskId))
}

/** Native theme and explicitly attributed children; source histories stay outside this scope. */
export function sessionUsageTotals(sessionId: string): UsageTotals {
  return rollupUsage(usageRecords().filter(row => row.sessionId === sessionId || row.rootSessionId === sessionId))
}

function rollupUsage(rows: Usage[]): UsageTotals {
  const sessions = new Set<string>()
  const providerModels = new Map<string, UsageProviderModelTotals>()
  const totals = rows.reduce<UsageTotals>((acc, row) => {
    if (row.sessionId !== undefined) sessions.add(row.sessionId)
    if (row.at !== undefined && (acc.lastAt === undefined || row.at > acc.lastAt)) acc.lastAt = row.at
    acc.calls += 1
    const auxiliary = row.callKind === 'auxiliary'
    if (auxiliary) acc.auxiliaryCalls += 1
    else acc.assistantCalls += 1
    const purpose: UsagePurpose = !auxiliary ? 'assistant'
      : row.purpose === 'session-title' || row.purpose === 'compaction' ? row.purpose : 'unknown'
    const group = acc.byPurpose[purpose]
    group.calls += 1
    const routeKey = JSON.stringify([row.provider ?? null, row.model ?? null])
    let route = providerModels.get(routeKey)
    if (!route) {
      route = { ...(row.provider === undefined ? {} : { provider: row.provider }), ...(row.model === undefined ? {} : { model: row.model }), calls: 0, totalTokens: 0, withoutUsage: 0,
        pricedCalls: 0, unpricedCalls: 0, cost: 0, failedCalls: 0, cancelledCalls: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costBases: [], unknownCostReasons: {} }
      providerModels.set(routeKey, route)
    }
    route.calls += 1
    if (row.outcome === 'failed') group.failedCalls += 1
    if (row.outcome === 'cancelled') group.cancelledCalls += 1
    if (row.outcome === 'failed') route.failedCalls += 1
    if (row.outcome === 'cancelled') route.cancelledCalls += 1
    if (row.origin === 'backfill') acc.backfilledCalls += 1
    else acc.liveCalls += 1
    const input = row.inputTokens ?? 0
    const output = row.outputTokens ?? 0
    const cacheRead = row.cacheReadTokens ?? 0
    const counted = row.totalTokens ?? input + cacheRead + output
    if (!hasReportedUsage(row)) {
      // No usage payload reached us for this call: unknown, so it is counted as
      // unknown rather than folded in as a zero-token call.
      acc.withoutUsage += 1
      group.withoutUsage += 1
      route.withoutUsage += 1
      route.unknownCostReasons['missing-usage'] = (route.unknownCostReasons['missing-usage'] ?? 0) + 1
      const scope = row.scope ?? usageScope(row).scope
      if (scope === 'butler') acc.butlerCalls += 1
      else if (scope === undefined) acc.scopeUnknown += 1
      return acc
    }
    acc.inputTokens += input
    acc.outputTokens += output
    acc.totalTokens += counted
    group.totalTokens += counted
    route.inputTokens += input
    route.outputTokens += output
    route.totalTokens += counted
    route.cacheReadTokens += cacheRead
    route.cacheWriteTokens += row.cacheWriteTokens ?? 0
    acc.cacheReadTokens += cacheRead
    acc.cacheWriteTokens += row.cacheWriteTokens ?? 0
    acc.reasoningTokens += row.reasoningTokens ?? 0
    acc.newTokens += input + output
    // Rows written before the price table existed carry no `cost`. Their tokens
    // are their own and the table is public, so pricing them here is a
    // re-derivation of a real number, not an invention - and it is counted so
    // the panel can say how much of the total was recomputed.
    let cost = row.cost
    let basis = row.costBasis
    if (cost === undefined && hasPriceableUsage(row) && isPriced(row.provider) && isPricedModel(row.model)) {
      const at = Date.parse(row.at)
      const estimate = estimateSpend(row, Number.isFinite(at) ? at : Date.now(), row.model)
      if (estimate !== undefined) {
        cost = estimate.cost
        basis = priceBasis(estimate)
        acc.costBasis = basis
        acc.derivedCalls += 1
      }
    }
    if (cost !== undefined) {
      acc.cost += cost
      acc.pricedCalls += 1
      group.cost += cost
      group.pricedCalls += 1
      route.cost += cost
      route.pricedCalls += 1
      if (!route.costBases.includes(basis ?? 'unknown')) route.costBases.push(basis ?? 'unknown')
    } else {
      acc.unpricedCalls += 1
      group.unpricedCalls += 1
      route.unpricedCalls += 1
      const reason: UsageUnknownCostReason = !isPriced(row.provider) ? 'provider-no-price' : !isPricedModel(row.model)
        ? 'model-no-price' : !hasPriceableUsage(row) ? 'incomplete-usage' : 'no-estimate'
      route.unknownCostReasons[reason] = (route.unknownCostReasons[reason] ?? 0) + 1
    }
    const scope = row.scope ?? usageScope(row).scope
    if (scope === 'butler') {
      acc.butlerCalls += 1
      acc.butlerNewTokens += input + output
      acc.butlerCost += cost ?? 0
    } else if (scope === undefined) {
      // Neither side gets to claim it: the session id was not resolvable, so it is
      // reported as unattributed instead of guessed.
      acc.scopeUnknown += 1
    }
    if (row.costBasis !== undefined) acc.costBasis = row.costBasis
    return acc
  }, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    newTokens: 0,
    cacheHitRate: 0,
    cost: 0,
    costBasis: 'unknown',
    pricedCalls: 0,
    derivedCalls: 0,
    withoutUsage: 0,
    calls: 0,
    assistantCalls: 0,
    auxiliaryCalls: 0,
    unpricedCalls: 0,
    byPurpose: Object.fromEntries(['assistant', 'session-title', 'compaction', 'unknown'].map(purpose => [purpose,
      { calls: 0, totalTokens: 0, withoutUsage: 0, pricedCalls: 0, unpricedCalls: 0, cost: 0, failedCalls: 0, cancelledCalls: 0 },
    ])) as Record<UsagePurpose, UsagePurposeTotals>,
    liveCalls: 0,
    backfilledCalls: 0,
    sessions: 0,
    butlerCalls: 0,
    butlerNewTokens: 0,
    butlerCost: 0,
    scopeUnknown: 0,
  })
  const prompt = totals.inputTokens + totals.cacheReadTokens
  return { ...totals, byProviderModel: [...providerModels.values()], cacheHitRate: prompt === 0 ? 0 : totals.cacheReadTokens / prompt, sessions: sessions.size }
}

/** Pending proposals awaiting a decision. */
export function listPending(options: ReadOptions = {}): PendingItem[] {
  return allPending(options).filter((item) => item.status === 'pending')
}

/** Every proposal, including answered ones (for audit). */
export function allPending(options: ReadOptions = {}): PendingItem[] {
  return readState<PendingItem[]>(PENDING_FILE(), [], rowsOf(isPending), options)
}

/**
 * Add a proposal to the approvals queue.
 * @param item - id, title, and reason.
 * @returns the stored item (an existing one wins, so calls stay idempotent).
 */
export function addPending(item: { id: string; title: string; reason: string; taskId?: string }, operation?: OperationMetadata): PendingItem {
  const now = operation?.time ?? new Date().toISOString()
  return commitState(pendingSpec(), { ...operation, time: now, kind: 'pending.add', targetId: item.id }, all => {
    const existing = all.find(entry => entry.id === item.id)
    if (existing !== undefined) return { value: all, result: existing }
    const created: PendingItem = { ...item, createdAt: now, status: 'pending' }
    return { value: [...all, created], result: created }
  })
}

/**
 * Answer a pending proposal. Approving records the owner's decision; the butler
 * acts on the next turn, never inside this call.
 * @param id - the proposal id.
 * @param decision - approved or declined.
 * @returns the updated item, or undefined when unknown.
 */
export function decidePending(id: string, decision: 'approved' | 'declined', operation?: OperationMetadata): PendingItem | undefined {
  return commitState(pendingSpec(), { ...operation, kind: 'pending.decide', targetId: id }, all => {
    const index = all.findIndex(entry => entry.id === id)
    if (index < 0) return { value: all, result: undefined }
    const next: PendingItem = { ...(all[index] as PendingItem), status: decision }
    all[index] = next
    return { value: all, result: next }
  })
}

/** Durable facts, including ones still awaiting confirmation. */
export function listMemos(options: ReadOptions = {}): Memo[] {
  return readState<Memo[]>(MEMOS_FILE(), [], rowsOf(isMemo), options)
}

/**
 * Record a fact. A butler-proposed fact stays `proposed` until the owner
 * confirms it; only the owner, or a confirmed proposal, reaches the profile.
 * @param memo - the fact and its origin.
 * @returns the stored memo (an existing one wins).
 */
export function addMemo(memo: { id: string; text: string; source: 'user' | 'butler' }, operation?: OperationMetadata): Memo {
  const now = operation?.time ?? new Date().toISOString()
  return commitState(memosSpec(), { ...operation, time: now, kind: 'memo.add', targetId: memo.id }, all => {
    const existing = all.find(entry => entry.id === memo.id)
    if (existing !== undefined) return { value: all, result: existing }
    const created: Memo = { ...memo, createdAt: now, status: memo.source === 'user' ? 'confirmed' : 'proposed' }
    return { value: [...all, created], result: created }
  })
}

/**
 * Confirm or reject a proposed memo.
 * @param id - memo id.
 * @param status - confirmed or rejected.
 * @returns the updated memo, or undefined when unknown.
 */
export function decideMemo(id: string, status: 'confirmed' | 'rejected', operation?: OperationMetadata): Memo | undefined {
  return commitState(memosSpec(), { ...operation, kind: 'memo.decide', targetId: id }, all => {
    const index = all.findIndex(entry => entry.id === id)
    if (index < 0) return { value: all, result: undefined }
    const next: Memo = { ...(all[index] as Memo), status }
    all[index] = next
    return { value: all, result: next }
  })
}

/** Per-tool consecutive failure counters, the runaway guard. */
function failureCounters(): Record<string, number> {
  return readState<Record<string, number>>(FAILURES_FILE(), {}, value => isRecord(value) && Object.values(value).every(count => typeof count === 'number' && Number.isFinite(count)))
}

/**
 * Record the outcome of a tool call against the runaway guard.
 * @param tool - tool name.
 * @param ok - whether the call succeeded.
 * @returns the current consecutive-failure count for that tool.
 */
export function noteToolOutcome(tool: string, ok: boolean): number {
  const counters = failureCounters()
  const next = ok ? 0 : (counters[tool] ?? 0) + 1
  counters[tool] = next
  writeJson(FAILURES_FILE(), counters)
  return next
}

/**
 * Whether a tool has failed too many times in a row.
 * A tool that keeps failing is switched off rather than retried forever
 * (OpenBot's routines do the same at ten failures).
 * @param tool - tool name.
 * @returns true when the tool must be refused.
 */
export function isToolFenced(tool: string): boolean {
  return (failureCounters()[tool] ?? 0) >= FAILURE_LIMIT
}

/** Human labels for the daily log. */
const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待办',
  running: '进行中',
  waiting_review: '等你确认',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

/**
 * Change a task's state and append the matching daily-log line.
 * @param id - task id.
 * @param status - the new state.
 * @param note - one-line reason or outcome.
 * @param timeZone - zone for the daily log.
 * @returns the updated task, or undefined when unknown.
 */
export function setTaskStatus(
  id: string,
  status: TaskStatus,
  note: string | undefined,
  timeZone: string,
  operation?: OperationMetadata,
  patch?: Partial<Task>,
): Task | undefined {
  const taskSnapshot = readSnapshot(tasksSpec()), tasks = taskSnapshot.value
  const index = tasks.findIndex(task => task.id === id)
  if (index < 0) return undefined
  const now = operation?.time ?? new Date().toISOString()
  const existing = tasks[index] as Task
  const task: Task = {
    ...existing, ...patch,
    id: existing.id, createdAt: existing.createdAt, status, updatedAt: now,
    ...(note === undefined ? {} : { note }),
  }
  tasks[index] = task
  const date = localDate(new Date(now), timeZone), dailyPath = vaultPath('daily', `${date}.md`)
  const dailySnapshot = readSnapshot({ path: dailyPath, format: 'text', fallback: `# ${date}\n\n` })
  const previous = dailySnapshot.value
  const line = `- [${STATUS_LABEL[status]}] ${task.title}${note === undefined ? '' : ` — ${note}`}`
  return commitFiles({ ...operation, time: now, kind: 'task.status', targetId: id, result: task, writes: [
    { path: TASKS_FILE(), content: taskText(tasks), format: 'jsonl', validate: rowsOf(isTask), expectedBefore: taskSnapshot.expectedBefore },
    { path: dailyPath, content: `${previous}${previous.endsWith('\n') ? '' : '\n'}${line}\n`, expectedBefore: dailySnapshot.expectedBefore },
  ] })
}

/**
 * Mark every task that was mid-flight when the process stopped.
 * Recovery restores state only: nothing is re-executed, so an uncertain
 * external write is never repeated behind the owner's back.
 * @returns the tasks that were flipped to `interrupted`.
 */
export function markInterruptedOnBoot(): Task[] {
  if (!listTasks().some(task => task.status === 'running')) return []
  const now = new Date().toISOString()
  return commitState(tasksSpec(), { time: now, kind: 'task.interrupted', targetId: 'boot' }, tasks => {
    const flipped: Task[] = []
    for (const task of tasks) {
      if (task.status !== 'running') continue
      Object.assign(task, {
        status: 'interrupted', note: '进程在它执行时停止了；没有自动重试（避免重复的外部动作）。', updatedAt: now,
      } satisfies Partial<Task>)
      flipped.push(task)
    }
    return { value: tasks, result: flipped }
  })
}

/** Append one line to today's daily page. */
export function appendDaily(timeZone: string, line: string): void {
  const date = localDate(new Date(), timeZone)
  const path = vaultPath('daily', `${date}.md`)
  if (!existsSync(path)) writeText(path, `# ${date}\n\n`)
  appendLine(path, line)
}

/** Read today's daily page. */
export function readDaily(timeZone: string): string | undefined {
  return readText(vaultPath('daily', `${localDate(new Date(), timeZone)}.md`))
}

/**
 * Open work: overdue, due within 24 hours, waiting for the owner, then recent
 * activity. Apply count/byte limits only after this deterministic ordering.
 * @returns open tasks in workbench order.
 */
export function openTasks(now = new Date(), options: ReadOptions = {}): Task[] {
  const instant = now.getTime(), soon = instant + 24 * 60 * 60 * 1000
  const due = (task: Task): number => task.dueAt === undefined ? Infinity : Date.parse(task.dueAt)
  const group = (task: Task): number => {
    const at = due(task)
    return at < instant ? 0 : at <= soon ? 1 : task.status === 'waiting_review' ? 2 : 3
  }
  return listTasks(options)
    .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
    .sort((a, b) => {
      const aGroup = group(a), bGroup = group(b)
      if (aGroup !== bGroup) return aGroup - bGroup
      if (aGroup <= 1 && due(a) !== due(b)) return due(a) - due(b)
      return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    })
}

/**
 * Assemble the workbench snapshot.
 * @returns open work, approvals, recent receipts, and the usage roll-up.
 */
export function snapshot(options: ReadOptions = {}): LedgerSnapshot {
  return {
    open: openTasks(new Date(), options),
    pending: listPending(options),
    proposedMemos: listMemos(options).filter((memo) => memo.status === 'proposed'),
    recent: receipts(20),
    usage: usageTotals(),
    interrupted: listTasks(options).filter((task) => task.status === 'interrupted'),
  }
}
