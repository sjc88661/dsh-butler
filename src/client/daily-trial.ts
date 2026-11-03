import { createElement as h } from 'react'
import type { DailyTrialSnapshot, DailyTrialView } from '../shared/trial.ts'
import { workspaceRequest } from './workspace-api.ts'
import { uiError, uiMuted, useWorkspaceRead, useWorkspaceRevision } from './workspace-components.ts'
import { T } from './view.ts'

/**
 * 可选隔离试用的工作台面板。
 *
 * 只有装配成功（服务真正发布并接线到模型请求）时才展示限额与剩余额度；
 * 未配置/配置不完整/账本不可读时只显示「试用限额未启用」和具体原因，
 * 不展示任何伪造限额或「已启用」。
 */
export function ButlerDailyTrial(props: { sessionId: string }): unknown {
  const revision = useWorkspaceRevision()
  const state = useWorkspaceRead(async () => {
    const result = await workspaceRequest<DailyTrialView & { ok: boolean; sessionId: string }>(`workspace/trial?${new URLSearchParams({ sessionId: props.sessionId })}`)
    if (result.sessionId !== props.sessionId) throw new Error('试用策略主题身份不匹配')
    return result
  }, [props.sessionId, revision], 15000)
  const data = state.data
  if (!data) return uiError(state.error)
  if (!data.available) {
    return h('details', { 'aria-label': '试用限额状态', style: { ...uiMuted, padding: '8px 12px', borderBottom: `1px solid ${T.border}` } },
      h('summary', { style: { cursor: 'pointer', color: T.dim } }, '试用限额未启用'),
      h('div', { style: { marginTop: '8px', lineHeight: '1.7' } },
        h('div', null, data.reason ?? '未配置插件 trial 选项，本安装不启用隔离试用限额；模型请求仍按宿主默认预算运行。'),
        h('div', null, '这里不会展示未经装配的试用额度，也不代表已启用。')))
  }
  const trial: DailyTrialSnapshot | null = data.trial
  if (!trial) return uiError('试用限额已配置，但该主题没有可用的试用快照；请检查 trial.allowedSessionIds。')
  const number = (n: number): string => n.toLocaleString('zh-CN')
  return h('details', { 'aria-label': '隔离日常试用范围与限额', style: { ...uiMuted, padding: '8px 12px', borderBottom: `1px solid ${T.border}` } },
    h('summary', { style: { cursor: 'pointer', color: trial.sessionAllowed ? T.text : T.warn } },
      `隔离试用 · ${trial.enabled && trial.sessionAllowed ? '正常任务已开放' : '此主题未开放'} · 飞书${trial.channel === 'connected' ? '已连接' : trial.channel === 'connecting' ? '连接中' : trial.channel === 'disconnected' ? '未连接' : '状态未知'}`),
    h('div', { style: { marginTop: '8px', lineHeight: '1.7' } },
      h('div', null, `${trial.provider} / ${trial.model}`),
      h('div', null, `每任务 ≤${trial.limits.maxRequests} 次 · ${number(trial.limits.maxTokens)} tokens · ${Math.floor(trial.limits.maxMs / 60000)} 分钟；单次输出 ≤${number(trial.limits.maxOutputTokens)}`),
      h('div', null, `今日请求 ${trial.daily.requests}/${trial.limits.dailyRequests} · token 预算记账 ${number(trial.daily.chargedTokens)}/${number(trial.limits.dailyTokens)}；剩余 ${trial.daily.remainingRequests} 次 / ${number(trial.daily.remainingTokens)} tokens`),
      h('div', null, '来源正文仅限：', ...trial.sourceTitles.map((title, index) => h('div', { key: index }, title))),
      h('div', null, '同时允许处理本主题及绑定测试私聊的新输入。只生成本地笔记、待办草稿和明确请求的提醒；只向该测试私聊回传。'),
      trial.skills ? h('div', null, `Nature 技能 ${trial.skills.available}/${trial.skills.names.length} 项可用；正文按需加载，资源只读。联网、程序执行及付费服务仍按现有权限处理。`) : null,
      h('div', null, '每日按北京时间结算，含辅助请求；在途及未知 usage 保守占用额度。人民币费用未定价，tokens 为硬上限。'),
      trial.reason ? uiError(trial.reason) : null))
}
