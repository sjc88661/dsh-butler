/** Durable reminder effects. Recovery restores local state and never repeats an uncertain create. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { ScheduleDeliveryReceipt, ScheduleRecord, ScheduleService, ScheduleTiming } from './ctx.ts'
import { executionKey, type ExecutionIdentity, type OriginUser } from './execution-context.ts'
import { getTask, setTaskStatus, upsertTask, type Task } from './ledger.ts'
import {
  concreteTime, reminderDeliveryReceipt, reminderHistoryLimits, reminderTargetSession,
  scheduleCreate, validTiming, validTimeZone, type ConcreteReminder,
} from './remind.ts'
import { deleteOwnedReminder } from './reminder-session.ts'
import { REMINDER_SESSION_PREFIX } from './runtime-controls.ts'
import { commitState, readState, type OperationMetadata } from './store.ts'
import { ReminderDeliveries, validReminderDestination, type ButlerReminderDelivery, type ReminderDestination, type ReminderOutboundBinding, type ReminderOutboundRecord } from './reminder-delivery.ts'

export type ReminderCreationState = 'creating' | 'committed' | 'uncertain'
export type ReminderDeliveryState = 'scheduled' | 'delivered' | 'assistant-completed' | 'unknown'
type DeleteReceipt = { id: string; deleted: boolean; code?: string }
/** Relative inputs are normalized once inside the complete native execution identity. */
export type ReminderCreateRequest = Omit<ConcreteReminder, 'at' | 'timing'> & {
  at?: string
  afterSeconds?: number
  /** 0.2.2 tagged timing (one-shot or recurring); exclusive with `at`/`afterSeconds`. */
  timing?: ScheduleTiming
}

export interface ReminderTaskLink {
  executionKey: string
  requestDigest: string
  scheduleId?: string
  destinationSessionId?: string
  confirmedAt: string
  timeZone: string
  creationState: ReminderCreationState
  deliveryState: ReminderDeliveryState
  lastDelivery?: ScheduleDeliveryReceipt
  outboundDestination?: ReminderDestination
}

export interface ReminderOperation {
  action: 'create' | 'cancel'
  executionKey: string
  identity: ExecutionIdentity
  requestDigest: string
  state: ReminderCreationState
  sourceSessionId: string
  taskId?: string
  destinationSessionId?: string
  scheduleId?: string
  /** Native 0.2.2 rule kind/status, kept verbatim beside the local operation state. */
  scheduleKind?: string
  scheduleStatus?: string
  confirmedAt?: string
  timeZone: string
  request?: ConcreteReminder
  /** Only an actual native create/delete response is stored here. */
  actualReceipt?: ScheduleRecord | DeleteReceipt
  createdAt: string
  updatedAt: string
  deliveryState?: ReminderDeliveryState
  lastDelivery?: ScheduleDeliveryReceipt
  /** Immutable verified host destination; absent on legacy/non-channel reminders. */
  outboundDestination?: ReminderDestination
  /** Read-only external receipt projection, separate from native inbox delivery. */
  outbound?: ReminderOutboundRecord[]
  task?: Task
  reason?: string
  /** Local ownership refusals are not native delete receipts. */
  refusal?: { code: string; reason: string }
}

export interface ReminderResult {
  ok: boolean
  state: ReminderCreationState
  operation: ReminderOperation
  taskId?: string
  task?: Task
  reminder?: {
    id: string
    sessionId: string
    scheduledAt?: string
    /** Native kind/status of the created rule, verbatim (extra info, not normalized). */
    kind?: string
    status?: string
    raw: ScheduleRecord
  }
  cancelled?: string | null
  code?: string
  reason?: string
  unavailable?: boolean
}

export interface ReminderHistoryResult {
  ok: boolean
  available: boolean
  deliveryState: ReminderDeliveryState
  scheduleId: string
  sessionId?: string
  taskId?: string
  records?: ScheduleDeliveryReceipt[]
  /** 0.2.2 page limits: older records exist but were not read/pruned. */
  earlierRecordsUnavailable?: boolean
  earlierRecordsPruned?: boolean
  retention?: { days?: number; records?: number }
  nextBefore?: string
  reason?: string
  code?: string
}

export interface ReminderOperationsOptions {
  file?: string
  outboundFile?: string
  /** Optional host-only transport; no target fields are accepted from model tool arguments. */
  delivery?(): ButlerReminderDelivery | undefined
  /** Exact native lookup supplied by ExecutionContexts; model reminder arguments cannot populate it. */
  userInput?(identity: ExecutionIdentity): Readonly<OriginUser> | undefined
  onDeliveryError?(error: unknown): void
  schedule(): ScheduleService | undefined
  /** Receives the complete native execution key, never only callId. */
  destination(sourceSessionId: string, title: string, callKey: string): Promise<string>
  /** Trusted persisted ReminderSessions binding, required for an unknown isolated legacy destination. */
  ownsDestination?(sourceSessionId: string, destinationSessionId: string): boolean
  ledger?: { upsertTask: typeof upsertTask; setTaskStatus: typeof setTaskStatus; getTask?: typeof getTask }
  now?(): string
}

