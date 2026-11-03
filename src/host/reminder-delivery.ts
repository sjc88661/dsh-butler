/** Optional host transport for one verified native reminder occurrence. No model-facing target inputs. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ExecutionIdentity, OriginUser } from './execution-context.ts'
import { commitState, readState } from './store.ts'

/** A snapshot supplied only by the host's verified same-owner binding resolver. */
export interface ReminderDestination {
  provider: 'lark'
  ownerId: string
  accountId: string
  chatId: string
  senderId?: string
  threadId?: string
}

export interface ReminderDeliveryIdentity {
  scheduleId: string
  occurrenceMessageId: string
  taskId: string
  sessionId: string
  ownerId: string
  turn: number
  assistantEventSeq: number
  assistantMessageId?: string
  textSha256: string
}

export interface ReminderExternalReceipt {
  /** An actual platform response, never the schedule inbox message id. */
  messageId: string
  chunkIds?: string[]
}

/** The trusted host must read the actual platform message and hash its complete body. */
export interface ReminderDeliveryVerification {
  destination: ReminderDestination
  textSha256: string
  receipt: ReminderExternalReceipt
}

/** Publish as the optional Cordis service `butlerReminderDelivery` in the trusted host. */
export interface ButlerReminderDelivery {
  /** user is host-only native input evidence, never model-supplied originalText. */
  destinationFor(identity: Readonly<ExecutionIdentity>, user?: Readonly<OriginUser>): Promise<ReminderDestination | undefined> | ReminderDestination | undefined
  send(destination: Readonly<ReminderDestination>, text: string, identity: Readonly<ReminderDeliveryIdentity>): Promise<ReminderExternalReceipt>
  /** Synchronous pre-send gate. A false result guarantees send has not been invoked. */
  isReady?(destination: Readonly<ReminderDestination>, identity: Readonly<ReminderDeliveryIdentity>): boolean
  /** Connection notifications only; the returned disposer must remove the subscription. */
  onReady?(listener: () => void): () => void
  /** Read-only platform lookup. Absence, errors and mismatches never authorize another send. */
  reconcile?(destination: Readonly<ReminderDestination>, identity: Readonly<ReminderDeliveryIdentity>): Promise<ReminderDeliveryVerification | undefined>
}

export type ReminderDeliveryAuditKind = 'queued' | 'claimed' | 'send-failed' | 'send-delivered'
  | 'binding-changed' | 'body-mismatch' | 'occurrence-unverified'
  | 'reconcile-verified' | 'reconcile-not-found' | 'reconcile-mismatch' | 'reconcile-error'
export interface ReminderDeliveryAudit { at: string; kind: ReminderDeliveryAuditKind }

export interface ReminderOutboundRecord extends ReminderDeliveryIdentity {
  key: string
  executionKey: string
  destination: ReminderDestination
  occurrenceEventSeq: number
  turnEndEventSeq: number
  state: 'waiting' | 'pending' | 'delivered' | 'uncertain'
  createdAt: string
  updatedAt: string
  receipt?: ReminderExternalReceipt
  reason?: string
  /** Host-only body. Only a waiting record is eligible to claim and send this text. */
  queuedText?: string
  /** Safe codes only; original transport failure remains in reason after reconciliation. */
  audit?: ReminderDeliveryAudit[]
}

/** Revalidated against both the saved native job and current business task before sending. */
export interface ReminderOutboundBinding {
  executionKey: string
  scheduleId: string
  taskId: string
  sessionId: string
  ownerId: string
  destination: ReminderDestination
}

