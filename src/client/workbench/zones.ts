/**
 * The four workbench zones - 今天 / 等你决定 / 资料与技能 / 系统状态 - as plain
 * builder functions over the latest overview snapshot.
 *
 * ## Why builders, not components
 * The zone builders are called directly by the panel so their host elements
 * (task rows, note rows, receipt rows) stay addressable by the existing
 * fake-tree panel harness, which walks host elements rather than rendering
 * function components. The design-system components (`Section`, `Pill`,
 * `StatusDot`, `EmptyState`, `KeyValue`, ...) are used for the chrome around
 * those rows.
 *
 * ## List rows
 * There is no list-row component in the design system yet. The row layout here
 * is therefore expressed with design *tokens* (`BUTLER_TYPE`, `BUTLER_SPACE`,
 * `BUTLER_COLORS`) rather than literal colours or sizes; moving it into the
 * shared stylesheet is a later step. Accessible names are the product
 * contract: `查看任务：<title>` and `查看笔记：<slug>` must not change.
 *
 * @module @dsh-external/dsh-butler/client/workbench
 */
import { createElement as h } from 'react'
import type { HistoryPage, Memo, NoteEntry, Overview, PendingItem, Receipt, ReminderRecord, Task } from '../api.ts'
import {
  BUTLER_COLORS,
  BUTLER_SPACE,
  BUTLER_TYPE,
  Button,
  Divider,
  EmptyState,
  InlineError,
  KeyValue,
  Pill,
  Section,
  StatChip,
  StatusDot,
  statusTone,
  TextField,
  type ButlerTone,
} from '../ui/index.ts'
import { STATUS_LABEL, shortDuration, shortNumber, shortTime } from '../view.ts'
import {
  budgetViews,
  reminderView,
  runtimeView,
  taskMetricsView,
  usageBreakdownView,
  usageCostBreakdownView,
  usageView,
} from '../workbench-model.ts'
import { budgetRow, memoryContent, runtimeContent } from '../workbench-details.ts'
import { HistorySection } from '../history.ts'
import { packRow } from '../packs.ts'

/** 工作台可以一键完成的本地账本动作（不触发任何外部行为）。 */
export type TaskRowAction = 'done' | 'postpone' | 'cancel'

/** 任务行动作回调：面板负责发请求、刷新与提示。 */
export type TaskActionHandler = (action: TaskRowAction, task: Task) => void

/* -------------------------------------------------------------------------- */
/* Shared row/layout styles (design tokens only)                               */
/* -------------------------------------------------------------------------- */

const stackStyle = { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.sm, minWidth: '0' }
const groupStyle = { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.xs, minWidth: '0' }
const rowStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: BUTLER_SPACE.sm,
  boxSizing: 'border-box',
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer',
  border: '0',
  borderTop: `1px solid ${BUTLER_COLORS.borderL1}`,
  background: 'transparent',
  color: BUTLER_COLORS.labelPrimary,
  font: 'inherit',
  padding: `${BUTLER_SPACE.sm} ${BUTLER_SPACE.xs}`,
}
const rowSelectedStyle = { background: BUTLER_COLORS.bgLayer2 }
const rowBodyStyle = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0', flex: '1 1 auto' }
const titleStyle = { fontSize: BUTLER_TYPE.body, lineHeight: BUTLER_TYPE.bodyLine, color: BUTLER_COLORS.labelPrimary, overflowWrap: 'anywhere' }
const metaStyle = { fontSize: BUTLER_TYPE.secondary, lineHeight: BUTLER_TYPE.secondaryLine, color: BUTLER_COLORS.labelSecondary, overflowWrap: 'anywhere' }
const microStyle = { fontSize: BUTLER_TYPE.micro, lineHeight: BUTLER_TYPE.microLine, color: BUTLER_COLORS.labelSecondary, overflowWrap: 'anywhere' }
const heading3Style = {
  margin: 0,
  fontSize: BUTLER_TYPE.secondary,
  lineHeight: BUTLER_TYPE.secondaryLine,
  fontWeight: BUTLER_TYPE.weightSemibold,
  color: BUTLER_COLORS.labelSecondary,
}
const mutedLine = (text: string, key?: string | number): unknown =>
  h('div', { key, style: metaStyle }, text)

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One task row: state dot, title, status pill, recent time; click opens detail.
 *
 * The reminder/delivery sentence keeps the exact composition the pre-rework
 * row used: it is the only place the dashboard states whether a reminder was
 * delivered, whether the assistant finished, and what the external channel
 * reported - three separate facts that must not be merged into one status.
 * @param task - ledger task snapshot.
 * @param openTask - open the task detail drawer.
 * @param selected - whether this task's drawer is the open one.
 * @param operations - reminder operation snapshots from the runtime controls.
 * @returns the row element.
 */
