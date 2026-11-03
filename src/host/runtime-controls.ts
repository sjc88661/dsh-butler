/** Cordis admission controls for all agent requests, including built-in tools and summaries. */
import { randomUUID } from 'node:crypto'
import { BudgetExceeded, TaskBudgets } from './budget.ts'
import { compactOverviewHistory, type OverviewSession } from './overview-context.ts'
import { planBudget, type BudgetPlan } from './budget-planning.ts'
import { compactLiteratureHistory } from './literature-context.ts'
import { LiteratureResults, type LiteratureScope } from './literature-results.ts'

interface RuntimeMessage { id?: string; source?: { kind?: string }; content?: unknown[] }
interface RuntimeSession extends OverviewSession {
  id?: string
  requestContext?(): { contextWindow?: number; provider?: string; model?: string }
  requestHeader?(): { config?: { provider?: string; model?: string; maxTokens?: number }; system?: string; tools?: unknown[] }
  toolHistory?(): unknown
}
export interface RuntimeAgent {
  id: string
  session: RuntimeSession
  ctx?: { get?(name: string, strict?: boolean): unknown }
  cancel?(reason: unknown, options?: { keepInbox?: boolean }): void
}
interface Registry {
  currentInitiator?(): RuntimeAgent | undefined
  list?(): RuntimeAgent[]
  isOwnedBy?(id: string, owner: RuntimeAgent): boolean
}
interface ControlContext {
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
  get(name: string, strict?: boolean): unknown
  logger?: { warn?(format: string, ...args: unknown[]): void }
}

interface NativeCompactor {
  config: Record<string, unknown>
  ctx?: { llm?: { stream(request: Record<string, unknown>): AsyncIterable<unknown> } }
  summarize?(input: unknown, agent: RuntimeAgent, signal?: AbortSignal): Promise<unknown>
  compactIfNeeded?(agent: RuntimeAgent, ...args: any[]): Promise<unknown>
}

export const REMINDER_SESSION_PREFIX = 'session-butler-reminder-'
const REMINDER_TOOLS = new Set(['butler_tools', 'read', 'grep', 'glob', 'web_search', 'web_fetch', 'butler_literature'])

interface NativeInputContext { contextWindow?: number; provider?: string; model?: string }

/** Conservative reservation, not measured usage. A valid request cannot consume
 * more input+output tokens than its native route's context capacity. Raw JSON
 * bytes (including metadata/escaped arguments) can exceed that physical ceiling.
 * Never trust a caller-supplied capacity or a different summarization route.
 */
export function reserveInput(request: Record<string, unknown>, context?: NativeInputContext): number {
  const bytes = (messages: unknown) => Buffer.byteLength(JSON.stringify({ messages, tools: request['tools'] ?? [],
    system: request['system'] ?? '', toolHistory: request['toolHistory'] ?? [] }), 'utf8') + 1024
  const raw = bytes(request['messages'] ?? [])
  const capacity = context?.contextWindow, output = request['maxTokens']
  if (!context?.provider || !context.model || request['provider'] !== context.provider || request['model'] !== context.model
    || !Number.isSafeInteger(capacity) || capacity! <= 0 || typeof output !== 'number' || !Number.isSafeInteger(output)
    || output <= 0 || output >= capacity!) return raw
  const ceiling = capacity! - output
  const textBlocks = new Set(['text', 'reasoning', 'tool-call', 'tool-addition', 'tool-removal'])
  const messages = (request['messages'] ?? []) as Array<{ role?: string; content?: Array<{ type?: string }>; [key: string]: unknown }>
  // Attachment handles are not the image/file input itself. Without native
  // per-media pricing, reserve the complete capacity rather than tiny JSON refs.
  const textOnly = Array.isArray(messages) && messages.every(message => Array.isArray(message.content) && message.content.every(block => textBlocks.has(block.type ?? '')))
  if (!textOnly) return ceiling
  // The native DeepSeek serializer omits local message ids and non-assistant sources.
  // source.entries retains the complete skill catalog for native discovery and
  // deduplication even when its model-facing text is small. Reserve only the
  // fields that can reach this known route. Assistant source.replayState can
  // supply native thinking signatures, so retain its entire source envelope.
  // Content, tool-call ids, tool history and unknown fields stay intact.
  // Both verified adapters register through registerDeepSeekProvider and use
  // the same serializer; account authentication does not serialize provenance.
  const visible = request['provider'] === 'deepseek-official' || request['provider'] === 'deepseek-account'
    ? messages.map(({ id: _localId, source, ...message }) => message.role === 'assistant' && source !== undefined ? { ...message, source } : message) : messages
  return Math.min(bytes(visible), ceiling)
}

