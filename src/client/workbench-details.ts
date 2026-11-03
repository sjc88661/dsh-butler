import { createElement as h } from 'react'
import type { HistoryBudget, HistoryItems, HistoryKind, HistoryPage, MemoryStatus, TaskDetail } from './api.ts'
import { budgetViews, runtimeView, usageView, usageBreakdownView, reminderView, reminderOperationView, taskMetricsView, type BudgetView, type OutboundView } from './workbench-model.ts'
import { HistorySection } from './history.ts'
import { artifactFilePath, continuationCommand, type TaskDetailActions } from './workbench-actions.ts'
import { T, STATUS_LABEL, STATUS_COLOR, buttonStyle, emptyLine, section, shortTime, shortDuration, shortNumber } from './view.ts'

export function budgetRow(row: BudgetView): unknown {
  const state = row.state === 'stopped' ? '已停止' : row.state === 'in-flight' ? '有请求预留' : row.state === 'settled' ? '本批请求已结算' : '限额未知'
  return h('details', { key: row.runId, style: { borderTop: `1px solid ${T.border}`, padding: '6px 0', fontSize: '12px' } },
    h('summary', { style: { cursor: 'pointer', color: row.state === 'stopped' ? T.warn : T.text, wordBreak: 'break-all' } }, `${row.kind === 'reminder' ? '提醒' : '普通执行'} · ${state} · ${row.requests} 次发送`),
    emptyLine(`会话 ${row.sessionId} · 执行 ${row.runId}`),
    row.current === undefined ? null : emptyLine(row.current ? '会话当前执行' : '历史执行；结束时间未记录'),
    h('div', {}, `预算计数 ${shortNumber(row.tokens)} token · 当前预留 ${shortNumber(row.reservedTokens)} token`),
    row.remaining ? h('div', { style: { marginTop: '4px' } }, `快照剩余：${row.remaining.requests} 次发送 · ${shortNumber(row.remaining.tokens)} token · ${shortDuration(row.remaining.ms)}`) : emptyLine('剩余额度未知：宿主未提供实际限额'),
    row.stopReason ? h('div', { style: { color: T.warn, marginTop: '4px', wordBreak: 'break-word' } }, `停止原因：${row.stopReason}`) : null,
    Object.keys(row.failures).length ? emptyLine(`保存的连续失败计数：${Object.entries(row.failures).map(([tool, count]) => `${tool} ${count}`).join('；')}`) : null,
    emptyLine(row.note))
}

export function runtimeContent(view: ReturnType<typeof runtimeView>, openTask: (id: string) => void): unknown {
  const label = view.state === 'healthy' ? '运行保护正常' : view.state === 'degraded' ? '保护状态有异常' : '保护状态未知'
  return h('div', {},
    h('div', { style: { fontSize: '13px', color: view.state === 'healthy' ? T.ok : T.warn } }, label),
    emptyLine(view.budgetPolicy),
    h('div', { style: { color: view.channels.attention ? T.warn : T.dim, fontSize: '12px', marginTop: '5px', wordBreak: 'break-word' } }, `${view.channels.summary}；${view.channels.note}`),
    view.problems.map((text, index) => h('div', { key: index, style: { color: T.warn, fontSize: '12px', marginTop: '5px', wordBreak: 'break-word' } }, text)),
    view.attention.length ? h('div', { style: { marginTop: '8px' } }, view.attention.slice(0, 20).map(row => h('div', { key: row.id, style: { padding: '6px 0', borderTop: `1px solid ${T.border}`, fontSize: '12px' } },
      h('strong', { style: { color: T.warn } }, `${row.state === 'creating' ? '提交中' : row.state === 'waiting' ? '等待连接恢复' : row.state === 'pending' ? '外发处理中' : '待核对'}：${row.title}`),
      emptyLine(row.reason), row.taskId ? h('button', { type: 'button', style: buttonStyle, onClick: () => openTask(row.taskId!) }, '查看关联任务') : null))) : null,
    view.budgets.length ? h('div', { style: { marginTop: '8px' } }, emptyLine(`预算记录：最近 ${view.budgets.length}/${view.budgetCount} 项；结算不等于业务完成。`), view.budgets.map(budgetRow)) : emptyLine('没有可读的执行预算记录'))
}

