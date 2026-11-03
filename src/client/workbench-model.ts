/** Honest, read-only display projections; this module never controls execution. */
import type { BudgetReport, HistoryBudget, RuntimeControlsSnapshot, UsageTotals } from './api.ts'
import type { BudgetState } from '../host/budget.ts'
import type { TaskReminderSnapshot, TaskReadSnapshot, ReminderOperationSnapshot, ReminderOutboundSnapshot } from '../shared/workbench.ts'

export interface BudgetView {
  runId: string
  sessionId: string
  kind: BudgetState['kind']
  requests: number
  tokens: number
  reservedTokens: number
  state: 'unknown' | 'stopped' | 'in-flight' | 'settled'
  stopReason?: string
  remaining?: BudgetReport['remaining']
  limits?: BudgetReport['limits']
  current?: boolean
  failures: Record<string, number>
  note: string
}

/** Project every supplied row; paging belongs to the history endpoint, never this helper. */
export function budgetViews(entries: Array<Readonly<BudgetState> | BudgetReport | HistoryBudget>): BudgetView[] {
  return [...entries].sort((a, b) => b.startedAt - a.startedAt || a.taskId.localeCompare(b.taskId)).map(row => {
    const historical = 'current' in row && row.current === false
    const report = !historical && 'remaining' in row && 'limits' in row ? row as BudgetReport : undefined
    return { runId: row.taskId, sessionId: row.sessionId, kind: row.kind, requests: row.requests, tokens: row.tokens, reservedTokens: row.reservedTokens,
      failures: { ...row.failures },
      ...('current' in row ? { current: row.current } : {}),
      state: row.blocked ? 'stopped' : report ? report.inFlight > 0 ? 'in-flight' : 'settled' : 'unknown',
      ...(row.blocked ? { stopReason: row.blocked } : {}),
      ...(report ? { remaining: { ...report.remaining }, limits: { ...report.limits } } : {}),
      note: historical ? '旧运行未保存当时限额与结束时间，剩余保持未知；预留不代表仍在执行'
        : report ? '剩余额度来自宿主快照；预算计数可能包含无 usage 时的保守记账' : '宿主未提供实际限额，剩余保持未知' }
  })
}

/** Attribution snapshots contain no live transport status or proof of business completion. */
function channelView(channels: RuntimeControlsSnapshot['channels']): { summary: string; note: string; attention: boolean } {
  const count = (value: number | undefined): string => Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : '未知'
  const configured = !channels ? '飞书归因未提供' : channels.error || !channels.active ? '飞书归因待核对'
    : channels.enabled === false ? '飞书归因未启用' : channels.enabled && channels.configuredOwner ? '飞书归因已配置' : '飞书归因记录可读'
  return {
    summary: `${configured} · 连接状态未知 · 接收 ${count(channels?.received)} · 回调返回 ${count(channels?.accepted)} · 已关联原生 ${count(channels?.nativeMapped)} · 回调返回未关联 ${count(channels?.acceptedWithoutNative)} · 处理中 ${count(channels?.pending)} · 待核对 ${count(channels?.uncertain)}`,
    note: '回调返回未关联可能是通道命令；任务建立与完成需核对原生任务记录。',
    attention: Boolean(channels?.error) || Boolean(channels && !channels.active) || Number(channels?.pending) > 0 || Number(channels?.uncertain) > 0,
  }
}

