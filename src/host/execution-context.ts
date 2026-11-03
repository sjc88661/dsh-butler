/** Session and native execution identities. Business task ids never double as budget run ids. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { commitFiles, readSnapshot } from './store.ts'
import { sha256 } from './vault.ts'
import type { ChannelOrigin } from './channel-ingress.ts'

export interface ExecutionIdentity {
  ownerId?: string
  channelOrigin?: ChannelOrigin
  /** Set only by the host's validated reminder binding, never by user/model input. */
  scheduleTaskId?: string
  sessionId?: string
  rootSessionId?: string
  runId?: string
  taskId?: string
  originMessageId?: string
  turn?: number
  step?: number
  callId?: string
}

export interface ContextAgent {
  id: string
  session?: { id?: string }
  ctx?: { get?(name: string, strict?: boolean): unknown }
  cancel?(reason: unknown, options?: { keepInbox?: boolean }): void
}

export interface ContextExecution {
  agent?: ContextAgent
  callId?: string
  /** Compatibility for older butler test/tool callers; native DSH uses callId. */
  id?: string
  name?: string
  token?: symbol
  [key: string]: unknown
}

export interface ContextMessage {
  id?: string
  source?: { kind?: string; rpcId?: string; scheduleId?: string }
  content?: unknown[]
}

export interface OriginUser {
  sessionId: string
  messageId: string
  source: 'user'
  text: string
  rpcId?: string
  ownerId?: string
  channelOrigin?: ChannelOrigin
}

export interface UserInputView {
  caller: Readonly<ExecutionIdentity>
  root: Readonly<ExecutionIdentity>
  user?: Readonly<OriginUser>
  expectedBefore?: string | null
}

export interface ExecutionContextOptions {
  appliesTo?: (agent: { id: string }) => boolean
  file?: string
  runFor?(rootSessionId: string): string | undefined
  agentFor?(): ContextAgent | undefined
  rootFor?(agent: ContextAgent): ContextAgent
  onReceipt?(receipt: ExecutionReceipt): void
  /** Host boundary only: exact native input lookup, never a model-supplied claim. */
  resolveUserOrigin?(sessionId: string, message: ContextMessage): { ownerId?: string; channelOrigin?: ChannelOrigin }
  beforeActivate?(taskId: string, identity: ExecutionIdentity): void
  resolveScheduleOwner?(taskId: string): string | undefined
}

export interface ArtifactReference { kind: string; reference: string }
export interface ExecutionReceipt extends ExecutionIdentity {
  at: string
  tool: string
  ok: boolean
  ms?: number
  summary?: string
  error?: string
  artifacts?: ArtifactReference[]
}

interface CallState { identity: ExecutionIdentity; tool?: string; startedAt: number; receipt?: ExecutionReceipt }
interface ActiveScope { identity: ExecutionIdentity; callKey: string; execution?: ContextExecution }

/** Native call ids may repeat in later steps. Unknown positions use their explicit origin/run. */
export function executionKey(identity: ExecutionIdentity | undefined): string | undefined {
  if (!identity?.sessionId || !identity.callId) return undefined
  if (identity.turn !== undefined && identity.step !== undefined) return JSON.stringify([identity.sessionId, 'position', identity.turn, identity.step, identity.callId])
  if (identity.runId !== undefined || identity.originMessageId !== undefined) return JSON.stringify([identity.sessionId, 'origin', identity.runId ?? null, identity.originMessageId ?? null, identity.callId])
  return undefined
}

interface ExecutionSnapshot { key: string; identity: ExecutionIdentity }
// This map follows individual native execution objects through a plugin reload.
// It contains no session-wide "current task" and cannot attribute a different execution.
const executionRegistry = Symbol.for('dsh-butler.execution-context.objects.v1')
const processContext = globalThis as unknown as { [key: symbol]: unknown }
const executionSnapshots = (processContext[executionRegistry] ??= new WeakMap<object, ExecutionSnapshot>()) as WeakMap<object, ExecutionSnapshot>

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const sessionOf = (agent: ContextAgent | string): string => typeof agent === 'string' ? agent : agent.session?.id ?? agent.id
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function validIdentity(value: unknown): value is ExecutionIdentity {
  const row = record(value)
  if (!row || text(row['sessionId']) === undefined) return false
  for (const key of ['rootSessionId', 'runId', 'taskId', 'originMessageId', 'callId', 'ownerId', 'scheduleTaskId']) {
    if (row[key] !== undefined && text(row[key]) === undefined) return false
  }
  if (row['channelOrigin'] !== undefined && (!validChannelOrigin(row['channelOrigin']) || row['ownerId'] !== row['channelOrigin'].ownerId)) return false
  for (const key of ['turn', 'step']) if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) return false
  return true
}