export interface ReminderDeliveryBinding {
  taskId: string
  sessionId: string
  scheduleId: string
  originMessageId?: string
}

interface OperationFile { version: 1; operations: Record<string, ReminderOperation> }
interface Pending { digest: string; promise: Promise<ReminderResult> }
// Hot-reloaded managers in this one host process share pending effects. This is not a distributed lock.
const pendingKey = Symbol.for('dsh-butler.reminder-operations.pending.v1')
const globals = globalThis as unknown as { [key: symbol]: unknown }
const pending = (globals[pendingKey] ??= new Map<string, Pending>()) as Map<string, Pending>
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const instant = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))
const nativeDelivered = (receipt: ScheduleDeliveryReceipt): boolean => text(receipt.messageId) || instant(receipt.deliveredAt)
const emptyFile = (): OperationFile => ({ version: 1, operations: {} })
const deliveryReceipt = (value: unknown): value is ScheduleDeliveryReceipt => record(value)
  && ['scheduledAt', 'deliveredAt', 'messageId', 'targetSessionId', 'prompt'].every(key => value[key] === undefined || typeof value[key] === 'string')

function validStoredRequest(request: unknown): boolean {
  if (!record(request)) return false
  return text(request['timeZone']) && (text(request['at']) || validTiming(request['timing']))
}

/**
 * Best host-side instant for a tagged timing, when it is knowable before the
 * scheduler answers. `at`/`after`/`every` are deterministic from the request
 * clock; `daily`/`weekly`/`cron`/`rrule` first occurrences are left to the
 * create receipt (`raw.scheduledAt`) instead of guessed here.
 */
function timingInstant(timing: ScheduleTiming, now: string): string | undefined {
  const base = Date.parse(now)
  const shifted = (seconds: number): string | undefined => {
    if (!Number.isFinite(base)) return undefined
    const at = new Date(base + seconds * 1000)
    return Number.isFinite(at.getTime()) ? at.toISOString() : undefined
  }
  switch (timing.kind) {
    case 'at': return typeof timing.at === 'string' ? timing.at : undefined
    case 'after': return shifted(timing.after_seconds)
    case 'every': return shifted(timing.every_seconds)
    default: return undefined
  }
}

function validFile(value: unknown): boolean {
  if (!record(value) || value.version !== 1 || !record(value.operations)) return false
  return Object.entries(value.operations).every(([key, row]) => record(row)
    && ['create', 'cancel'].includes(String(row.action)) && row.executionKey === key
    && record(row.identity) && executionKey(row.identity as ExecutionIdentity) === key
    && row.sourceSessionId === row.identity.sessionId && text(row.sourceSessionId)
    && typeof row.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(row.requestDigest)
    && ['creating', 'committed', 'uncertain'].includes(String(row.state))
    && text(row.timeZone) && instant(row.createdAt) && instant(row.updatedAt)
    && (row.destinationSessionId === undefined || (text(row.destinationSessionId)
      && (row.action === 'cancel' || row.destinationSessionId.startsWith(REMINDER_SESSION_PREFIX))))
    && (row.scheduleId === undefined || text(row.scheduleId))
    && (row.action !== 'create' || (text(row.taskId) && text(row.confirmedAt) && validStoredRequest(row.request)
      && (text((row.request as Record<string, unknown>)['title']) && text((row.request as Record<string, unknown>)['prompt']))))
    && (row.actualReceipt === undefined || (record(row.actualReceipt) && text(row.actualReceipt.id)
      && (row.action !== 'cancel' || typeof row.actualReceipt.deleted === 'boolean')))
    && (row.refusal === undefined || (row.action === 'cancel' && record(row.refusal) && text(row.refusal.code) && text(row.refusal.reason)))
    && (row.state !== 'committed' || (row.action === 'cancel' && record(row.refusal)) || (record(row.actualReceipt) && row.actualReceipt.id === row.scheduleId
      && (row.action === 'cancel' || (text(row.destinationSessionId) && text(row.scheduleId)
        && record(row.task) && row.task.id === row.taskId))))
    && (row.lastDelivery === undefined || deliveryReceipt(row.lastDelivery))
    && (row.scheduleKind === undefined || text(row.scheduleKind))
    && (row.scheduleStatus === undefined || text(row.scheduleStatus))
    && (row.outboundDestination === undefined || (validReminderDestination(row.outboundDestination)
      && row.outboundDestination.ownerId === row.identity.ownerId)))
}