export function runtimeView(controls: RuntimeControlsSnapshot | undefined): {
  state: 'healthy' | 'degraded' | 'unknown'
  problems: string[]
  budgets: BudgetView[]
  budgetCount: number
  budgetPolicy: string
  channels: ReturnType<typeof channelView>
  attention: Array<{ id: string; title: string; reason: string; taskId?: string; state: 'uncertain' | 'creating' | 'waiting' | 'pending' }>
} {
  if (!controls) return { state: 'unknown', problems: ['运行控制状态未提供'], budgets: [], budgetCount: 0, budgetPolicy: '普通管家 token 预算与提醒限额状态未提供。', attention: [], channels: channelView(undefined) }
  const problems: string[] = [], attention: ReturnType<typeof runtimeView>['attention'] = []
  if (controls.error) problems.push(controls.error)
  if (!controls.active) problems.push('运行保护未确认启用')
  if (controls.blocked && !controls.error) problems.push('预算保护已阻止继续执行')
  for (const issue of controls.storage?.diagnostics ?? []) problems.push(`${issue.path}${issue.line === undefined ? '' : `:${issue.line}`}：${issue.message}`)
  if (controls.workflows?.active === false) problems.push(controls.workflows.error ?? '业务证据与审批流程不可用')
  if (controls.workflows?.nativeActionGuard === false) problems.push('原生敏感动作守卫未就绪')
  for (const reason of Object.values(controls.workflows?.errors ?? {})) problems.push(reason)
  if (controls.executionContext?.active === false) problems.push(controls.executionContext.error ?? '任务归因服务不可用')
  if (controls.toolLoading?.registered === false) problems.push(controls.toolLoading.error ?? '工具发现入口不可用')
  if (controls.skillLoading?.registered === false) problems.push(controls.skillLoading.error ?? '技能发现入口不可用')
  if (controls.reminderError) problems.push(controls.reminderError)
  if (controls.reminderOperationsError) problems.push(`提醒操作记录不可读：${controls.reminderOperationsError}`)
  for (const item of controls.reminderOperations ?? []) {
    const title = item.request?.title ?? item.scheduleId ?? item.taskId ?? '提醒操作'
    if (item.state === 'uncertain' || item.state === 'creating') attention.push({ id: item.executionKey, title,
      reason: item.reason ?? (item.state === 'creating' ? '提交中，尚未取得确定结果' : '宿主结果未知，请核对原操作'), taskId: item.taskId, state: item.state })
    for (const outbound of outboundViews(item.outbound ?? [])) if (outbound.state !== 'delivered') attention.push({
      id: `outbound:${outbound.key}`, title: `提醒外发：${title}`, reason: outbound.label, taskId: item.taskId, state: outbound.state,
    })
  }
  for (const item of controls.reminders ?? []) if (item.uncertain) attention.push({ id: item.id, title: item.title, reason: item.uncertain, state: 'uncertain' })
  const known = controls.active && !controls.unavailable && controls.storage !== undefined
    && controls.workflows?.active === true && controls.workflows.nativeActionGuard === true && controls.executionContext?.active === true
  const state = controls.unavailable ? 'unknown' : problems.length || controls.storage?.degraded || controls.blocked ? 'degraded' : known ? 'healthy' : 'unknown'
  if (state === 'unknown' && !problems.length) problems.push('部分保护状态未提供，不能确认全部就绪')
  const entries: Array<Readonly<BudgetState> | BudgetReport> = controls.budgetReports ?? controls.taskBudgets ?? []
  const budgets = budgetViews(entries).slice(0, 12)
  const normalNative = controls.layer?.mode === 'dedicated-layer' && controls.layer.normalTokenBudget === null
    && controls.layer.normalExecutionPolicy === 'native'
  const normalPolicy = normalNative ? '普通管家不设 token 硬预算；仅统计实际消耗。' : '普通管家 token 预算策略未提供。'
  const reminderPolicy = controls.controlScope === 'isolated-reminders-only' ? '提醒会话保留隔离限额。' : '提醒限额范围未提供。'
  return { state, problems, budgets, budgetCount: entries.length, budgetPolicy: normalPolicy + reminderPolicy, attention, channels: channelView(controls.channels) }
}

/** Each operation is a saved final snapshot, not an invented sequence of transitions. */
export function reminderOperationView(row: ReminderOperationSnapshot): {
  id: string; title: string; label: string; requestedAt: string; updatedAt: string; plannedAt?: string
  receiptText: string; reason?: string; delivery?: NonNullable<ReminderOperationSnapshot['lastDelivery']>
  completion: string; external: string; outbound: OutboundView[]
} {
  const receipt = row.actualReceipt
  const deletion = receipt && 'deleted' in receipt ? receipt : undefined
  const label = row.refusal ? '取消被拒绝' : row.state === 'uncertain' ? '待核对' : row.state === 'creating' ? '提交中'
    : row.action === 'cancel' ? deletion?.deleted === true ? '已取消' : deletion?.deleted === false ? '取消未成功' : '取消结果未记录'
    : receipt ? '已取得创建回执' : '创建回执未记录'
  const delivery = row.lastDelivery
  const outbound = outboundViews(row.outbound ?? [])
  const delivered = delivery && ((typeof delivery.messageId === 'string' && delivery.messageId.length > 0)
    || (typeof delivery.deliveredAt === 'string' && Number.isFinite(Date.parse(delivery.deliveredAt))))
  return { id: row.executionKey, title: row.request?.title ?? row.scheduleId ?? '提醒操作', label,
    requestedAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.request?.at ? { plannedAt: row.request.at } : {}),
    receiptText: deletion ? `原生取消回执 ${deletion.id} · deleted=${deletion.deleted}${deletion.code ? ` · ${deletion.code}` : ''}`
      : receipt ? `真实创建回执 ${receipt.id}（未单列接受时间）` : '真实原生回执未记录',
    ...(row.refusal || row.reason ? { reason: row.refusal ? `${row.refusal.code}：${row.refusal.reason}` : row.reason } : {}),
    ...(delivered ? { delivery: { ...delivery } } : {}),
    completion: row.deliveryState === 'assistant-completed' || outbound.length ? '已记录助手完成' : '助手完成未核实',
    external: externalSummary(outbound), outbound }
}

