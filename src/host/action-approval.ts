/** Exact-call, one-shot approvals. This module never executes an external action. */
import { createHash } from 'node:crypto'
import { executionKey, type ContextExecution, type ExecutionContexts, type ExecutionIdentity } from './execution-context.ts'
import { commitFiles, readSnapshot } from './store.ts'
import { statePath } from './vault.ts'

export type NativeApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
interface NativeAuditEvent { seq: number; type: string; data: Record<string, unknown> }
interface NativeAudit { inheritedEventCount: number; cursor: number; events: NativeAuditEvent[] }
export interface ActionDecision {
  source: 'native-approval'
  requestId: string
  outcome: NativeApprovalOutcome
  askedSeq: number
  decidedSeq: number
  sessionId: string
  executionKey: string
  argsDigest: string
}
export interface ActionProposal {
  id: string
  kind: 'external-action'
  toolName: string
  argsDigest: string
  callId: string
  identity: ExecutionIdentity
  createdAt: string
  expiresAt: string
  auditAfter: number | null
  status: 'pending' | 'approved' | 'declined' | 'consumed'
  decision?: ActionDecision
  consumedAt?: string
}
export interface ActionTarget {
  toolName: string
  argsDigest: string
  taskId?: string
  callId?: string
  expiresAt?: string
}
export interface ActionApprovalOptions {
  contexts: ExecutionContexts
  file?: string
  now?: () => number
  sessionQuery?: { readSession(sessionId: string): Promise<unknown> }
}
export interface ActionAuthorization {
  allowed: boolean
  reason?: string
  proposalId?: string
  callId?: string
}
interface ApprovalFile { version: 1; proposals: ActionProposal[]; audits: Record<string, NativeAudit> }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const safeInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const outcomes: NativeApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']
const auditTypes = ['turn/start', 'turn/end', 'approval/asked', 'approval/decided']
const empty = (): ApprovalFile => ({ version: 1, proposals: [], audits: {} })
function canonical(value: unknown, parents = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || parents.has(value)) throw new Error('动作参数必须是完整、无循环的 JSON 值。')
  const next = new Set(parents).add(value)
  if (Array.isArray(value)) return `[${Array.from(value, item => canonical(item, next)).join(',')}]`
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('动作参数必须是普通 JSON 对象。')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], next)}`).join(',')}}`
}
/** Includes every structured argument, including recipients and action targets. */
export function actionArgumentsDigest(value: unknown): string { return hash(canonical(value)) }
function validFile(value: unknown): boolean {
  if (!record(value) || value['version'] !== 1 || !Array.isArray(value['proposals']) || !record(value['audits'])) return false
  return value['proposals'].every(row => record(row) && nonempty(row['id']) && row['kind'] === 'external-action' && nonempty(row['toolName'])
    && typeof row['argsDigest'] === 'string' && /^[a-f0-9]{64}$/.test(row['argsDigest']) && nonempty(row['callId']) && record(row['identity'])
    && nonempty(row['identity']['sessionId']) && nonempty(row['identity']['originMessageId']) && nonempty(row['identity']['taskId'])
    && nonempty(row['createdAt']) && Number.isFinite(Date.parse(String(row['expiresAt'])))
    && (row['auditAfter'] === null || safeInt(row['auditAfter'])) && ['pending', 'approved', 'declined', 'consumed'].includes(String(row['status'])))
    && Object.values(value['audits']).every(row => record(row) && safeInt(row['inheritedEventCount']) && safeInt(row['cursor']) && Array.isArray(row['events'])
      && row['events'].every(event => record(event) && safeInt(event['seq']) && nonempty(event['type']) && record(event['data'])))
}
function projectEvent(value: unknown): NativeAuditEvent | undefined {
  if (!record(value) || !safeInt(value['seq']) || !auditTypes.includes(String(value['type'])) || !record(value['data'])) return undefined
  const data = value['data'], type = String(value['type'])
  // Keep only approval identity, never arbitrary event payloads or tool arguments.
  return { seq: value['seq'], type, data: type === 'approval/asked' ? { id: data['id'], toolName: data['toolName'], callId: data['callId'] }
    : type === 'approval/decided' ? { id: data['id'], outcome: data['outcome'] }
      : type === 'turn/start' && safeInt(data['turn']) ? { turn: data['turn'] } : {} }
}
function auditFromSnapshot(value: unknown): NativeAudit {
  if (!record(value) || !Array.isArray(value['events']) || !safeInt(value['inheritedEventCount']) || value['inheritedEventCount'] > value['events'].length) throw new Error('原生宿主 sessionQuery 审批快照不可用。')
  const boundary = value['inheritedEventCount'], all = value['events']
  if (!all.every((event, index) => record(event) && safeInt(event['seq']) && event['seq'] === index)) throw new Error('原生审批事件序号不完整。')
  const events = all.filter(event => event['seq'] >= boundary).map(projectEvent).filter((event): event is NativeAuditEvent => event !== undefined)
  return { inheritedEventCount: boundary, cursor: all.length, events }
}
function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  const key = executionKey(a)
  return key !== undefined && key === executionKey(b)
    && ['sessionId', 'rootSessionId', 'taskId', 'runId', 'originMessageId', 'callId', 'turn', 'step'].every(key => a[key as keyof ExecutionIdentity] === b[key as keyof ExecutionIdentity])
}