interface OutboundFile { version: 1; deliveries: Record<string, ReminderOutboundRecord> }
interface NativeEvent { type?: string; data?: unknown; seq?: number; time?: number }
interface NativeSession { id?: string; inheritedEventCount?: number }
interface Candidate { seq: number; messageId?: string; text: string }
interface Turn {
  turn: number
  inherited: number
  occurrence?: { id: string; seq: number; binding: ReminderOutboundBinding }
  assistant?: Candidate
  invalid?: boolean
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const keyFor = (scheduleId: string, occurrenceMessageId: string): string => sha256(JSON.stringify([scheduleId, occurrenceMessageId]))
const empty = (): OutboundFile => ({ version: 1, deliveries: {} })
const instant = (value: unknown): boolean => nonempty(value) && Number.isFinite(Date.parse(value))
const auditKinds: ReminderDeliveryAuditKind[] = ['queued', 'claimed', 'send-failed', 'send-delivered', 'binding-changed', 'body-mismatch',
  'occurrence-unverified', 'reconcile-verified', 'reconcile-not-found', 'reconcile-mismatch', 'reconcile-error']
// Reloaded managers share the active call fence; a pending SDK call must not be reconciled underneath its receipt.
const activeKey = Symbol.for('dsh-butler.reminder-outbound.active.v1')
const globals = globalThis as unknown as { [key: symbol]: unknown }
const active = (globals[activeKey] ??= new Map<string, symbol>()) as Map<string, symbol>

export function validReminderDestination(value: unknown): value is ReminderDestination {
  return record(value) && value.provider === 'lark' && ['ownerId', 'accountId', 'chatId'].every(key => nonempty(value[key]))
    && ['senderId', 'threadId'].every(key => value[key] === undefined || nonempty(value[key]))
    && Object.keys(value).every(key => ['provider', 'ownerId', 'accountId', 'chatId', 'senderId', 'threadId'].includes(key))
}

function validReceipt(value: unknown): value is ReminderExternalReceipt {
  return record(value) && nonempty(value.messageId) && (value.chunkIds === undefined
    || (Array.isArray(value.chunkIds) && value.chunkIds.length > 0 && value.chunkIds.every(nonempty)))
}

function validFile(value: unknown): boolean {
  if (!record(value) || value.version !== 1 || !record(value.deliveries)) return false
  return Object.entries(value.deliveries).every(([key, row]) => record(row) && row.key === key
    && ['executionKey', 'scheduleId', 'occurrenceMessageId', 'taskId', 'sessionId', 'ownerId'].every(field => nonempty(row[field]))
    && key === keyFor(String(row.scheduleId), String(row.occurrenceMessageId))
    && validReminderDestination(row.destination) && row.destination.ownerId === row.ownerId
    && ['turn', 'assistantEventSeq', 'occurrenceEventSeq', 'turnEndEventSeq'].every(field => integer(row[field]))
    && Number(row.occurrenceEventSeq) < Number(row.assistantEventSeq) && Number(row.assistantEventSeq) < Number(row.turnEndEventSeq)
    && (row.assistantMessageId === undefined || nonempty(row.assistantMessageId))
    && typeof row.textSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.textSha256)
    && ['waiting', 'pending', 'delivered', 'uncertain'].includes(String(row.state)) && instant(row.createdAt) && instant(row.updatedAt)
    && (row.reason === undefined || nonempty(row.reason)) && (row.receipt === undefined || validReceipt(row.receipt))
    && (row.queuedText === undefined || nonempty(row.queuedText)) && (row.state !== 'waiting' || nonempty(row.queuedText))
    && (row.audit === undefined || (Array.isArray(row.audit) && row.audit.every(item => record(item) && instant(item.at)
      && auditKinds.includes(item.kind as ReminderDeliveryAuditKind) && Object.keys(item).every(key => key === 'at' || key === 'kind'))))
    && (row.state !== 'delivered' || validReceipt(row.receipt)))
}

