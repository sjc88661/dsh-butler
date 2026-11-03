/** Repair only explicitly identified sessions left with a legacy deferred-only declaration series. */
interface Schema { name: string; deferLoading?: boolean; [key: string]: unknown }
interface Agent {
  id: string
  session?: {
    id?: string
    requestHeader?(): { tools?: Schema[]; [key: string]: unknown } | undefined
    toolHistory?(): { tools: Schema[] } | undefined
    append?(type: string, data: unknown): unknown
  }
}
interface Context {
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
}

export function installLegacyToolSeriesRepair(ctx: Context, options: { affected(agent: Agent): boolean }) {
  let count = 0, lastSessionId: string | undefined
  let unsupported: { sessionId: string; reason: string } | undefined
  const off = ctx.on('system-prompt/assemble', async (_input: unknown, context: { agent?: Agent }, next: () => Promise<any>) => {
    const agent = context.agent, allowed = agent !== undefined && options.affected(agent)
    const assembly = await next()
    if (!allowed || !agent || !options.affected(agent)) return assembly
    const tools = assembly.tools as Schema[] | undefined
    if (!tools?.length) return assembly
    if (!tools.some(tool => tool.deferLoading !== true)) {
      unsupported = { sessionId: agent.id, reason: 'all-current-tools-deferred' }
      return assembly
    }
    const session = agent.session, header = session?.requestHeader?.()
    if (!header) return assembly
    const history = session?.toolHistory?.()
    if (!history) return assembly
    const currentNames = new Set(tools.map(tool => tool.name))
    if (history.tools.some(tool => tool.deferLoading !== true && currentNames.has(tool.name))) return assembly
    if (!session?.append) throw new Error('[BUTLER_LEGACY_TOOL_SERIES] 原生 append 不可用，无法安全迁移工具声明基线')
    session.append('request/header', { header: { ...header, tools }, reason: 'series' })
    count++; lastSessionId = agent.id
    return assembly
  }, { prepend: true, global: true })
  return { status: () => ({ count, lastSessionId, ...(unsupported ? { unsupported: { ...unsupported } } : {}) }), stop: off }
}