function validChannelOrigin(value: unknown): value is ChannelOrigin {
  const row = record(value)
  return row?.['provider'] === 'lark'
    && ['accountId', 'senderId', 'chatId', 'ownerId', 'messageId', 'nativeMessageId', 'sessionId'].every(key => text(row[key]) !== undefined)
    && (row['threadId'] === undefined || text(row['threadId']) !== undefined)
}

interface ContextFile {
  version: 1
  sessions: Record<string, ExecutionIdentity>
  steps?: Record<string, ExecutionIdentity>
  calls?: Record<string, CallState>
  users?: Record<string, OriginUser>
}
/** A synchronous caller's exact business bytes; never shared across public entries. */
type ContextSnapshot = { value: ContextFile; expectedBefore: string | null } | undefined
const emptyFile = (): ContextFile => ({ version: 1, sessions: {}, steps: {}, calls: {} })
/** Bounded retention: execution context keeps recent provenance, never an unbounded transcript. */
function contextLimit(name: string, fallback: number): number {
  const configured = Number(process.env[name])
  return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback
}
function pruneOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done === true) return
    map.delete(oldest.value)
  }
}
/** Native user text is evidence for the current turn, not a transcript archive. */
function boundedUserText(text: string): string {
  const limit = contextLimit('DSH_BUTLER_CONTEXT_MAX_USER_TEXT', 2000)
  return text.length <= limit ? text : text.slice(0, limit)
}
function validFile(value: unknown): boolean {
  const data = record(value), sessions = record(data?.['sessions'])
  if (data?.['version'] !== 1 || sessions === undefined || !Object.entries(sessions).every(([id, row]) => validIdentity(row) && row.sessionId === id)) return false
  if (data['steps'] !== undefined && (!record(data['steps']) || !Object.values(data['steps'] as object).every(validIdentity))) return false
  if (data['calls'] !== undefined && (!record(data['calls']) || !Object.values(data['calls'] as object).every(value => {
    const row = record(value), identity = record(row?.['identity'])
    return row !== undefined && identity !== undefined && (identity['sessionId'] === undefined || validIdentity(identity))
      && typeof row['startedAt'] === 'number' && Number.isFinite(row['startedAt'])
      && (row['tool'] === undefined || text(row['tool']) !== undefined)
      && (row['receipt'] === undefined || (record(row['receipt']) !== undefined && typeof (row['receipt'] as ExecutionReceipt).ok === 'boolean'))
  }))) return false
  if (data['users'] !== undefined && (!record(data['users']) || !Object.values(data['users'] as object).every(value => {
    const user = record(value)
    return user !== undefined && text(user['sessionId']) !== undefined && text(user['messageId']) !== undefined
      && user['source'] === 'user' && typeof user['text'] === 'string' && (user['rpcId'] === undefined || text(user['rpcId']) !== undefined)
      && (user['ownerId'] === undefined || text(user['ownerId']) !== undefined)
      && (user['channelOrigin'] === undefined || (validChannelOrigin(user['channelOrigin']) && user['ownerId'] === user['channelOrigin'].ownerId
        && user['sessionId'] === user['channelOrigin'].sessionId && user['messageId'] === user['channelOrigin'].nativeMessageId))
  }))) return false
  return true
}

export class ExecutionContexts {
  private readonly scope = new AsyncLocalStorage<ActiveScope>()
  private readonly sessions = new Map<string, ExecutionIdentity>()
  private readonly steps = new Map<string, ExecutionIdentity>()
  private readonly calls = new Map<string, CallState>()
  private readonly users = new Map<string, OriginUser>()
  private disposers: Array<() => void> = []
  private readonly options: ExecutionContextOptions

