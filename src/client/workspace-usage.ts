import { createElement as h } from 'react'
import { fetchWorkspaceUsage } from './workspace-api.ts'
import { uiError, uiMuted, useWorkspaceRead, useWorkspaceRevision } from './workspace-components.ts'
import { usageBreakdownView, usageCostBreakdownView, usageView } from './workbench-model.ts'
import { T } from './view.ts'

/** This is a read model of native usage, independent of pending tasks and selected source content. */
export function ButlerWorkspaceUsage(props: { sessionId: string }): unknown {
  const revision = useWorkspaceRevision()
  const state = useWorkspaceRead(() => fetchWorkspaceUsage(props.sessionId), [props.sessionId, revision], 15000)
  const usage = state.data?.usage, display = usage ? usageView(usage) : undefined
  return h('details', { 'aria-label': '当前主题用量', style: { padding: '8px 12px', borderBottom: `1px solid ${T.border}`, flex: '0 0 auto', ...uiMuted } },
    h('summary', { style: { cursor: 'pointer', overflowWrap: 'anywhere' } }, `当前主题用量：${usage && display ? `${usage.calls} 次 · ${display.tokenText} tokens · ${display.costText}` : state.loading ? '读取中…' : '读取失败'}`),
    uiError(state.error),
    usage ? h('div', { style: { marginTop: '6px', lineHeight: '1.6' } },
      h('div', null, `未缓存输入 ${usage.inputTokens.toLocaleString('zh-CN')} · 输出 ${usage.outputTokens.toLocaleString('zh-CN')} · 缓存读取 ${usage.cacheReadTokens.toLocaleString('zh-CN')}`),
      ...usageBreakdownView(usage).map((text, index) => h('div', { key: index }, text)),
      ...usageCostBreakdownView(usage).map((text, index) => h('div', { key: `cost-${index}` }, text)),
      h('div', null, `计价覆盖 ${usage.pricedCalls}/${usage.calls} 次；未知用量 ${usage.withoutUsage} 次。金额为估算，未计价不等于免费。`)) : null,
    h('p', { style: { margin: '6px 0 0' } }, '仅当前主题及其明确归属的子会话；来源对话的历史用量不计入。待办执行用量在任务详情单列。'))
}
