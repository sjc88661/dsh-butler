/** Durable, fail-closed transport receipts and exact native provenance. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { commitFiles, readSnapshot, readState } from './store.ts'
import { statePath } from './vault.ts'

export interface ChannelBinding {
  accountId: string
  senderId: string
  chatId: string
  ownerId: string
}

export interface ChannelOrigin extends ChannelBinding {
  provider: 'lark'
  messageId: string
  threadId?: string
  nativeMessageId: string
  sessionId: string
}

export interface LarkInbound {
  messageId: string
  chatId: string
  senderId: string
  chatType: string
  content: string
  threadId?: string
  senderIsBot?: boolean
  [key: string]: unknown
}

export interface ChannelIngressOptions { file?: string; bindings: ChannelBinding[] }
export interface ChannelReceiveResult { status: 'accepted' | 'duplicate' | 'uncertain' | 'rejected'; code?: string }

export class ChannelIngressError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`Channel ingress refused: ${code}`)
    this.name = 'ChannelIngressError'
    this.code = code
  }
}

type NativeAlias = { sessionId: string; nativeMessageId: string }
interface Receipt extends ChannelBinding {
  provider: 'lark'
  messageId: string
  threadId?: string
  fingerprint: string
  phase: 'pending' | 'accepted' | 'uncertain'
  code?: string
  native?: NativeAlias
}
interface IngressState {
  version: 1
  entries: Record<string, Receipt>
  sessions: Record<string, string>
  aliases: Record<string, string>
  tasks: Record<string, string>
}
interface Scope {
  key: string
  fingerprint: string
  ownerId: string
  closed: boolean
  failure?: { error: unknown; code: string }
}
type Snapshot = { value: IngressState; expectedBefore: string | null }

const failureCodes = new Set([
  'HANDLER_FAILED', 'ASSOCIATION_FAILED', 'COMMIT_FAILED', 'INVALID_NATIVE_SOURCE',
  'SOURCE_NATIVE_CONFLICT', 'SESSION_OWNER_CONFLICT', 'NATIVE_SOURCE_CONFLICT', 'SOURCE_STATE_CHANGED',
])
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
// Validate without trimming, case folding, or otherwise rewriting platform identifiers.
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value !== '' && !/[\u0000-\u001f\u007f]/.test(value)
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceKey = (accountId: string, messageId: string): string => digest(['lark', accountId, messageId])
const nativeKey = (sessionId: string, nativeMessageId: string): string => JSON.stringify([sessionId, nativeMessageId])
const get = <T>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined
// Native and owner IDs can legitimately equal Object.prototype property names.
function put<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, enumerable: true, configurable: true, writable: true })
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}
function validBinding(value: unknown): value is ChannelBinding {
  return record(value) && [value.accountId, value.senderId, value.chatId, value.ownerId].every(identity)
}
const emptyState = (): IngressState => ({ version: 1, entries: {}, sessions: {}, aliases: {}, tasks: {} })

/** Reject inconsistent indexes as corruption; never rebuild them from a latest message. */
function validState(value: unknown): value is IngressState {
  if (!record(value) || !keys(value, ['version', 'entries', 'sessions', 'aliases', 'tasks']) || value.version !== 1
    || !record(value.entries) || !record(value.sessions) || !record(value.aliases) || !record(value.tasks)) return false
  const expectedAliases = new Map<string, string>(), expectedSessions = new Map<string, string>()
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!record(entry) || !keys(entry, ['provider', 'accountId', 'senderId', 'chatId', 'ownerId', 'messageId', 'fingerprint', 'phase'], ['threadId', 'code', 'native'])
      || !validBinding(entry) || entry.provider !== 'lark' || !identity(entry.messageId)
      || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
      || key !== sourceKey(entry.accountId, entry.messageId)
      || (Object.hasOwn(entry, 'threadId') && !identity(entry.threadId))
      || !['pending', 'accepted', 'uncertain'].includes(entry.phase as string)) return false
    if (entry.phase === 'uncertain' ? !failureCodes.has(entry.code as string) : Object.hasOwn(entry, 'code')) return false
    if (!Object.hasOwn(entry, 'native')) continue
    if (!record(entry.native) || !keys(entry.native, ['sessionId', 'nativeMessageId'])
      || !identity(entry.native.sessionId) || !identity(entry.native.nativeMessageId)) return false
    const alias = nativeKey(entry.native.sessionId, entry.native.nativeMessageId)
    if (expectedAliases.has(alias) || (expectedSessions.has(entry.native.sessionId) && expectedSessions.get(entry.native.sessionId) !== entry.ownerId)) return false
    expectedAliases.set(alias, key); expectedSessions.set(entry.native.sessionId, entry.ownerId)
  }
  if (Object.keys(value.aliases).length !== expectedAliases.size || Object.keys(value.sessions).length !== expectedSessions.size) return false
  for (const [alias, source] of Object.entries(value.aliases)) if (expectedAliases.get(alias) !== source) return false
  for (const [session, owner] of Object.entries(value.sessions)) if (expectedSessions.get(session) !== owner) return false
  return Object.entries(value.tasks).every(([taskId, ownerId]) => identity(taskId) && identity(ownerId))
}