export class ActionApprovalService {
  private readonly options: ActionApprovalOptions
  private readonly verified = new Map<string, string>()
  private readonly liveSessions = new Set<string>()
  constructor(options: ActionApprovalOptions) { this.options = options }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private spec() { return { path: this.options.file ?? statePath('action-approvals.json'), format: 'json' as const, fallback: empty(), validate: validFile } }
  private snapshot() { return readSnapshot(this.spec()) }
  private save(file: ReturnType<ActionApprovalService['snapshot']>, value: ApprovalFile, kind: string, targetId: string): void {
    commitFiles({ kind, targetId, writes: [{ ...this.spec(), content: `${JSON.stringify(value, null, 2)}\n`, expectedBefore: file.expectedBefore }] })
  }
  private currentMatches(identity: ExecutionIdentity): boolean {
    if (!identity.sessionId || !identity.originMessageId || !identity.taskId) return false
    const current = this.options.contexts.forAgent(identity.sessionId)
    const root = this.options.contexts.forAgent(identity.rootSessionId ?? identity.sessionId)
    return ['sessionId', 'rootSessionId', 'taskId', 'runId', 'originMessageId'].every(key => current[key as keyof ExecutionIdentity] === identity[key as keyof ExecutionIdentity])
      && root.originMessageId === identity.originMessageId && this.options.contexts.originUser(identity)?.source === 'user'
  }
  private exact(proposal: ActionProposal, exec: ContextExecution, supplied?: ExecutionIdentity): boolean {
    const [, call] = this.options.contexts.capture(exec), identity = call.identity
    if (supplied && !sameIdentity(supplied, identity)) return false
    if (!sameIdentity(proposal.identity, identity) || !this.currentMatches(identity) || exec.name !== proposal.toolName
      || (exec.callId ?? exec.id) !== proposal.callId) return false
    try { return actionArgumentsDigest(exec['arguments']) === proposal.argsDigest } catch { return false }
  }

