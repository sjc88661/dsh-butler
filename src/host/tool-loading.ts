/** Bounded model-facing tool discovery; real registration and execution stay native. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defineTool, type JsonSchema, type ToolDefinition } from './tool-spec.ts'
import { demandPromptSections } from './prompt-loading.ts'

const DISCOVERY = 'butler_tools'
const BASE = new Set([DISCOVERY, 'ask_user_question', 'butler_skills', 'butler_overview'])
const READ_ONLY = new Set([DISCOVERY, 'read', 'grep', 'glob', 'web_search', 'web_fetch', 'butler_literature'])
const CORE_FALLBACK = ['butler_task', 'butler_remember', 'butler_approve', 'butler_literature', 'butler_pdf', 'butler_note', 'butler_remind', 'butler_pack']
interface Schema { name: string; description: string; parameters: JsonSchema; deferLoading?: boolean }
interface Input { id?: string; source?: { kind?: string } }
interface Header { tools?: Schema[]; [key: string]: unknown }
interface Agent { id: string; ctx?: { get?(name: string, strict?: boolean): unknown };
  session?: { snapshotEvents?(): Array<{ type: string; data: any }>; requestHeader?(): Header | undefined;
    toolHistory?(): { tools: Schema[]; updates?: unknown[] }; append?(type: string, data: unknown): unknown } }
interface Compactor {
  compactIfNeeded?: (agent: Agent, ...args: any[]) => any
  compactNow?: (agent: Agent, ...args: any[]) => any
}
interface Tools { register(tool: ToolDefinition): () => void; schemas(agent: Agent): Schema[]; get?(name: string, agent?: Agent): unknown; modeFor?(agent: Agent): string }
interface Context {
  get(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
  logger?: { warn?(message: string, ...args: unknown[]): void }
}
interface Choice { origin?: string; names: string[] }

function inputOrigin(message: Input): string | undefined {
  const kind = message.source?.kind
  return message.id && (kind === 'user' || kind === 'schedule') ? `${kind}:${message.id}` : undefined
}

/** Recover this agent's claimed input, including the claim-before-user/message window. */
function persistedOrigin(agent: Agent): string | undefined {
  const pending: Record<string, Input[]> = { 'next-turn': [], 'next-step': [] }
  let claimed: string | undefined, committed: string | undefined
  for (const event of agent.session?.snapshotEvents?.() ?? []) {
    if (event.type === 'user/message') committed = inputOrigin(event.data) ?? committed
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data, queue = pending[data.target]
    if (!queue) continue
    const removed = queue.splice(data.start, data.removedCount ?? 0, ...data.inserted.map((message: Input) => ({ id: message.id, source: message.source })))
    // Native claim removes input without a cancellation outcome. Merely queued
    // or cancelled input must not change the active task's tool selection.
    if (data.outcome === undefined) for (const message of removed) claimed = inputOrigin(message) ?? claimed
  }
  return claimed ?? committed
}

class Choices {
  private memory = new Map<string, Choice>()
  private file?: string
  constructor(file?: string) { this.file = file }
  read(): Map<string, Choice> {
    if (!this.file || !existsSync(this.file)) return this.memory
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as { version: number; scopes: Record<string, Choice> }
    if (data.version !== 1 || !data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) throw new Error('invalid tool selection storage')
    for (const entry of Object.values(data.scopes)) {
      if (!entry || !Array.isArray(entry.names) || entry.names.length > 100 || !entry.names.every(name => typeof name === 'string')
        || (entry.origin !== undefined && typeof entry.origin !== 'string')) throw new Error('invalid tool selection')
    }
    return new Map(Object.entries(data.scopes))
  }
  update(id: string, change: (current: Choice) => Choice): Choice {
    const all = this.read(), next = change(all.get(id) ?? { names: [] })
    all.set(id, next)
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, scopes: Object.fromEntries(all) }) + '\n', { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.file)
    }
    this.memory = all
    return next
  }
}