export class ReminderDeliveries {
  private memory: OutboundFile = empty()
  private readonly turns = new Map<string, Turn>()
  private readonly cursors = new Map<string, number>()
  private readonly namespace: string
  private service?: ButlerReminderDelivery
  private serviceImplementation?: ButlerReminderDelivery
  private serviceEpoch = 0
  private unsubscribe?: () => void
  private recovering?: { epoch: number; promise: Promise<void>; dirty: boolean }
  private scheduledRecovery?: ReturnType<typeof setImmediate>
  private stopped = false
  private readonly options: {
    file?: string
    service(): ButlerReminderDelivery | undefined
    binding(sessionId: string): ReminderOutboundBinding | undefined
    verifyOccurrence(binding: ReminderOutboundBinding, occurrenceMessageId: string): Promise<boolean>
    now?(): string
    onError?(error: unknown): void
  }
  constructor(options: ReminderDeliveries['options']) {
    this.options = options
    this.namespace = options.file === undefined ? randomUUID() : resolve(options.file).toLowerCase()
    this.read()
  }

  private read(recover = true): OutboundFile {
    return this.options.file === undefined ? structuredClone(this.memory) : readState(this.options.file, empty(), validFile, { recover })
  }
  private mutate<R>(key: string, update: (file: OutboundFile) => { value: OutboundFile; result: R }): R {
    if (this.options.file === undefined) {
      const result = update(structuredClone(this.memory))
      this.memory = structuredClone(result.value)
      return result.result
    }
    return commitState({ path: this.options.file, format: 'json', fallback: empty(), validate: validFile },
      { kind: 'reminder.outbound', targetId: key }, update)
  }
  private now(): string { return this.options.now?.() ?? new Date().toISOString() }

  /** Snapshot reads never recover the WAL, invoke the resolver, or retry an external action. */
  status(): ReminderOutboundRecord[] { return structuredClone(Object.values(this.read(false).deliveries)) }
  stop(): void {
    this.stopped = true; this.serviceEpoch++; this.turns.clear()
    const unsubscribe = this.unsubscribe; this.unsubscribe = undefined; this.service = undefined; this.serviceImplementation = undefined
    if (this.scheduledRecovery !== undefined) clearImmediate(this.scheduledRecovery)
    this.scheduledRecovery = undefined
    unsubscribe?.()
  }

  private currentService(): ButlerReminderDelivery | undefined {
    if (this.stopped) return
    const service = this.options.service()
    // Cordis ctx.get() creates a fresh traceable Proxy on every read. Keep the first caller-bound proxy
    // for method calls, but compare its actual implementation, as exposed by the native Cordis symbol.
    const implementation = (service as (ButlerReminderDelivery & { [key: symbol]: ButlerReminderDelivery }) | undefined)?.[Symbol.for('cordis.original')] ?? service
    if (implementation !== this.serviceImplementation) {
      const unsubscribe = this.unsubscribe
      this.unsubscribe = undefined; this.service = service; this.serviceImplementation = implementation; this.serviceEpoch++
      unsubscribe?.()
      const epoch = this.serviceEpoch
      this.unsubscribe = service?.onReady?.(() => {
        if (!this.stopped && this.service === service && this.serviceEpoch === epoch) {
          void this.recover().catch(error => this.options.onError?.(error))
        }
      })
    }
    return this.service
  }

  private live(service: ButlerReminderDelivery, epoch: number): boolean {
    return !this.stopped && this.currentService() === service && this.serviceEpoch === epoch
  }

  private identity(intent: ReminderOutboundRecord): Readonly<ReminderDeliveryIdentity> {
    return Object.freeze({ scheduleId: intent.scheduleId, occurrenceMessageId: intent.occurrenceMessageId,
      taskId: intent.taskId, sessionId: intent.sessionId, ownerId: intent.ownerId, turn: intent.turn,
      assistantEventSeq: intent.assistantEventSeq, textSha256: intent.textSha256,
      ...(intent.assistantMessageId === undefined ? {} : { assistantMessageId: intent.assistantMessageId }) })
  }

  private bindingMatches(intent: ReminderOutboundRecord): boolean {
    return isDeepStrictEqual(this.options.binding(intent.sessionId), {
      executionKey: intent.executionKey, scheduleId: intent.scheduleId, taskId: intent.taskId, sessionId: intent.sessionId,
      ownerId: intent.ownerId, destination: intent.destination,
    })
  }