function usageTotal(usage: Record<string, unknown>): number | undefined {
  if (typeof usage['totalTokens'] === 'number' && Number.isSafeInteger(usage['totalTokens']) && usage['totalTokens'] >= 0) return usage['totalTokens']
  if (typeof usage['inputTokens'] !== 'number' || typeof usage['outputTokens'] !== 'number') return undefined
  return Number(usage['inputTokens']) + Number(usage['outputTokens']) + Number(usage['cacheReadTokens'] ?? 0) + Number(usage['cacheWriteTokens'] ?? 0)
}

export function installRuntimeControls(ctx: ControlContext, options: {
  budgets: TaskBudgets
  appliesTo?: (agent: RuntimeAgent) => boolean
  contextTokens?: number
  literatureScope?(agent: RuntimeAgent): LiteratureScope | undefined
  redirectReminder?(agent: RuntimeAgent, message: RuntimeMessage): Promise<void>
}) {
  const budgets = options.budgets
  const disposers: Array<() => void> = []
  const compactors = new Set<NativeCompactor>()
  const observedPolicies = new Map<string, Record<string, unknown>>()
  const applies = (agent: RuntimeAgent | undefined): agent is RuntimeAgent => agent !== undefined && (options.appliesTo?.(agent) ?? true)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const deadlines = new Map<RuntimeAgent, { taskId: string; timer: ReturnType<typeof setTimeout> }>()
  const nativeReminders = new WeakSet<RuntimeAgent>()
  const scopedSummaries = new WeakSet<NativeCompactor>()
  const scopedCompaction = new WeakSet<NativeCompactor>()
  const finalRequests = new Map<string, string>()
  const claimedInputs = new Map<string, Map<string, RuntimeMessage>>()
  const literatureResults = new LiteratureResults()
  const compactionTasks = new Map<string, { sessionId: string; taskId: string }>()
  const inputReservations = new Map<string, { taskId?: string; inputUpperBound: number; requestedOutput: number; nativeContext?: NativeInputContext }>()
  const registry = () => ctx.get('agents', false) as Registry | undefined
  function rootOf(agent: RuntimeAgent): RuntimeAgent {
    const service = registry()
    const seen = new Set<RuntimeAgent>()
    while (!seen.has(agent)) {
      seen.add(agent)
      const parent = service?.list?.().find(candidate => service?.isOwnedBy?.(agent.id, candidate))
      if (parent === undefined) break
      agent = parent
    }
    return agent
  }
  const isReminder = (agent: RuntimeAgent) => rootOf(agent).id.startsWith(REMINDER_SESSION_PREFIX)
  function estimatedInput(agent: RuntimeAgent): number {
    const session = agent.session, header = session.requestHeader?.(), root = rootOf(agent)
    if (header && session.surface && session.eventAt && session.deriveEventMessage) {
      const messages = session.surface.nodes.map(seq => session.deriveEventMessage!(session.eventAt!(seq))).filter(Boolean)
      const present = new Set(messages.map(message => message.id))
      for (const [id, message] of claimedInputs.get(agent.id) ?? []) {
        if (present.has(id)) claimedInputs.get(agent.id)!.delete(id)
        else messages.push({ ...message, role: 'user' })
      }
      return reserveInput({ ...header.config, maxTokens: header.config?.maxTokens ?? 8192, messages,
        system: header.system, tools: header.tools, toolHistory: session.toolHistory?.() }, session.requestContext?.())
    }
    const last = inputReservations.get(root.id)
    const pending = [...(claimedInputs.get(agent.id)?.values() ?? [])]
    return (last?.taskId === budgets.status(root.id)?.taskId ? last?.inputUpperBound ?? 0 : 0)
      + (pending.length ? reserveInput({ messages: pending }) : 0)
  }
  function planning(agent: RuntimeAgent): BudgetPlan | undefined {
    if (!applies(agent)) return undefined
    const state = budgets.status(rootOf(agent).id)
    return state && planBudget(state, budgets.limitsFor(state.kind), estimatedInput(agent))
  }
  const contextTarget = (agent: RuntimeAgent, capacity: number) => Math.min(options.contextTokens ?? 64_000, capacity * .5,
    planning(agent)?.inputTarget ?? Math.max(1, Math.floor(budgets.limitsFor(isReminder(agent) ? 'reminder' : 'normal').maxTokens / 8)))
  const add = (name: string, listener: (...args: any[]) => any) => disposers.push(ctx.on(name, listener, { prepend: true, global: true }))

  function projectHistory(agent: RuntimeAgent): void {
    const presets = ctx.get('agentPresets', false) as { serviceFor?(agent: RuntimeAgent, name: string): unknown } | undefined
    const meter = (presets?.serviceFor?.(agent, 'tokenMeter') ?? agent.ctx?.get?.('tokenMeter', false)) as { estimateMessage?(message: unknown): number } | undefined
    if (typeof meter?.estimateMessage !== 'function') return
    const estimate = (message: unknown) => meter.estimateMessage!(message)
    compactOverviewHistory(agent.session, estimate)
    const scope = options.literatureScope?.(agent)
    if (scope) compactLiteratureHistory(agent.session, literatureResults, scope, estimate)
  }

  // Native claim precedes prompt assembly; new input must not inherit an old stop.
  add('agent/inbox/claimed', ({ agent, message }: { agent: RuntimeAgent; message: RuntimeMessage }) => {
    if (!applies(agent)) return
    const root = rootOf(agent)
    if (message.id && (message.source?.kind === 'user' || message.source?.kind === 'schedule')) {
      if (claimedInputs.size >= 128 && !claimedInputs.has(agent.id)) claimedInputs.delete(claimedInputs.keys().next().value!)
      const pending = claimedInputs.get(agent.id) ?? new Map<string, RuntimeMessage>()
      pending.set(message.id, message); claimedInputs.set(agent.id, pending)
    }
    if (agent === root && message.source?.kind === 'user') budgets.begin(root.id, { humanMessageId: message.id })
    else if (isReminder(agent) && message.source?.kind === 'schedule') budgets.begin(root.id, { scheduleMessageId: message.id })
  })

  function scopeAutomaticCompaction(service: NativeCompactor): void {
    const original = service.compactIfNeeded
    if (scopedCompaction.has(service) || typeof original !== 'function') return
    const wrapped = function (this: NativeCompactor, agent: RuntimeAgent, ...args: any[]) {
      if (!applies(agent)) return original.call(this, agent, ...args)
      if (planning(agent)?.allowSummary === false) return Promise.resolve(null)
      const receiver = Object.create(this) as NativeCompactor
      Object.defineProperty(receiver, 'config', { value: scopedPolicy(this.config, agent) })
      return original.call(receiver, agent, ...args)
    }
    service.compactIfNeeded = wrapped; scopedCompaction.add(service)
    disposers.push(() => { if (service.compactIfNeeded === wrapped) service.compactIfNeeded = original })
  }

  // The native basic summarizer's public hook reads config and ctx from its
  // receiver. An invocation-local receiver avoids races in shared presets,
  // including when summarization yields before reading its configuration.
  function scopeSummaryOutput(service: NativeCompactor): void {
    if (scopedSummaries.has(service) || typeof service.summarize !== 'function') return
    const original = service.summarize
    const wrapped = function (this: NativeCompactor, input: unknown, agent: RuntimeAgent, signal?: AbortSignal) {
      if (!applies(agent)) return original.call(this, input, agent, signal)
      const capacity = agent.session.requestContext?.()?.contextWindow ?? 1000000
      const cap = Math.min(isReminder(agent) ? 1024 : 8192, Math.floor(capacity / 8), Math.max(1, Math.floor(contextTarget(agent, capacity) / 4)))
      const config = scopedPolicy(this.config, agent)
      const receiver = Object.create(this) as NativeCompactor
      Object.defineProperty(receiver, 'config', { value: { ...config, maxTokens: cap,
        modelPolicies: (config['modelPolicies'] as Record<string, unknown>[] ?? []).map(policy => ({ ...policy, maxTokens: cap })) } })
      // The native summary call omits reasoningEffort, which lets DeepSeek's
      // provider default spend the output allowance on thinking. Scope the
      // public LLM call to this summary; main requests and shared ctx stay intact.
      const nativeContext = this.ctx, llm = nativeContext?.llm
      if (nativeContext && typeof llm?.stream === 'function') {
        const context = Object.create(nativeContext) as NonNullable<NativeCompactor['ctx']>
        Object.defineProperty(context, 'llm', { value: { stream(request: Record<string, unknown>) {
          if (request['purpose'] !== 'compaction') return llm.stream(request)
          const messages = request['messages'] as Array<{ content?: unknown[] }> | undefined
          const last = messages?.at(-1)
          const target = Math.max(1, Math.floor(cap * .75))
          const note = { type: 'text', text: `Checkpoint output budget: aim for at most ${target} tokens of concise checkpoint text. Use compact tables or short lists for repeated facts. Preserve required identifiers and paths; omit inert raw telemetry and repeated wording. Do not add a reasoning preamble.` }
          return llm.stream({ ...request, reasoningEffort: 'off', ...(last === undefined ? {} : {
            messages: [...messages!.slice(0, -1), { ...last, content: [...(last.content ?? []), note] }],
          }) })
        } } })
        Object.defineProperty(receiver, 'ctx', { value: context })
      }
      return original.call(receiver, input, agent, signal)
    }
    service.summarize = wrapped; scopedSummaries.add(service)
    disposers.push(() => { if (service.summarize === wrapped) service.summarize = original })
  }

  add('session/event', (session: { id: string }, event: { type: string; data?: { compactionId?: string; error?: unknown } }) => {
    if (!event.type.startsWith('compaction/')) return
    const agent = registry()?.list?.().find(candidate => (candidate.session.id ?? candidate.id) === session.id)
    if (!applies(agent)) return
    const id = event.data?.compactionId
    if (!id) return
    if (event.type === 'compaction/start') {
      const root = rootOf(agent), task = budgets.status(root.id) ?? budgets.begin(root.id, {})
      compactionTasks.set(id, { sessionId: root.id, taskId: task.taskId })
    } else if (event.type === 'compaction/end') {
      const owner = compactionTasks.get(id); compactionTasks.delete(id)
      if (owner && event.data?.error !== undefined && !String(event.data.error).includes('[COMPACTION_DEFERRED]')) {
        budgets.halt(owner.sessionId, `[COMPACTION_FAILED] 上下文压缩失败，本任务停止，避免后续步骤重复压缩：${String(event.data.error).slice(0, 800)}`, owner.taskId)
      }
    }
  })

  function reminderTools(agent: RuntimeAgent): void {
    if (nativeReminders.has(agent) || !isReminder(agent)) return
    const tools = agent.ctx?.get?.('tools', false) as { presentAs?(mode: 'native'): () => void } | undefined
    if (!tools?.presentAs) return
    const dispose = tools.presentAs('native')
    disposers.push(dispose)
    nativeReminders.add(agent)
  }

  add('system-prompt/assemble', async (_assembly: unknown, context: { agent?: RuntimeAgent }, next: () => any) => {
    if (!applies(context.agent)) return next()
    if (context.agent) { reminderTools(context.agent); projectHistory(context.agent) }
    const assembly = await next()
    if (!context.agent) return assembly
    const plan = planning(context.agent), root = rootOf(context.agent)
    if (plan) {
      if (plan.finalize) finalRequests.set(context.agent.id, budgets.status(root.id)!.taskId)
      else finalRequests.delete(context.agent.id)
    }
    const planned = plan ? { ...assembly, ...(plan.finalize ? { tools: [] } : {}),
      contexts: [...(assembly.contexts ?? []), { name: plan.finalize ? 'butler:budget-final' : 'butler:budget', text: plan.notice }] } : assembly
    if (!isReminder(context.agent) || plan?.finalize) return planned
    const tools = context.agent.ctx?.get?.('tools', false) as { schemas?(scope: RuntimeAgent): Array<{ name: string }> } | undefined
    const schemas = tools?.schemas?.(context.agent) ?? assembly.tools
    return { ...planned, tools: schemas.filter((tool: { name: string }) => REMINDER_TOOLS.has(tool.name)) }
  })
  function armDeadline(agent: RuntimeAgent, root: RuntimeAgent): void {
    if (!applies(agent)) return
    const state = budgets.status(root.id)!
    const old = deadlines.get(agent)
    if (old?.taskId === state.taskId) return
    if (old) { clearTimeout(old.timer); timers.delete(old.timer) }
    const timer = setTimeout(() => {
      timers.delete(timer)
      deadlines.delete(agent)
      if (applies(agent) && budgets.status(root.id)?.taskId === state.taskId) {
        agent.cancel?.({ kind: 'hook', reason: new BudgetExceeded('time 时长预算已用尽', budgets.status(root.id)!).message }, { keepInbox: true })
      }
    }, Math.max(1, budgets.remainingMs(root.id)))
    timer.unref?.()
    timers.add(timer)
    deadlines.set(agent, { taskId: state.taskId, timer })
  }

  /** Configure the actual agent/preset-scoped instance, preserving unrelated model policies. */
  function compactPolicy(agent: RuntimeAgent): void {
    if (!applies(agent)) return
    // Preset groups isolate compaction below agent.ctx. The registry is the
    // runtime's supported bridge into that retained preset revision.
    const presets = ctx.get('agentPresets', false) as { serviceFor?(agent: RuntimeAgent, name: string): unknown } | undefined
    const proxy = (presets?.serviceFor?.(agent, 'compaction') ?? agent.ctx?.get?.('compaction', false)) as NativeCompactor | undefined
    // Cordis returns fresh caller-context proxies. Preserve the native engine's
    // own injected ctx and use one stable identity for policy/wrapper cleanup.
    const service = (proxy as (NativeCompactor & { [key: symbol]: NativeCompactor }) | undefined)?.[Symbol.for('cordis.original')] ?? proxy
    if (!service?.config) return
    scopeSummaryOutput(service)
    scopeAutomaticCompaction(service)
    compactors.add(service)
  }

  function scopedPolicy(old: Record<string, unknown>, agent: RuntimeAgent): Record<string, unknown> {
    const context = agent.session.requestContext?.()
    const route = context?.provider && context.model ? context : agent.session.requestHeader?.()?.config
    if (!route?.provider || !route.model) return old
    const capacity = context?.contextWindow ?? 1_000_000
    const policies = (Array.isArray(old['modelPolicies']) ? old['modelPolicies'] : []) as Record<string, unknown>[]
    const existing = policies.find(p => p['provider'] === route.provider && p['model'] === route.model)
    const baseline = old
    const baselinePolicies = (Array.isArray(baseline['modelPolicies']) ? baseline['modelPolicies'] : []) as Record<string, unknown>[]
    const basePolicy = baselinePolicies.find(p => p['provider'] === route.provider && p['model'] === route.model)
    const target = contextTarget(agent, capacity)
    const thresholdRatio = Math.min(Number(basePolicy?.['thresholdRatio'] ?? baseline['thresholdRatio'] ?? .8), target / capacity)
    const headroomTokens = Math.min(Number(basePolicy?.['headroomTokens'] ?? baseline['headroomTokens'] ?? 65536), 4096, Math.floor(capacity / 8))
    const outputReserve = Math.min(8192, Math.floor(capacity / 4))
    const pressure = Math.min(capacity * thresholdRatio, capacity - outputReserve - headroomTokens)
    const policy = {
      ...existing, provider: route.provider, model: route.model,
      thresholdRatio,
      retainTokens: Math.min(Number(basePolicy?.['retainTokens'] ?? 12_000), 12_000, Math.max(1, Math.floor(pressure / 2))),
      headroomTokens,
      // Full ordinary checkpoints need room; reminder calls retain their own
      // smaller cap through the invocation-scoped native summarizer above.
      maxTokens: Math.min(8192, Math.floor(capacity / 8), Math.max(1, Math.floor(target / 4))), compactionRetries: 0,
    }
    delete (policy as Record<string, unknown>)['retainRatio']
    observedPolicies.set(agent.id, policy)
    if (existing && JSON.stringify(existing) === JSON.stringify(policy)) return old
    const next = { ...old, modelPolicies: [...policies.filter(p => p !== existing), policy] }
    return next
  }

  add('agent/created', ({ agent }: { agent: RuntimeAgent }) => compactPolicy(agent))
  for (const agent of registry()?.list?.() ?? []) {
    if (!applies(agent)) continue
    compactPolicy(agent)
    const root = rootOf(agent)
    if (budgets.status(root.id)) armDeadline(agent, root)
  }

  add('agent/pre-step', async (payload: { agent: RuntimeAgent; messages: RuntimeMessage[]; step: number }, next: () => any) => {
    const { agent } = payload
    if (!applies(agent)) return next()
    const diverted = new Set<string | undefined>()
    if (!isReminder(agent)) {
      const scheduled = payload.messages.filter(message => message.source?.kind === 'schedule')
      if (scheduled.length > 0) {
        if (!options.redirectReminder) throw new Error('提醒隔离服务不可用，拒绝在开发会话执行提醒')
        for (const message of scheduled) await options.redirectReminder(agent, message)
        for (const message of scheduled) diverted.add(message.id)
        // The real Cordis waterfall does not accept replacement arguments to next().
        // This payload is a fresh mutable event envelope, distinct from logged messages.
        payload.messages = payload.messages.filter(message => !scheduled.includes(message))
        if (payload.messages.length === 0) return { kind: 'reject' }
      }
    }
    const root = rootOf(agent)
    const human = agent === root ? payload.messages.findLast(message => message.source?.kind === 'user') : undefined
    const schedule = isReminder(agent) ? payload.messages.findLast(message => message.source?.kind === 'schedule') : undefined
    budgets.begin(root.id, { humanMessageId: human?.id, scheduleMessageId: schedule?.id })
    budgets.check(root.id)
    projectHistory(agent)
    armDeadline(agent, root)
    compactPolicy(agent)
    const decision = await next()
    // Native automatic compaction catches its error and continues next().
    // Recheck the durable failure latch before admitting a main request.
    budgets.check(root.id)
    if (decision.kind === 'reject') return decision
    const messages = decision.messages.filter((message: RuntimeMessage) => !diverted.has(message.id))
    if (isReminder(agent) && (payload.step === 1 || schedule)) {
      messages.push({ id: randomUUID(), role: 'user', source: { kind: 'runtime-context', form: 'notice' },
        content: [{ type: 'text', text: '本轮只执行本条定时提醒。不得接续其他会话的开发目标，不修代码、不重建插件、不创建子任务或新提醒。最多 5 次模型请求；需要更长工作时报告现有结果和下一步。' }] })
    }
    return { ...decision, messages }
  })

  add('agent/request', async ({ agent }: { agent: RuntimeAgent }, next: () => Promise<Record<string, unknown>>) => {
    if (!applies(agent)) return next()
    const config = await next()
    const root = rootOf(agent)
    budgets.check(root.id)
    const max = Math.min(isReminder(agent) ? 1024 : 8192, Math.floor((agent.session.requestContext?.()?.contextWindow ?? 1000000) / 4))
    return { ...config, maxTokens: Math.min(Number(config['maxTokens'] ?? max), max) }
  })

  add('llm/stream', (request: Record<string, unknown>, next: () => AsyncIterable<Record<string, unknown>>) => {
    const agent = registry()?.currentInitiator?.() ?? (typeof request['sessionId'] === 'string'
      ? registry()?.list?.().find(a => a.id === request['sessionId']) : undefined)
    if (!applies(agent)) return next() // Standalone service probes are outside an agent task.
    const root = rootOf(agent)
    return (async function* () {
      const requested = request['maxTokens']
      if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested <= 0) {
        throw new Error('预算要求模型调用显式声明 maxTokens；拒绝使用未知的适配器默认值')
      }
      const nativeContext = agent.session.requestContext?.()
      const inputUpperBound = reserveInput(request, nativeContext)
      if (inputReservations.size >= 128 && !inputReservations.has(root.id)) inputReservations.delete(inputReservations.keys().next().value!)
      const state = budgets.status(root.id), limits = budgets.limitsFor(state?.kind ?? (isReminder(agent) ? 'reminder' : 'normal'))
      if (request['purpose'] === 'compaction' && state && !state.blocked) {
        const remainingTokens = limits.maxTokens - state.tokens - state.reservedTokens
        const answerReserve = estimatedInput(agent) + limits.maxOutputTokens + 4096
        if (limits.maxRequests - state.requests < 3 || inputUpperBound + requested + answerReserve > remainingTokens) {
          throw new Error('[COMPACTION_DEFERRED] 摘要将占用最终答复的请求或输入输出额度；保留原有上下文，跳过可选摘要。')
        }
      }
      inputReservations.set(root.id, { taskId: state?.taskId, inputUpperBound, requestedOutput: requested, nativeContext })
      const lease = budgets.admit(root.id, inputUpperBound, requested, { requireFullOutput: true })
      if (lease.maxOutputTokens !== requested) {
        budgets.finish(lease, 0)
        throw new BudgetExceeded('token 预算不足，或请求输出超过任务上限', budgets.status(root.id)!)
      }
      let total: number | undefined
      armDeadline(agent, root)
      try {
        for await (const chunk of next()) {
          if (chunk['type'] === 'usage' && chunk['usage'] !== null && typeof chunk['usage'] === 'object') total = usageTotal(chunk['usage'] as Record<string, unknown>)
          yield chunk
        }
      } finally {
        budgets.finish(lease, total)
      }
    })()
  })

  add('tools/pre-execute', async (exec: { agent?: RuntimeAgent; name: string }, next: () => any) => {
    if (!applies(exec.agent)) return next()
    const root = rootOf(exec.agent)
    try { budgets.check(root.id) } catch (error) { return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) } }
    if (finalRequests.get(exec.agent.id) === budgets.status(root.id)?.taskId) return { kind: 'deny', reason: '[BUDGET_FINAL_ANSWER] 当前请求仅用于最终答复，工具未执行。请用现有证据如实报告结果和限制。' }
    if (isReminder(exec.agent) && !REMINDER_TOOLS.has(exec.name)) {
      return { kind: 'deny', reason: `[REMINDER_ISOLATION tool=${exec.name}] 提醒会话只允许读取和查询，不能修改代码、运行程序、派生任务或新建提醒。` }
    }
    return next()
  })

  add('tools/post-execute', async (exec: { agent?: RuntimeAgent; name: string; id?: string; callId?: string }, result: { isError?: boolean; value?: { ok?: boolean }; content?: Array<{ type: string; text?: string }> }, next: () => any) => {
    if (!applies(exec.agent)) return next()
    const failed = result.isError === true || result.value?.ok === false
    if (exec.agent) budgets.observeTool(rootOf(exec.agent).id, exec.name, !failed)
    const decision = await next()
    if (!failed || decision.kind === 'block') return decision
    const identity = `[tool=${exec.name} call=${exec.id ?? exec.callId ?? 'unavailable'}]`
    const { value: _value, content: _content, ...preserved } = decision
    return { ...preserved, content: [{ type: 'text', text: `${identity}\n${(decision.content ?? result.content ?? []).map((b: { text?: string }) => b.text ?? '').join('\n')}` }] }
  })

  add('agent/request-error', (payload: { agent: RuntimeAgent; failure?: { message?: string } }, next: () => any) => {
    if (!applies(payload.agent)) return next()
    if (payload.failure?.message?.includes('BUDGET_EXCEEDED')) return undefined
    try { budgets.check(rootOf(payload.agent).id) } catch { return undefined }
    return next()
  })

  return {
    status: () => {
      const agents = registry()?.list?.() ?? []
      const roots = new Set(agents.filter(applies).map(agent => rootOf(agent).id))
      const budgetReports = options.appliesTo ? budgets.reports().filter(report => roots.has(report.sessionId)) : budgets.reports()
      return { version: '2026-10-15', active: true, contextTokens: options.contextTokens ?? 64_000,
      taskBudgets: budgetReports.map(({ limits: _limits, remaining: _remaining, inFlight: _inFlight, ...state }) => state),
      budgetReports, configuredCompactors: compactors.size,
      plans: (registry()?.list?.() ?? []).flatMap(agent => { const plan = planning(agent); return plan ? [{ sessionId: agent.id, ...plan }] : [] }),
      inputReservationMethod: 'native-context-ceiling-or-conservative-visible-utf8',
      inputReservations: [...inputReservations].filter(([id]) => !options.appliesTo || roots.has(id)).map(([sessionId, value]) => ({ sessionId, ...value })),
      compactionPolicies: [...observedPolicies].filter(([id]) => applies(agents.find(agent => agent.id === id))).map(([, policy]) => ({
        provider: policy['provider'], model: policy['model'], thresholdRatio: policy['thresholdRatio'], retainTokens: policy['retainTokens'], maxTokens: policy['maxTokens'],
      })),
      hooks: ['system-prompt/assemble', 'agent/inbox/claimed', 'agent/created', 'agent/pre-step', 'agent/request', 'llm/stream', 'tools/pre-execute', 'tools/post-execute', 'agent/request-error'] }
    },
    stop() {
      for (const dispose of disposers.reverse()) dispose()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      deadlines.clear()
      inputReservations.clear()
      finalRequests.clear()
      claimedInputs.clear()
      observedPolicies.clear()
      compactors.clear()
    },
  }
}