  async propose(target: ActionTarget, suppliedIdentity?: ExecutionIdentity): Promise<ActionProposal> {
    const identity = { ...(suppliedIdentity ?? this.options.contexts.current() ?? {}) }
    identity.callId = target.callId ?? identity.callId
    if (!nonempty(target.toolName) || !/^[a-f0-9]{64}$/.test(target.argsDigest) || !executionKey(identity) || !this.currentMatches(identity)
      || (target.taskId !== undefined && target.taskId !== identity.taskId)) throw new Error('外部动作缺少可信会话、任务或精确调用标识。')
    const id = `action:${hash(canonical([executionKey(identity), target.toolName, target.argsDigest])).slice(0, 24)}`
    let file = this.snapshot()
    const existing = file.value.proposals.find(row => row.id === id)
    if (existing) return structuredClone(existing)
    if (file.value.proposals.some(row => executionKey(row.identity) === executionKey(identity))) throw new Error('同一原生调用已经绑定另一个工具或参数目标；需要新的调用。')
    const native = this.options.sessionQuery === undefined ? undefined : auditFromSnapshot(await this.options.sessionQuery.readSession(identity.sessionId!))
    file = this.snapshot()
    const concurrent = file.value.proposals.find(row => row.id === id)
    if (concurrent) return structuredClone(concurrent)
    if (file.value.proposals.some(row => executionKey(row.identity) === executionKey(identity))) throw new Error('同一原生调用已经绑定另一个工具或参数目标；需要新的调用。')
    const expiresAt = target.expiresAt ?? new Date(this.now() + 10 * 60_000).toISOString()
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now()) throw new Error('动作审批有效期无效或已过期。')
    const audit = native ?? file.value.audits[identity.sessionId!]
    const proposal: ActionProposal = { id, kind: 'external-action', toolName: target.toolName, argsDigest: target.argsDigest, callId: identity.callId!, identity,
      createdAt: new Date(this.now()).toISOString(), expiresAt, status: 'pending', auditAfter: audit?.cursor ?? null }
    const value: ApprovalFile = { ...file.value, proposals: [...file.value.proposals, proposal], audits: { ...file.value.audits,
      ...(native === undefined ? {} : { [identity.sessionId!]: native }) } }
    this.save(file, value, 'action.propose', id)
    return structuredClone(proposal)
  }

  private decisionFor(proposal: ActionProposal, audit: NativeAudit, requestId: string): ActionDecision {
    const own = audit.events.filter(event => event.seq >= audit.inheritedEventCount)
    const asked = own.filter(event => event.type === 'approval/asked' && event.data['id'] === requestId)
    const decided = own.filter(event => event.type === 'approval/decided' && event.data['id'] === requestId)
    if (asked.length !== 1 || decided.length !== 1) throw new Error('缺少唯一完整的原生审批 asked/decided 记录。')
    const ask = asked[0]!, answer = decided[0]!
    const start = own.filter(event => event.type === 'turn/start' && event.seq < ask.seq).at(-1)
    if (!start || (proposal.identity.turn !== undefined && start.data['turn'] !== proposal.identity.turn)
      || own.some(event => event.type === 'turn/end' && event.seq > start.seq && event.seq < answer.seq)
      || ask.seq >= answer.seq || proposal.auditAfter === null || ask.seq < proposal.auditAfter
      || ask.data['toolName'] !== proposal.toolName || ask.data['callId'] !== proposal.callId || !outcomes.includes(answer.data['outcome'] as NativeApprovalOutcome)) throw new Error('原生审批与当前调用或 own turn 不匹配。')
    return { source: 'native-approval', requestId, outcome: answer.data['outcome'] as NativeApprovalOutcome, askedSeq: ask.seq, decidedSeq: answer.seq,
      sessionId: proposal.identity.sessionId!, executionKey: executionKey(proposal.identity)!, argsDigest: proposal.argsDigest }
  }

  /** The caller supplies an id, never an outcome; the outcome comes from native own events. */
  async recordNativeDecision(id: string, proof: { requestId: string }, exec: ContextExecution, suppliedIdentity?: ExecutionIdentity): Promise<ActionProposal> {
    this.verified.delete(id)
    const initial = this.snapshot().value.proposals.find(row => row.id === id)
    if (!initial || !this.exact(initial, exec, suppliedIdentity)) throw new Error('原生审批的会话或精确调用不匹配。')
    let audit: NativeAudit | undefined
    if (this.options.sessionQuery) audit = auditFromSnapshot(await this.options.sessionQuery.readSession(initial.identity.sessionId!))
    else if (this.liveSessions.has(initial.identity.sessionId!)) audit = this.snapshot().value.audits[initial.identity.sessionId!]
    if (!audit) throw new Error('真实宿主原生审批审计不可用；未运行可核验的审批来源。')
    const file = this.snapshot(), proposal = file.value.proposals.find(row => row.id === id)
    if (!proposal || !this.exact(proposal, exec, suppliedIdentity)) throw new Error('等待原生审批时调用上下文已变化。')
    const decision = this.decisionFor(proposal, audit, proof.requestId)
    if (proposal.decision && canonical(proposal.decision) !== canonical(decision)) throw new Error('原生审批记录已变化，拒绝复用。')
    const updated: ActionProposal = { ...proposal, decision, status: proposal.status === 'consumed' ? 'consumed' : decision.outcome === 'allowed-once' ? 'approved' : 'declined' }
    this.save(file, { ...file.value, proposals: file.value.proposals.map(row => row.id === id ? updated : row),
      audits: { ...file.value.audits, [proposal.identity.sessionId!]: audit } }, 'action.native-decision', id)
    this.verified.set(id, canonical(decision))
    return structuredClone(updated)
  }

  /** Trusted native session/event hook only. Boundary is mandatory; inherited rows are ignored. */
  observeSessionEvent(session: { id?: string; inheritedEventCount?: number }, suppliedEvent: unknown, boundary?: { inheritedEventCount: number }): void {
    const inherited = boundary?.inheritedEventCount ?? session.inheritedEventCount
    const event = projectEvent(suppliedEvent), sessionId = session.id
    if (!sessionId || !safeInt(inherited) || !event || event.seq < inherited) return
    const hasNativeQuery = typeof this.options.sessionQuery?.readSession === 'function'
    const file = this.snapshot(), old = file.value.audits[sessionId]
    if (old && old.inheritedEventCount !== inherited) throw new Error('原生审批 own-event 边界已变化。')
    const previous = old?.events.find(row => row.seq === event.seq)
    if (previous && canonical(previous) !== canonical(event)) {
      for (const proposal of file.value.proposals.filter(row => row.identity.sessionId === sessionId)) this.verified.delete(proposal.id)
      throw new Error('原生审批事件已变化。')
    }
    // A later proposal reads the complete native query, including this turn.
    // Live-only auditing and every existing action/audit keep their durable path.
    if (hasNativeQuery && old === undefined && (event.type === 'turn/start' || event.type === 'turn/end')
      && !file.value.proposals.some(proposal => proposal.identity.sessionId === sessionId)) return
    const audit: NativeAudit = { inheritedEventCount: inherited, cursor: Math.max(old?.cursor ?? inherited, event.seq + 1),
      events: previous ? old!.events : [...old?.events ?? [], event].sort((a, b) => a.seq - b.seq) }
    this.liveSessions.add(sessionId)
    const proposals = file.value.proposals.map(proposal => {
      if (proposal.identity.sessionId !== sessionId || !this.currentMatches(proposal.identity)) return proposal
      let next = proposal
      if (proposal.auditAfter === null && event.type === 'approval/asked' && event.data['toolName'] === proposal.toolName && event.data['callId'] === proposal.callId) next = { ...proposal, auditAfter: event.seq }
      if (event.type !== 'approval/decided' || !nonempty(event.data['id'])) return next
      try {
        const decision = this.decisionFor(next, audit, event.data['id'])
        if (next.decision && canonical(next.decision) !== canonical(decision)) return next
        this.verified.set(next.id, canonical(decision))
        return { ...next, decision, status: next.status === 'consumed' ? 'consumed' as const : decision.outcome === 'allowed-once' ? 'approved' as const : 'declined' as const }
      } catch { return next }
    })
    this.save(file, { ...file.value, proposals, audits: { ...file.value.audits, [sessionId]: audit } }, 'action.native-event', `${sessionId}:${event.seq}`)
  }

  /** Consumes a verified one-shot grant; it never invokes exec or any callback. */
  authorize(id: string, exec: ContextExecution, suppliedIdentity?: ExecutionIdentity): ActionAuthorization {
    const file = this.snapshot(), proposal = file.value.proposals.find(row => row.id === id)
    const denied = (reason: string): ActionAuthorization => ({ allowed: false, reason, proposalId: id })
    if (!proposal || !this.exact(proposal, exec, suppliedIdentity)) return denied('审批与当前会话、任务、调用或参数不匹配。')
    if (proposal.status === 'consumed') return denied('一次性审批已经消费。')
    if (this.now() >= Date.parse(proposal.expiresAt)) return denied('动作审批已经过期。')
    if (proposal.status !== 'approved' || proposal.decision?.outcome !== 'allowed-once'
      || this.verified.get(id) !== canonical(proposal.decision)) return denied('缺少本次宿主已核验的原生批准。')
    const audit = file.value.audits[proposal.identity.sessionId!]
    try {
      if (!audit || canonical(this.decisionFor(proposal, audit, proposal.decision.requestId)) !== canonical(proposal.decision)) return denied('原生审批审计已变化。')
    } catch { return denied('原生审批审计不可核验。') }
    const consumed: ActionProposal = { ...proposal, status: 'consumed', consumedAt: new Date(this.now()).toISOString() }
    this.save(file, { ...file.value, proposals: file.value.proposals.map(row => row.id === id ? consumed : row) }, 'action.consume', id)
    this.verified.delete(id)
    return { allowed: true, proposalId: id, callId: proposal.callId }
  }

  private bound(exec: ContextExecution): ActionProposal | undefined {
    const [, call] = this.options.contexts.capture(exec), key = executionKey(call.identity)
    return key === undefined ? undefined : this.snapshot().value.proposals.find(row => executionKey(row.identity) === key)
  }
  /** Return this only for a deliberately bound external action at tools/pre-execute. */
  gate(exec: ContextExecution): { kind: 'ask' | 'deny'; reason: string } | undefined {
    const proposal = this.bound(exec)
    if (!proposal) return undefined
    if (!this.exact(proposal, exec) || proposal.status === 'consumed' || proposal.status === 'declined' || this.now() >= Date.parse(proposal.expiresAt)) return { kind: 'deny', reason: '绑定动作的审批已经失效、消费或参数变化。' }
    return { kind: 'ask', reason: `请批准本次 ${proposal.toolName} 精确调用；提案 ${proposal.id}；参数摘要 ${proposal.argsDigest}` }
  }
  /** Native tools.guard runs after its approval gate. Unbound local tools keep their host policy. */
  guard(exec: ContextExecution): string | undefined {
    const proposal = this.bound(exec)
    if (!proposal) return undefined
    const result = this.authorize(proposal.id, exec)
    return result.allowed ? undefined : result.reason
  }
}