  constructor(options: ExecutionContextOptions = {}) { this.options = options; this.refresh() }

  private refresh(): ContextSnapshot {
    if (!this.options.file) return
    const snapshot = readSnapshot({ path: this.options.file, format: 'json', fallback: emptyFile(), validate: validFile })
    const data = snapshot.value
    this.sessions.clear()
    for (const [id, value] of Object.entries(data.sessions)) this.sessions.set(id, { ...value })
    this.steps.clear()
    for (const [id, value] of Object.entries(data.steps ?? {})) this.steps.set(id, { ...value })
    this.calls.clear()
    for (const [id, value] of Object.entries(data.calls ?? {})) this.calls.set(id, structuredClone(value))
    this.users.clear()
    for (const [id, value] of Object.entries(data.users ?? {})) this.users.set(id, { ...value })
    return snapshot
  }

  private save(snapshot: ContextSnapshot): ContextSnapshot {
    const file = this.options.file
    if (file === undefined) return
    if (snapshot === undefined) throw new Error('execution context save requires its local snapshot')
    // Every save rewrites the whole file and appends a journal line; keep both bounded.
    pruneOldest(this.sessions, contextLimit('DSH_BUTLER_CONTEXT_MAX_SESSIONS', 200))
    pruneOldest(this.steps, contextLimit('DSH_BUTLER_CONTEXT_MAX_STEPS', 120))
    pruneOldest(this.calls, contextLimit('DSH_BUTLER_CONTEXT_MAX_CALLS', 100))
    pruneOldest(this.users, contextLimit('DSH_BUTLER_CONTEXT_MAX_USERS', 20))
    const value = { ...snapshot.value, version: 1 as const, sessions: Object.fromEntries(this.sessions), steps: Object.fromEntries(this.steps), calls: Object.fromEntries(this.calls), users: Object.fromEntries(this.users) }
    const content = `${JSON.stringify(value, null, 2)}\n`
    commitFiles({ kind: 'execution-context.update', targetId: file,
      writes: [{ path: file, format: 'json', content, validate: validFile, expectedBefore: snapshot.expectedBefore }] })
    return { value, expectedBefore: sha256(Buffer.from(content, 'utf8')) }
  }

  forAgent(agent: ContextAgent | string): ExecutionIdentity {
    return this.forAgentSnapshot(agent).identity
  }

  private forAgentSnapshot(agent: ContextAgent | string): { identity: ExecutionIdentity; snapshot: ContextSnapshot } {
    let snapshot = this.refresh()
    const sessionId = sessionOf(agent)
    const root = typeof agent === 'string' ? agent : this.options.rootFor?.(agent) ?? agent
    let stored = this.sessions.get(sessionId)
    // A string is a persisted lookup. A live Agent has authoritative native ownership.
    const rootSessionId = typeof agent === 'string' ? stored?.rootSessionId ?? sessionOf(root) : sessionOf(root)
    const ownershipChanged = stored?.rootSessionId !== undefined && stored.rootSessionId !== rootSessionId
    if (ownershipChanged) stored = undefined
    const inherited = sessionId === rootSessionId ? undefined : this.sessions.get(rootSessionId)
    const { turn: _rootTurn, step: _rootStep, callId: _rootCall, ...rootBinding } = inherited ?? {}
    const prior = stored ?? (inherited === undefined ? undefined : rootBinding)
    const liveRun = sessionId === rootSessionId || stored === undefined
    const runId = liveRun ? this.options.runFor?.(rootSessionId) : stored?.runId
    const identity = { ...prior, sessionId, rootSessionId, ...(runId === undefined ? {} : { runId }) }
    if (liveRun && this.options.runFor !== undefined && runId === undefined) delete identity.runId
    if (ownershipChanged || (stored === undefined && inherited !== undefined)) {
      this.sessions.set(sessionId, identity)
      snapshot = this.save(snapshot)
    }
    return { identity, snapshot }
  }

  current(): ExecutionIdentity | undefined {
    return this.currentSnapshot(undefined).identity
  }

  private currentSnapshot(snapshot: ContextSnapshot): { identity: ExecutionIdentity | undefined; snapshot: ContextSnapshot } {
    const active = this.scope.getStore()
    if (active) return { identity: { ...active.identity }, snapshot }
    const agent = this.options.agentFor?.()
    return agent ? this.forAgentSnapshot(agent) : { identity: undefined, snapshot }
  }