/** No timer or scheduler is started by this service. Every external request is explicit. */
export class ReminderOperations {
  private readonly options: ReminderOperationsOptions
  private readonly namespace: string
  private memory: OperationFile = emptyFile()
  private readonly volatile = new Map<string, ReminderOperation>()
  private readonly outbound: ReminderDeliveries

  constructor(options: ReminderOperationsOptions) {
    this.options = options
    this.namespace = options.file === undefined ? randomUUID() : resolve(options.file)
    this.read()
    this.outbound = new ReminderDeliveries({ file: options.outboundFile ?? (options.file === undefined ? undefined : `${options.file}.outbound.json`), service: () => options.delivery?.(),
      binding: sessionId => this.outboundBinding(sessionId), verifyOccurrence: (binding, id) => this.verifyOccurrence(binding, id),
      now: options.now, onError: options.onDeliveryError })
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString() }
  private get ledger() { return this.options.ledger ?? { upsertTask, setTaskStatus, getTask } }
  private spec() { return { path: this.options.file!, format: 'json' as const, fallback: emptyFile(), validate: validFile } }
  private read(options: { recover?: boolean } = {}): OperationFile {
    const state = this.options.file === undefined ? structuredClone(this.memory) : readState(this.options.file, emptyFile(), validFile, options)
    for (const [key, row] of this.volatile) state.operations[key] = structuredClone(row)
    return state
  }

  private save(operation: ReminderOperation): ReminderOperation {
    const next = { ...this.read().operations[operation.executionKey], ...structuredClone(operation), updatedAt: this.now() }
    try {
      if (this.options.file === undefined) this.memory.operations[next.executionKey] = structuredClone(next)
      else commitState(this.spec(), { kind: 'reminder.operation', targetId: next.executionKey }, state => {
        state.operations[next.executionKey] = next
        return { value: state, result: next }
      })
      this.volatile.delete(next.executionKey)
      return next
    } catch (error) {
      // Even when this write cannot be persisted, this manager must remember the accepted effect.
      this.volatile.set(next.executionKey, next)
      throw error
    }
  }

  private key(identity: ExecutionIdentity): string {
    const key = executionKey(identity)
    if (key === undefined || !identity.sessionId || identity.sessionId === 'butler-vault') throw new Error('提醒缺少稳定的执行身份 identity，不能安全建立或取消')
    return key
  }

  private shared(key: string, digest: string, work: () => Promise<ReminderResult>): Promise<ReminderResult> {
    const activeKey = `${this.namespace}\n${key}`, active = pending.get(activeKey)
    if (active !== undefined) {
      if (active.digest !== digest) return Promise.reject(new Error('同一执行身份的 payload 请求内容变化，拒绝重复外部动作'))
      return active.promise
    }
    const promise = Promise.resolve().then(work)
    pending.set(activeKey, { digest, promise })
    void promise.finally(() => { if (pending.get(activeKey)?.promise === promise) pending.delete(activeKey) }).catch(() => {})
    return promise
  }

  private existing(key: string, digest: string): ReminderOperation | undefined {
    const previous = this.read().operations[key]
    if (previous !== undefined && previous.requestDigest !== digest) throw new Error('同一执行身份的 payload 请求内容变化，拒绝重复外部动作')
    return previous
  }

  private metadata(operation: ReminderOperation, stage: string): OperationMetadata {
    return { operationId: `reminder-${hash(`${operation.executionKey}:${stage}`)}`, time: operation.createdAt }
  }

  private link(operation: ReminderOperation): ReminderTaskLink {
    return {
      executionKey: operation.executionKey, requestDigest: operation.requestDigest,
      ...(operation.scheduleId === undefined ? {} : { scheduleId: operation.scheduleId }),
      ...(operation.destinationSessionId === undefined ? {} : { destinationSessionId: operation.destinationSessionId }),
      confirmedAt: operation.confirmedAt!, timeZone: operation.timeZone, creationState: operation.state,
      deliveryState: operation.deliveryState ?? 'unknown',
      ...(operation.lastDelivery === undefined ? {} : { lastDelivery: operation.lastDelivery }),
      ...(operation.outboundDestination === undefined ? {} : { outboundDestination: structuredClone(operation.outboundDestination) }),
    }
  }

  private result(operation: ReminderOperation): ReminderResult {
    const out: ReminderResult = { ok: operation.state === 'committed' && operation.refusal === undefined, state: operation.state, operation: structuredClone(operation),
      ...(operation.taskId === undefined ? {} : { taskId: operation.taskId }), ...(operation.task === undefined ? {} : { task: structuredClone(operation.task) }),
      ...(operation.reason === undefined ? {} : { reason: operation.reason }) }
    if (operation.action === 'create' && operation.scheduleId && operation.destinationSessionId && operation.actualReceipt) {
      const receipt = operation.actualReceipt as ScheduleRecord
      out.reminder = { id: operation.scheduleId, sessionId: operation.destinationSessionId,
        ...(receipt.scheduledAt === undefined ? {} : { scheduledAt: receipt.scheduledAt }),
        ...(operation.scheduleKind === undefined ? {} : { kind: operation.scheduleKind }),
        ...(operation.scheduleStatus === undefined ? {} : { status: operation.scheduleStatus }),
        raw: structuredClone(receipt) }
    }
    if (operation.action === 'cancel') {
      const receipt = operation.actualReceipt as DeleteReceipt | undefined
      out.ok = out.ok && receipt?.deleted === true
      out.cancelled = out.ok ? operation.scheduleId! : null
      if (receipt?.code !== undefined) out.code = receipt.code
    }
    if (operation.refusal !== undefined) {
      out.code = operation.refusal.code
      out.reason = operation.refusal.reason
    }
    return out
  }