  private ready(service: ButlerReminderDelivery, intent: ReminderOutboundRecord): boolean {
    try { return service.isReady?.(Object.freeze(structuredClone(intent.destination)), this.identity(intent)) ?? true }
    catch { return false }
  }

  private audited(intent: ReminderOutboundRecord, kind: ReminderDeliveryAuditKind): ReminderOutboundRecord {
    const at = this.now()
    return { ...intent, updatedAt: at, audit: [...(intent.audit ?? []), { at, kind }] }
  }

  private note(intent: ReminderOutboundRecord, kind: ReminderDeliveryAuditKind): void {
    if (intent.audit?.at(-1)?.kind === kind) return
    this.mutate(intent.key, file => {
      if (isDeepStrictEqual(file.deliveries[intent.key], intent)) file.deliveries[intent.key] = this.audited(intent, kind)
      return { value: file, result: undefined }
    })
  }

  /** Explicit host lifecycle action. Snapshot/API readers must never call it. */
  recover(): Promise<void> {
    const service = this.currentService(), epoch = this.serviceEpoch
    if (!service) return Promise.resolve()
    if (this.recovering?.epoch === epoch) { this.recovering.dirty = true; return this.recovering.promise }
    if (this.scheduledRecovery !== undefined) clearImmediate(this.scheduledRecovery)
    this.scheduledRecovery = undefined
    const promise: Promise<void> = Promise.resolve().then(async () => {
      // One pass plus one coalesced rescan keeps recover() useful to await without an unbounded loop.
      for (let pass = 0; pass < 2; pass++) {
        recovery.dirty = false
        if (!this.live(service, epoch)) return
        for (const intent of Object.values(this.read().deliveries)) {
          if (!this.live(service, epoch)) return
          if (intent.state === 'waiting') await this.resume(intent, service, epoch)
          else if (intent.state === 'pending' || intent.state === 'uncertain') await this.reconcile(intent, service, epoch)
        }
        if (!recovery.dirty) return
      }
    })
    const recovery = { epoch, promise, dirty: false }
    this.recovering = recovery
    void promise.finally(() => {
      if (this.recovering !== recovery) return
      this.recovering = undefined
      // A readiness notification may arrive after an earlier row was skipped. Coalesce notices into
      // one follow-up scan, yielding to the host instead of recursing or polling in a microtask loop.
      if (recovery.dirty && this.live(service, epoch)) this.scheduledRecovery = setImmediate(() => {
        this.scheduledRecovery = undefined
        if (this.live(service, epoch)) void this.recover().catch(error => this.options.onError?.(error))
      })
    }).catch(() => {})
    return promise
  }