export function taskRow(task: Task, openTask: (id: string) => void, selected: boolean, operations: NonNullable<Overview['runtimeControls']>['reminderOperations'] = [], taskActions?: TaskActionHandler): unknown {
  const evidence = task.evidence?.length ?? 0
  const reminder = task.kind === 'reminder' || task.reminder !== undefined
  const delivery = reminder ? reminderView({
    link: task.reminder,
    history: { available: false, deliveryState: 'unknown' },
    outbound: operations.filter(row => row.taskId === task.id && row.action === 'create').flatMap(row => row.outbound ?? []),
  }) : undefined
  const note = reminder ? `${task.reminder?.creationState === 'uncertain' ? '提醒创建待核对'
    : task.reminder?.deliveryState === 'delivered' || task.reminder?.deliveryState === 'assistant-completed' ? '调度已入提醒会话' : '提醒调度记录'}；${delivery!.completion}；${delivery!.external}；回执见详情` : task.note
  const meta = [
    `${reminder ? '账本' : ''}${STATUS_LABEL[task.status]}`,
    task.dueAt === undefined ? '' : ` · 到期 ${shortTime(task.dueAt)}`,
    evidence === 0 ? '' : ` · 证据 ${evidence}`,
    note === undefined || note === '' ? '' : ` · ${note}`,
  ].filter((part) => part !== '').join('')
  // Reminder tasks already carry their own delivery surface; one-click task
  // bookkeeping must not appear to "complete" a scheduled reminder.
  const actionable = taskActions !== undefined && task.kind !== 'reminder' && task.status !== 'done' && task.status !== 'cancelled'
  return h('div', { key: task.id, style: { display: 'flex', alignItems: 'stretch', gap: BUTLER_SPACE.xs, minWidth: '0' } },
    h('button', {
      type: 'button',
      onClick: () => openTask(task.id),
      'aria-label': `查看任务：${task.title}`,
      'aria-current': selected ? 'true' : undefined,
      style: { ...rowStyle, ...(selected ? rowSelectedStyle : {}), flex: '1 1 auto', minWidth: '0' },
    },
    h(StatusDot, { tone: statusTone(task.status), size: 8, label: STATUS_LABEL[task.status] }),
    h('div', { style: rowBodyStyle },
      h('div', { style: titleStyle }, task.title),
      h('div', { style: metaStyle }, meta),
      h('div', { style: metaStyle }, taskMetricsView(task))),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: BUTLER_SPACE.xs, marginLeft: 'auto' } },
      h(Pill, { tone: statusTone(task.status) }, STATUS_LABEL[task.status]),
      h('span', { style: microStyle }, `最近 ${shortTime(task.updatedAt)}`))),
    actionable ? h('div', { style: { display: 'flex', alignItems: 'center', gap: BUTLER_SPACE.xs, flex: '0 0 auto' } },
      h(Button, { size: 'sm', variant: 'ghost', ariaLabel: `完成任务：${task.title}`, onClick: () => taskActions('done', task) }, '完成'),
      h(Button, { size: 'sm', variant: 'ghost', ariaLabel: `改期任务：${task.title}`, onClick: () => taskActions('postpone', task) }, '改期'),
      h(Button, { size: 'sm', variant: 'ghost', ariaLabel: `取消任务：${task.title}`, onClick: () => taskActions('cancel', task) }, '取消')) : null)
}

/**
 * 一条提醒：状态点、标题、计划时间、最近投递与启用状态。
 *
 * 只呈现调度目录的快照。「已启用 / 已排期 / 已投递 / 助手已处理 / 外部平台
 * 已送达」是互相独立的事实，这里不合并成一句"成功"。
 * @param record - 调度目录里的一条提醒。
 * @returns 该行元素。
 */
export function reminderRow(record: ReminderRecord): unknown {
  const armed = record.status !== 'inactive'
  const tone = armed ? statusTone('pending') : statusTone('cancelled')
  const delivery = record.lastDelivery === undefined
    ? '尚未投递'
    : `最近投递 ${shortTime(record.lastDelivery.deliveredAt)}`
  const schedule = record.scheduledAt === undefined ? '计划时间未提供' : `计划 ${shortTime(record.scheduledAt)}`
  return h('div', { key: record.id, style: { ...rowStyle, cursor: 'default' }, 'data-butler-reminder': record.id },
    h(StatusDot, { tone, size: 8, label: armed ? '启用中' : '已停止' }),
    h('div', { style: rowBodyStyle },
      h('div', { style: titleStyle }, record.title ?? record.prompt ?? record.id),
      h('div', { style: metaStyle }, `${schedule} · ${delivery}`)),
    h(Pill, { tone }, armed ? '启用中' : '已停止'))
}