  private uncertain(operation: ReminderOperation, error: unknown): ReminderResult {
    const next = { ...operation, state: 'uncertain' as const, reason: `${error instanceof Error ? error.message : String(error)}；结果待核对，不自动重发外部请求。` }
    try { return this.result(this.save(next)) } catch { return this.result(next) }
  }

  private refuse(operation: ReminderOperation, code: string, reason: string): ReminderResult {
    // Do not expose another source's task, destination or receipt, including on old-record replay.
    const refused: ReminderOperation = { ...operation, state: 'committed', refusal: { code, reason },
      taskId: undefined, task: undefined, destinationSessionId: undefined, actualReceipt: undefined, reason: undefined }
    return this.result(this.save(refused))
  }

  async create(input: { identity: ExecutionIdentity; reminder: ReminderCreateRequest }): Promise<ReminderResult> {
    const key = this.key(input.identity), request = structuredClone(input.reminder)
    const relative = request.afterSeconds !== undefined
    const tagged = request.timing !== undefined
    if (!text(request.title) || !text(request.prompt) || !text(request.timeZone)) throw new Error('提醒标题、正文和时区不能为空')
    if (tagged
      ? request.at !== undefined || request.afterSeconds !== undefined || !validTiming(request.timing)
      : relative ? request.at !== undefined || typeof request.afterSeconds !== 'number' || request.afterSeconds <= 0
        || !Number.isSafeInteger(request.afterSeconds * 1000) : !concreteTime(request.at)) {
      throw new Error('提醒时间无效：需要具体 at、正数 afterSeconds 或有效 timing，且只能提供一种')
    }
    if (!validTimeZone(request.timeZone)) throw new Error('提醒时间的时区无效')
    // Preserve legacy absolute digests; relative replays compare their original duration, never a moving clock.
    // A tagged timing digest is the rule itself, so a repeat never moves either.
    const digest = hash(JSON.stringify(['create', input.identity.sessionId, request.title, request.prompt,
      tagged ? { timing: request.timing } : relative ? { afterSeconds: request.afterSeconds } : request.at, request.timeZone]))
    return this.shared(key, digest, async () => {
      let operation = this.existing(key, digest)
      if (operation?.state === 'committed') return this.result(operation)
      const schedule = this.options.schedule()
      if (schedule === undefined) {
        if (operation) return { ...this.uncertain(operation, '调度服务不可用'), unavailable: true }
        throw new Error('调度服务不可用，提醒未建立')
      }
      if (operation !== undefined) return this.reconcileCreate(operation, schedule)
      const now = this.now()
      const { reminder, predictedAt } = this.concreteReminder(request, now)
      operation = {
        action: 'create', executionKey: key, identity: structuredClone(input.identity), requestDigest: digest,
        state: 'creating', sourceSessionId: input.identity.sessionId!, taskId: `task-reminder-${hash(key).slice(0, 32)}`,
        confirmedAt: predictedAt ?? now, timeZone: reminder.timeZone, request: reminder,
        createdAt: now, updatedAt: now, deliveryState: 'unknown',
      }
      try {
        operation = this.save(operation)
        const task = this.ledger.upsertTask(operation.taskId!, {
          title: `提醒：${reminder.title}`, kind: 'reminder', status: 'pending', sessionId: input.identity.sessionId,
          ownerId: input.identity.ownerId, channelOrigin: input.identity.channelOrigin,
          rootSessionId: input.identity.rootSessionId, runId: input.identity.runId, originMessageId: input.identity.originMessageId,
          note: '提醒创建结果尚未确认', ...{ reminder: this.link(operation) },
        }, this.metadata(operation, 'task.prepared'))
        if (task === undefined) throw new Error('提醒业务任务未能保存')
        const service = this.options.delivery?.()
        if (service !== undefined) {
          const identity = Object.freeze(structuredClone(operation.identity))
          const user = this.options.userInput?.(identity)
          const target = await service.destinationFor(identity, user === undefined ? undefined : Object.freeze(structuredClone(user)))
          if (target !== undefined) {
            if (!validReminderDestination(target) || target.ownerId !== operation.identity.ownerId || task.ownerId !== target.ownerId) {
              throw new Error('提醒外发目标与已持久化 owner 不一致，拒绝建立外发绑定')
            }
            operation = this.save({ ...operation, outboundDestination: structuredClone(target) })
          }
        }
        const destination = await this.options.destination(operation.sourceSessionId, reminder.title, key)
        if (!destination.startsWith(REMINDER_SESSION_PREFIX)) throw new Error('提醒目标不是独立提醒会话，拒绝建立规则')
        operation = this.save({ ...operation, destinationSessionId: destination })
        // 0.2.2: request first, then the acting butler session; the isolated reminder session is the target.
        const receipt = await scheduleCreate(schedule, operation.sourceSessionId, destination, reminder)
        if (!text(receipt.id)) throw new Error('调度服务未返回可信规则 ID')
        const raw = receipt.raw
        operation = { ...operation, scheduleId: receipt.id, actualReceipt: raw as ScheduleRecord, deliveryState: 'scheduled',
          ...(receipt.kind === undefined ? {} : { scheduleKind: receipt.kind }),
          ...(receipt.status === undefined ? {} : { scheduleStatus: receipt.status }),
          // A recurring rule's first occurrence is only known once the scheduler stored it.
          ...(reminder.at === undefined && raw.scheduledAt !== undefined ? { confirmedAt: raw.scheduledAt } : {}) }
        operation = this.save(operation)
        return this.commitCreate(operation)
      } catch (error) { return this.uncertain(operation, error) }
    })
  }

