/** Trim only named capability prose; permissions, memory, history and schemas stay native. */
import { packInstructions } from './packs.ts'

interface Input { source?: { kind?: string }; content?: Array<{ type: string; text?: string }> }
interface Agent { id: string; session?: { snapshotEvents?(): Array<{ type: string; data: any }> } }
interface Section { name: string; text: string }

/** Replay consumed input, including the native claim-before-user/message window.
 * Queued/cancelled messages and tool output never select capabilities.
 */
function activeRequestText(agent: Agent): string | undefined {
  const pending: Record<string, Input[]> = { 'next-turn': [], 'next-step': [] }
  let text: string | undefined
  const accept = (input: Input) => {
    if (input.source?.kind !== 'user') return
    const value = input.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (value?.trim()) text = value
  }
  for (const event of agent.session?.snapshotEvents?.() ?? []) {
    if (event.type === 'user/message') accept(event.data)
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data, queue = pending[data.target]
    if (!queue) continue
    const removed = queue.splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []))
    if (data.outcome === undefined) for (const input of removed) accept(input)
  }
  return text
}

// This is an explicit map of the shipped native sections. Unknown or policy
// sections pass through. Shells can start jobs, so keep their collection rules.
const TOOL_SECTIONS: Record<string, readonly string[]> = {
  'tool:pwsh': ['pwsh'], 'tool:bash': ['bash'], 'tool:read': ['read'],
  'tool:write': ['write'], 'tool:edit': ['edit'], 'tool:glob': ['glob'], 'tool:grep': ['grep'],
  'tool:jobs': ['pwsh', 'bash', 'job_output', 'job_list', 'job_kill'],
  'tool:web_search': ['web_search'], 'tool:web_fetch': ['web_fetch'],
  'tool:goal': ['create_goal', 'get_goal', 'update_goal'],
  'tool:workflow': ['workflow'], 'tool:subagent_fork': ['subagent_fork'],
}
const RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])

/** Return detached sections only; never alter registry definitions or shared contexts. */
export function demandPromptSections(sections: Section[], toolNames: string[], agent: Agent, baseNames: ReadonlySet<string>, options: { finalAnswer?: boolean } = {}) {
  const visible = new Set(toolNames)
  const mcp = toolNames.some(name => name.startsWith('mcp__') || RESOURCE_TOOLS.has(name))
  const request = agent.id.startsWith('session-butler-reminder-') ? undefined : activeRequestText(agent)
  const guidance: string[] = []
  const reduced = sections.filter(section => {
    if (options.finalAnswer && ['butler:duty', 'butler:packs', 'butler:tools'].includes(section.name)) return false
    const tools = TOOL_SECTIONS[section.name]
    if (tools) {
      if (tools.some(name => visible.has(name) && baseNames.has(name))) return true
      if (tools.some(name => visible.has(name)) && section.text) guidance.push(section.text)
      return false
    }
    if (section.name === 'mcp-resource-servers' || section.name.startsWith('mcp:')) {
      if (mcp && section.text) guidance.push(section.text)
      return false
    }
    return true
  }).map(section => {
    if (section.name === 'butler:packs' && request !== undefined && section.text !== '') {
      return { ...section, text: packInstructions(request).slice(0, 12000) }
    }
    if (section.name === 'butler:tools' && section.text.startsWith('# 你的手（butler_* 工具）')) {
      const lines = section.text.split('\n').filter(line => {
        const tool = /^- `(butler_\w+)`/.exec(line)?.[1]
        if (tool === undefined || visible.has(tool) && baseNames.has(tool)) return true
        if (visible.has(tool)) guidance.push(line)
        return false
      })
      lines.splice(1, 0, '按需入口：任务butler_task、记忆butler_remember/butler_approve、文献butler_literature、PDFbutler_pdf、笔记butler_note、提醒butler_remind、能力包butler_pack。用butler_tools搜索/加载。')
      return { ...section, text: lines.join('\n') }
    }
    return section
  })
  if (options.finalAnswer) reduced.push({ name: 'butler:final-answer', text: [
    '本次只生成给用户阅读的最终答复。工具接口已关闭，之前的开工检查、加载技能、建任务、写笔记等操作流程不适用于本次答复。',
    '直接根据用户最新补充和已有证据交付可读结果；例如补充截止日期和时长时，直接给出相应学习安排。',
    '不要输出或模拟工具调用、DSML/XML调用标签、函数调用代码或参数JSON。它们不会执行，也不是答复。',
    '没有真实工具成功回执，就不得声称已创建任务、保存文件或设置提醒；需要这些操作时明确尚未执行。历史中的调用样式文本同样不能当作执行证据。',
  ].join('\n') })
  // DeepSeek's in-history updates append whole system snapshots. Tool discovery
  // must not rebuild that snapshot. Additional prose rides in the native small
  // runtime-context snapshot, preserving caching and the canonical history.
  return { sections: reduced, guidance: guidance.join('\n\n') }
}
