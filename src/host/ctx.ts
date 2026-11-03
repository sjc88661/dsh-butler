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

/** Request accepted by `schedule.create`. */
export interface ScheduleCreateRequest {
  /** Reminder body shown when it fires. */
  prompt: string
  /** Required by the service; a missing title is refused as `invalid_prompt`. */
  title: string
  after_seconds?: number
  at?: string | { date: string; time: string; time_zone: string }
  every_seconds?: number
  daily?: { time: string; time_zone: string }
  weekly?: { time: string; time_zone: string; weekdays: number[] }
  cron?: { expression: string; time_zone: string }
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
}

/** One entry of the host-wide reminder catalog. */
export interface ScheduleCatalogEntry extends ScheduleRecord {
  /** Session the reminder is bound to; a delivery arrives in that session. */
  sessionId?: string
  status?: 'active' | 'inactive'
  /** The most recent delivery, when the reminder already fired once. */
  lastDelivery?: ScheduleDeliveryReceipt
}

/** One delivery of a reminder, the receipt the owner asked for. */
export interface ScheduleDeliveryReceipt {
  scheduledAt?: string
  deliveredAt?: string
  messageId?: string
}

/** Request naming one reminder inside its owning session. */
export interface ScheduleRef {
  sessionId: string
  id: string
}

/** The slice of DSH's `schedule` service the butler uses. */
export interface ScheduleService {
  create(sessionId: string, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord>
  list(request: { sessionId: string }): Promise<ScheduleRecord[]>
  catalog(): Promise<ScheduleCatalogEntry[]>
  delete(request: ScheduleRef, signal?: AbortSignal): Promise<{ id: string; deleted: boolean; code?: string }>
  update(request: unknown, signal?: AbortSignal): Promise<unknown>
  history(request: { sessionId: string; id: string; limit: number }): Promise<{ records?: ScheduleDeliveryReceipt[] }>
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