  bindUser(agent: ContextAgent | string, message: ContextMessage, runId?: string): ExecutionIdentity {
    const { identity, snapshot } = this.forAgentSnapshot(agent)
    if (message.source?.kind !== 'user' || identity.sessionId !== identity.rootSessionId) return identity
    const originMessageId = text(message.id)
    const next = { ...identity, ...(runId === undefined ? {} : { runId }) }
    delete next.scheduleTaskId
    const origin = this.options.resolveUserOrigin?.(identity.sessionId!, message)
    if (identity.originMessageId !== originMessageId || this.options.resolveUserOrigin !== undefined) {
      delete next.ownerId
      delete next.channelOrigin
      if (origin?.ownerId !== undefined) next.ownerId = origin.ownerId
      if (origin?.channelOrigin !== undefined) next.channelOrigin = { ...origin.channelOrigin }
    }
    if (identity.originMessageId !== originMessageId || originMessageId === undefined) {
      delete next.taskId
      delete next.originMessageId
      if (runId === undefined) delete next.runId
    }
    if (originMessageId !== undefined) next.originMessageId = originMessageId
    let user: OriginUser | undefined
    let userKey: string | undefined
    if (originMessageId !== undefined) {
      const blocks = (message.content ?? []).map(record).filter(block => block?.['type'] === 'text' && typeof block['text'] === 'string')
      if (blocks.length) {
        const rpcId = text(message.source?.rpcId)
        userKey = JSON.stringify([identity.sessionId, originMessageId])
        user = { sessionId: identity.sessionId!, messageId: originMessageId,
          source: 'user', text: boundedUserText(blocks.map(block => block!['text']).join('\n')), ...(rpcId === undefined ? {} : { rpcId }),
          ...(next.ownerId === undefined ? {} : { ownerId: next.ownerId }),
          ...(next.channelOrigin === undefined ? {} : { channelOrigin: { ...next.channelOrigin } }) }
      }
    }
    if (isDeepStrictEqual(this.sessions.get(identity.sessionId!), next)
      && (user === undefined || isDeepStrictEqual(this.users.get(userKey!), user))) {
      // Live ownership/run callbacks follow the first read and may reenter or edit
      // state. Only a new full store fence with the same token admits a no-op.
      const fresh = this.refresh()
      if (fresh?.expectedBefore === snapshot?.expectedBefore) return { ...next }
      // Preserve the original CAS conflict and degraded diagnostic on changed bytes.
    }
    if (user !== undefined) this.users.set(userKey!, user)
    this.sessions.set(identity.sessionId!, next)
    this.save(snapshot)
    return { ...next }
  }

  /** Host-only: a validated native reminder occurrence supersedes prior human input without becoming human proof. */
  bindSchedule(agent: ContextAgent | string, message: ContextMessage, taskId: string): ExecutionIdentity {
    const { identity, snapshot } = this.forAgentSnapshot(agent)
    if (message.source?.kind !== 'schedule' || !text(message.id) || !text(taskId) || identity.rootSessionId !== identity.sessionId) {
      throw new Error('提醒绑定需要真实独立会话中的原生 schedule 输入及业务任务。')
    }
    const next = { ...identity, originMessageId: message.id!, taskId, scheduleTaskId: taskId }
    delete next.ownerId
    delete next.channelOrigin
    const ownerId = this.options.resolveScheduleOwner?.(taskId)
    if (ownerId !== undefined) next.ownerId = ownerId
    this.sessions.set(identity.sessionId!, next)
    this.save(snapshot)
    return { ...next }
  }

  /** Actual user text observed at the native input boundary; model text never populates this evidence. */
  originUser(identity: ExecutionIdentity | undefined = this.current()): OriginUser | undefined {
    this.refresh()
    if (!identity?.originMessageId || !identity.sessionId) return undefined
    const user = this.users.get(JSON.stringify([identity.rootSessionId ?? identity.sessionId, identity.originMessageId]))
    return user === undefined ? undefined : { ...user }
  }