export function memoryContent(memory: MemoryStatus | undefined, error: string | undefined): unknown {
  if (error) return emptyLine(`记忆不可读，原件保留：${error}`)
  if (!memory) return emptyLine('记忆状态未提供')
  const labels = { confirmed: '已确认', proposed: '待确认', rejected: '已拒绝', retracted: '已撤回' }
  const sources = { 'user-input': '明确用户输入', 'native-question': '原生问题确认', 'local-file': '本地文件', unverified: '来源未核实' }
  return h('div', {}, emptyLine(`已确认 ${memory.counts.confirmed} · 待确认 ${memory.counts.proposed} · 已拒绝 ${memory.counts.rejected} · 已撤回 ${memory.counts.retracted}`),
    memory.entries.slice(0, 8).map(row => h('details', { key: row.id, style: { padding: '5px 0', borderTop: `1px solid ${T.border}`, fontSize: '12px' } },
      h('summary', { style: { cursor: 'pointer', wordBreak: 'break-word', color: row.projectionState === 'changed' ? T.warn : T.text } }, `${labels[row.status]} · ${row.text}`),
      emptyLine(`${row.scope === 'topic' ? `主题 ${row.topic ?? ''}` : '稳定偏好 / 边界'} · ${sources[row.provenance.kind]}`),
      row.projectionState === 'changed' ? h('div', { style: { color: T.warn } }, '本地正文已手改，等待核对；不会覆盖。') : null,
      row.provenance.messageId ? emptyLine(`来源消息 ${row.provenance.messageId}`) : null,
      row.supersedes ? emptyLine(`更正自 ${row.supersedes}`) : null,
      row.supersededBy ? emptyLine(`已由 ${row.supersededBy} 更正`) : null)),
    emptyLine('查询、更正与撤回通过对话的记忆工具处理，沿用可信用户确认。'))
}