  /** Collection and the durable claim are synchronous; only the already-claimed transport can yield. */
  observeSessionEvent(session: NativeSession, event: NativeEvent): Promise<void> | undefined {
    const sessionId = session.id, data = record(event.data) ? event.data : undefined
    if (this.stopped || !sessionId || !integer(session.inheritedEventCount) || !integer(event.seq) || event.seq < session.inheritedEventCount) return
    const cursor = this.cursors.get(sessionId)
    if (cursor !== undefined && event.seq <= cursor) return
    this.cursors.set(sessionId, event.seq)
    if (event.type === 'turn/start') {
      if (data && integer(data.turn)) this.turns.set(sessionId, { turn: data.turn, inherited: session.inheritedEventCount })
      else this.turns.delete(sessionId)
      return
    }
    const turn = this.turns.get(sessionId)
    if (!turn || turn.inherited !== session.inheritedEventCount || !data) return
    if (event.type === 'user/message') {
      const source = record(data.source) ? data.source : undefined
      // Native host metadata follows the claimed input without replacing its occurrence or human provenance.
      if (source?.kind === 'runtime-context' || (source?.kind === 'skill-catalog' && source.form === 'catalog')
        || (source?.kind === 'time-context' && source.form === 'snapshot')) return
      if (source?.kind !== 'schedule' || !nonempty(data.id)) { turn.invalid = true; return }
      const binding = this.options.binding(sessionId)
      if (!binding || (source.scheduleId !== undefined && source.scheduleId !== binding.scheduleId)
        || (turn.occurrence !== undefined && turn.occurrence.id !== data.id)) { turn.invalid = true; return }
      turn.occurrence ??= { id: data.id, seq: event.seq, binding: structuredClone(binding) }
      turn.assistant = undefined
      return
    }
    if (event.type === 'assistant/message') {
      turn.assistant = undefined
      const message = record(data.message) ? data.message : undefined
      if (turn.invalid || !turn.occurrence || data.turn !== turn.turn || !integer(data.step) || !message || !Array.isArray(message.content)) return
      if (message.content.some(block => record(block) && block.type === 'tool-call')) return
      const body = message.content.filter(block => record(block) && block.type === 'text' && typeof block.text === 'string')
        .map(block => (block as { text: string }).text).join('\n')
      if (!body.trim()) return
      turn.assistant = { seq: event.seq, text: body, ...(nonempty(message.id) ? { messageId: message.id } : {}) }
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'assistant/attempt') {
      turn.assistant = undefined
      return
    }
    if (event.type !== 'turn/end') return
    this.turns.delete(sessionId)
    const reason = record(data.reason) ? data.reason : undefined
    if (turn.invalid || data.turn !== turn.turn || reason?.kind !== 'completed' || !turn.occurrence || !turn.assistant) return
    return this.complete(sessionId, turn as Turn & { occurrence: NonNullable<Turn['occurrence']>; assistant: Candidate }, event.seq)
  }

  private async complete(sessionId: string, turn: Turn & { occurrence: NonNullable<Turn['occurrence']>; assistant: Candidate }, turnEndEventSeq: number): Promise<void> {
    const key = keyFor(turn.occurrence.binding.scheduleId, turn.occurrence.id)
    if (this.read(false).deliveries[key] !== undefined) return
    // Native schedule writes history after followup + session flush, so it can lag this turn's events.
    if (!await this.options.verifyOccurrence(turn.occurrence.binding, turn.occurrence.id) || this.stopped) return
    const current = this.options.binding(sessionId), service = this.currentService(), epoch = this.serviceEpoch
    if (!isDeepStrictEqual(current, turn.occurrence.binding)) return
    const binding = turn.occurrence.binding, now = this.now()
    const intent: ReminderOutboundRecord = {
      ...binding, destination: structuredClone(binding.destination), key: keyFor(binding.scheduleId, turn.occurrence.id),
      occurrenceMessageId: turn.occurrence.id, occurrenceEventSeq: turn.occurrence.seq, turn: turn.turn,
      assistantEventSeq: turn.assistant.seq, ...(turn.assistant.messageId === undefined ? {} : { assistantMessageId: turn.assistant.messageId }),
      turnEndEventSeq, textSha256: sha256(turn.assistant.text), state: 'waiting', queuedText: turn.assistant.text,
      createdAt: now, updatedAt: now, audit: [{ at: now, kind: 'queued' }],
    }
    const claimed = this.mutate(intent.key, file => {
      if (file.deliveries[intent.key] !== undefined) return { value: file, result: false }
      file.deliveries[intent.key] = intent
      return { value: file, result: true }
    })
    if (!claimed) return
    if (service) return this.resume(intent, service, epoch, true)
  }

