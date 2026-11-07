/**
 * The host's view of the services the butler leans on.
 *
 * Written as narrow structural interfaces rather than imports of every DSH
 * package: the butler uses a small slice of each service, and pinning the slice
 * keeps the plugin compiling across harness versions where the full service type
 * has grown fields the butler has no opinion about.
 *
 * @module @dsh-external/dsh-butler/host/ctx
 */
import type { Context } from '@deepseek-ai/cordis'

/** One search hit as DSH's web service reports it. */
export interface WebSearchHit {
  title?: string
  url?: string
  snippet?: string
  /** Some providers return the published date here. */
  published?: string
}

/** The result of one search. */
export interface WebSearchResult {
  /** The provider that answered. */
  provider?: string
  /** Hits, in provider order. */
  results?: WebSearchHit[]
  /** Free-text answer when the provider synthesises one. */
  answer?: string
}

/**
 * One fetched document as `ctx.web.fetch({ url })` answers it.
 *
 * Observed shape (probed live through the host `web` service): the status is
 * `statusCode`, and the payload is `body: { kind, content }` — not a flat
 * `text`. `text`/`status` are kept as fallbacks so an older or newer harness
 * that answers the flatter shape still parses.
 */
export interface WebFetchResult {
  url?: string
  statusCode?: number
  /** Payload wrapper used by the running harness. */
  body?: { kind?: string; content?: string; text?: string; bytes?: number }
  /** Older/alternate flat shape. */
  status?: number
  contentType?: string
  text?: string
}

/** The slice of DSH's `web` service the butler uses. */
export interface WebService {
  search(request: { query: string; maxResults?: number }): Promise<WebSearchResult>
  fetch(request: { url: string }): Promise<WebFetchResult>
}

/**
 * One timing rule accepted by `schedule.create` (DSH 0.2.2).
 *
 * The old flat `after_seconds` / `at` / `daily` fields on the request are gone:
 * every create now carries exactly one tagged `timing` variant.
 */
export type ScheduleTiming =
  | { kind: 'after'; after_seconds: number }
  | { kind: 'at'; at: string | { date: string; time: string; time_zone: string } }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
  | { kind: 'rrule'; rrule: string }

/** How a delivery finds its destination session (DSH 0.2.2). */
export type ScheduleTargetRequest =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; create?: { cwd?: string; agentPreset?: string } }
  | { kind: 'new'; create?: { cwd?: string; agentPreset?: string } }

/** Request accepted by `schedule.create` in DSH 0.2.2. */
export interface ScheduleCreateRequest {
  /** Reminder body shown when it fires. */
  prompt: string
  /** Required by the service; a missing title is refused as `invalid_prompt`. */
  title: string
  /** Exactly one one-shot or recurring rule. */
  timing: ScheduleTiming
  /** Delivery destination; the butler always binds one existing isolated reminder session. */
  target?: ScheduleTargetRequest
}

/**
 * A stored reminder, flattened across the service's per-kind union.
 *
 * Every kind carries `id/title/prompt/scheduledAt`; the timing fields differ
 * (`afterSeconds`, `time`, `timeZone`, `weekdays`, `expression`, …), so the
 * shape stays open and callers read only what they need.
 */
export interface ScheduleRecord {
  id: string
  kind?: string
  title?: string
  prompt?: string
  /** The committed target instant, ISO with offset. */
  scheduledAt?: string
  /**
   * Read-only compatibility with 0.2.1-shaped rows persisted by older builds
   * (and with `scheduleRunResult` receipts). DSH 0.2.2 carries the destination
   * under `target.sessionId`; new code reads it through `reminderTargetSession`.
   */
  sessionId?: string
}

/** One delivery of a reminder, the receipt the owner asked for. */
export interface ScheduleDeliveryReceipt {
  scheduledAt?: string
  deliveredAt?: string
  messageId?: string
  /** Session the delivery landed in; reported by 0.2.2 history. */
  targetSessionId?: string
  /** Prompt snapshot kept by 0.2.2 delivery history. */
  prompt?: string
}

/** Native status of a stored task in DSH 0.2.2. */
export type ScheduleStatus = 'active' | 'paused' | 'ended'

/** One stored target as the catalog reports it; `new_once` keeps its reserved session id. */
export type ScheduleTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; sessionId: string; create?: { cwd?: string; agentPreset?: string } }
  | { kind: 'new'; create?: { cwd?: string; agentPreset?: string } }