  /** Pure persisted proof after live identity resolution; no ownership callbacks or binding writes. */
  readUserInputView(identity: ExecutionIdentity): UserInputView | undefined {
    const sessionId = text(identity.sessionId)
    const rootSessionId = text(identity.rootSessionId) ?? sessionId
    const originMessageId = text(identity.originMessageId)
    const snapshot = this.refresh()
    if (sessionId === undefined || rootSessionId === undefined || originMessageId === undefined) return undefined
    const caller = this.sessions.get(sessionId), root = this.sessions.get(rootSessionId)
    if (caller === undefined || root === undefined
      || (caller.rootSessionId ?? caller.sessionId) !== rootSessionId
      || (root.rootSessionId ?? root.sessionId) !== rootSessionId
      || caller.originMessageId !== originMessageId || root.originMessageId !== originMessageId) return undefined
    const user = this.users.get(JSON.stringify([rootSessionId, originMessageId]))
    if (user !== undefined && (user.sessionId !== rootSessionId || user.messageId !== originMessageId)) return undefined
    return { caller: { ...caller }, root: { ...root }, ...(user === undefined ? {} : { user: { ...user } }),
      ...(snapshot === undefined ? {} : { expectedBefore: snapshot.expectedBefore }) }
  }

  activate(taskId: string | undefined, identity: ExecutionIdentity | undefined = this.current()): ExecutionIdentity {
    const snapshot = this.refresh()
    if (!identity?.sessionId) throw new Error('business task activation requires an explicit execution session')
    if (taskId !== undefined && !text(taskId)) throw new Error('business task id must be a non-empty string')
    if (taskId !== undefined) this.options.beforeActivate?.(taskId, { ...identity })
    const next = { ...identity }
    if (taskId === undefined) delete next.taskId
    else next.taskId = taskId
    const { callId: _callId, turn: _turn, step: _step, ...binding } = next
    const currentBinding = this.sessions.get(identity.sessionId)
    if (currentBinding === undefined || currentBinding.originMessageId === identity.originMessageId) {
      const updated = { ...currentBinding, ...binding }
      if (taskId === undefined) delete updated.taskId
      this.sessions.set(identity.sessionId, updated)
    }
    const active = this.scope.getStore()
    if (active?.identity.sessionId === identity.sessionId) {
      if (taskId === undefined) delete active.identity.taskId
      else active.identity.taskId = taskId
      const call = this.calls.get(active.callKey)
      if (call) call.identity = { ...active.identity }
      if (active.execution) executionSnapshots.set(active.execution, { key: active.callKey, identity: { ...active.identity } })
    }
    this.save(snapshot)
    return next
  }

  withExecution<T>(execution: ContextExecution | undefined, fn: () => T): T {
    const [callKey, call] = this.capture(execution)
    return this.scope.run({ identity: { ...call.identity }, callKey, ...(execution === undefined ? {} : { execution }) }, fn)
  }

  /** Capture the identity at dispatch, before another task can become current. */
  capture(execution: ContextExecution | undefined): [string, CallState] {
    const [key, call] = this.captureSnapshot(execution)
    return [key, call]
  }

  private captureSnapshot(execution: ContextExecution | undefined): [string, CallState, ContextSnapshot] {
    const known = execution && executionSnapshots.get(execution)
    let snapshot: ContextSnapshot
    if (known !== undefined) {
      snapshot = this.refresh()
      if (this.calls.has(known.key)) return [known.key, this.calls.get(known.key)!, snapshot]
    }
    const agent = execution?.agent ?? this.options.agentFor?.()
    const binding = known ? { identity: { ...known.identity }, snapshot } : agent ? this.forAgentSnapshot(agent) : this.currentSnapshot(this.refresh())
    const identity = binding.identity ?? {}; snapshot = binding.snapshot
    const callId = text(execution?.callId) ?? text(execution?.id)
    if (callId !== undefined) identity.callId = callId
    const callKey = known?.key ?? executionKey(identity) ?? `volatile:${randomUUID()}`
    let call = this.calls.get(callKey)
    if (!call) {
      call = { identity, startedAt: Date.now(), ...(text(execution?.name) === undefined ? {} : { tool: execution!.name }) }
      this.calls.set(callKey, call)
      snapshot = this.save(snapshot)
    }
    if (execution) executionSnapshots.set(execution, { key: callKey, identity: { ...call.identity } })
    return [callKey, call, snapshot]
  }