  /**
   * Turn a validated request into the concrete reminder the scheduler receives.
   *
   * Legacy `at`/`afterSeconds` calls keep the old behaviour: the wall-clock or
   * relative instant is frozen before the external request, so a replay can
   * never silently move. An explicit `timing` is forwarded untouched — the
   * scheduler is the authority on recurrence — and `predictedAt` is only the
   * best host-side instant for display/ledger bookkeeping (the create receipt
   * replaces it when the real first occurrence is known).
   */
  private concreteReminder(request: ReminderCreateRequest, now: string): { reminder: ConcreteReminder; predictedAt?: string } {
    const base = { title: request.title, prompt: request.prompt, timeZone: request.timeZone }
    if (request.timing !== undefined) {
      const timing = structuredClone(request.timing)
      const predictedAt = timingInstant(timing, now)
      return { reminder: { ...base, timing }, ...(predictedAt === undefined ? {} : { predictedAt }) }
    }
    if (request.afterSeconds !== undefined) {
      const at = new Date(Date.parse(now) + request.afterSeconds * 1000)
      if (!Number.isFinite(at.getTime())) throw new Error('相对提醒时间超出有效范围')
      const instant = at.toISOString()
      return { reminder: { ...base, at: instant }, predictedAt: instant }
    }
    return { reminder: { ...base, at: request.at! }, predictedAt: request.at }
  }

  private async reconcileCreate(operation: ReminderOperation, schedule: ScheduleService): Promise<ReminderResult> {
    try {
      const catalog = await schedule.catalog()
      // Matching title/time is never proof of ownership after a lost create response.
      if (!operation.scheduleId || !operation.destinationSessionId || !operation.actualReceipt) {
        return this.uncertain(operation, '上次创建缺少实际宿主回执，请核对原生提醒目录')
      }
      const matches = catalog.filter(row => row.id === operation.scheduleId
        && reminderTargetSession(row) === operation.destinationSessionId)
      if (matches.length !== 1) return this.uncertain(operation, '实际规则 ID/目标会话未能在宿主目录唯一核实')
      const row = matches[0]!
      return this.commitCreate({ ...operation,
        ...(row.kind === undefined ? {} : { scheduleKind: row.kind }),
        ...(row.status === undefined ? {} : { scheduleStatus: row.status }) })
    } catch (error) { return this.uncertain(operation, error) }
  }

  private commitCreate(operation: ReminderOperation): ReminderResult {
    const committed = { ...operation, state: 'committed' as const, deliveryState: operation.deliveryState === 'delivered' ? 'delivered' as const : 'scheduled' as const }
    delete committed.reason
    const task = this.ledger.setTaskStatus(operation.taskId!, committed.deliveryState === 'delivered' ? 'running' : 'pending',
      `已建立提醒 ${operation.scheduleId}`, operation.timeZone, this.metadata(operation, 'task.scheduled'), {
        ...((operation.actualReceipt as ScheduleRecord).scheduledAt === undefined ? {} : { dueAt: (operation.actualReceipt as ScheduleRecord).scheduledAt }),
        ...{ reminder: this.link(committed) },
      })
    if (task === undefined) throw new Error('提醒规则已接受，但业务任务未能提交')
    return this.result(this.save({ ...committed, task }))
  }