/** One entry of the host-wide reminder catalog (DSH 0.2.2). */
export interface ScheduleCatalogEntry extends ScheduleRecord {
  /** Where deliveries land. `session` and `new_once` carry the session id. */
  target?: ScheduleTarget
  /** Every acting Session recorded on the task. */
  involvedSessionIds?: string[]
  /** Native status: `active`, `paused` or `ended`. */
  status?: ScheduleStatus
  createdAt?: string
  updatedAt?: string
  /** The most recent delivery, when the reminder already fired once. */
  lastDelivery?: ScheduleDeliveryReceipt
}

/**
 * One reminder as the butler projects it to its existing client and tools.
 *
 * `status` is normalized to the client's historical `'active' | 'inactive'`
 * type, while `rawStatus` keeps the native 0.2.2 `active|paused|ended` value so
 * no information is lost. `sessionId` is derived from `target` for the same
 * read-compatibility reason, and `kind` stays untouched.
 */
export type ButlerReminderSummary = Omit<ScheduleCatalogEntry, 'status'> & {
  status: 'active' | 'inactive'
  rawStatus?: ScheduleStatus
  /** Delivery destination derived from `target.sessionId`. */
  sessionId?: string
  targetKind?: string
}

/** Page request accepted by `schedule.list`. */
export interface ScheduleListRequest {
  active?: boolean
  limit?: number
  offset?: number
}

/** Page result of `schedule.list`. */
export interface ScheduleListResult {
  items: ScheduleCatalogEntry[]
  shown: number
  total: number
  limit: number
  offset: number
}

/** Identity request accepted by `schedule.view` / `schedule.run`. */
export interface ScheduleViewRequest {
  id: string
}

/** Non-mutating miss returned by `schedule.view` and `schedule.edit`. */
export interface ScheduleNotFoundResult {
  id: string
  code: 'schedule_not_found'
}

/** Non-mutating conflict returned by `schedule.edit`. */
export interface ScheduleConflictResult {
  id: string
  code: 'schedule_conflict'
}

/** Outcome of a `schedule.edit` delete. */
export type ScheduleDeleteResult =
  | { id: string; deleted: true }
  | { id: string; deleted: false; code: 'schedule_not_found' }

/** Patch accepted by `schedule.edit` update. */
export interface SchedulePatch {
  title?: string
  prompt?: string
  timing?: ScheduleTiming
  target?: ScheduleTargetRequest
  active?: boolean
}

/** Request accepted by `schedule.edit` in DSH 0.2.2. */
export type ScheduleEditRequest =
  | { id: string; action: 'update'; patch: SchedulePatch; expectedUpdatedAt?: string | null }
  | { id: string; action: 'delete'; expectedUpdatedAt?: string | null }

/** Result of `schedule.edit`: the updated task, a deletion, or a non-mutating miss/conflict. */
export type ScheduleEditResult =
  | ScheduleCatalogEntry
  | Extract<ScheduleDeleteResult, { deleted: true }>
  | ScheduleNotFoundResult
  | ScheduleConflictResult

/** Request accepted by `schedule.history`; `limit` is mandatory and pages are newest-first. */
export interface ScheduleHistoryRequest {
  id: string
  limit: number
  /** Exclusive message cursor from a previous page's `nextBefore`. */
  before?: string
}

/** Saved-delivery bounds reported by 0.2.2 history. */
export interface ScheduleDeliveryRetention {
  days?: number
  records?: number
}

/** One page of saved deliveries (DSH 0.2.2 shape). */
export interface ScheduleHistoryPage {
  id: string
  records: ScheduleDeliveryReceipt[]
  /** Older records exist beyond the retention window and were not read. */
  earlierRecordsUnavailable?: boolean
  /** Older records were pruned by retention. */
  earlierRecordsPruned?: boolean
  retention?: ScheduleDeliveryRetention
  /** Exclusive cursor for the next (older) page. */
  nextBefore?: string
}

/** Non-mutating history miss. */
export interface ScheduleHistoryMiss {
  id: string
  code: 'schedule_not_found' | 'delivery_cursor_not_found'
}