export function usageView(usage: Pick<UsageTotals, 'calls' | 'withoutUsage' | 'totalTokens' | 'pricedCalls' | 'cost'>): { tokenText: string; costText: string } {
  const known = usage.calls > usage.withoutUsage
  return { tokenText: !usage.calls ? '未记录（实际用量未知）' : !known ? '未知' : `${usage.totalTokens.toLocaleString('zh-CN')}${usage.withoutUsage ? `（另有 ${usage.withoutUsage} 次未知）` : ''}`,
    costText: usage.pricedCalls > 0 ? usage.pricedCalls < usage.calls
      ? `已计价部分估算 ¥${usage.cost.toFixed(4)}（${usage.pricedCalls}/${usage.calls} 次；其余费用未知）`
      : `估算 ¥${usage.cost.toFixed(4)}（${usage.pricedCalls}/${usage.calls} 次已计价）` : '未计价' }
}

/** Legacy hosts still render; new hosts expose disjoint assistant and auxiliary purposes. */
export function usageBreakdownView(usage: Pick<UsageTotals, 'calls'> & Partial<Pick<UsageTotals, 'assistantCalls' | 'auxiliaryCalls' | 'byPurpose'>>): string[] {
  const lines = [`助手回复 ${usage.assistantCalls ?? usage.calls} 次，辅助调用 ${usage.auxiliaryCalls ?? 0} 次`]
  const labels = { assistant: '助手回复', 'session-title': '会话命名', compaction: '上下文压缩', unknown: '辅助用途未知' }
  for (const purpose of ['assistant', 'session-title', 'compaction', 'unknown'] as const) {
    const group = usage.byPurpose?.[purpose]
    if (!group?.calls) continue
    const display = usageView(group)
    lines.push(`${labels[purpose]} ${group.calls} 次：${display.tokenText} tokens，缺用量 ${group.withoutUsage} 次，已报用量未计价 ${group.unpricedCalls} 次，${display.costText}${group.failedCalls ? `，失败 ${group.failedCalls} 次` : ''}${group.cancelledCalls ? `，取消 ${group.cancelledCalls} 次` : ''}`)
  }
  return lines
}

/** Coverage and missing-price explanations are a read model, never a monetary budget. */
export function usageCostBreakdownView(usage: Pick<UsageTotals, 'byProviderModel'>): string[] {
  const lines = usage.byProviderModel === undefined ? ['提供方/模型成本细分未提供，具体缺价原因未知。'] : usage.byProviderModel.map(group => {
    const display = usageView(group)
    const reasons: Array<[keyof typeof group.unknownCostReasons, string]> = [
      ['missing-usage', '未取得提供方用量，费用未知'],
      ['provider-no-price', group.provider === 'deepseek-account'
        ? '未获得 deepseek-account 账户线路的可适用价格；现有价目表仅适用于 deepseek-official，不能套用'
        : group.provider ? `未获得 ${group.provider} 线路的可适用价格` : '未报告提供方，无法匹配价格'],
      ['model-no-price', group.model ? `当前价目表未包含模型 ${group.model}` : '未报告模型，无法匹配价格'],
      ['incomplete-usage', '输入/输出用量不完整，无法估价'],
      ['no-estimate', '未取得可用估价，费用未知'],
    ]
    const missing = reasons.filter(([key]) => (group.unknownCostReasons[key] ?? 0) > 0)
      .map(([key, label]) => `${label}（${group.unknownCostReasons[key]} 次）`)
    return `${group.provider ?? '提供方未知'} / ${group.model ?? '模型未知'}：已报告 ${display.tokenText} tokens`
      + `（未缓存输入 ${group.inputTokens.toLocaleString('zh-CN')} / 输出 ${group.outputTokens.toLocaleString('zh-CN')} / 缓存读取 ${group.cacheReadTokens.toLocaleString('zh-CN')} / 缓存写入 ${group.cacheWriteTokens.toLocaleString('zh-CN')}）`
      + `；计价覆盖 ${group.pricedCalls}/${group.calls} 次；${group.pricedCalls ? display.costText : '未计价，费用未知'}`
      + `；已报用量未计价 ${group.unpricedCalls} 次，缺用量 ${group.withoutUsage} 次`
      + (group.pricedCalls ? `；计价依据 ${group.costBases.join('、') || '未记录'}` : '')
      + (missing.length ? `；缺价原因：${missing.join('；')}` : '')
  })
  return [...lines, '金额仅为已计价部分的估算，未计价费用未知；执行以 token 限额为硬边界。']
}