  async cancel(input: { identity: ExecutionIdentity; id: string; timeZone: string }): Promise<ReminderResult> {
    const key = this.key(input.identity), digest = hash(JSON.stringify(['cancel', input.identity.sessionId, input.id, input.timeZone]))
    return this.shared(key, digest, async () => {
      let operation = this.existing(key, digest)
      if (operation?.destinationSessionId && !this.canAccess(operation.sourceSessionId, input.id, operation.destinationSessionId)) {
        return this.refuse(operation, 'schedule_owner_mismatch', '提醒归属与来源会话不匹配，未取消提醒。')
      }
      if (operation?.state === 'committed') return this.result(operation)
      // A persisted native delete receipt permits local repair; an uncertain delete never repeats automatically.
      if (operation?.actualReceipt !== undefined) {
        try { return this.commitCancel(operation) } catch (error) { return this.uncertain(operation, error) }
      }
      if (operation !== undefined) return this.uncertain(operation, '上次取消没有实际删除回执，请核对宿主目录')
      const schedule = this.options.schedule()
      if (!schedule) throw new Error('调度服务不可用，不能取消提醒')
      const now = this.now()
      operation = { action: 'cancel', executionKey: key, identity: structuredClone(input.identity), requestDigest: digest,
        state: 'creating', sourceSessionId: input.identity.sessionId!, scheduleId: input.id, timeZone: input.timeZone, createdAt: now, updatedAt: now }
      try {
        operation = this.save(operation)
        const owned = this.createsFor(input.id).filter(row => row.sourceSessionId === operation!.sourceSessionId)
        if (owned.length > 1) return this.refuse(operation, 'schedule_not_found_or_ambiguous', '当前来源有多个同 ID 的提醒目标，无法唯一取消。')
        const associated = owned[0]
        const rows = (await schedule.catalog()).filter(row => row.id === input.id)
        // 0.2.2 carries the delivery destination under `target`, not a flat sessionId.
        const targets = rows.map(row => ({ row, target: reminderTargetSession(row) }))
        const owner = associated?.destinationSessionId
          ? targets.filter(entry => entry.target === associated.destinationSessionId)
          : targets.filter(entry => entry.target !== undefined && this.canAccess(operation!.sourceSessionId, input.id, entry.target))
        if (owner.some(entry => !entry.target || !this.canAccess(operation!.sourceSessionId, input.id, entry.target))) {
          return this.refuse(operation, 'schedule_owner_mismatch', '提醒归属与来源会话不匹配，未取消提醒。')
        }
        if (owner.length === 0 && rows.length > 0 && associated === undefined) {
          return this.refuse(operation, 'schedule_owner_mismatch', '缺少当前来源对该提醒目标的可信绑定，未取消提醒。')
        }
        if (owner.length > 1) return this.refuse(operation, 'schedule_not_found_or_ambiguous', '提醒目标不唯一，未取消提醒。')
        const matched = owner[0]
        operation = this.save({ ...operation,
          ...(matched?.target === undefined ? {} : { destinationSessionId: matched.target }),
          ...(associated?.taskId === undefined ? {} : { taskId: associated.taskId }),
          ...(matched?.row.kind === undefined ? {} : { scheduleKind: matched.row.kind }),
          ...(matched?.row.status === undefined ? {} : { scheduleStatus: matched.row.status }),
        })
        // 0.2.2 cancellation is `edit({ action: 'delete' })`; ids are host-wide.
        const receipt = await deleteOwnedReminder({ catalog: async () => owner.map(entry => entry.row), edit: request => schedule.edit(request) },
          operation.sourceSessionId, input.id)
        if (receipt.id !== input.id) throw new Error('调度删除回执与请求规则 ID 不一致')
        operation = { ...operation, actualReceipt: receipt }
        operation = this.save(operation)
        return this.commitCancel(operation)
      } catch (error) { return this.uncertain(operation, error) }
    })
  }

  private commitCancel(operation: ReminderOperation): ReminderResult {
    const receipt = operation.actualReceipt as DeleteReceipt
    let task: Task | undefined
    if (receipt.deleted === true && operation.taskId) {
      task = this.ledger.setTaskStatus(operation.taskId, 'cancelled', `已取消提醒 ${operation.scheduleId}`, operation.timeZone, this.metadata(operation, 'task.cancelled'))
      if (!task) throw new Error('提醒已删除，但业务任务取消状态尚未保存')
    }
    const committed = { ...operation, state: 'committed' as const, ...(task === undefined ? {} : { task }) }
    delete committed.reason
    return this.result(this.save(committed))
  }

  private createsFor(id: string): ReminderOperation[] {
    return Object.values(this.read().operations).filter(row => row.action === 'create' && row.scheduleId === id)
  }

  private canAccess(source: string, id: string, destination: string): boolean {
    const known = this.createsFor(id).filter(row => row.destinationSessionId === destination)
    if (known.length > 0) return known.length === 1 && known[0]!.sourceSessionId === source
    return destination === source || (destination.startsWith(REMINDER_SESSION_PREFIX) && this.options.ownsDestination?.(source, destination) === true)
  }