/**
 * One activity receipt row.
 * @param receipt - the recorded tool call.
 * @param index - stable index for list keys when the receipt carries no id.
 * @returns the row element.
 */
export function receiptRow(receipt: Receipt, index = 0): unknown {
  return h('div', {
    key: `${receipt.callId ?? receipt.tool}:${receipt.at}:${index}`,
    style: {
      display: 'flex', gap: BUTLER_SPACE.sm, alignItems: 'baseline',
      padding: `${BUTLER_SPACE.xs} 0`, borderTop: `1px solid ${BUTLER_COLORS.borderL1}`,
    },
  },
  h('span', {
    style: {
      flex: '0 0 auto', fontFamily: 'ui-monospace, monospace',
      color: receipt.ok ? BUTLER_COLORS.success : BUTLER_COLORS.error,
    },
  }, receipt.ok ? '✓' : '✗'),
  h('div', { style: { ...rowBodyStyle } },
    h('div', { style: { ...titleStyle, fontSize: BUTLER_TYPE.secondary, lineHeight: BUTLER_TYPE.secondaryLine, wordBreak: 'break-all' } },
      `${receipt.tool}${receipt.summary === undefined ? '' : ` · ${receipt.summary}`}`),
    h('div', { style: microStyle }, `${shortTime(receipt.at)} · ${shortDuration(receipt.ms)}`),
    receipt.callId ? h('div', { style: microStyle }, `调用 ${receipt.callId} · 执行 ${receipt.runId ?? '未知'}`) : null,
    receipt.error === undefined
      ? null
      : h('div', { style: { ...microStyle, color: BUTLER_COLORS.error } }, receipt.error)))
}

/**
 * A clickable note row (opens the note detail drawer).
 * @param entry - the note file entry.
 * @param onOpen - opens the note detail drawer by slug.
 * @param selected - whether this note's drawer is the open one.
 * @returns the row element.
 */