  captureRequest(agent: ContextAgent, turn: unknown, step: unknown): void {
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || Number(turn) < 0 || Number(step) < 0) return
    const current = this.forAgentSnapshot(agent)
    const identity = { ...current.identity, turn: Number(turn), step: Number(step) }
    this.steps.set(JSON.stringify([identity.sessionId, turn, step]), identity)
    this.sessions.set(identity.sessionId!, identity)
    this.save(current.snapshot)
  }

  /** Unknown positions remain unknown; no fallback to the session's newest task. */
  forCall(sessionId: string, turn: number | undefined, step: number | undefined): ExecutionIdentity | undefined {
    this.refresh()
    if (turn === undefined || step === undefined) return undefined
    const identity = this.steps.get(JSON.stringify([sessionId, turn, step]))
    return identity === undefined ? undefined : { ...identity }
  }

  /** Record the final native result (or a direct tool call), omitting arguments and output text. */
  receipt(execution: ContextExecution | undefined, result?: unknown, error?: unknown): ExecutionReceipt {
    const [key, call, snapshot] = this.captureSnapshot(execution)
    if (call.receipt) return structuredClone(call.receipt)
    const row = record(result), value = record(row?.['value']) ?? row
    const failure = record(error) ?? record(row?.['error']) ?? record(value?.['error'])
    const ok = error === undefined && row?.['isError'] !== true && row?.['ok'] !== false && value?.['ok'] !== false
    const content = Array.isArray(row?.['content']) ? row['content'] as unknown[] : []
    const contentTypes = [...new Set(content.map(block => text(record(block)?.['type'])).filter(Boolean))]
    const exitCode = value?.['exitCode'] ?? row?.['exitCode']
    const summary = JSON.stringify({ ...(typeof exitCode === 'number' ? { exitCode } : {}), ...(contentTypes.length ? { contentTypes } : {}), ...(row?.['isError'] === true ? { isError: true } : {}), ...(value?.['ok'] === false ? { ok: false } : {}) })
    const artifacts: ArtifactReference[] = []
    const add = (kind: string, suppliedReference: unknown) => {
      const ref = text(suppliedReference)
      if (ref === undefined || ref.length > 2048 || artifacts.length >= 16 || artifacts.some(item => item.reference === ref)) return
      // Signed query strings and fragments are never copied into an audit reference.
      let reference = ref
      if (/^https?:\/\//i.test(ref)) {
        try {
          const url = new URL(ref)
          url.username = ''; url.password = ''; url.search = ''; url.hash = ''
          reference = url.href
        } catch { return }
      }
      artifacts.push({ kind: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(kind) ? kind : 'artifact', reference })
    }
    for (const field of ['path', 'storedPath']) add('file', value?.[field])
    for (const item of Array.isArray(value?.['artifacts']) ? value['artifacts'] : []) {
      const artifact = record(item)
      if (artifact) add(text(artifact['kind']) ?? 'artifact', artifact['reference'] ?? artifact['path'] ?? artifact['storedPath'] ?? artifact['url'])
    }
    const errorLabel = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : undefined
    const name = errorLabel(error instanceof Error ? error.name : failure?.['name'])
    const code = errorLabel(failure?.['code'])
    const receipt: ExecutionReceipt = { ...call.identity, at: new Date().toISOString(), tool: call.tool ?? text(execution?.name) ?? 'unknown', ok,
      ms: Math.max(0, Date.now() - call.startedAt), ...(summary === '{}' ? {} : { summary }),
      ...(ok ? {} : { error: [name, code].filter(Boolean).join(':') || 'TOOL_EXECUTION_FAILED' }), ...(artifacts.length ? { artifacts } : {}) }
    this.options.onReceipt?.(receipt)
    call.receipt = receipt
    this.calls.set(key, call)
    this.save(snapshot)
    return structuredClone(receipt)
  }

  attach(disposers: Array<() => void>): this { this.disposers.push(...disposers); return this }
  stop(): void { for (const dispose of this.disposers.splice(0).reverse()) dispose() }
  status() { return { active: this.disposers.length > 0, sessions: this.sessions.size, callPositions: this.steps.size, executions: this.calls.size } }
}

