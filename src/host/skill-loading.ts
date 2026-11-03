/** Compact model-facing skill catalogs, preserving native loading and digest metadata. */
import { defineTool, type ToolDefinition } from './tool-spec.ts'
import { randomUUID } from 'node:crypto'

interface Entry { name: string; description: string }
interface Message { id?: string; content: Array<{ type: string; text?: string }>; source: { kind: string; form?: string; entries?: unknown } }
interface Agent { id: string; ctx?: { get?(name: string, strict?: boolean): unknown };
  session: { header?: { cwd?: string }; surface?: { nodes: number[] }; eventAt?(seq: number): { type: string; data: Message } | undefined } }
interface Tools { get(name: string, agent: Agent): object | undefined; register(tool: ToolDefinition): () => void }
interface Skills { snapshot(options: { cwd?: string; scope: Agent; signal?: AbortSignal }): Promise<{
  skills: Array<Entry & { invocation: { modelInvocable: boolean } }>; complete: boolean }> }
interface Context {
  get(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
  logger?: { warn?(format: string, ...args: unknown[]): void }
}
const DISCOVERY = 'butler_skills'
const NORMAL_GUIDANCE = '技能目录按需发现：专业任务需要技能时，用butler_skills按主题或名称检索少量摘要；再用butler_tools加载skill工具，下一次请求中用原生skill(name)读取相关技能完整指令。已知精确名称也须先加载skill工具；用户/name已注入skill_content时直接遵循，不重复加载。搜索不执行技能，摘要不替代完整指令。'
const REMINDER_GUIDANCE = '当前只执行本条提醒。技能正文不会自动载入；读取和查询仍通过butler_tools按需发现。不得接续开发、加载开发指令或扩大提醒的执行权限。'
const EMPTY_GUIDANCE = '当前原生skill工具没有可向模型提供的技能目录。不要使用旧目录名称；用户显式/name调用仍由原生规则处理。'
const ALIASES: Array<[string, string]> = [['文献', 'literature'], ['搜索', 'search'], ['写作', 'writing'], ['翻译', 'translate'],
  ['图片', 'image'], ['演示', 'presentation slides ppt'], ['表格', 'spreadsheet excel'], ['文档', 'document docx'],
  ['诊断', 'diagnose debug'], ['网页', 'web'], ['技能', 'skill'], ['开发', 'development'], ['总结', 'summary'],
  ['文献检索', 'nature-academic-search'], ['引文核验', 'nature-academic-search'],
  ['cns引用', 'nature-citation'], ['nature引用', 'nature-citation'],
  ['数据可用性', 'nature-data'], ['代码可用性', 'nature-data'],
  ['科研绘图', 'nature-figure'], ['科学图表', 'nature-figure'],
  ['文献汇报', 'nature-paper2ppt'], ['论文汇报', 'nature-paper2ppt'],
  ['润色', 'nature-polishing'], ['学术翻译', 'nature-polishing'],
  ['论文精读', 'nature-reader'], ['双语精读', 'nature-reader'],
  ['审稿回复', 'nature-response'], ['回复审稿', 'nature-response'],
  ['论文起草', 'nature-writing'], ['论文撰写', 'nature-writing']]

function entriesOf(message: Message): Entry[] | undefined {
  if (message.source.kind !== 'skill-catalog' || message.source.form !== 'catalog' || !Array.isArray(message.source.entries)) return undefined
  const entries = message.source.entries as Entry[]
  return entries.every(row => row && typeof row.name === 'string' && row.name !== '' && typeof row.description === 'string') ? entries : undefined
}
function visibleCatalog(agent: Agent, messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (entriesOf(messages[i]!)) return messages[i]
  const nodes = agent.session.surface?.nodes ?? []
  for (let i = nodes.length - 1; i >= 0; i--) {
    const event = agent.session.eventAt?.(nodes[i]!)
    if (event?.type === 'user/message' && entriesOf(event.data)) return event.data
  }
}
function score(entry: Entry, query: string): number {
  let expanded = query.toLowerCase()
  for (const [word, alias] of ALIASES) if (expanded.includes(word)) expanded += ` ${alias}`
  const name = entry.name.toLowerCase(), description = entry.description.toLowerCase()
  const words = [...new Set(expanded.match(/[\p{L}\p{N}_-]+/gu) ?? [])]
  return (name === query.toLowerCase() ? 1000 : name.includes(expanded) ? 400 : 0)
    + words.reduce((sum, word) => sum + (name.includes(word) ? 50 : description.includes(word) ? 10 : 0), 0)
}

export function installSkillLoading(ctx: Context, options: { appliesTo?(agent: Agent): boolean } = {}) {
  const disposers: Array<() => void> = []
  const views = new WeakMap<Agent, { tool?: object; names: Set<string> }>()
  const observed = new Map<string, Record<string, number>>()
  const rootTools = ctx.get('tools', false) as Tools | undefined
  const appliesTo = (agent: Agent) => options.appliesTo?.(agent) ?? true
  let registered = false, error: string | undefined, catalogsRewritten = 0, searches = 0
  const toolsFor = (agent: Agent) => (agent.ctx?.get?.('tools', false) ?? rootTools) as Tools | undefined
  function reminder(agent: Agent): boolean {
    const registry = ctx.get('agents', false) as { list?(): Agent[]; isOwnedBy?(id: string, owner: Agent): boolean } | undefined
    const seen = new Set<Agent>()
    while (!seen.has(agent)) {
      seen.add(agent)
      const parent = registry?.list?.().find(candidate => registry.isOwnedBy?.(agent.id, candidate))
      if (!parent) break
      agent = parent
    }
    return agent.id.startsWith('session-butler-reminder-')
  }
  const discovery = defineTool({
    name: DISCOVERY,
    description: '按主题或精确名称检索当前可加载技能的少量摘要；随后用原生skill(name)读取完整指令。检索不会加载正文或执行技能。',
    parameters: { query: { type: 'string', required: true, description: '中英文主题或精确技能名称，最多300字符。' },
      limit: { type: 'integer', description: '结果数1到8，默认6。' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      try {
        const exec = execution as { agent?: Agent; signal?: AbortSignal } | undefined
        const agent = exec?.agent
        if (!agent) throw new Error('技能检索必须在当前代理会话中调用')
        if (!appliesTo(agent)) throw new Error('技能检索仅供管家会话使用')
        if (reminder(agent)) throw new Error('提醒只执行当前提醒，不开放技能加载或开发能力')
        const query = String(args['query'] ?? '').trim(), limit = Number(args['limit'] ?? 6)
        if (!query || query.length > 300) throw new Error('query需要1到300字符的主题或技能名')
        if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('limit必须为1到8')
        const view = views.get(agent), tool = toolsFor(agent)?.get('skill', agent)
        if (toolsFor(agent)?.get(DISCOVERY, agent) !== discovery || !view || !tool || tool !== view.tool || view.names.size === 0) return {
          ok: true, matches: [], complete: false, next: '当前原生skill目录不可用或尚未就绪；不要从其他会话或旧目录推断可用技能。' }
        const skills = (agent.ctx?.get?.('skills', false) ?? ctx.get('skills', false)) as Skills | undefined
        if (!skills?.snapshot) throw new Error('原生技能服务不可用；原有skill加载路径保持不变')
        exec?.signal?.throwIfAborted()
        const snapshot = await skills.snapshot({ cwd: agent.session.header?.cwd, scope: agent, signal: exec?.signal })
        exec?.signal?.throwIfAborted()
        if (toolsFor(agent)?.get('skill', agent) !== tool || toolsFor(agent)?.get(DISCOVERY, agent) !== discovery || views.get(agent) !== view) return {
          ok: true, matches: [], complete: false, next: '检索期间原生技能目录或加载器已变化，本次未提供过期名称。' }
        // Both the native catalog's exact-loader authority and current scoped
        // provider winners must admit a name. No hidden/user-only skill leaks.
        const matches = snapshot.skills.filter(skill => skill.invocation.modelInvocable && view.names.has(skill.name))
          .map(skill => ({ skill, score: score(skill, query) })).filter(row => row.score > 0)
          .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name)).slice(0, limit)
          .map(({ skill }) => ({ name: skill.name, description: skill.description.replace(/\s+/g, ' ').trim().slice(0, 160) }))
        searches++
        return { ok: true, matches, complete: snapshot.complete, next: '用原生skill(name)加载所需完整指令；已出现skill_content的技能不必重复加载。' }
      } catch (caught) {
        return { ok: false, matches: [], error: caught instanceof Error ? caught.message : String(caught) }
      }
    },
  })
  try {
    if (!rootTools?.register) throw new Error('native tool registry is unavailable')
    disposers.push(rootTools.register(discovery)); registered = true
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
    ctx.logger?.warn?.('[dsh-butler] skill discovery unavailable; preserving the native catalog: %s', error)
  }
  disposers.push(ctx.on('agent/pre-step', async ({ agent }: { agent: Agent }, next: () => any) => {
    if (!appliesTo(agent)) return next()
    const beforeTool = toolsFor(agent)?.get('skill', agent)
    const beforeDiscovery = toolsFor(agent)?.get(DISCOVERY, agent)
    const decision = await next()
    if (decision.kind === 'reject' || (!registered && reminder(agent))) return decision
    const tool = toolsFor(agent)?.get('skill', agent)
    const catalog = visibleCatalog(agent, decision.messages)
    const entries = catalog && entriesOf(catalog)
    // A scoped restriction/shadow may hide our globally registered entry.
    // Preserve the native discovery catalog if our replacement is not usable.
    if (!registered || (!reminder(agent) && (beforeDiscovery !== discovery || toolsFor(agent)?.get(DISCOVERY, agent) !== discovery))) {
      views.delete(agent)
      // A restriction introduced after our compact message must also restore
      // discovery. Publish one full fallback; native entries/digest still dedupe it.
      if (tool && beforeTool === tool && entries?.length && catalog?.content.length === 1 && catalog.content[0]?.text === NORMAL_GUIDANCE) {
        const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        const text = '当前技能搜索入口不可用。以下为原生可用技能摘要；按任务选择，先用butler_tools加载skill工具，再用skill(name)读取完整指令。用户/name已注入的技能无需重复加载。\n'
          + entries.map(entry => `- ${entry.name}: ${escape(entry.description)}`).join('\n')
        return { ...decision, messages: [...decision.messages, { ...catalog, id: randomUUID(), content: [{ type: 'text', text }] }] }
      }
      return decision
    }
    views.set(agent, { tool, names: new Set(beforeTool === tool ? entries?.map(entry => entry.name) ?? [] : []) })
    const messages = decision.messages.map((message: Message) => {
      const catalog = entriesOf(message)
      if (!catalog) return message
      const text = reminder(agent) ? REMINDER_GUIDANCE : catalog.length ? NORMAL_GUIDANCE : EMPTY_GUIDANCE
      observed.set(agent.id, { summaries: catalog.length,
        originalTextBytes: Buffer.byteLength(message.content.map(block => block.text ?? '').join('\n')),
        visibleTextBytes: Buffer.byteLength(text) })
      if (observed.size > 64) observed.delete(observed.keys().next().value!)
      catalogsRewritten++
      // Native messages are frozen. Keep the native source.entries verbatim:
      // its digest suppresses re-publication; DeepSeek sends only user content.
      return { ...message, content: [{ type: 'text', text }] }
    })
    return { ...decision, messages }
  }, { prepend: true, global: true }))
  return {
    status: () => ({ enabled: registered, registered, catalogsRewritten, searches,
      scopes: [...observed].map(([sessionId, metrics]) => ({ sessionId, ...metrics })), ...(error ? { error } : {}) }),
    stop() { for (const dispose of disposers.reverse()) dispose(); observed.clear() },
  }
}
