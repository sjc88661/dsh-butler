/**
 * The butler workbench: a center-column page rendered through the layout's
 * keyed `main` seat, mirroring how the shipped Plugins/Schedule pages and the
 * task board occupy that seat.
 *
 * @module @dsh-external/dsh-butler/client
 */
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  fetchNote, fetchOverview, fetchTask,
  type ButlerSession, type HistoryPage, type NoteEntry, type NoteResult, type Overview, type PackEntry, type Receipt, type Task, type TaskDetail, type UsageTotals,
} from './api.ts'
import { PANEL_ID } from './ids.ts'
import { T, STATUS_LABEL, STATUS_COLOR, shortTime, shortDuration, shortNumber, emptyLine, section, buttonStyle } from './view.ts'
import { openButlerConversation, rememberReadySession } from './navigate.ts'
import { budgetViews, runtimeView, usageView, usageBreakdownView, usageCostBreakdownView, taskMetricsView, reminderView } from './workbench-model.ts'
import { budgetRow, runtimeContent, memoryContent, taskDetailPane } from './workbench-details.ts'
import { continueTaskWithButler, copyTaskContinuation, openTaskFile, openTaskSourceConversation, subscribeTaskFiles, taskFileSnapshot, type TaskActionOutcome } from './workbench-actions.ts'
import { HistorySection } from './history.ts'
import { packRow } from './packs.ts'

/** Poll cadence while the seat is mounted. */
const POLL_MS = 15000

/**
 * Turn the host's price basis into something a reader can check.
 *
 * The host stores `official-<effective-date>/<row>/<period>` on every priced
 * row, so the panel can name the table and the column instead of printing a
 * number with no provenance.
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
 * One open task row: state dot, title, due date and evidence count.
 * @param task - the ledger task.
 * @returns the row element.
 */
function taskRow(task: Task, openTask: (id: string) => void, selected: boolean, operations: NonNullable<Overview['runtimeControls']>['reminderOperations'] = []): unknown {
  const evidence = task.evidence?.length ?? 0
  const reminder = task.kind === 'reminder' || task.reminder !== undefined
  const delivery = reminder ? reminderView({ link: task.reminder, history: { available: false, deliveryState: 'unknown' },
    outbound: operations.filter(row => row.taskId === task.id && row.action === 'create').flatMap(row => row.outbound ?? []) }) : undefined
  const note = reminder ? `${task.reminder?.creationState === 'uncertain' ? '提醒创建待核对'
    : task.reminder?.deliveryState === 'delivered' || task.reminder?.deliveryState === 'assistant-completed' ? '调度已入提醒会话' : '提醒调度记录'}；${delivery!.completion}；${delivery!.external}；回执见详情` : task.note
  return h('button', {
    key: task.id, type: 'button', onClick: () => openTask(task.id), 'aria-label': `查看任务：${task.title}`,
    style: {
      display: 'flex', gap: '8px', alignItems: 'flex-start',
      padding: '6px 4px', width: '100%', textAlign: 'left', cursor: 'pointer', border: '0', borderTop: `1px solid ${T.border}`,
      background: selected ? T.bg2 : 'transparent',
    },
  },
  h('span', {
    title: STATUS_LABEL[task.status],
    style: {
      flex: '0 0 auto', marginTop: '5px', width: '7px', height: '7px',
      borderRadius: '50%', background: STATUS_COLOR[task.status],
    },
  }),
  h('div', { style: { minWidth: '0', flex: '1 1 auto' } },
    h('div', { style: { fontSize: '13px', color: T.text, wordBreak: 'break-word' } }, task.title),
    h('div', { style: { fontSize: '11px', color: T.dim, marginTop: '2px' } },
      [
        `${reminder ? '账本' : ''}${STATUS_LABEL[task.status]}`,
        task.dueAt === undefined ? '' : ` · 到期 ${shortTime(task.dueAt)}`,
        evidence === 0 ? '' : ` · 证据 ${evidence}`,
        note === undefined || note === '' ? '' : ` · ${note}`,
      ].filter((part) => part !== '').join('')),
    h('div', { style: { fontSize: '11px', color: T.dim, marginTop: '2px' } }, taskMetricsView(task))))
}