  async history(input: { sourceSessionId: string; id: string; limit?: number; timeZone?: string }): Promise<ReminderHistoryResult> {
    const schedule = this.options.schedule()
    const unavailable = (reason: string, code?: string): ReminderHistoryResult => ({ ok: false, available: false, deliveryState: 'unknown', scheduleId: input.id,
      reason, ...(code === undefined ? {} : { code }) })
    if (!schedule || typeof schedule.history !== 'function') return unavailable('宿主未提供原生 history，送达历史不可用')
    try {
      const owned = this.createsFor(input.id).filter(row => row.sourceSessionId === input.sourceSessionId)
      if (owned.length > 1) return unavailable('当前来源有多个同 ID 的提醒目标，无法唯一查询历史')
      const known = owned[0]
      let destination = known?.destinationSessionId
      if (destination && !this.canAccess(input.sourceSessionId, input.id, destination)) return unavailable('提醒归属与来源会话不匹配')
      if (!destination) {
        const matches = (await schedule.catalog()).filter(row => row.id === input.id
          && reminderTargetSession(row) !== undefined && this.canAccess(input.sourceSessionId, input.id, reminderTargetSession(row)!))
        const match = matches.length === 1 ? matches[0] : undefined
        if (!match) return unavailable('无法唯一确定提醒所属会话，送达历史不可用')
        destination = reminderTargetSession(match)!
      }
      const limit = Math.max(1, Math.min(100, Number.isSafeInteger(input.limit) ? input.limit! : 20))
      // 0.2.2 history is target-based: the id and an explicit page size, no session id.
      const response = await schedule.history({ id: input.id, limit })
      if (!('records' in response) || !Array.isArray(response.records)) {
        const code = 'code' in response && typeof response.code === 'string' ? response.code : undefined
        return unavailable(code === undefined ? '宿主未返回有效的原生历史记录' : `宿主原生历史查询未命中：${code}`, code)
      }
      if (!response.records.every((row: unknown) => deliveryReceipt(row))) return unavailable('宿主未返回有效的原生历史记录')
      const records: ScheduleDeliveryReceipt[] = response.records.map((row: ScheduleDeliveryReceipt) => reminderDeliveryReceipt(row))
      const limits = reminderHistoryLimits(response)
      const delivered = records.filter(nativeDelivered).sort((a, b) => (a.deliveredAt ?? '').localeCompare(b.deliveredAt ?? '')).at(-1)
      if (known && delivered) this.recordDelivery(known, delivered)
      const deliveryState: ReminderDeliveryState = delivered ? 'delivered' : records.some(row => instant(row.scheduledAt)) ? 'scheduled' : 'unknown'
      return { ok: true, available: true, deliveryState, scheduleId: input.id, sessionId: destination,
        ...(known?.taskId === undefined ? {} : { taskId: known.taskId }), records, ...limits }
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)) }
  }

  private recordDelivery(operation: ReminderOperation, receipt: ScheduleDeliveryReceipt): void {
    if (!nativeDelivered(receipt) || !operation.taskId) return
    if (operation.outboundDestination !== undefined && !isDeepStrictEqual(operation.task?.reminder?.outboundDestination, operation.outboundDestination)) {
      throw new Error('提醒外发目标与创建时的任务快照不一致，拒绝更换目标')
    }
    const next = this.save({ ...operation, deliveryState: 'delivered', lastDelivery: structuredClone(receipt) })
    const task = this.ledger.getTask?.(operation.taskId)
    if (task?.status === 'cancelled' || task?.status === 'done') return
    const updated = this.ledger.setTaskStatus(operation.taskId, 'running', `提醒已投递 ${operation.scheduleId}，等待可核实的处理完成事件`, operation.timeZone,
      { ...this.metadata(operation, `task.delivered:${hash(JSON.stringify(receipt))}`), time: receipt.deliveredAt ?? this.now() }, { kind: 'reminder', ...{ reminder: this.link(next) } })
    if (updated !== undefined) this.save({ ...next, task: updated })
  }

  /** Native session/event hook. Plain assistant text never proves a completed occurrence. */
  observeSessionEvent(session: { id?: string }, event: { type?: string; data?: unknown; time?: number; seq?: number }): ReminderDeliveryBinding | undefined {
    if (!session.id || event.type !== 'user/message' || !record(event.data)) return
    const message = event.data, source = record(message.source) ? message.source : undefined
    if (source?.kind !== 'schedule' || !text(message.id)) return
    const binding = this.taskForSession(session.id)
    if (!binding) return
    if (source.scheduleId !== undefined && source.scheduleId !== binding.scheduleId) return
    const operation = Object.values(this.read().operations).find(row => row.action === 'create' && row.destinationSessionId === session.id && row.taskId === binding.taskId)!
    this.recordDelivery(operation, { messageId: message.id,
      ...(typeof event.time === 'number' && Number.isFinite(new Date(event.time).getTime()) ? { deliveredAt: new Date(event.time).toISOString() } : {}),
      ...((operation.actualReceipt as ScheduleRecord | undefined)?.scheduledAt === undefined ? {} : { scheduledAt: (operation.actualReceipt as ScheduleRecord).scheduledAt }),
    })
    return { taskId: binding.taskId, sessionId: session.id, scheduleId: binding.scheduleId, originMessageId: message.id }
  }

  /** Unique accepted rule/task mapping only; this lookup never changes a budget or execution context. */
  taskForSession(sessionId: string): ReminderDeliveryBinding | undefined {
    const rows = Object.values(this.read().operations).filter(row => row.action === 'create' && row.destinationSessionId === sessionId)
    const operation = rows.length === 1 ? rows[0] : undefined
    if (!operation || operation.state !== 'committed' || !operation.taskId || !operation.scheduleId
      || operation.actualReceipt?.id !== operation.scheduleId) return undefined
    return { taskId: operation.taskId, sessionId, scheduleId: operation.scheduleId,
      ...(text(operation.lastDelivery?.messageId) ? { originMessageId: operation.lastDelivery.messageId } : {}) }
  }

  private outboundBinding(sessionId: string): ReminderOutboundBinding | undefined {
    const rows = Object.values(this.read().operations).filter(row => row.action === 'create' && row.destinationSessionId === sessionId)
    const operation = rows.length === 1 ? rows[0] : undefined
    if (!operation || operation.state !== 'committed' || !operation.scheduleId || !operation.taskId || !operation.outboundDestination
      || operation.actualReceipt?.id !== operation.scheduleId || operation.outboundDestination.ownerId !== operation.identity.ownerId
      || !isDeepStrictEqual(operation.task?.reminder?.outboundDestination, operation.outboundDestination)) return
    const receipt = operation.actualReceipt as ScheduleRecord
    // 0.2.2 receipts carry the destination under `target`; older files kept `sessionId`.
    const receiptSession = reminderTargetSession(receipt)
    if (receiptSession !== undefined && receiptSession !== sessionId) return
    const task = this.ledger.getTask?.(operation.taskId)
    if (!task || task.ownerId !== operation.identity.ownerId || task.status === 'cancelled' || task.status === 'done'
      || task.reminder?.executionKey !== operation.executionKey || task.reminder.scheduleId !== operation.scheduleId
      || task.reminder.destinationSessionId !== sessionId || task.sessionId !== operation.sourceSessionId
      || !isDeepStrictEqual(task.reminder.outboundDestination, operation.outboundDestination)) return
    return { executionKey: operation.executionKey, scheduleId: operation.scheduleId, taskId: operation.taskId,
      sessionId, ownerId: operation.outboundDestination.ownerId, destination: structuredClone(operation.outboundDestination) }
  }

  private async verifyOccurrence(binding: ReminderOutboundBinding, occurrenceMessageId: string): Promise<boolean> {
    const schedule = this.options.schedule()
    if (typeof schedule?.history !== 'function') return false
    for (let attempt = 0; attempt < 3; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const response = await Promise.race([
          schedule.history({ id: binding.scheduleId, limit: 100 }),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 500) }),
        ])
        if (response !== undefined && typeof response === 'object' && 'records' in response
          && Array.isArray(response.records) && response.records.every((row: unknown) => deliveryReceipt(row))
          && response.records.some((row: ScheduleDeliveryReceipt) => row.messageId === occurrenceMessageId)) return true
      } catch { /* No history receipt can be inferred from an unavailable host. */ }
      finally { if (timer !== undefined) clearTimeout(timer) }
      if (attempt < 2) await delay(50 * (attempt + 1))
    }
    return false
  }

  observeOutboundSessionEvent(session: { id?: string; inheritedEventCount?: number }, event: { type?: string; data?: unknown; time?: number; seq?: number }): Promise<void> | undefined {
    return this.outbound.observeSessionEvent(session, event)
  }

  /** Host lifecycle only. HTTP/status callers must keep using the local snapshot. */
  recoverOutbound(): Promise<void> { return this.outbound.recover() }

  stop(): void { this.outbound.stop() }

  status(options: { recover?: boolean } = {}): ReminderOperation[] {
    const records = this.outbound.status()
    return structuredClone(Object.values(this.read({ recover: options.recover ?? false }).operations).map(operation => {
      const outbound = records.filter(row => row.executionKey === operation.executionKey && row.taskId === operation.taskId
        && row.scheduleId === operation.scheduleId && row.sessionId === operation.destinationSessionId)
      return { ...operation, ...(outbound.length === 0 ? {} : { outbound }) }
    }))
  }
}