/** The slice of DSH's `schedule` service the butler uses (0.2.2 contract). */
export interface ScheduleService {
  create(request: ScheduleCreateRequest, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleCatalogEntry>
  list(request?: ScheduleListRequest): Promise<ScheduleListResult>
  catalog(): Promise<ScheduleCatalogEntry[]>
  view(request: ScheduleViewRequest): Promise<ScheduleCatalogEntry | ScheduleNotFoundResult>
  history(request: ScheduleHistoryRequest): Promise<ScheduleHistoryPage | ScheduleHistoryMiss>
  edit(request: ScheduleEditRequest, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleEditResult>
  /** Present in 0.2.2; the butler does not schedule deliveries itself. */
  run?(request: ScheduleViewRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry | ScheduleNotFoundResult | { id: string; code: 'schedule_execution_pending' }>
  deleteInactive?(): Promise<{ deleted: number }>
  deliveryLimits?(): { newSessionIntervalSeconds: number }
}

/** One live agent as `agents.create`/`agents.resume` hand it back. */
export interface AgentHandle {
  agent?: { id?: string }
  dispose?(): Promise<void>
}

/** Native scoped preset setup; returning void keeps the factory transaction intact. */
export interface AgentPreparation {
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
  setup?: (context: unknown, agent?: unknown) => void | Promise<void>
}

/**
 * The slice of DSH's `agents` service the butler uses.
 *
 * This is the only route to a session that actually persists: the `sessions`
 * service creates a session without a writer ("a session published outside that
 * lifecycle persists nothing"), while `agents.create`/`resume` go through the
 * factory registered by `@deepseek-ai/dsh-agent-loop`, which attaches the
 * session-log writer and publishes the agent with it.
 */
export interface AgentsService {
  /** Construct and publish an agent (and its session) through the factory. */
  create(options: AgentPreparation & {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    signal?: AbortSignal
  }): Promise<AgentHandle>
  /** Reopen a persisted session as a live agent. */
  resume(options: AgentPreparation & { resumeSessionId: string; signal?: AbortSignal }): Promise<AgentHandle>
  /** A live agent by session id, when one exists. */
  get?(id: string): { id?: string } | undefined
  /**
   * The agent a tool call is running inside.
   *
   * This is how a tool learns *which conversation* asked it to do something,
   * which is what a reminder has to be bound to if it is to be delivered back
   * into that same conversation.
   */
  currentInitiator?(): { id?: string } | undefined
}

/** The slice of DSH's `sessions` service the butler uses. */
export interface SessionsService {
  /** The live session object, or `undefined` when it is not in memory. */
  get(id: string): unknown
  list(): Array<{ id?: string }>
  /** Flush the exact resident Session through its registered persistence listeners. */
  flush(session: unknown): Promise<boolean>
}

/** Read/replay a native Session without activating an Agent. */
export interface SessionQueryService {
  readSession(id: string): Promise<{ session: { id: string; cwd?: string }; events: unknown[] }>
}

/**
 * The slice of DSH's `sessionTitle` service the butler uses.
 *
 * `rename` accepts an explicit owner title and appends it as a `user`-sourced
 * `session/title` event, which pins the title: automatic naming is superseded
 * and later messages schedule none. Without it the butler's own conversation
 * would be renamed after whatever the owner happened to say first.
 */
export interface SessionTitleService {
  get(session: unknown): { title?: string; source?: { kind?: string } } | undefined
  rename(session: unknown, title: string): { title?: string }
}

/** The slice of DSH's `workspaceRegistry` service the butler uses. */
export interface WorkspaceRegistryService {
  list(): Array<{ id?: string; path?: string }>
  resolveByPath(cwd: string): Promise<WorkspaceEntity | undefined>
  create(cwd: string, title?: string): Promise<WorkspaceEntity>
}

/** Official durable workspace membership API; attachment returns no value. */
export interface WorkspaceEntity {
  readonly id: string
  readonly path: string
  readonly sessionIds: readonly string[]
  attachSession(id: string): Promise<void>
}

/** The slice of DSH's `fs` service the butler uses. */
export interface FsService {
  readBytes(path: string): Promise<Uint8Array>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  stat(path: string): Promise<{ size?: number; isFile?: boolean } | undefined>
}

/** Service bag the butler expects to be present once its `inject` list is filled. */
export interface ButlerServices {
  web?: WebService
  schedule?: ScheduleService
  fs?: FsService
  tools: {
    register(tool: unknown): () => void
    get(name: string): unknown
  }
}

/** The host context plus the butler's service slice. */
export type ButlerContext = Context & ButlerServices