export function noteRow(entry: NoteEntry, onOpen: (slug: string) => void, selected: boolean): unknown {
  const slug = entry.path.replace(/^notes\//, '').replace(/\.md$/, '')
  return h('button', {
    key: entry.path, type: 'button', 'aria-label': `查看笔记：${slug}`,
    'aria-current': selected ? 'true' : undefined,
    onClick: () => { onOpen(slug) },
    style: { ...rowStyle, borderRadius: '6px', ...(selected ? rowSelectedStyle : {}) },
  },
  h('div', { style: rowBodyStyle },
    h('div', { style: titleStyle }, slug),
    h('div', { style: microStyle }, `${entry.size}B · ${shortTime(entry.modified)}`)))
}

/** A clickable decision row for items that open a non-task drawer. */
function decisionRow(key: string, ariaLabel: string, title: string, detail: string, onOpen: () => void, tone: ButlerTone): unknown {
  return h('button', {
    key, type: 'button', 'aria-label': ariaLabel, onClick: onOpen,
    style: rowStyle,
  },
  h('div', { style: rowBodyStyle },
    h('div', { style: titleStyle }, title),
    h('div', { style: metaStyle }, detail)),
  h(Pill, { tone }, '待你决定'))
}

/* -------------------------------------------------------------------------- */
/* Zone 1 - 今天                                                               */
/* -------------------------------------------------------------------------- */

/** Props of {@link todayZone}. */
export interface TodayZoneProps {
  overview: Overview
  /** Open a task detail drawer. */
  openTask: (id: string) => void
  /** One-click local bookkeeping on the owner's tasks. */
  taskActions?: TaskActionHandler
  /** Task whose drawer is currently open. */
  selectedTaskId: string | null
}

/**
 * 今天: the owner's open work, running first because that is the only thing
 * that is moving without them.
 * @param props - overview and row callbacks.
 * @returns the `今天` section.
 */
export function todayZone(props: TodayZoneProps): unknown {
  const ledger = props.overview.ledger
  const tasks = ledger?.open ?? []
  const running = tasks.filter(task => task.status === 'running').length
  const operations = props.overview.runtimeControls?.reminderOperations
  return h(Section, {
    title: '今天',
    count: ledger === undefined ? undefined : tasks.length,
    hint: tasks.length === 0 ? undefined : `进行中 ${running} · 待办 ${tasks.length - running}`,
    bodyId: 'butler-zone-today',
  },
  ledger === undefined
    ? h(EmptyState, { title: '账本暂不可读', description: '待办与在跑的任务来自账本快照；账本恢复后会自动出现。' })
    : tasks.length === 0
      ? h(EmptyState, { title: '今天没有在跑的事', description: '跟我说要做什么就行。' })
      : h('div', { style: groupStyle }, ...tasks.map(task => taskRow(task, props.openTask, task.id === props.selectedTaskId, operations, props.taskActions))))
}

/* -------------------------------------------------------------------------- */
/* Zone 2 - 等你决定                                                           */
/* -------------------------------------------------------------------------- */

/** Props of {@link decisionsZone}. */
export interface DecisionsZoneProps {
  overview: Overview
  openTask: (id: string) => void
  /** Open the memory-proposal drawer. */
  openMemo: (memo: Memo) => void
  /** Open the pending-approval drawer. */
  openApproval: (item: PendingItem) => void
  /** Open the snapshot drawer for an uncertain item that has no task id. */
  openNotice: (title: string, detail: string) => void
  /** One-click local bookkeeping on the owner's tasks. */
  taskActions?: TaskActionHandler
  selectedTaskId: string | null
}

/**
 * 等你决定: everything the host recorded as *not yet decided* - uncertain
 * reminder hand-offs, interrupted tasks, pending approvals and proposed
 * memories. Interrupted tasks are real rows now, not a number in the footer.
 * @param props - overview and row callbacks.
 * @returns the `等你决定` section.
 */
export function decisionsZone(props: DecisionsZoneProps): unknown {
  const overview = props.overview
  const ledger = overview.ledger
  const pending = ledger?.pending ?? []
  const memos = ledger?.proposedMemos ?? []
  const interrupted = ledger?.interrupted ?? []
  const attention = runtimeView(overview.runtimeControls).attention
  const count = pending.length + memos.length + interrupted.length + attention.length
  const operations = overview.runtimeControls?.reminderOperations
  const groups: unknown[] = []

  if (attention.length > 0) {
    groups.push(h('div', { style: groupStyle },
      h('h3', { style: heading3Style }, '待核对 · 交接与提醒'),
      ...attention.map(row => h('button', {
        key: row.id,
        type: 'button',
        onClick: () => {
          if (row.taskId === undefined) props.openNotice(row.title, row.reason)
          else props.openTask(row.taskId)
        },
        'aria-label': `查看待核对：${row.title}`,
        style: rowStyle,
      },
      h('div', { style: rowBodyStyle },
        h('div', { style: titleStyle }, row.title),
        h('div', { style: metaStyle }, row.reason)),
      h(Pill, { tone: statusTone('waiting_review') }, '待核对')))))
  }
  if (interrupted.length > 0) {
    groups.push(h('div', { style: groupStyle },
      h('h3', { style: heading3Style }, '重启打断 · 未自动重试'),
      ...interrupted.map(task => taskRow(task, props.openTask, task.id === props.selectedTaskId, operations, props.taskActions))))
  }
  if (pending.length > 0) {
    groups.push(h('div', { style: groupStyle },
      h('h3', { style: heading3Style }, '等你点头'),
      ...pending.map(item => decisionRow(`approval:${item.id}`, `查看待批准：${item.title}`, item.title,
        `因为：${item.reason}`, () => props.openApproval(item), statusTone('waiting_review')))))
  }
  if (memos.length > 0) {
    groups.push(h('div', { style: groupStyle },
      h('h3', { style: heading3Style }, '记忆提案'),
      ...memos.map(memo => decisionRow(`memo:${memo.id}`, `查看记忆提案：${memo.text}`, memo.text,
        memo.source === 'user' ? '来自你的明确输入' : '管家提出，等待你确认', () => props.openMemo(memo), statusTone('waiting_review')))))
  }

  return h(Section, {
    title: '等你决定',
    count,
    hint: count === 0 ? undefined : '这些都不会自己执行',
    bodyId: 'butler-zone-decisions',
  },
  ledger === undefined && count === 0
    ? h(EmptyState, { title: '账本暂不可读', description: '无法判断待决定事项；状态条会显示账本错误，恢复后这里会自动出现。' })
    : count === 0
      ? h(EmptyState, { title: '没有等你决定的事', description: '外部动作我都不会自己执行。' })
      : h('div', { style: stackStyle }, ...groups))
}

/* -------------------------------------------------------------------------- */
/* Zone 3 - 资料与技能                                                         */
/* -------------------------------------------------------------------------- */

/** Props of {@link resourcesZone}. */
export interface ResourcesZoneProps {
  overview: Overview
  /** Visible vault notes (already fetched by the panel). */
  notes: NoteEntry[]
  /** Note listing failure, when the last read failed. */
  notesError?: string | undefined
  /** Current client-side search filter for the note list. */
  noteQuery: string
  /** Change the note search filter; the panel resets the page size. */
  onNoteQuery: (value: string) => void
  /** Notes matching the filter that are not rendered yet. */
  noteRemaining: number
  /** Render the next page of matching notes. */
  onShowMoreNotes: () => void
  /** Retry the note listing read. */
  onRetryNotes: () => void
  /** Open the note detail drawer. */
  openNote: (slug: string) => void
  /** Note whose drawer is currently open. */
  selectedSlug: string | null
}

/**
 * 资料与技能: notes, capability packs and the document Space, collapsed by
 * default because they are reference material rather than today's work.
 * @param props - overview and note callbacks.
 * @returns the `资料与技能` section.
 */
export function resourcesZone(props: ResourcesZoneProps): unknown {
  const packs = props.overview.packs
  const noteTotal = props.notes.length + props.noteRemaining
  const searching = props.noteQuery.trim() !== ''
  const packCount = packs?.length
  const enabledPacks = packs === undefined ? undefined : packs.filter(pack => pack.enabled).length
  const groups: unknown[] = []
  groups.push(h('div', { style: groupStyle },
    h('h3', { style: heading3Style }, searching ? `文档 Space · 匹配 ${noteTotal} 篇` : `文档 Space · ${noteTotal} 篇`),
    props.notesError === undefined
      ? null
      : h(InlineError, {
        message: `笔记读取失败：${props.notesError}；已显示的列表保留为上次快照。`,
        retry: props.onRetryNotes,
        retryLabel: '重试',
      }),
    noteTotal === 0 && !searching
      ? h(EmptyState, { title: '还没有笔记', description: '让管家整理一篇就会出现在这里。' })
      : h(TextField, {
        value: props.noteQuery,
        placeholder: '按笔记路径搜索',
        ariaLabel: '搜索笔记',
        onChange: props.onNoteQuery,
      }),
    noteTotal === 0 && searching
      ? h(EmptyState, { title: '没有匹配的笔记', description: '换个关键词，或清空搜索看全部笔记。' })
      : h('div', { style: groupStyle }, ...props.notes.map(entry => {
        const slug = entry.path.replace(/^notes\//, '').replace(/\.md$/, '')
        return noteRow(entry, props.openNote, slug === props.selectedSlug)
      })),
    props.noteRemaining > 0
      ? h('div', { style: rowStyle },
        h(Button, { size: 'sm', variant: 'ghost', onClick: props.onShowMoreNotes }, `显示更多（剩余 ${props.noteRemaining} 篇）`))
      : null))
  groups.push(h('div', { style: groupStyle },
    h('h3', { style: heading3Style }, packs === undefined ? '技能包 · 未读到' : `技能包 · ${enabledPacks}/${packCount} 已启用`),
    props.overview.packsError !== undefined
      ? h(InlineError, { message: `能力包列表读不出来：${props.overview.packsError}` })
      : packs === undefined
        ? h(EmptyState, { title: '能力包列表未提供', description: '旧版宿主不返回能力包清单；不影响工作台其余部分。' })
        : packs.length === 0
          ? h(EmptyState, { title: '没有可用的能力包', description: '装包用 butler_pack，或自己在 vault/packs 里写一个。' })
          : h('div', { style: groupStyle }, ...packs.map(packRow))))

  return h(Section, {
    title: '资料与技能',
    count: noteTotal + (packCount ?? 0),
    hint: `笔记 ${noteTotal} · 技能包 ${packs === undefined ? '未读到' : `${enabledPacks}/${packCount} 启用`}`,
    collapsible: true,
    defaultOpen: false,
    bodyId: 'butler-zone-resources',
  },
  h('div', { style: { ...stackStyle, gap: BUTLER_SPACE.md } }, ...groups))
}

/* -------------------------------------------------------------------------- */
/* Zone 4 - 系统状态                                                           */
/* -------------------------------------------------------------------------- */

/** Human label for the butler session's last state. */
const SESSION_LABEL: Record<string, string> = {
  live: '已在',
  created: '新建',
  resumed: '已恢复',
  failed: '建不起来',
}

/**
 * Turn the host's price basis into something a reader can check.
 * @param basis - the stored basis, e.g. `official-2026-09-10/flash/offPeak`.
 * @returns a human label.
 */
function basisLabel(basis: string): string {
  if (!/^official-\d{4}-\d{2}-\d{2}\/(flash|pro)\/(peak|offPeak)$/.test(basis)) return basis === 'unknown' ? '未记录' : `已存依据 ${basis}`
  const [table = '', row = '', period = ''] = basis.split('/')
  const date = table.replace('official-', '')
  const column = period === 'peak' ? '高峰时段' : period === 'offPeak' ? '非高峰时段' : period
  return `官方价目表 ${date} 版，${row || '未知档'}·${column || '未知时段'}`
}

/**
 * The usage / recorder / backfill sentences that used to be joined into the
 * 30-item footer paragraph. They stay verbatim: the same strings carry the
 * provenance (price table version, coverage boundaries, unknown usage).
 * @param overview - the current overview snapshot.
 * @returns the detail lines, in reading order.
 */
function usageDetailLines(overview: Overview): string[] {
  const lines: string[] = []
  const usage = overview.ledger?.usage
  if (usage !== undefined) {
    if (usage.calls > 0) {
      const display = usageView(usage)
      const hit = Math.round(usage.cacheHitRate * 100)
      const live = `实时 ${usage.liveCalls}`
      const recovered = usage.backfilledCalls > 0 ? ` + 启动回填 ${usage.backfilledCalls}` : ''
      const used: string[] = [
        `${usage.calls} 次已记录模型调用（本机全部会话：${live}${recovered}）`,
        `提供方已报告 ${display.tokenText} tokens`,
        `已报告未缓存输入 ${shortNumber(usage.inputTokens)} / 输出 ${shortNumber(usage.outputTokens)}`,
      ]
      if (usage.cacheReadTokens > 0) used.push(`缓存读 ${shortNumber(usage.cacheReadTokens)}（占已报告输入 ${hit}%）`)
      if (usage.reasoningTokens > 0) used.push(`推理 ${shortNumber(usage.reasoningTokens)}`)
      if (usage.sessions > 1) used.push(`来自 ${usage.sessions} 个会话`)
      lines.push(used.join('，'))
      lines.push(...usageBreakdownView(usage))
      lines.push(...usageCostBreakdownView(usage))
      lines.push(`费用：${display.costText}（估算，非账单）`)
      if (usage.pricedCalls > 0) {
        if (usage.byProviderModel === undefined) lines.push(`计价依据（旧服务未提供逐模型细分）：${basisLabel(usage.costBasis)}`)
        if (usage.derivedCalls > 0) lines.push(`其中 ${usage.derivedCalls} 次按已存价目表回算，依据见成本细分`)
      }
      const other = Math.max(0, usage.calls - usage.butlerCalls - usage.scopeUnknown)
      const unknown = usage.scopeUnknown > 0 ? `，另有 ${usage.scopeUnknown} 次归属未定` : ''
      lines.push(`其中管家会话 ${usage.butlerCalls} 次 / 已报告未缓存输入与输出 ${shortNumber(usage.butlerNewTokens)} tokens，其他会话 ${other} 次${unknown}`)
    } else {
      lines.push('用量：还没记录到模型调用')
    }
    lines.push('覆盖：助手回复由会话事件及日志回填记录；会话命名、上下文压缩在插件运行时实时观察。其他用途、无用途标记的辅助流及未加载时段未保证覆盖，未知用量与未计价部分未包含在金额中。')
  }
  const backfill = overview.usageBackfill
  if (backfill !== undefined) {
    if (backfill.running) lines.push('启动回填：正在核对会话日志')
    else if (backfill.problem !== undefined) lines.push(`启动回填失败：${backfill.problem}`)
    else if (backfill.added > 0) lines.push(`启动回填补记 ${backfill.added} 次调用（实时记录漏掉的）`)
    if (backfill.last) {
      if (backfill.last.ambiguousLegacy > 0) lines.push(`${backfill.last.ambiguousLegacy} 条旧用量记录无法唯一配对，已保留待核对，总量可能重叠`)
      if (backfill.last.skips.length > 0) lines.push(`回填跳过 ${backfill.last.skips.length} 项：${backfill.last.skips.slice(0, 2).join('；')}`)
      if (backfill.last.problems.length > 0) lines.push(`回填问题：${backfill.last.problems.slice(0, 2).join('；')}`)
    }
  }
  const recorder = overview.usageRecorder
  if (recorder !== undefined && (recorder.listening === false || recorder.problem !== undefined)) {
    lines.push(`用量记录没接上：${recorder.problem ?? 'session/event 事件未订阅'}`)
  }
  if (recorder !== undefined && recorder.withoutUsage > 0) {
    lines.push(`${recorder.withoutUsage} 次调用没有用量字段（按未知计，不当成 0）`)
  }
  if (recorder !== undefined && recorder.unpriced > 0) {
    lines.push(`${recorder.unpriced} 次实时记录未取得计价金额（包括缺用量；费用未知）`)
  }
  if (recorder !== undefined && (recorder.auxiliaryListening === false || recorder.auxiliaryProblem !== undefined)) {
    lines.push(`辅助用量观察：${recorder.auxiliaryProblem ?? 'llm/stream 事件未订阅'}`)
  }
  if (recorder !== undefined && recorder.uncoveredPurposeStreams > 0) {
    lines.push(`${recorder.uncoveredPurposeStreams} 次流使用未识别用途，未按辅助调用计入；若为助手回复仍由原生事件记录`)
  }
  if (recorder !== undefined && recorder.failed > 0) {
    lines.push(`用量记录出错 ${recorder.failed} 次`)
  }
  const interrupted = overview.ledger?.interrupted.length ?? 0
  if (interrupted > 0) lines.push(`重启打断 ${interrupted} 件（未自动重试）`)
  const session = overview.session
  if (session !== undefined) {
    lines.push(`会话 ${session.id}（${SESSION_LABEL[session.state] ?? session.state}，标题「${session.title}」${session.titlePinned ? '已钉住' : '未钉住'}）`)
    if (session.note !== undefined && session.note !== '') lines.push(session.note)
  }
  return lines
}

/** Props of {@link systemZone}. */
export interface SystemZoneProps {
  overview: Overview
  /** Open a task detail drawer (used by attention rows inside runtime controls). */
  openTask: (id: string) => void
  /** Re-read the overview; used by retry affordances. */
  onRefresh: () => void
}

/**
 * 系统状态: budgets, storage, usage and history - the evidence a reader checks
 * when a number looks wrong. Collapsed by default; the expanded body carries
 * the same facts the old footer paragraph did, as chips and a key/value list.
 * @param props - overview and callbacks.
 * @returns the `系统状态` section.
 */
export function systemZone(props: SystemZoneProps): unknown {
  const overview = props.overview
  const controls = runtimeView(overview.runtimeControls)
  const ledger = overview.ledger
  const usage = ledger?.usage
  const recorder = overview.usageRecorder
  const storage = overview.runtimeControls?.storage
  const budgetCount = controls.budgetCount
  const detailLines = usageDetailLines(overview)
  const reminders = overview.remindersAvailable
    ? `${overview.reminders.filter(row => row.status !== 'inactive').length} 条启用`
    : '未读到'
  const recorderLabel = recorder === undefined
    ? '未提供'
    : recorder.listening ? `监听中 · 记录 ${recorder.recorded} 次` : '未接上'
  const sessionLabel = overview.session === undefined
    ? '未提供'
    : `${overview.session.id}（${SESSION_LABEL[overview.session.state] ?? overview.session.state}）`

  return h(Section, {
    title: '系统状态',
    hint: `更新于 ${shortTime(overview.generatedAt)} · ${overview.timeZone}`,
    collapsible: true,
    defaultOpen: false,
    bodyId: 'butler-zone-system',
  },
  h('div', { className: 'butler-row' },
    h(StatChip, {
      label: '预算记录',
      value: String(budgetCount),
      tone: controls.state === 'healthy' ? statusTone('done') : controls.state === 'degraded' ? statusTone('waiting_review') : statusTone('pending'),
    }),
    h(StatChip, {
      label: '存储',
      value: storage === undefined ? '未知' : storage.degraded ? '降级' : '正常',
      tone: storage === undefined ? statusTone('pending') : storage.degraded ? statusTone('failed') : statusTone('done'),
    }),
    h(StatChip, {
      label: '用量调用',
      value: usage === undefined ? '未提供' : shortNumber(usage.calls),
      tone: usage === undefined ? statusTone('pending') : statusTone('done'),
    }),
    h(StatChip, {
      label: '记录器',
      value: recorderLabel,
      tone: recorder === undefined ? statusTone('pending') : recorder.listening ? statusTone('done') : statusTone('failed'),
    })),
  overview.remindersError === undefined
    ? null
    : h(InlineError, { message: `提醒不可读：${overview.remindersError}`, retry: props.onRefresh, retryLabel: '重试' }),
  h('div', { style: stackStyle },
    h(KeyValue, { label: '数据目录', value: overview.vault.home }),
    h(KeyValue, { label: '数据文件', value: `${overview.vault.files.length} 个` }),
    h(KeyValue, { label: '提醒', value: reminders }),
    h(KeyValue, {
      label: '预算记录',
      value: `${budgetCount} 项 · ${controls.state === 'healthy' ? '运行保护正常' : controls.state === 'degraded' ? '保护状态有异常' : '保护状态未知'}`,
      tone: controls.state === 'healthy' ? 'success' : controls.state === 'degraded' ? 'warn' : 'neutral',
    }),
    h(KeyValue, { label: '管家会话', value: sessionLabel }),
    h(KeyValue, {
      label: '记录器版本',
      value: overview.runtimeControls?.version ?? '未提供',
    }),
    detailLines.length === 0
      ? null
      : h('div', { style: stackStyle, 'data-butler-usage-details': '' }, ...detailLines.map((line, index) => mutedLine(line, index)))),
  h(Divider),
  h('h3', { style: heading3Style }, overview.remindersAvailable ? `提醒 · ${overview.reminders.length} 条` : '提醒 · 未读到'),
  overview.remindersAvailable
    ? overview.reminders.length === 0
      ? mutedLine('还没有建立提醒。')
      : h('div', { style: groupStyle }, ...overview.reminders.slice(0, 20).map(reminderRow),
        overview.reminders.length > 20 ? mutedLine(`只显示前 20 条，共 ${overview.reminders.length} 条。`) : null)
    : mutedLine('当前宿主没有提供提醒目录：计数与列表都不可读，不代表没有提醒。'),
  h('h3', { style: heading3Style }, '运行保护与预算'),
  runtimeContent(controls, props.openTask),
  h('h3', { style: heading3Style }, '保存的运行预算'),
  h(HistorySection<'budgets'>, {
    kind: 'budgets',
    limit: 12,
    preview: mutedLine('浏览保存的全部运行预算，含同会话较早的运行及停止记录。'),
    renderPage: (page: HistoryPage<'budgets'>) => h('div', {},
      mutedLine('保存的运行预算；旧运行未记录的限额与剩余保持未知。'),
      page.items.length ? budgetViews(page.items).map(budgetRow) : mutedLine('没有保存的运行预算。')),
  }),
  h('h3', { style: heading3Style }, overview.taskHistory === undefined ? '任务记录' : `任务记录 · ${overview.taskHistory.total} 项`),
  overview.taskHistory === undefined
    ? mutedLine('任务记录暂不可读；已完成任务需要独立详情。')
    : h(HistorySection<'tasks'>, {
      kind: 'tasks',
      limit: 50,
      preview: h('div', { style: { maxHeight: '300px', overflow: 'auto' } },
        overview.taskHistory.tasks.length
          ? overview.taskHistory.tasks.map(row => taskRow(row, props.openTask, false, overview.runtimeControls?.reminderOperations))
          : mutedLine('还没有任务记录。'),
        overview.taskHistory.total > overview.taskHistory.tasks.length
          ? mutedLine(`首屏 ${overview.taskHistory.tasks.length}/${overview.taskHistory.total} 项，可浏览完整历史。`)
          : null),
      renderPage: (page: HistoryPage<'tasks'>) => h('div', { style: { maxHeight: '360px', overflow: 'auto' } },
        page.items.length
          ? page.items.map(row => taskRow(row, props.openTask, false, overview.runtimeControls?.reminderOperations))
          : mutedLine('还没有任务记录。')),
    }),
  h('h3', { style: heading3Style }, '它刚做了什么'),
  ledger === undefined || ledger.recent.length === 0
    ? mutedLine('还没有工具回执。每次工具调用都会在这里留一行。')
    : h(HistorySection<'recentReceipts'>, {
      kind: 'recentReceipts',
      preview: h('div', {}, ledger.recent.slice(0, 12).map(receiptRow)),
      renderPage: (page: HistoryPage<'recentReceipts'>) => h('div', {},
        mutedLine('全局工具回执；没有任务身份的旧记录保持归属未知。'),
        page.items.length ? page.items.map(receiptRow) : mutedLine('没有工具回执。')),
    }),
  h('h3', { style: heading3Style }, '记忆状态与来源'),
  memoryContent(overview.memory, overview.memoryError))
}
