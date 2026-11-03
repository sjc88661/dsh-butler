/** Connect business state to final native tool results and native permission decisions. */
import { ActionApprovalService, actionArgumentsDigest } from './action-approval.ts'
import type { ScheduleService } from './ctx.ts'
import { EvidenceStore } from './evidence-store.ts'
import type { ContextAgent, ContextExecution, ContextMessage, ExecutionContexts } from './execution-context.ts'
import { MemoryService } from './memory.ts'
import { ReminderOperations } from './reminder-operations.ts'
import type { ButlerReminderDelivery } from './reminder-delivery.ts'
import { statePath } from './vault.ts'

interface WorkflowContext {
  on(name: string, listener: (...args: any[]) => any, options?: unknown): () => void
  get?(name: string, strict?: boolean): unknown
  tools: { guard?(guard: (exec: ContextExecution) => string | undefined): () => void }
  logger?: { warn?(message: string, ...args: unknown[]): void }
}
interface WorkflowOptions {
  appliesTo?: (agent: { id: string }) => boolean
  contexts: ExecutionContexts
  timeZone: string
  schedule(): ScheduleService | undefined
  destination(source: string, title: string, key: string): Promise<string>
  ownsDestination?(source: string, destination: string): boolean
  delivery?(): ButlerReminderDelivery | undefined
  filePrefix?: string
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
// Native executions retain their bound approval through a same-process plugin reload.
const bindingsKey = Symbol.for('dsh-butler.native-ask-bindings.v1')
const globals = globalThis as unknown as { [key: symbol]: unknown }
const nativeAsks = (globals[bindingsKey] ??= new WeakMap<object, { file: string; proposalId: string }>()) as WeakMap<object, { file: string; proposalId: string }>

export function installBusinessWorkflows(ctx: WorkflowContext, options: WorkflowOptions) {
  const registry = () => ctx.get?.('agents', false) as { list?(): ContextAgent[]; currentInitiator?(): ContextAgent | undefined } | undefined
  const applies = (agent: ContextAgent | undefined) => agent !== undefined && (options.appliesTo?.(agent) ?? true)
  const executionApplies = (exec: ContextExecution) => applies(exec.agent ?? registry()?.currentInitiator?.())
  const contexts = options.contexts
  const path = (name: string) => statePath(`${options.filePrefix ? `${options.filePrefix}-` : ''}${name}`)
  const evidence = new EvidenceStore({ file: path('evidence.json'), identity: () => contexts.current() })
  const memory = new MemoryService({ contexts, timeZone: options.timeZone })
  const query = ctx.get?.('sessionQuery', false) as { readSession?(id: string): Promise<unknown> } | undefined
  const actions = new ActionApprovalService({ contexts, file: path('action-approvals.json'),
    ...(query?.readSession ? { sessionQuery: { readSession: id => query.readSession!(id) } } : {}) })
  const reminderOperations = new ReminderOperations({ file: path('reminder-operations.json'), schedule: options.schedule, destination: options.destination,
    ownsDestination: options.ownsDestination, outboundFile: path('reminder-outbound.json'),
    delivery: options.delivery ?? (() => ctx.get?.('butlerReminderDelivery', false) as ButlerReminderDelivery | undefined),
    userInput: identity => contexts.readUserInputView(identity)?.user,
    onDeliveryError: error => report('reminder-outbound-recovery', error) })
  const disposers: Array<() => void> = []
  const errors: Record<string, string> = {}
  const report = (name: string, error: unknown): void => {
    errors[name] = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.('[dsh-butler] %s：%s', name, errors[name])
  }
  let guarded = false
  if (ctx.tools.guard) {
    try {
      disposers.push(ctx.tools.guard(exec => {
        if (!executionApplies(exec)) return undefined
        const binding = nativeAsks.get(exec)
        if (!binding || binding.file !== path('action-approvals.json')) return undefined
        try {
          const result = actions.authorize(binding.proposalId, exec)
          return result.allowed ? undefined : result.reason ?? '本次动作尚未核验原生批准。'
        } catch (error) { report('action-guard', error); return '动作审批核验失败；未执行该动作。' }
      }))
      guarded = true
    } catch (error) { report('action-guard-install', error) }
  }
  try {
    disposers.push(ctx.on('internal/service', (name: string) => {
      if (name === 'butlerReminderDelivery') return reminderOperations.recoverOutbound().catch(error => report('reminder-outbound-recovery', error))
    }))
    disposers.push(ctx.on('tools/pre-execute', async (exec: ContextExecution, next: () => Promise<{ kind: string; reason?: string }>) => {
      if (!executionApplies(exec)) return next()
      const [, captured] = contexts.capture(exec)
      const decision = await next()
      // Bind only the exact calls for which the native policy already asks.
      // This does not infer risky operations from shell text or bypass host policy.
      if (decision.kind !== 'ask' || !captured.identity.taskId) return decision
      if (!guarded) return { kind: 'deny', reason: '原生 tools.guard 不可用，无法核验本业务动作的一次性批准。' }
      try {
        const proposal = await actions.propose({ toolName: exec.name!, argsDigest: actionArgumentsDigest(exec['arguments']),
          taskId: captured.identity.taskId, callId: captured.identity.callId }, captured.identity)
        nativeAsks.set(exec, { file: path('action-approvals.json'), proposalId: proposal.id })
        return actions.gate(exec) ?? { kind: 'deny', reason: '动作批准绑定失败。' }
      } catch (error) {
        report('action-bind', error)
        return { kind: 'deny', reason: '本次动作的精确批准无法绑定；请核对运行状态。' }
      }
    }, { global: true, prepend: true }))
    disposers.push(ctx.on('tools/result', (exec: ContextExecution, result: unknown) => {
      if (!executionApplies(exec)) return
      const receipt = contexts.receipt(exec, result)
      try { memory.observeToolResult(exec, result, receipt) } catch (error) { report('memory-final-result', error) }
      try {
        const envelope = object(result), value = object(envelope?.['value']) ?? envelope
        const exit = value?.['exitCode'] ?? value?.['exit_code']
        const ok = receipt.ok && value?.['success'] !== false && !(typeof exit === 'number' && exit !== 0)
        evidence.observe(exec.name ?? 'unknown', ok ? { ...value, ok: true } : { ok: false }, receipt)
      } catch (error) { report('evidence-final-result', error) }
    }, { global: true }))
    disposers.push(ctx.on('session/event', (session: { id?: string; inheritedEventCount?: number }, event: { type?: string; data?: unknown; time?: number; seq?: number }) => {
      const agent = registry()?.list?.().find(candidate => (candidate.session?.id ?? candidate.id) === session.id)
      if (options.appliesTo !== undefined && !applies(agent)) return
      try { actions.observeSessionEvent(session, event) } catch (error) { report('native-approval-event', error) }
      try {
        const binding = reminderOperations.observeSessionEvent(session, event)
        if (binding && binding.originMessageId) contexts.bindSchedule(binding.sessionId, { id: binding.originMessageId, source: { kind: 'schedule', scheduleId: binding.scheduleId } }, binding.taskId)
      } catch (error) { report('reminder-delivery-event', error) }
      try {
        // Native append notifications do not await listeners. Claim synchronously before send can yield.
        const delivery = reminderOperations.observeOutboundSessionEvent(session, event)
        return delivery?.catch(error => report('reminder-outbound-event', error))
      } catch (error) { report('reminder-outbound-event', error) }
    }, { global: true }))
    disposers.push(ctx.on('agent/pre-step', async (payload: { agent: ContextAgent; messages: ContextMessage[] }, next: () => Promise<unknown>) => {
      if (!applies(payload.agent)) return next()
      // Claimed native inbox input can precede its durable user/message event.
      // Bind its task here without declaring a delivery or granting human approval.
      const identity = contexts.forAgent(payload.agent)
      const binding = reminderOperations.taskForSession(identity.sessionId!)
      if (binding) {
        const scheduled = payload.messages.findLast(message => message.source?.kind === 'schedule')
        const human = payload.messages.some(message => message.source?.kind === 'user')
        if (!human && scheduled?.id && (scheduled.source?.scheduleId === undefined || scheduled.source.scheduleId === binding.scheduleId)) contexts.bindSchedule(payload.agent, scheduled, binding.taskId)
        else if (!human && binding.originMessageId && identity.originMessageId === binding.originMessageId) contexts.activate(binding.taskId, identity)
      }
      return next()
    }, { global: true }))
  } catch (error) {
    reminderOperations.stop()
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  void reminderOperations.recoverOutbound().catch(error => report('reminder-outbound-recovery', error))
  return { evidence, memory, actions, reminderOperations,
    status: () => ({ active: true, nativeActionGuard: guarded, errors: { ...errors } }),
    stop: () => { reminderOperations.stop(); for (const dispose of disposers.splice(0).reverse()) dispose() } }
}

export type BusinessWorkflows = ReturnType<typeof installBusinessWorkflows>