/**
 * One activity receipt row.
 * @param receipt - the recorded tool call.
 * @returns the row element.
 */
function receiptRow(receipt: Receipt, index = 0): unknown {
  return h('div', {
    key: `${receipt.callId ?? receipt.tool}:${receipt.at}:${index}`,
    style: {
      display: 'flex', gap: '8px', alignItems: 'baseline',
      padding: '5px 0', borderTop: `1px solid ${T.border}`, fontSize: '12px',
    },
  },
  h('span', {
    style: { flex: '0 0 auto', color: receipt.ok ? T.ok : T.err, fontFamily: 'ui-monospace, monospace' },
  }, receipt.ok ? '✓' : '✗'),
  h('div', { style: { minWidth: '0', flex: '1 1 auto' } },
    h('div', { style: { color: T.text, wordBreak: 'break-all' } },
      `${receipt.tool}${receipt.summary === undefined ? '' : ` · ${receipt.summary}`}`),
    h('div', { style: { color: T.dim, fontSize: '11px' } },
      `${shortTime(receipt.at)} · ${shortDuration(receipt.ms)}`),
    receipt.callId ? h('div', { style: { color: T.dim, fontSize: '11px', wordBreak: 'break-all' } }, `调用 ${receipt.callId} · 执行 ${receipt.runId ?? '未知'}`) : null,
    receipt.error === undefined
      ? null
      : h('div', { style: { color: T.err, fontSize: '11px', wordBreak: 'break-word' } }, receipt.error)))
}

/**
 * A clickable note row.
 * @param entry - the note file entry.
 * @param onOpen - selection callback.
 * @param selected - whether it is the open note.
 * @returns the row element.
 */