export function taskMetricsView(task: Partial<Pick<TaskReadSnapshot, 'usage' | 'execution'>>): string {
  const usage = task.usage ? usageView(task.usage) : undefined
  return `实际 token ${usage?.tokenText ?? '未提供'} · ${usage?.costText ?? '未计价'} · ${task.execution?.available
    ? `已关联 ${task.execution.runCount} 次执行 · ${task.execution.requests} 次预算请求` : '执行与预算请求未知'}`
}

export interface OutboundView {
  key: string; state: 'waiting' | 'pending' | 'delivered' | 'uncertain'; label: string; updatedAt: string
  messageId?: string; chunkIds?: string[]; receiptAt?: string
  originalFailure?: string
  audit: Array<{ at: string; label: string }>
}

const auditLabels = {
  queued: '已保存待发送正文', claimed: '已持久认领一次发送', 'send-failed': '发送结果未知，原失败已保留', 'send-delivered': '已保存真实平台回执',
  'binding-changed': '业务或目标绑定变化，等待核验', 'body-mismatch': '待发送正文摘要不匹配，等待核验', 'occurrence-unverified': '原生发生项未核实，等待核验',
  'reconcile-verified': '平台只读核对目标与完整正文匹配', 'reconcile-not-found': '平台只读核对查无匹配回执',
  'reconcile-mismatch': '平台只读核对目标、正文或回执不匹配', 'reconcile-error': '平台只读核对暂不可用',
}

function outboundViews(rows: ReminderOutboundSnapshot[]): OutboundView[] {
  return rows.map(row => {
    const received = row.state === 'delivered' && typeof row.receipt?.messageId === 'string' && row.receipt.messageId.trim() !== ''
    const state = received ? 'delivered' : row.state === 'waiting' ? 'waiting' : row.state === 'pending' ? 'pending' : 'uncertain'
    return { key: row.key, state, updatedAt: row.updatedAt,
      label: received ? '飞书平台已收到（用户已读未核实）' : state === 'waiting' ? '等待连接恢复，尚未调用发送'
        : state === 'pending' ? '外发处理中，平台收到未核实' : '外发结果待核对，不自动重发',
      ...(row.failure ? { originalFailure: `原失败保留于宿主记录 ${row.key} · ${row.failure.at}` } : {}),
      audit: (row.audit ?? []).map(entry => ({ at: entry.at, label: auditLabels[entry.kind] })),
      ...(received ? { messageId: row.receipt!.messageId, receiptAt: row.updatedAt, ...(row.receipt!.chunkIds ? { chunkIds: [...row.receipt!.chunkIds] } : {}) } : {}) }
  })
}

function externalSummary(rows: OutboundView[]): string {
  if (!rows.length) return '外部渠道送达未核实'
  if (rows.some(row => row.state === 'uncertain')) return '外发有待核对记录，不自动重发'
  if (rows.some(row => row.state === 'pending')) return '外发处理中，平台收到未核实'
  if (rows.some(row => row.state === 'waiting')) return '等待连接恢复，尚未调用发送'
  return '飞书平台已收到（用户已读未核实）'
}

export function reminderView(reminder: TaskReminderSnapshot): { label: string; completion: string; external: string; outbound: OutboundView[]; reason?: string } {
  const outbound = outboundViews(reminder.outbound ?? [])
  const common = { completion: reminder.link?.deliveryState === 'assistant-completed' || outbound.length ? '已记录助手完成' : '助手完成未核实',
    external: reminder.outboundError ? `外发状态不可读：${reminder.outboundError}` : externalSummary(outbound), outbound,
    ...(reminder.history.reason ? { reason: reminder.history.reason } : {}) }
  if (reminder.link?.creationState === 'uncertain') return { ...common, label: '待核对', reason: reminder.history.reason ?? '调度创建结果未知' }
  if (reminder.link?.creationState === 'creating') return { ...common, label: '提交中' }
  if (!reminder.history.available) return { ...common, label: '历史未知', reason: reminder.history.reason }
  const label = reminder.history.deliveryState === 'delivered' ? '已入提醒会话' : reminder.history.deliveryState === 'scheduled' ? '已计划' : '入箱未知'
  return { ...common, label }
}