const ALIASES: Array<[string, string]> = [['文件', 'file'], ['搜索', 'search'], ['查找', 'search'], ['网页', 'web'], ['浏览器', 'browser'],
  ['反编译', 'decompile'], ['函数', 'function'], ['调试', 'debug'], ['插件', 'plugin'], ['文献', 'literature'], ['提醒', 'remind'], ['笔记', 'note'], ['技能', 'skill'], ['任务', 'task']]
function score(tool: Schema, query: string): number {
  const name = tool.name.toLowerCase(), description = tool.description.toLowerCase()
  let expanded = query.toLowerCase().trim()
  for (const [original, alias] of ALIASES) if (expanded.includes(original)) expanded += ` ${alias}`
  const words = [...new Set(expanded.match(/[\p{L}\p{N}_-]+/gu) ?? [])]
  let value = name === expanded ? 1000 : name.includes(expanded) ? 400 : 0
  for (const word of words) value += name.includes(word) ? 50 : description.includes(word) ? 10 : 0
  return value
}

export function installToolLoading(ctx: Context, options: { file?: string; maxExtraTools?: number; maxExtraBytes?: number; appliesTo?(agent: Agent): boolean;
  /** Independently persisted task origin prevents stale choices after a failed reset and reload. */
  originFor?(agent: Agent): string | undefined } = {}) {
  const maxExtraTools = options.maxExtraTools ?? 8, maxExtraBytes = options.maxExtraBytes ?? 24_000
  const choices = new Choices(options.file)
  const claimedOrigins = new Map<string, string>()
  const restoredOrigins = new WeakMap<Agent, string | undefined>()
  const dispose: Array<() => void> = []
  const observed = new Map<string, Record<string, unknown>>()
  const exposed = new Map<string, { origin?: string; names: Set<string> }>()
  const wrappedCompactors = new WeakSet<object>()
  let error: string | undefined, registered = false
  const rootTools = ctx.get('tools', false) as Tools | undefined
  const appliesTo = (agent: Agent) => options.appliesTo?.(agent) ?? true
  function originFor(agent: Agent): string | undefined {
    const active = claimedOrigins.get(agent.id) ?? options.originFor?.(agent)
    if (active !== undefined) return active
    if (!restoredOrigins.has(agent)) restoredOrigins.set(agent, persistedOrigin(agent))
    return restoredOrigins.get(agent)
  }
  function toolsFor(agent: Agent): Tools | undefined { return (agent.ctx?.get?.('tools', false) ?? rootTools) as Tools | undefined }
  function reminder(agent: Agent): boolean {
    const agents = ctx.get('agents', false) as { list?(): Agent[]; isOwnedBy?(id: string, owner: Agent): boolean } | undefined
    const seen = new Set<Agent>()
    while (!seen.has(agent)) {
      seen.add(agent)
      const parent = agents?.list?.().find(candidate => agents.isOwnedBy?.(agent.id, candidate))
      if (!parent) break
      agent = parent
    }
    return agent.id.startsWith('session-butler-reminder-')
  }
  function available(agent: Agent): Schema[] {
    const schemas = toolsFor(agent)?.schemas(agent) ?? []
    return schemas.filter(tool => !reminder(agent) || READ_ONLY.has(tool.name))
  }
  function base(agent: Agent): Set<string> { return reminder(agent) ? new Set([DISCOVERY]) : BASE }
  function legacyHeader(agent: Agent, schemas: Schema[]): boolean {
    const header = agent.session?.requestHeader?.()
    if (!header) return false
    const initial = agent.session?.toolHistory?.()?.tools ?? []
    const limit = base(agent).size + maxExtraTools
    const baseBytes = Buffer.byteLength(JSON.stringify(schemas.filter(tool => base(agent).has(tool.name))))
    return [header.tools ?? [], initial].some(tools => tools.length > limit
      || Buffer.byteLength(JSON.stringify(tools)) > baseBytes + maxExtraBytes)
  }
  /** Append a new native declaration series; never rewrite historical events or registrations. */
  function rebaseHeader(agent: Agent, tools: Schema[], checkLegacy = true): boolean {
    const session = agent.session, header = session?.requestHeader?.(), history = session?.toolHistory?.()
    // Native projection marks every addition after the series baseline deferred.
    // Resuming after a no-tools final answer can therefore produce an illegal
    // all-deferred request, even though the current schemas are not deferred.
    // Start a supported series before the loop logs additions (also repairs a
    // failed restored run whose additions are already persisted).
    // Addition-only routes also drop baseline declarations absent from current
    // tools (for example native -> PTC). An immediate tool must survive that filter.
    const names = new Set(tools.map(tool => tool.name))
    const missingBaseline = history && !history.tools.some(tool => tool.deferLoading !== true && (!tools.length || names.has(tool.name)))
      && (tools.length > 0 || history.tools.length > 0 || (history.updates?.length ?? 0) > 0)
    if (!session || !header || (!missingBaseline && (!checkLegacy || !legacyHeader(agent, tools)))) return false
    if (tools.length > 0 && tools.every(tool => tool.deferLoading === true)) throw new Error('[BUTLER_TOOL_BASELINE] 当前目录没有可立即使用的工具，无法建立有效声明基线')
    if (!session.append) throw new Error('无法持久更新工具声明基线，拒绝发送无效工具目录')
    const { tools: _previousTools, ...envelope } = header
    session.append('request/header', { header: { ...envelope, ...(tools.length ? { tools } : {}) }, reason: 'series' })
    return true
  }
  /** Manual compression can bypass prompt assembly; refresh before its native pressure read too. */
  function prepareCompactor(agent: Agent): void {
    if (!appliesTo(agent)) return
    const presets = ctx.get('agentPresets', false) as { serviceFor?(agent: Agent, name: string): Compactor } | undefined
    const proxy = presets?.serviceFor?.(agent, 'compaction') ?? agent.ctx?.get?.('compaction', false)
    const service = ((proxy as Record<symbol, unknown> | undefined)?.[Symbol.for('cordis.original')] ?? proxy) as Compactor | undefined
    if (!service || wrappedCompactors.has(service)) return
    wrappedCompactors.add(service)
    for (const method of ['compactIfNeeded', 'compactNow'] as const) {
      const original = service[method]
      if (typeof original !== 'function') continue
      const wrapped = function (this: unknown, owner: Agent, ...args: any[]) {
        if (!appliesTo(owner)) return original.call(this, owner, ...args)
        if (toolsFor(owner)?.modeFor?.(owner) === 'ptc' || !legacyHeader(owner, available(owner))) return original.call(this, owner, ...args)
        const signal = method === 'compactNow' ? args[0] : args[1]
        signal?.throwIfAborted?.()
        const prompt = ctx.get('systemPrompt', false) as { assemble?(context: { agent: Agent; scope: Agent; signal?: AbortSignal }): Promise<unknown> } | undefined
        if (!prompt?.assemble) throw new Error('无法装配按需工具目录，拒绝使用旧工具头压缩')
        return Promise.resolve(prompt.assemble({ agent: owner, scope: owner, ...(signal ? { signal } : {}) })).then(() => {
          signal?.throwIfAborted?.()
          return original.call(this, owner, ...args)
        })
      }
      service[method] = wrapped
      dispose.push(() => { if (service[method] === wrapped) service[method] = original })
    }
  }
  function failure(caught: unknown): string {
    const message = caught instanceof Error ? caught.message : String(caught)
    if (error !== message) ctx.logger?.warn?.('[dsh-butler] tool loading: %s', message)
    error = message
    return message
  }
  function selected(agent: Agent, schemas: Schema[]): string[] {
    try {
      const choice = choices.read().get(agent.id)
      const origin = originFor(agent)
      if (origin !== undefined && choice?.origin !== origin) return []
      const names = choice?.names ?? []
      const extras = names.filter(name => !base(agent).has(name) && schemas.some(tool => tool.name === name))
      if (extras.length > maxExtraTools || Buffer.byteLength(JSON.stringify(schemas.filter(tool => extras.includes(tool.name)))) > maxExtraBytes) throw new Error('stored tool selection exceeds current limits')
      return extras
    } catch (caught) { failure(caught); return [] }
  }

  const discovery = defineTool({
    name: DISCOVERY,
    description: '按需发现工具。先 search 用中英文关键词查少量名称和摘要，再 load 精确名称；下一次请求会提供完整参数。用 unload 释放不再需要的工具。加载不执行工具，也不批准操作。',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'load', 'unload'] },
      query: { type: 'string', description: 'search 的关键词，可用工具名称或英文能力词。' },
      names: { type: 'array', items: { type: 'string' }, description: 'load/unload 的精确工具名，每次最多4个。' },
      limit: { type: 'integer', description: 'search 结果数，1到8，默认6。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      try {
        const agent = (execution as { agent?: Agent } | undefined)?.agent
        if (!agent) throw new Error('工具发现必须在当前代理会话中调用')
        if (!appliesTo(agent)) throw new Error('工具发现仅供管家会话使用')
        if (toolsFor(agent)?.modeFor?.(agent) === 'ptc') throw new Error('当前会话使用原生PTC传输；请通过run_code使用工具')
        const schemas = available(agent)
        if (args['action'] === 'search') {
          const query = String(args['query'] ?? '').trim()
          if (!query || query.length > 300) throw new Error('search需要1到300字符的具体关键词')
          const limit = Number(args['limit'] ?? 6)
          if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('limit必须为1到8')
          const matches = schemas.map(tool => ({ tool, score: score(tool, query) })).filter(row => row.score > 0)
            .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, limit)
            .map(({ tool }) => ({ name: tool.name, description: tool.description.replace(/\s+/g, ' ').slice(0, 160) }))
          return { ok: true, matches, next: '需要时用load加载精确名称；尚未执行任何目标工具。' }
        }
        const names = args['names'] as string[] | undefined
        if (!names?.length || names.length > 4) throw new Error('每次需要1到4个精确工具名')
        if (names.some(name => !schemas.some(tool => tool.name === name))) throw new Error('工具不存在、当前作用域不可见或提醒不允许加载该工具')
        const current = selected(agent, schemas)
        const next = args['action'] === 'unload' ? current.filter(name => !names.includes(name))
          : [...new Set([...current, ...names.filter(name => !base(agent).has(name))])]
        if (next.length > maxExtraTools) throw new Error(`最多同时加载${maxExtraTools}个额外工具；先unload不再使用的工具`)
        if (Buffer.byteLength(JSON.stringify(schemas.filter(tool => next.includes(tool.name)))) > maxExtraBytes) throw new Error(`额外工具定义超过${maxExtraBytes}字节预算；请缩小选择`)
        choices.update(agent.id, prior => ({ ...prior, origin: originFor(agent) ?? prior.origin, names: next }))
        return { ok: true, loaded: next, next: '下一次模型请求包含已加载工具的完整原生参数；操作仍受原生权限和预算约束。' }
      } catch (caught) {
        return { ok: false, error: failure(caught), next: '未扩大工具目录；请修正名称、范围或存储问题后再试。' }
      }
    },
  })
  try {
    if (!rootTools?.register) throw new Error('native tool registry is unavailable')
    dispose.push(rootTools.register(discovery)); registered = true
  } catch (caught) { failure(caught) }

  dispose.push(ctx.on('agent/created', ({ agent }: { agent: Agent }) => prepareCompactor(agent), { prepend: true, global: true }))
  for (const agent of (ctx.get('agents', false) as { list?(): Agent[] } | undefined)?.list?.() ?? []) prepareCompactor(agent)

  // Inbox.claim emits synchronously BEFORE prompt assembly. pre-step is too late:
  // the first request of a new task would otherwise retain the previous schemas.
  dispose.push(ctx.on('agent/inbox/claimed', (payload: { agent: Agent; message: Input }) => {
    if (!appliesTo(payload.agent)) return
    const key = inputOrigin(payload.message)
    if (key === undefined) return
    claimedOrigins.set(payload.agent.id, key)
    try {
      if (choices.read().get(payload.agent.id)?.origin !== key) choices.update(payload.agent.id, () => ({ origin: key, names: [] }))
    } catch (caught) { failure(caught) }
  }, { prepend: true, global: true }))

  dispose.push(ctx.on('tools/pre-execute', async (execution: { agent?: Agent; name?: string }, next: () => any) => {
    // Keep native permission and reminder isolation decisions authoritative.
    const decision = await next(), agent = execution.agent, name = execution.name
    if (decision?.kind !== 'allow' || !agent || !appliesTo(agent) || !name?.startsWith('butler_') || BASE.has(name)) return decision
    const nativeTools = toolsFor(agent), visible = exposed.get(agent.id)
    if (!registered || !visible || nativeTools?.modeFor?.(agent) === 'ptc') return decision
    const schemas = nativeTools?.schemas(agent) ?? []
    if (!schemas.some(tool => tool.name === name) || !schemas.some(tool => tool.name === DISCOVERY)
      || (nativeTools?.get && nativeTools.get(DISCOVERY, agent) !== discovery)) return decision
    if (visible.origin === originFor(agent) && visible.names.has(name)) return decision
    return { kind: 'deny', reason: `[BUTLER_TOOL_NOT_LOADED tool=${name}] 当前模型请求未暴露该工具的完整参数；请先调用 butler_tools action=load names=["${name}"]，以下一次请求提供的 schema 和参数为准再调用。未自动加载或执行目标工具。` }
  }, { prepend: true, global: true }))

  dispose.push(ctx.on('system-prompt/assemble', async (_assembly: unknown, context: { agent?: Agent }, next: () => any) => {
    const assembly = await next(), agent = context.agent
    if (!agent || !appliesTo(agent)) return assembly
    // DSH 0.2.2 stopped handing tool declarations to this waterfall: the
    // assembly it passes carries sections/contexts/variables only, and the host
    // adds the final `tools` AFTER the waterfall (it also overrides a `tools`
    // returned here). Filtering the request's tool list is therefore impossible
    // in this host version — degrade to the host's own immediate set and keep
    // the runtime guard permissive, instead of failing every turn with
    // "reading 'some'". Older hosts still take the filtering path below.
    if (!Array.isArray((assembly as { tools?: Schema[] }).tools)) {
      const immediate = available(agent)
      if (assembly.contexts?.some((item: { name: string }) => item.name === 'butler:budget-final')) {
        exposed.set(agent.id, { origin: originFor(agent), names: new Set() })
        observed.set(agent.id, { mode: 'final-answer', hostToolsInWaterfall: false, availableTools: immediate.length, visibleTools: 0 })
        try { rebaseHeader(agent, [], false) } catch (caught) { failure(caught) }
        return { ...assembly, sections: demandPromptSections(assembly.sections ?? [], [], agent, new Set(), { finalAnswer: true }).sections }
      }
      exposed.set(agent.id, { origin: originFor(agent), names: new Set(immediate.map(tool => tool.name)) })
      observed.set(agent.id, { mode: 'native-unfiltered', hostToolsInWaterfall: false, availableTools: immediate.length, visibleTools: immediate.length })
      return { ...assembly, contexts: [...(assembly.contexts ?? []),
        { name: 'butler:tool-loading', text: '当前宿主版本由原生工具层决定本次请求的工具目录；已注册的管家工具可直接调用，无需先 load。工具发现与加载只影响旧版宿主的按需目录，不阻止本请求的执行。' }] }
    }
    if (assembly.contexts?.some((item: { name: string }) => item.name === 'butler:budget-final')) {
      rebaseHeader(agent, [], false)
      exposed.set(agent.id, { origin: originFor(agent), names: new Set() })
      observed.set(agent.id, { mode: 'final-answer', visibleTools: 0 })
      return { ...assembly, tools: [], sections: demandPromptSections(assembly.sections ?? [], [], agent, new Set(), { finalAnswer: true }).sections }
    }
    if (toolsFor(agent)?.modeFor?.(agent) === 'ptc') {
      rebaseHeader(agent, assembly.tools, false)
      exposed.delete(agent.id)
      observed.set(agent.id, { mode: 'ptc-passthrough', visibleTools: assembly.tools.length })
      return assembly
    }
    prepareCompactor(agent)
    const schemas = available(agent), nativeTools = toolsFor(agent)
    const discoveryAvailable = registered && assembly.tools.some((tool: Schema) => tool.name === DISCOVERY)
      && (!nativeTools?.get || nativeTools.get(DISCOVERY, agent) === discovery)
    const names = new Set([...base(agent), ...(discoveryAvailable ? selected(agent, schemas) : [])])
    if (!discoveryAvailable) {
      names.delete(DISCOVERY)
      const candidates = reminder(agent) ? [...READ_ONLY].filter(name => name !== DISCOVERY) : CORE_FALLBACK
      const extras: Schema[] = []
      for (const name of candidates) {
        const candidate = assembly.tools.find((tool: Schema) => tool.name === name)
        if (!candidate || names.has(name) || extras.length >= maxExtraTools) continue
        if (Buffer.byteLength(JSON.stringify([...extras, candidate])) > maxExtraBytes) continue
        extras.push(candidate)
        names.add(name)
      }
    }
    const tools = assembly.tools.filter((tool: Schema) => names.has(tool.name))
    // Compaction's pre-step hook runs before the loop logs the next request.
    // Its pressure check must already see the bounded header and history baseline.
    let headerRebased = false
    try { headerRebased = rebaseHeader(agent, tools) } catch (caught) { failure(caught); throw caught }
    observed.set(agent.id, { mode: 'native', discoveryAvailable, degraded: !discoveryAvailable, availableTools: schemas.length, visibleTools: tools.length,
      sourceBytes: Buffer.byteLength(JSON.stringify(assembly.tools)), visibleBytes: Buffer.byteLength(JSON.stringify(tools)), headerRebased })
    const guidance = !discoveryAvailable
      ? '当前作用域的工具发现入口不可用。仅保留有大小上限且原生可见的基础与管家工具；不要尝试调用缺失入口或从其他作用域加载。所需能力不在当前目录时，报告能力故障并停止该步骤。'
      : reminder(agent)
      ? '只执行当前提醒。需要读取或查询时，先用butler_tools search查名称，再load；提醒不能加载写入、程序运行、开发、调度或子代理工具。'
      : `默认仅列出基础工具。缺少能力时先butler_tools search，再load精确名称；完整参数在下一次请求出现。最多${maxExtraTools}个额外工具，不用时unload。发现/加载不执行目标工具，不替代权限与用户批准。`
    const prompt = demandPromptSections(assembly.sections, tools.map((tool: Schema) => tool.name), agent, base(agent))
    if (discoveryAvailable) exposed.set(agent.id, { origin: originFor(agent), names: new Set(tools.map((tool: Schema) => tool.name)) })
    else exposed.delete(agent.id)
    return { ...assembly, tools, sections: prompt.sections, contexts: [...assembly.contexts,
      { name: 'butler:tool-loading', text: guidance },
      ...(prompt.guidance ? [{ name: 'butler:loaded-guidance', text: prompt.guidance }] : [])] }
  }, { prepend: true, global: true }))

  return {
    status: () => ({ enabled: true, registered, maxExtraTools, maxExtraBytes, baseToolNames: [...BASE],
      scopes: [...observed].map(([sessionId, metrics]) => ({ sessionId, ...metrics })), ...(error ? { error } : {}) }),
    stop() { for (const fn of dispose.reverse()) fn(); observed.clear(); exposed.clear(); claimedOrigins.clear() },
  }
}
