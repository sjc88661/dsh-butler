/** The dedicated butler layer: ownership and native scoped tool registration. */
interface Agent {
  id: string
  session?: unknown
  ctx?: { get?(name: string, strict?: boolean): unknown }
}
interface Registry { list?(): Agent[]; isOwnedBy?(id: string, owner: Agent): boolean }
interface Definition { name: string; [key: string]: unknown }
interface ToolRegistry { register(definition: unknown): () => void }
interface Host {
  get(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
  logger?: { warn?(format: string, ...args: unknown[]): void }
}

export function createButlerLayer(ctx: Host, options: {
  ownsSession(id: string): boolean
  reminderSession(id: string): boolean
}) {
  const definitions = new Map<string, unknown>()
  const mounted = new Map<Agent, Map<string, () => void>>()
  const registry = () => ctx.get('agents', false) as Registry | undefined
  function root(agent: Agent): Agent | undefined {
    const seen = new Set<Agent>(), agents = registry()
    while (!seen.has(agent)) {
      seen.add(agent)
      const parent = agents?.list?.().find(candidate => agents.isOwnedBy?.(agent.id, candidate))
      if (!parent) return agent
      agent = parent
    }
    return undefined
  }
  const sessionId = (agent: Agent) => (agent.session as { id?: string } | undefined)?.id ?? agent.id
  const rootId = (agent: Agent) => { const owner = root(agent); return owner && sessionId(owner) }
  const isReminder = (agent: Agent) => { const id = rootId(agent); return id !== undefined && options.reminderSession(id) }
  const appliesTo = (agent: Agent) => {
    const id = rootId(agent)
    return id !== undefined && (options.ownsSession(id) || options.reminderSession(id))
  }
  function mount(agent: Agent): void {
    if (!appliesTo(agent)) {
      for (const dispose of mounted.get(agent)?.values() ?? []) dispose()
      mounted.delete(agent)
      return
    }
    const tools = agent.ctx?.get?.('tools', false) as ToolRegistry | undefined
    if (!tools?.register) throw new Error('管家会话缺少原生作用域工具注册器')
    const installed = mounted.get(agent) ?? new Map<string, () => void>()
    mounted.set(agent, installed)
    for (const [name, definition] of definitions) if (!installed.has(name)) installed.set(name, tools.register(definition))
  }
  function refresh(): void { for (const agent of registry()?.list?.() ?? []) mount(agent) }
  const tools = {
    register(definition: unknown): () => void {
      const name = (definition as Definition)?.name
      if (typeof name !== 'string' || !name.startsWith('butler_') || definitions.has(name)) throw new Error('管家工具名称无效或重复')
      definitions.set(name, definition)
      try { refresh() } catch (error) { remove(name); throw error }
      return () => remove(name)
    },
  }
  function remove(name: string): void {
    definitions.delete(name)
    for (const installed of mounted.values()) { installed.get(name)?.(); installed.delete(name) }
  }
  // Other borrowed services retain their real native receiver. Only registration
  // is redirected; lookup/execution always uses the actual agent's registry.
  const host = { get: (name: string, strict?: boolean) => name === 'tools' ? tools : ctx.get(name, strict),
    on: (name: string, listener: (...args: any[]) => any, settings?: { prepend?: boolean; global?: boolean }) => ctx.on(name, listener, settings),
    logger: ctx.logger }
  const disposers = [
    ctx.on('agent/created', ({ agent }: { agent: Agent }) => mount(agent), { prepend: true, global: true }),
    // New topics enter the workspace registry after native creation. A claimed
    // input precedes native schema collection, unlike the assemble waterfall.
    ctx.on('agent/inbox/claimed', ({ agent }: { agent: Agent }) => mount(agent), { prepend: true, global: true }),
    ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
      for (const dispose of mounted.get(agent)?.values() ?? []) dispose()
      mounted.delete(agent)
    }, { global: true }),
    ctx.on('system-prompt/assemble', async (_assembly: unknown, context: { agent?: Agent }, next: () => any) => {
      if (context.agent) mount(context.agent)
      return next()
    }, { prepend: true, global: true }),
  ]
  return { appliesTo, isReminder, rootId, tools, host, refresh,
    status: () => ({ mode: 'dedicated-layer', normalTokenBudget: null, normalExecutionPolicy: 'native',
      toolRegistration: 'agent-scoped', toolCount: definitions.size, sessions: [...mounted.keys()].map(sessionId) }),
    stop() {
      for (const dispose of disposers.reverse()) dispose()
      for (const name of [...definitions.keys()]) remove(name)
      mounted.clear()
    },
  }
}