function sourceReference(value: string | undefined): unknown {
  if (!value) return '未知来源'
  if (/^https?:\/\//i.test(value)) return h('a', { href: value, target: '_blank', rel: 'noopener noreferrer', style: { color: T.brand, wordBreak: 'break-all' } }, value)
  return h('code', { style: { wordBreak: 'break-all' } }, value)
}

const itemStyle = { borderTop: `1px solid ${T.border}`, padding: '6px 0', fontSize: '12px', wordBreak: 'break-word' }

function outboundRows(rows: OutboundView[]): unknown {
  return rows.map(row => h('div', { key: row.key, style: itemStyle },
    h('div', { style: { color: row.state === 'delivered' ? T.ok : T.warn } }, row.label),
    row.messageId ? emptyLine(`平台回执 ${row.messageId} · 回执记录时间 ${row.receiptAt}`) : emptyLine(`外发状态记录更新 ${row.updatedAt}；平台回执未取得`),
    row.chunkIds && row.chunkIds.length > 1 ? emptyLine(`分段平台回执：${row.chunkIds.join('；')}`) : null,
    row.originalFailure ? emptyLine(row.originalFailure) : null,
    row.audit.length ? h('details', null, h('summary', { style: { cursor: 'pointer' } }, '恢复与核对记录'),
      ...row.audit.map((entry, index) => h('div', { key: index }, `${entry.at} · ${entry.label}`))) : null))
}

function usageRows(rows: HistoryItems['usageRecords'][]): unknown {
  return rows.length ? rows.map((row, index) => h('details', { key: index, style: itemStyle },
    h('summary', { style: { cursor: 'pointer' } }, `${shortTime(row.at)} · ${row.provider ?? '未知提供方'}/${row.model ?? '未知模型'}`),
    emptyLine(`总量 ${row.totalTokens === undefined ? '未报告' : shortNumber(row.totalTokens)} · 输入 ${row.inputTokens === undefined ? '未报告' : shortNumber(row.inputTokens)} · 输出 ${row.outputTokens === undefined ? '未报告' : shortNumber(row.outputTokens)} · 缓存读 ${row.cacheReadTokens === undefined ? '未报告' : shortNumber(row.cacheReadTokens)}`),
    emptyLine(`推理 ${row.reasoningTokens === undefined ? '未单列' : shortNumber(row.reasoningTokens)} · ${row.callKind === 'auxiliary'
      ? `辅助调用 ${row.purpose === 'session-title' ? '会话命名' : row.purpose === 'compaction' ? '上下文压缩' : '用途未知'} · ${row.outcome === 'completed' ? '完成' : row.outcome === 'failed' ? '失败' : row.outcome === 'cancelled' ? '取消' : '结果未知'} · 调用 ${row.callId ?? '未知'}`
      : `助手回复 · 原生事件 ${row.eventSeq ?? 'legacy 未知'}`}`),
    emptyLine(row.cost === undefined ? '金额未计价' : `记录估值 ¥${row.cost.toFixed(4)} · ${row.costBasis ?? '依据未记录'}`))) : emptyLine('没有已关联用量记录。')
}

function evidenceRows(rows: HistoryItems['evidence'][]): unknown {
  return rows.length ? rows.map(row => h('details', { key: row.evidenceId, style: itemStyle },
    h('summary', { style: { cursor: 'pointer' } }, `${row.kind} · ${row.summary || row.source_url}`),
    sourceReference(row.source_url), emptyLine(`${row.evidenceId} · ${row.read_level === 'fulltext' ? '全文' : '实际片段 / 摘要'} · ${row.provenance.tool}`),
    emptyLine(`调用 ${row.provenance.callId} · ${shortTime(row.provenance.at)} · ${row.provenance.parserVersion}`),
    row.sha256 ? emptyLine(`登记时 SHA-256 ${row.sha256}`) : null,
    row.anchors.length ? emptyLine(`锚点：${row.anchors.join('；')}`) : null)) : emptyLine('没有已登记证据。')
}

function artifactRows(rows: HistoryItems['artifacts'][], openNote: (path: string) => void, actions?: TaskDetailActions): unknown {
  return rows.length ? rows.map((artifact, index) => {
    const file = artifactFilePath(artifact)
    return h('div', { key: index, style: itemStyle },
      sourceReference(artifact.path ?? artifact.reference), artifact.sha256 ? emptyLine(`登记时 SHA-256 ${artifact.sha256}`) : null,
      artifact.path?.toLowerCase().endsWith('.md') ? h('button', { type: 'button', style: buttonStyle, onClick: () => openNote(artifact.path!) }, '在工作台查看笔记') : null,
      file === undefined ? null : h('button', { type: 'button', style: buttonStyle, disabled: !actions?.openFile, onClick: () => actions?.openFile?.(file) }, '用DSH打开文件'))
  }) : emptyLine('没有已关联产物。')
}

function operationRows(rows: HistoryItems['reminderOperations'][]): unknown {
  return rows.length ? rows.map(operation => {
    const row = reminderOperationView(operation)
    return h('details', { key: row.id, style: itemStyle },
      h('summary', { style: { cursor: 'pointer', color: /待核对|拒绝|未成功/.test(row.label) ? T.warn : T.text } }, `${operation.action === 'cancel' ? '取消' : '创建'} · ${row.label} · ${row.title}`),
      emptyLine(`请求记录 ${shortTime(row.requestedAt)} · 快照更新 ${shortTime(row.updatedAt)}`),
      row.plannedAt ? emptyLine(`计划触发 ${row.plannedAt} · ${operation.timeZone}`) : null,
      emptyLine(`调度 ${operation.scheduleId ?? '未知'}`),
      emptyLine(`来源 ${operation.sourceSessionId} · 执行 ${row.id}`),
      h('div', {}, row.receiptText),
      row.reason ? h('div', { style: { color: T.warn } }, row.reason) : null,
      row.delivery ? h('div', {}, '调度已入提醒会话', emptyLine(`入箱消息 ${row.delivery.messageId ?? '未提供'} · 入箱 ${shortTime(row.delivery.deliveredAt)}`)) : emptyLine('本地未记录调度入箱凭据'),
      emptyLine(`${row.completion} · ${row.external}`), outboundRows(row.outbound))
  }) : emptyLine('没有按任务 ID 关联的本地提醒操作。')
}

function taskHistory<K extends Exclude<HistoryKind, 'tasks' | 'budgets' | 'recentReceipts'>>(id: string, kind: K, preview: unknown, renderPage: (page: HistoryPage<K>) => unknown): unknown {
  return h(HistorySection<K>, { key: `${kind}:${id}`, kind, taskId: id, preview, renderPage })
}

export function taskDetailPane(detail: TaskDetail, close: () => void, receiptRow: (receipt: TaskDetail['receipts'][number]) => unknown, openNote: (path: string) => void, actions?: TaskDetailActions): unknown {
  const usage = usageView(detail.usage), reminder = detail.reminder ? reminderView(detail.reminder) : undefined
  const command = continuationCommand(detail.task.id)
  const reports = new Map(detail.budgets.map(row => [row.taskId, row]))
  const renderBudgets = (rows: HistoryBudget[]): unknown[] => budgetViews(rows.map(row => row.current && reports.has(row.taskId) ? { ...row, ...reports.get(row.taskId)! } : row)).map(budgetRow)
  const knownBudgets = detail.budgetHistory === undefined ? budgetViews(detail.budgets).map(budgetRow) : renderBudgets(detail.budgetHistory.slice(0, 12))
  return h('div', { 'data-butler-task-detail': detail.task.id, style: { margin: '0 14px 12px', border: `1px solid ${T.border2}`, borderRadius: '8px', background: T.bg } },
    h('div', { style: { padding: '12px', display: 'flex', alignItems: 'center', gap: '8px' } },
      h('strong', { style: { flex: '1 1 auto', fontSize: '14px', wordBreak: 'break-word' } }, detail.task.title),
      h('span', { style: { color: STATUS_COLOR[detail.task.status], fontSize: '12px' } }, STATUS_LABEL[detail.task.status]),
      h('button', { type: 'button', style: buttonStyle, onClick: close }, '关闭任务详情')),
    h('div', { style: { padding: '0 12px 12px' } },
      emptyLine(`任务 ${detail.task.id} · 更新 ${shortTime(detail.task.updatedAt)}`),
      detail.task.note ? h('div', { style: { fontSize: '12px', marginBottom: '8px' } }, detail.task.kind === 'reminder' ? `账本备注（提醒状态见下方回执）：${detail.task.note}` : detail.task.note) : null,
      emptyLine(taskMetricsView({ usage: detail.usage, execution: detail.task.execution })),
      emptyLine(`来源会话 ${detail.task.sessionId ?? '未知'} · 用户输入 ${detail.task.originMessageId ?? '未知'} · 初始执行 ${detail.task.runId ?? '未知'}`),
      h('div', { style: { margin: '8px 0', fontSize: '12px' } },
        command === undefined ? h('div', { role: 'alert', style: { color: T.warn } }, '任务 ID 无效，无法生成接续指令。')
          : h('input', { 'aria-label': '任务接续指令', readOnly: true, value: command, style: { boxSizing: 'border-box', width: '100%', color: T.text, background: T.bg2, border: `1px solid ${T.border2}`, padding: '5px 6px', marginBottom: '6px', fontSize: '12px' } }),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: buttonStyle, disabled: command === undefined || !actions?.copyContinuation, onClick: () => actions?.copyContinuation?.() }, '复制接续指令'),
          h('button', { type: 'button', style: buttonStyle, disabled: !actions?.continueWithButler, onClick: () => actions?.continueWithButler?.() }, '和管家继续'),
          h('button', { type: 'button', style: buttonStyle, disabled: !actions?.openSourceConversation, onClick: () => actions?.openSourceConversation?.() }, '打开来源会话')),
        actions?.outcome ? h('div', { role: actions.outcome.ok ? 'status' : 'alert', style: { marginTop: '6px', color: actions.outcome.ok ? T.dim : T.warn, wordBreak: 'break-word' } }, actions.outcome.message) : null),
      detail.controlsError ? emptyLine(detail.controlsError) : null,
      detail.storage.degraded ? h('div', { style: { color: T.warn, fontSize: '12px' } }, detail.storage.diagnostics.map(issue => `${issue.path}：${issue.message}`).join('；')) : null),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px', padding: '0 12px 12px', alignItems: 'start' } },
      section('提供方实际用量', detail.usage.calls, h('div', {}, h('div', { style: { fontSize: '13px' } }, `已报告 token：${usage.tokenText}`),
        emptyLine(`未知调用 ${detail.usage.withoutUsage} · ${usage.costText}，估算不等于账单。`),
        ...usageBreakdownView(detail.usage).map(emptyLine),
        emptyLine(`共 ${detail.usageRecordCount} 条已关联记录；预算预留单列。`),
        taskHistory(detail.task.id, 'usageRecords', usageRows(detail.usageRecords), page => usageRows(page.items)))),
      section('相关执行预算', detail.budgetHistory?.length ?? detail.budgets.length, h('div', {},
        detail.budgetHistoryError ? emptyLine(detail.budgetHistoryError) : null,
        taskHistory(detail.task.id, 'taskBudgets', knownBudgets.length ? knownBudgets : emptyLine('未提供这个任务的保存预算，保持未知。'), page => page.items.length ? budgetViews(page.items).map(budgetRow) : emptyLine('没有已明确关联的预算记录。')))),
      section('工具回执', detail.receiptCount, taskHistory(detail.task.id, 'receipts', h('div', {},
        detail.receipts.length ? detail.receipts.map(receiptRow) : emptyLine('没有已关联回执；不会从相同会话推测。'),
        detail.receiptCount > detail.receipts.length ? emptyLine(`首屏显示 ${detail.receipts.length}/${detail.receiptCount} 条`) : null), page => page.items.length ? page.items.map(receiptRow) : emptyLine('没有已关联回执。'))),
      section('执行时登记的证据', detail.evidenceCount, h('div', {},
        taskHistory(detail.task.id, 'evidence', detail.evidenceAvailable ? evidenceRows(detail.evidence ?? []) : emptyLine(`证据暂不可读：${detail.evidenceError ?? '未知原因'}`), page => evidenceRows(page.items)),
        emptyLine('这里展示执行时记录，不表示本次重新校验了文件。'))),
      section('产物', detail.artifactCount, taskHistory(detail.task.id, 'artifacts', artifactRows(detail.artifacts, openNote, actions), page => artifactRows(page.items, openNote, actions))),
      detail.reminder || detail.reminderOperations.length || detail.reminderOperationsError ? section('本地提醒操作', detail.reminderOperations.length,
        h('div', {}, emptyLine('每项为已保存的操作快照与回执；未保留的中间状态不补造。'),
          taskHistory(detail.task.id, 'reminderOperations', detail.reminderOperationsAvailable === false ? emptyLine(`本地操作不可读：${detail.reminderOperationsError ?? '状态未提供'}`) : operationRows(detail.reminderOperations), page => operationRows(page.items)))) : null,
      detail.reminder && reminder ? section('提醒送达状态与回执', undefined, h('div', {},
        h('div', { style: { color: reminder.label.includes('未知') || reminder.label === '待核对' ? T.warn : T.text, fontSize: '13px' } }, `调度：${reminder.label}`),
        emptyLine(`助手：${reminder.completion}`), emptyLine(`外部渠道：${reminder.external}`), outboundRows(reminder.outbound),
        reminder.reason ? emptyLine(reminder.reason) : null, emptyLine(`调度 ${detail.reminder.link?.scheduleId ?? '未知'}`),
        emptyLine('以下为调度入箱历史，最多最近 20 条；入箱与外部平台回执分别记录。'),
        (detail.reminder.history.records ?? []).map((row, index) => h('div', { key: index, style: itemStyle }, `计划 ${shortTime(row.scheduledAt)} · 入箱 ${shortTime(row.deliveredAt)}`, emptyLine(`入箱消息 ${row.messageId ?? '未提供'}`))))) : null,
      detail.task.evidence?.length && detail.task.evidenceVerification !== 'host-registered' ? section('历史来源 · 未核验', detail.task.evidence.length,
        h('div', {}, detail.task.evidence.map((row, index) => h('div', { key: index, style: itemStyle }, sourceReference(row.source_url), emptyLine('旧记录未升级为已验证证据。'))))) : null))
}