function origin(receipt: Receipt): ChannelOrigin | undefined {
  if (receipt.native === undefined) return undefined
  return {
    provider: 'lark', accountId: receipt.accountId, senderId: receipt.senderId, chatId: receipt.chatId,
    ownerId: receipt.ownerId, messageId: receipt.messageId,
    ...(receipt.threadId === undefined ? {} : { threadId: receipt.threadId }), ...receipt.native,
  }
}

export class ChannelIngress {
  private readonly file: string
  private readonly bindings: ChannelBinding[]
  private readonly scope = new AsyncLocalStorage<Scope>()

  constructor(options: ChannelIngressOptions) {
    if (!record(options) || !Array.isArray(options.bindings) || !options.bindings.every(validBinding)) throw new ChannelIngressError('INVALID_BINDING')
    this.file = options.file ?? statePath('channel-ingress.json')
    this.bindings = options.bindings.map(({ accountId, senderId, chatId, ownerId }) => ({ accountId, senderId, chatId, ownerId }))
    this.inspect()
  }

  async receive(accountId: string, message: LarkInbound, handler: () => void | Promise<void>): Promise<ChannelReceiveResult> {
    if (!identity(accountId) || !record(message)) return { status: 'rejected', code: 'INVALID_SOURCE' }
    // Snapshot only normalized fields. Extra credentials and raw objects never enter a receipt or WAL.
    const input = {
      messageId: message.messageId, senderId: message.senderId, chatId: message.chatId,
      chatType: message.chatType, content: message.content, threadId: message.threadId, senderIsBot: message.senderIsBot,
    }
    if (![input.messageId, input.senderId, input.chatId].every(identity) || typeof input.content !== 'string'
      || (input.threadId !== undefined && !identity(input.threadId))
      || (input.senderIsBot !== undefined && typeof input.senderIsBot !== 'boolean') || typeof handler !== 'function') return { status: 'rejected', code: 'INVALID_SOURCE' }
    if (input.senderIsBot === true) return { status: 'rejected', code: 'BOT_SOURCE' }
    if (input.chatType !== 'p2p') return { status: 'rejected', code: 'UNSUPPORTED_CHAT' }
    const bindings = this.bindings.filter(binding => binding.accountId === accountId && binding.senderId === input.senderId && binding.chatId === input.chatId)
    if (bindings.length === 0) return { status: 'rejected', code: 'UNBOUND_SOURCE' }
    if (bindings.length !== 1) return { status: 'rejected', code: 'AMBIGUOUS_BINDING' }
    const binding = bindings[0]!, key = sourceKey(accountId, input.messageId)
    const fingerprint = digest([accountId, input.messageId, input.senderId, input.chatId, input.chatType, input.content, input.threadId ?? null])
    const snapshot = this.read(), previous = get(snapshot.value.entries, key)
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint || previous.ownerId !== binding.ownerId) return { status: 'rejected', code: 'SOURCE_CONFLICT' }
      return previous.phase === 'accepted' ? { status: 'duplicate' } : { status: 'uncertain', code: previous.phase === 'pending' ? 'PENDING' : previous.code }
    }
    put(snapshot.value.entries, key, {
      ...binding, provider: 'lark', messageId: input.messageId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }), fingerprint, phase: 'pending',
    })
    // No callback occurs unless the shared store has durably won its CAS claim.
    this.commit(snapshot, 'prepare')
    const scope: Scope = { key, fingerprint, ownerId: binding.ownerId, closed: false }
    let completedHandler = false
    try {
      await this.scope.run(scope, handler)
      if (scope.failure !== undefined) throw scope.failure.error
      completedHandler = true
      this.finish(scope, 'accepted')
      return { status: 'accepted' }
    } catch (error) {
      // Storage failure must never hide the original callback/association error or permit replay.
      // If storage itself is unavailable, the already durable pending receipt remains a fence.
      try { this.finish(scope, 'uncertain', scope.failure?.code ?? (completedHandler ? 'COMMIT_FAILED' : 'HANDLER_FAILED')) } catch { /* fail closed on its existing receipt */ }
      throw error
    } finally { scope.closed = true }
  }

  /** Called synchronously from the host's post-append, pre-wake native inbox hook. */
  associate(sessionId: string, message: { id?: string; source?: { kind?: string } }): ChannelOrigin | undefined {
    const scope = this.scope.getStore()
    if (scope === undefined) return undefined
    if (scope.closed) throw new ChannelIngressError('INGRESS_SCOPE_CLOSED')
    if (scope.failure !== undefined) throw scope.failure.error
    try {
      const nativeMessageId = message?.id
      if (!identity(sessionId) || !identity(nativeMessageId) || message?.source?.kind !== 'user') throw new ChannelIngressError('INVALID_NATIVE_SOURCE')
      const snapshot = this.read(), receipt = this.active(snapshot, scope)
      if (receipt.native !== undefined) {
        if (receipt.native.sessionId !== sessionId || receipt.native.nativeMessageId !== nativeMessageId) throw new ChannelIngressError('SOURCE_NATIVE_CONFLICT')
        return origin(receipt)
      }
      const owner = get(snapshot.value.sessions, sessionId)
      if (owner !== undefined && owner !== receipt.ownerId) throw new ChannelIngressError('SESSION_OWNER_CONFLICT')
      const alias = nativeKey(sessionId, nativeMessageId), source = get(snapshot.value.aliases, alias)
      if (source !== undefined && source !== scope.key) throw new ChannelIngressError('NATIVE_SOURCE_CONFLICT')
      receipt.native = { sessionId, nativeMessageId }
      put(snapshot.value.sessions, sessionId, receipt.ownerId)
      put(snapshot.value.aliases, alias, scope.key)
      this.commit(snapshot, 'associate')
      return origin(receipt)
    } catch (error) {
      const code = error instanceof ChannelIngressError && failureCodes.has(error.code) ? error.code : 'ASSOCIATION_FAILED'
      scope.failure = { error, code }
      throw error
    }
  }

  /** Exact persisted alias only: never infer from a current turn or last receipt. */
  originFor(sessionId: string, nativeMessageId: string): ChannelOrigin | undefined {
    const state = this.inspect(), key = get(state.aliases, nativeKey(sessionId, nativeMessageId))
    const receipt = key === undefined ? undefined : get(state.entries, key)
    return receipt === undefined ? undefined : origin(receipt)
  }

  ownerForSession(sessionId: string): string | undefined { return get(this.inspect().sessions, sessionId) }
  ownerForTask(taskId: string): string | undefined { return get(this.inspect().tasks, taskId) }

  /** Host-only. The caller first verifies actual task creation or an explicit continuation. */
  bindTask(taskId: string, ownerId: string): void {
    if (!identity(taskId) || !identity(ownerId)) throw new ChannelIngressError('INVALID_TASK_BINDING')
    const snapshot = this.read(), owner = get(snapshot.value.tasks, taskId)
    if (owner !== undefined && owner !== ownerId) throw new ChannelIngressError('TASK_OWNER_CONFLICT')
    if (owner === ownerId) return
    put(snapshot.value.tasks, taskId, ownerId)
    this.commit(snapshot, 'bind-task')
  }

  status(): { active: true; received: number; accepted: number; nativeMapped: number; acceptedWithoutNative: number; pending: number; uncertain: number; bindings: number } {
    const receipts = Object.values(this.inspect().entries)
    return {
      active: true, received: receipts.length, accepted: receipts.filter(row => row.phase === 'accepted').length,
      nativeMapped: receipts.filter(row => row.native !== undefined).length,
      acceptedWithoutNative: receipts.filter(row => row.phase === 'accepted' && row.native === undefined).length,
      pending: receipts.filter(row => row.phase === 'pending').length, uncertain: receipts.filter(row => row.phase === 'uncertain').length,
      bindings: this.bindings.length,
    }
  }

  private read(): Snapshot {
    return readSnapshot({ path: this.file, format: 'json', fallback: emptyState(), validate: validState })
  }

  /** Workbench reads inspect current bytes and must not replay or commit a pending WAL. */
  private inspect(): IngressState {
    return readState(this.file, emptyState(), validState, { recover: false })
  }

  private commit(snapshot: Snapshot, kind: string): void {
    commitFiles({ kind: `channel-ingress.${kind}`, targetId: this.file, writes: [{
      path: this.file, format: 'json', content: `${JSON.stringify(snapshot.value, null, 2)}\n`,
      expectedBefore: snapshot.expectedBefore, validate: validState,
    }] })
  }

  private active(snapshot: Snapshot, scope: Scope): Receipt {
    const receipt = get(snapshot.value.entries, scope.key)
    if (receipt === undefined || receipt.phase !== 'pending' || receipt.fingerprint !== scope.fingerprint || receipt.ownerId !== scope.ownerId) throw new ChannelIngressError('SOURCE_STATE_CHANGED')
    return receipt
  }

  private finish(scope: Scope, phase: 'accepted' | 'uncertain', code?: string): void {
    const snapshot = this.read(), receipt = this.active(snapshot, scope)
    receipt.phase = phase
    if (code !== undefined) receipt.code = code
    this.commit(snapshot, phase)
  }
}