function noteRow(entry: { path: string; size: number; modified: string }, onOpen: (slug: string) => void, selected: boolean): unknown {
  const slug = entry.path.replace(/^notes\//, '').replace(/\.md$/, '')
  return h('button', {
    key: entry.path, type: 'button', 'aria-label': `查看笔记：${slug}`,
    onClick: () => { onOpen(slug) },
    style: {
      padding: '5px 6px', borderTop: `1px solid ${T.border}`, cursor: 'pointer',
      background: selected ? T.bg2 : 'transparent', borderRadius: '4px',
      border: '0', width: '100%', textAlign: 'left',
    },
  },
  h('div', { style: { fontSize: '12px', color: T.text, wordBreak: 'break-all' } }, slug),
  h('div', { style: { fontSize: '11px', color: T.dim } },
    `${entry.size}B · ${shortTime(entry.modified)}`))
}

/** Human-readable Chinese label for the butler session's last state. */
const SESSION_LABEL: Record<ButlerSession['state'], string> = {
  live: '已在',
  created: '新建',
  resumed: '已恢复',
  failed: '建不起来',
}

/**
 * The full workbench page.
 * @param props - slot props; `ctx` is used only to reach the conversation.
 * @returns the page element.
 */
export function ButlerWorkbench(props: { ctx?: Context; initialTaskId?: string }): unknown {
  const ctx = props.ctx as Context
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<NoteResult | null>(null)
  const [noteEntries, setNoteEntries] = useState<NoteEntry[]>([])
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [navProblem, setNavProblem] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(props.initialTaskId ?? null)
  const [task, setTask] = useState<TaskDetail | null>(null)
  const [taskProblem, setTaskProblem] = useState<string | null>(null)
  const [taskOutcome, setTaskOutcome] = useState<{ taskId: string; outcome: TaskActionOutcome } | null>(null)
  const [settledTaskId, setSettledTaskId] = useState<string | null>(null)
  const [settledSlug, setSettledSlug] = useState<string | null>(null)
  const loadVersion = useRef(0)
  const taskAnchor = useRef<HTMLDivElement | null>(null)
  const noteAnchor = useRef<HTMLDivElement | null>(null)
  const scrolledTask = useRef<string | null>(null)
  const scrolledSlug = useRef<string | null>(null)
  const taskVisit = useRef(0)
  const fileAction = useSyncExternalStore(subscribeTaskFiles, taskFileSnapshot)

  const load = async (signal?: AbortSignal): Promise<void> => {
    const version = ++loadVersion.current
    try {
      const next = await fetchOverview(signal)
      if (signal?.aborted || version !== loadVersion.current) return
      setOverview(next)
      rememberReadySession(next.ok === true ? next.session : undefined)
      setError(null)
    } catch (cause) {
      if (signal?.aborted === true || version !== loadVersion.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = window.setInterval(() => { void load(controller.signal) }, POLL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    scrolledSlug.current = null
    setSettledSlug(null)
    setNotes(null)
  }, [openSlug])

  useEffect(() => {
    const controller = new AbortController()
    void fetchNote(openSlug ?? undefined, controller.signal).then(next => {
      if (controller.signal.aborted) return
      if (openSlug && (next.kind === 'list' || (next.kind === 'note' && next.slug !== openSlug))) {
        setNotes({ kind: 'error', message: '笔记结构或身份不匹配' })
      } else {
        setNotes(next)
        if (next.kind === 'list') setNoteEntries(next.notes)
      }
      if (openSlug) setSettledSlug(openSlug)
    }, (cause: unknown) => {
      if (controller.signal.aborted) return
      setNotes({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      if (openSlug) setSettledSlug(openSlug)
    })
    return () => controller.abort()
  }, [openSlug, overview?.generatedAt])

  useEffect(() => {
    taskVisit.current++
    scrolledTask.current = null
    setSettledTaskId(null)
    setTaskOutcome(null)
    return () => { taskVisit.current++ }
  }, [openTaskId])

  useEffect(() => {
    if (fileAction.result?.taskId === openTaskId) setTaskOutcome(fileAction.result)
  }, [fileAction.result, openTaskId])

  useEffect(() => {
    if (!openTaskId) { setTask(null); setTaskProblem(null); return }
    const controller = new AbortController()
    setTask(previous => previous?.task.id === openTaskId ? previous : null)
    setTaskProblem(null)
    void fetchTask(openTaskId, controller.signal).then(next => {
      if (controller.signal.aborted) return
      setTask(next)
      setSettledTaskId(openTaskId)
    }, (cause: unknown) => {
      if (controller.signal.aborted) return
      setTaskProblem(cause instanceof Error ? cause.message : String(cause))
      setSettledTaskId(openTaskId)
    })
    return () => controller.abort()
  }, [openTaskId, overview?.generatedAt])

  useEffect(() => {
    if (openTaskId && settledTaskId === openTaskId && scrolledTask.current !== openTaskId && taskAnchor.current) {
      taskAnchor.current.scrollIntoView({ block: 'start' })
      scrolledTask.current = openTaskId
    }
  }, [openTaskId, settledTaskId])

  useEffect(() => {
    if (openSlug && settledSlug === openSlug && scrolledSlug.current !== openSlug && noteAnchor.current) {
      noteAnchor.current.scrollIntoView({ block: 'start' })
      scrolledSlug.current = openSlug
    }
  }, [openSlug, settledSlug])

  const runTaskAction = (taskId: string, action: () => TaskActionOutcome | Promise<TaskActionOutcome>): void => {
    const visit = taskVisit.current
    // Start clipboard/native navigation inside the click's user activation.
    void (async () => {
      let outcome: TaskActionOutcome
      try { outcome = await action() } catch (cause) {
        outcome = { ok: false, message: `操作失败：${cause instanceof Error ? cause.message : String(cause)}` }
      }
      if (visit === taskVisit.current) setTaskOutcome({ taskId, outcome })
    })()
  }

  const ledger = overview?.ledger
  const usage: UsageTotals | undefined = ledger?.usage
  const packs: PackEntry[] | undefined = overview?.packs
  const notesList = noteEntries
  const openNote = notes?.kind === 'note' && notes.slug === openSlug ? notes : null
  const controls = runtimeView(overview?.runtimeControls)

  const header = h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '10px 14px', borderBottom: `1px solid ${T.border}`,
    },
  },
  h('span', { style: { fontSize: '14px', fontWeight: '600', color: T.text } }, '管家工作台'),
  h('span', { style: { fontSize: '11px', color: T.dim } },
    overview === null ? '正在读取…' : `更新于 ${shortTime(overview.generatedAt)} · ${overview.timeZone}`),
  h('span', { style: { flex: '1 1 auto' } }),
  error === null
    ? null
    : h('span', { style: { fontSize: '11px', color: T.err } }, `读取失败：${error}`),
  overview?.ledgerError === undefined
    ? null
    : h('span', { style: { fontSize: '11px', color: T.err } }, `账本不可用，原件已保留：${overview.ledgerError}`),
  navProblem === null
    ? null
    : h('span', { style: { fontSize: '11px', color: T.warn, maxWidth: '320px' } }, navProblem),
  h('button', {
    type: 'button',
    // The workbench is a dashboard: talking happens in the butler's own
    // conversation, and this is the way in from here.
    onClick: () => {
      void openButlerConversation(ctx, overview?.session?.id).then((outcome) => {
        setNavProblem(outcome.ok ? null : (outcome.reason ?? '打不开管家会话'))
      })
    },
    title: overview?.session === undefined
      ? '打开和管家的专属对话'
      : `打开和管家的专属对话（${overview.session.id}）`,
    style: {
      fontSize: '12px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
      color: '#fff', background: T.brand, border: `1px solid ${T.brand}`,
    },
  }, '和管家说话'),
  h('button', {
    type: 'button',
    onClick: () => { void load() },
    style: {
      fontSize: '12px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
      color: T.text, background: T.bg2, border: `1px solid ${T.border2}`,
    },
  }, '刷新'))

  const grid = h('div', {
    style: {
      display: 'grid', gap: '12px', padding: '12px 14px',
      gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', alignItems: 'start',
    },
  },
  section('运行保护与预算', controls.budgetCount, h('div', {}, runtimeContent(controls, setOpenTaskId),
    h(HistorySection<'budgets'>, { kind: 'budgets', limit: 12,
      preview: emptyLine('浏览保存的全部运行预算，含同会话较早的运行及停止记录。'),
      renderPage: (page: HistoryPage<'budgets'>) => h('div', {}, emptyLine('保存的运行预算；旧运行未记录的限额与剩余保持未知。'),
        page.items.length ? budgetViews(page.items).map(budgetRow) : emptyLine('没有保存的运行预算。')) }))),
  section('今日待办 / 在跑的事', ledger?.open.length, ledger === undefined || ledger.open.length === 0
    ? emptyLine(overview?.ledgerError ? '账本读取失败，无法判断待办数量。' : '没有在跑的事。跟我说要做什么就行。')
    : h('div', {}, ledger.open.map(row => taskRow(row, setOpenTaskId, row.id === openTaskId, overview?.runtimeControls?.reminderOperations)))),
  section('任务记录', overview?.taskHistory?.total, overview?.taskHistory === undefined
    ? emptyLine('任务记录暂不可读；已完成任务需要独立详情。')
    : h(HistorySection<'tasks'>, { kind: 'tasks', limit: 50,
      preview: h('div', { style: { maxHeight: '300px', overflow: 'auto' } }, overview.taskHistory.tasks.length
        ? overview.taskHistory.tasks.map(row => taskRow(row, setOpenTaskId, row.id === openTaskId, overview?.runtimeControls?.reminderOperations)) : emptyLine('还没有任务记录。'),
        overview.taskHistory.total > overview.taskHistory.tasks.length ? emptyLine(`首屏 ${overview.taskHistory.tasks.length}/${overview.taskHistory.total} 项，可浏览完整历史。`) : null),
      renderPage: (page: HistoryPage<'tasks'>) => h('div', { style: { maxHeight: '360px', overflow: 'auto' } },
        page.items.length ? page.items.map(row => taskRow(row, setOpenTaskId, row.id === openTaskId, overview?.runtimeControls?.reminderOperations)) : emptyLine('还没有任务记录。')) })),
  section('记忆状态与来源', overview?.memory?.total, memoryContent(overview?.memory, overview?.memoryError)),
  section('在等你点头', ledger?.pending.length, ledger === undefined || ledger.pending.length === 0
    ? emptyLine(overview?.ledgerError ? '审批账本不可用，无法判断待批数量。' : '没有等你决定的事。外部动作我都不会自己执行。')
    : h('div', {}, ledger.pending.map((item) => h('div', {
      style: { padding: '6px 0', borderTop: `1px solid ${T.border}` },
    },
    h('div', { style: { fontSize: '13px', color: T.text } }, item.title),
    h('div', { style: { fontSize: '11px', color: T.dim } }, `因为：${item.reason}`))))),
  section('技能包', packs === undefined || packs.length === 0 ? undefined : packs.filter((pack) => pack.enabled).length,
    overview?.packsError !== undefined
      ? emptyLine(`能力包列表读不出来：${overview.packsError}`)
      : packs === undefined || packs.length === 0
        ? emptyLine('没有可用的能力包。装包用 butler_pack，或自己在 vault/packs 里写一个。')
        : h('div', {}, packs.map(packRow))),
  section('文档 Space', notesList.length === 0 ? undefined : notesList.length, notesList.length === 0
    ? emptyLine('还没有笔记。让管家整理一篇就会出现在这里。')
    : h('div', {}, notesList.map((entry) => noteRow(entry, setOpenSlug, openNote?.slug === entry.path.replace(/^notes\//, '').replace(/\.md$/, ''))))),
  section('它刚做了什么', undefined, ledger === undefined || ledger.recent.length === 0
    ? emptyLine('还没有工具回执。每次工具调用都会在这里留一行。')
    : h(HistorySection<'recentReceipts'>, { kind: 'recentReceipts',
      preview: h('div', {}, ledger.recent.slice(0, 12).map(receiptRow)),
      renderPage: (page: HistoryPage<'recentReceipts'>) => h('div', {}, emptyLine('全局工具回执；没有任务身份的旧记录保持归属未知。'),
        page.items.length ? page.items.map(receiptRow) : emptyLine('没有工具回执。')) })))

  const selectedTask = task?.task.id === openTaskId ? task : null
  const selectedProblem = settledTaskId === openTaskId ? taskProblem : null
  const taskPane = !openTaskId ? null : h('div', { ref: taskAnchor },
    selectedTask ? null : h('div', { style: { margin: '0 14px 10px', fontSize: '12px' } },
      selectedProblem ? h('div', { role: 'alert', style: { color: T.warn } }, `任务详情读取失败：${selectedProblem}`) : emptyLine('正在读取所选任务…'),
      h('button', { type: 'button', style: buttonStyle, onClick: () => setOpenTaskId(null) }, '关闭任务详情')),
    selectedTask && selectedProblem ? h('div', { role: 'alert', style: { color: T.warn, margin: '0 14px 10px', fontSize: '12px' } }, `任务详情读取失败：${selectedProblem}`) : null,
    selectedTask ? taskDetailPane(selectedTask, () => setOpenTaskId(null), receiptRow, path => {
      const prefix = `${overview?.vault.home.replaceAll('\\', '/') ?? ''}/notes/`, normalized = path.replaceAll('\\', '/')
      if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
        const relative = normalized.slice(prefix.length)
        if (/^[^/]+\.md$/i.test(relative)) { setOpenSlug(relative.slice(0, -3)); return }
      }
      setTaskOutcome({ taskId: selectedTask.task.id, outcome: { ok: false, message: '这个产物不在笔记目录，请用 DSH 打开文件或按记录路径打开。' } })
    }, {
      openFile: path => runTaskAction(selectedTask.task.id, () => openTaskFile(ctx, selectedTask.task.id, selectedTask.task.sessionId, path)),
      copyContinuation: () => runTaskAction(selectedTask.task.id, () => copyTaskContinuation(selectedTask.task.id)),
      continueWithButler: () => runTaskAction(selectedTask.task.id, () => continueTaskWithButler(ctx)),
      openSourceConversation: () => runTaskAction(selectedTask.task.id, () => openTaskSourceConversation(ctx, selectedTask.task.sessionId)),
      outcome: taskOutcome?.taskId === selectedTask.task.id ? taskOutcome.outcome : undefined,
    }) : null)

  const notePane = openSlug === null
    ? null
    : h('div', {
      ref: noteAnchor,
      style: {
        margin: '0 14px 12px', padding: '10px 12px', background: T.bg,
        border: `1px solid ${T.border}`, borderRadius: '8px',
      },
    },
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
      h('span', { style: { fontSize: '12px', color: T.text, fontWeight: '600' } }, openSlug),
      openNote ? h('span', { style: { fontSize: '11px', color: T.dim } }, openNote.path) : null,
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', {
        type: 'button',
        onClick: () => { setOpenSlug(null) },
        style: {
          fontSize: '11px', padding: '2px 8px', borderRadius: '6px', cursor: 'pointer',
          color: T.text, background: T.bg2, border: `1px solid ${T.border2}`,
        },
      }, '关闭')),
    notes?.kind === 'error' && settledSlug === openSlug ? h('div', { role: 'alert', style: { color: T.warn, fontSize: '12px' } }, `笔记读取失败：${notes.message}`) : null,
    openNote ? h('pre', {
      style: {
        margin: '0', fontSize: '12px', lineHeight: '1.55', color: T.text,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '360px', overflow: 'auto',
      },
    }, openNote.text) : notes?.kind === 'error' && settledSlug === openSlug ? null : emptyLine('正在读取所选笔记…'))

  const footerParts: string[] = []
  if (overview !== null) {
    footerParts.push(`资料库 ${overview.vault.home}`)
    footerParts.push(`${overview.vault.files.length} 个文件`)
    footerParts.push(`提醒 ${overview.remindersAvailable ? String(overview.reminders.filter((r) => r.status !== 'inactive').length) : '未读到'}`)
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
        if (usage.cacheReadTokens > 0) {
          used.push(`缓存读 ${shortNumber(usage.cacheReadTokens)}（占已报告输入 ${hit}%）`)
        }
        if (usage.reasoningTokens > 0) used.push(`推理 ${shortNumber(usage.reasoningTokens)}`)
        if (usage.sessions > 1) used.push(`来自 ${usage.sessions} 个会话`)
        footerParts.push(used.join('，'))
        footerParts.push(...usageBreakdownView(usage))
        footerParts.push(...usageCostBreakdownView(usage))
        footerParts.push(`费用：${display.costText}（估算，非账单）`)
        if (usage.pricedCalls > 0) {
          if (usage.byProviderModel === undefined) footerParts.push(`计价依据（旧服务未提供逐模型细分）：${basisLabel(usage.costBasis)}`)
          if (usage.derivedCalls > 0) footerParts.push(`其中 ${usage.derivedCalls} 次按已存价目表回算，依据见成本细分`)
        }
        const other = Math.max(0, usage.calls - usage.butlerCalls - usage.scopeUnknown)
        const unknown =
          usage.scopeUnknown > 0 ? `，另有 ${usage.scopeUnknown} 次归属未定` : ''
        footerParts.push(
          `其中管家会话 ${usage.butlerCalls} 次 / 已报告未缓存输入与输出 ${shortNumber(usage.butlerNewTokens)} tokens，其他会话 ${other} 次${unknown}`,
        )
      } else {
        footerParts.push('用量：还没记录到模型调用')
      }
      footerParts.push('覆盖：助手回复由会话事件及日志回填记录；会话命名、上下文压缩在插件运行时实时观察。其他用途、无用途标记的辅助流及未加载时段未保证覆盖，未知用量与未计价部分未包含在金额中。')
    }
    const backfill = overview.usageBackfill
    if (backfill !== undefined) {
      if (backfill.running) footerParts.push('启动回填：正在核对会话日志')
      else if (backfill.problem !== undefined) footerParts.push(`启动回填失败：${backfill.problem}`)
      else if (backfill.added > 0) footerParts.push(`启动回填补记 ${backfill.added} 次调用（实时记录漏掉的）`)
      if (backfill.last) {
        if (backfill.last.ambiguousLegacy > 0) footerParts.push(`${backfill.last.ambiguousLegacy} 条旧用量记录无法唯一配对，已保留待核对，总量可能重叠`)
        if (backfill.last.skips.length > 0) footerParts.push(`回填跳过 ${backfill.last.skips.length} 项：${backfill.last.skips.slice(0, 2).join('；')}`)
        if (backfill.last.problems.length > 0) footerParts.push(`回填问题：${backfill.last.problems.slice(0, 2).join('；')}`)
      }
    }
    const recorder = overview.usageRecorder
    if (recorder !== undefined && (recorder.listening === false || recorder.problem !== undefined)) {
      footerParts.push(`用量记录没接上：${recorder.problem ?? 'session/event 事件未订阅'}`)
    }
    if (recorder !== undefined && recorder.withoutUsage > 0) {
      footerParts.push(`${recorder.withoutUsage} 次调用没有用量字段（按未知计，不当成 0）`)
    }
    if (recorder !== undefined && recorder.unpriced > 0) {
      footerParts.push(`${recorder.unpriced} 次实时记录未取得计价金额（包括缺用量；费用未知）`)
    }
    if (recorder !== undefined && (recorder.auxiliaryListening === false || recorder.auxiliaryProblem !== undefined)) {
      footerParts.push(`辅助用量观察：${recorder.auxiliaryProblem ?? 'llm/stream 事件未订阅'}`)
    }
    if (recorder !== undefined && recorder.uncoveredPurposeStreams > 0) {
      footerParts.push(`${recorder.uncoveredPurposeStreams} 次流使用未识别用途，未按辅助调用计入；若为助手回复仍由原生事件记录`)
    }
    if (recorder !== undefined && recorder.failed > 0) {
      footerParts.push(`用量记录出错 ${recorder.failed} 次`)
    }
    if (ledger !== undefined && ledger.interrupted.length > 0) {
      footerParts.push(`重启打断 ${ledger.interrupted.length} 件（未自动重试）`)
    }
    if (overview.remindersError !== undefined) footerParts.push(overview.remindersError)
    const session = overview.session
    if (session !== undefined) {
      footerParts.push(`会话 ${session.id}（${SESSION_LABEL[session.state]}，标题「${session.title}」${session.titlePinned ? '已钉住' : '未钉住'}）`)
      if (session.note !== undefined && session.note !== '') footerParts.push(session.note)
    }
    if (overview.sessionError !== undefined) footerParts.push(`会话读不到：${overview.sessionError}`)
  }

  const footer = h('div', {
    style: {
      padding: '8px 14px 14px', fontSize: '11px', color: T.dim,
      borderTop: `1px solid ${T.border}`, wordBreak: 'break-word',
    },
  }, footerParts.length === 0 ? '正在读取管家状态…' : footerParts.join(' · '))

  return h('div', {
    'data-dsh-plugin': PANEL_ID,
    'data-dsh-butler-view': '',
    style: {
      height: '100%', overflow: 'auto', background: T.bg2 ?? 'transparent',
      color: T.text, display: 'flex', flexDirection: 'column',
    },
  }, header, grid, taskPane, openSlug === null && settledSlug === null && notes?.kind === 'error' ? emptyLine(`笔记读取失败：${notes.message}`) : null, notePane, footer)
}