interface RuntimeContext {
  get(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
}
interface AgentRegistry {
  currentInitiator?(): ContextAgent | undefined
  list?(): ContextAgent[]
  isOwnedBy?(id: string, owner: ContextAgent): boolean
}

/** Event contracts: runtime-extracted-20261013 dsh-agent-loop:1179, dsh-tools:3225/3504/3409. */
export function installExecutionContext(ctx: RuntimeContext, options: ExecutionContextOptions = {}): ExecutionContexts {
  const registry = () => ctx.get('agents', false) as AgentRegistry | undefined
  const rootFor = options.rootFor ?? ((agent: ContextAgent) => {
      const seen = new Set<ContextAgent>()
      while (!seen.has(agent)) {
        seen.add(agent)
        const parent = registry()?.list?.().find(candidate => registry()?.isOwnedBy?.(agent.id, candidate))
        if (!parent) break
        agent = parent
      }
      return agent
    })
  const applies = (agent: ContextAgent | undefined) => agent !== undefined && (options.appliesTo?.(agent) ?? true)
  const executionAgent = (execution: ContextExecution) => execution.agent ?? options.agentFor?.() ?? registry()?.currentInitiator?.()
  const contexts = new ExecutionContexts({ ...options,
    agentFor: options.agentFor ?? (() => registry()?.currentInitiator?.()), rootFor,
  })
  function staleChild(agent: ContextAgent): string | undefined {
    const root = rootFor(agent)
    if (sessionOf(root) === sessionOf(agent)) return undefined
    const child = contexts.forAgent(agent), owner = contexts.forAgent(root)
    if (child.runId === undefined || owner.runId === undefined || child.runId === owner.runId) return undefined
    const reason = `[STALE_CHILD_RUN session=${sessionOf(agent)} root=${sessionOf(root)}] 父会话已进入新的预算run，旧子代理不能继续执行当前任务。`
    agent.cancel?.({ kind: 'hook', reason }, { keepInbox: true })
    return reason
  }
  const disposers: Array<() => void> = []
  const add = (name: string, listener: (...args: any[]) => any) => disposers.push(ctx.on(name, listener, { prepend: true, global: true }))
  add('agent/created', ({ agent }: { agent: ContextAgent }) => { if (applies(agent)) contexts.forAgent(agent) })
  add('agent/inbox/claimed', ({ agent, message }: { agent: ContextAgent; message: ContextMessage }) => { if (applies(agent)) contexts.bindUser(agent, message) })
  add('agent/pre-step', async ({ agent, messages }: { agent: ContextAgent; messages: ContextMessage[] }, next: () => unknown) => {
    if (!applies(agent)) return next()
    if (staleChild(agent)) return { kind: 'reject' }
    const human = messages.findLast(message => message.source?.kind === 'user')
    if (human) contexts.bindUser(agent, human)
    return next()
  })
  add('agent/request', async ({ agent, turn, step }: { agent: ContextAgent; turn: number; step: number }, next: () => unknown) => {
    if (!applies(agent)) return next()
    const denied = staleChild(agent)
    if (denied) throw new Error(denied)
    contexts.captureRequest(agent, turn, step)
    return next()
  })
  add('tools/pre-execute', (execution: ContextExecution, next: () => unknown) => {
    if (!applies(executionAgent(execution))) return next()
    contexts.capture(execution)
    const denied = execution.agent && staleChild(execution.agent)
    if (denied) return { kind: 'deny', reason: denied }
    return next()
  })
  // post-execute is a decision waterfall, so the authoritative receipt waits for tools/result.
  add('tools/post-execute', (_execution: ContextExecution, _result: unknown, next: () => unknown) => next())
  add('tools/result', (execution: ContextExecution, result: unknown) => { if (applies(executionAgent(execution))) contexts.receipt(execution, result) })
  add('session/event', (session: { id?: string }, event: { type?: string; data?: ContextMessage }) => {
    if (event.type !== 'user/message' || !session.id || !event.data) return
    const agent = registry()?.list?.().find(candidate => sessionOf(candidate) === session.id)
    if (agent && applies(agent)) contexts.bindUser(agent, event.data)
  })
  return contexts.attach(disposers)
}