/** Keep the plugin active and deny execution if its persisted accounting cannot be trusted. */
export function installBudgetFailure(ctx: ControlContext, error: unknown, options: { appliesTo?: (agent: RuntimeAgent) => boolean } = {}) {
  const reason = `[BUDGET_STORAGE_UNAVAILABLE] ${error instanceof Error ? error.message : String(error)}`
  const agentFor = (value: { agent?: RuntimeAgent; sessionId?: unknown }) => value.agent ?? (() => {
    const registry = ctx.get('agents', false) as Registry | undefined
    return registry?.currentInitiator?.() ?? registry?.list?.().find(agent => (agent.session.id ?? agent.id) === value.sessionId)
  })()
  const applies = (value: { agent?: RuntimeAgent; sessionId?: unknown }) => {
    const agent = agentFor(value)
    return agent !== undefined && (options.appliesTo?.(agent) ?? true)
  }
  const block = (value: { agent?: RuntimeAgent; sessionId?: unknown }, next: () => unknown) => { if (!applies(value)) return next(); throw new Error(reason) }
  const blockAgent = (value: { agent?: RuntimeAgent }, next: () => unknown) => value.agent ? block(value, next) : next()
  const dispose = [
    ctx.on('agent/pre-step', blockAgent, { prepend: true, global: true }),
    ctx.on('llm/stream', block, { prepend: true, global: true }),
    ctx.on('tools/pre-execute', (exec: { agent?: RuntimeAgent }, next: () => unknown) => exec.agent && applies(exec) ? ({ kind: 'deny', reason }) : next(), { prepend: true, global: true }),
  ]
  return {
    status: () => ({ version: '2026-10-15', active: true, blocked: true, error: reason, taskBudgets: [] }),
    stop: () => { for (const fn of dispose.reverse()) fn() },
  }
}