  private async resume(intent: ReminderOutboundRecord, service: ButlerReminderDelivery, epoch: number, verified = false): Promise<void> {
    if (!this.live(service, epoch) || !this.ready(service, intent)) return
    if (intent.queuedText === undefined || sha256(intent.queuedText) !== intent.textSha256) { this.note(intent, 'body-mismatch'); return }
    if (!this.bindingMatches(intent)) { this.note(intent, 'binding-changed'); return }
    if (!verified && !await this.options.verifyOccurrence({ executionKey: intent.executionKey, scheduleId: intent.scheduleId,
      taskId: intent.taskId, sessionId: intent.sessionId, ownerId: intent.ownerId, destination: structuredClone(intent.destination) }, intent.occurrenceMessageId)) {
      if (this.live(service, epoch)) this.note(intent, 'occurrence-unverified')
      return
    }
    if (!this.live(service, epoch) || !this.ready(service, intent)) return
    if (!this.bindingMatches(intent)) { this.note(intent, 'binding-changed'); return }
    const scope = `${this.namespace}\n${intent.key}`
    if (active.has(scope)) return
    const { queuedText, ...saved } = intent
    const pending: ReminderOutboundRecord = { ...this.audited(saved, 'claimed'), state: 'pending' }
    const claimed = this.mutate(intent.key, file => {
      if (!isDeepStrictEqual(file.deliveries[intent.key], intent)) return { value: file, result: false }
      file.deliveries[intent.key] = pending
      return { value: file, result: true }
    })
    if (!claimed) return
    const token = Symbol()
    active.set(scope, token)
    try { await this.send(service, pending, queuedText) }
    finally { if (active.get(scope) === token) active.delete(scope) }
  }

  private async reconcile(intent: ReminderOutboundRecord, service: ButlerReminderDelivery, epoch: number): Promise<void> {
    const scope = `${this.namespace}\n${intent.key}`
    if (!service.reconcile || active.has(scope) || !this.live(service, epoch) || !this.ready(service, intent)) return
    const token = Symbol()
    active.set(scope, token)
    try {
      let verification: ReminderDeliveryVerification | undefined, kind: ReminderDeliveryAuditKind = 'reconcile-not-found'
      try {
        verification = await service.reconcile(Object.freeze(structuredClone(intent.destination)), this.identity(intent))
        if (verification !== undefined) kind = validReminderDestination(verification?.destination)
          && isDeepStrictEqual(verification.destination, intent.destination) && verification.textSha256 === intent.textSha256
          && validReceipt(verification.receipt) ? 'reconcile-verified' : 'reconcile-mismatch'
      } catch { kind = 'reconcile-error' }
      if (!this.live(service, epoch)) return
      this.mutate(intent.key, file => {
        if (isDeepStrictEqual(file.deliveries[intent.key], intent)) file.deliveries[intent.key] = {
          ...this.audited(intent, kind), state: kind === 'reconcile-verified' ? 'delivered' : 'uncertain',
          ...(kind === 'reconcile-verified' ? { receipt: structuredClone(verification!.receipt) }
            : intent.reason === undefined ? { reason: '上次外发结果未知；平台只读核对未取得匹配回执，不自动重发。' } : {}),
        }
        return { value: file, result: undefined }
      })
    } finally { if (active.get(scope) === token) active.delete(scope) }
  }

  private async send(service: ButlerReminderDelivery, intent: ReminderOutboundRecord, text: string): Promise<void> {
    try {
      // All pre-send checks and the durable claim ran synchronously. Once called, every SDK failure is unknown.
      const receipt = await service.send(Object.freeze(structuredClone(intent.destination)), text, this.identity(intent))
      if (!validReceipt(receipt)) throw new Error('外发服务缺少真实平台 messageId 回执')
      this.mutate(intent.key, file => {
        const current = file.deliveries[intent.key]
        if (!isDeepStrictEqual(current, intent)) throw new Error('外发 intent 已变化，拒绝覆盖回执')
        file.deliveries[intent.key] = { ...this.audited(intent, 'send-delivered'), state: 'delivered', receipt: structuredClone(receipt) }
        return { value: file, result: undefined }
      })
    } catch (error) {
      this.mutate(intent.key, file => {
        const current = file.deliveries[intent.key]
        if (current?.state === 'pending' && isDeepStrictEqual(current, intent)) file.deliveries[intent.key] = {
          ...this.audited(intent, 'send-failed'), state: 'uncertain',
          reason: `${error instanceof Error ? error.message : String(error)}；不自动重发。`,
        }
        return { value: file, result: undefined }
      })
    }
  }
}
