/**
 * The butler workbench: a center-column page rendered through the layout's
 * keyed `main` seat, mirroring how the shipped Plugins/Schedule pages and the
 * task board occupy that seat.
 *
 * ## Information architecture
 * The page is one status bar plus four fixed zones, in this order:
 *
 * 1. `今天` - open work (today's to-dos and running tasks);
 * 2. `等你决定` - uncertain hand-offs, interrupted tasks, pending approvals and
 *    proposed memories; interrupted work is a real row here, not a number in a
 *    footer paragraph;
 * 3. `资料与技能` - notes, capability packs and the document Space, collapsed by
 *    default because they are reference material;
 * 4. `系统状态` - budgets, storage, usage and history, collapsed by default.
 *
 * Task and note details no longer render after the zone grid and call
 * `scrollIntoView`: each opens a right-hand {@link Drawer} mounted at this page
 * root. The drawer supplies the focus trap, Escape handling and focus
 * restoration to the triggering row; the page therefore never changes DOM
 * order for a detail and never steals the page scroll position.
 *
 * ## Async semantics kept
 * * Selecting a task still opens a read (`/task?id=`), and the settled detail is
 *   tied to the exact selected id: a late/aborted response for another task is
 *   ignored (`settledTaskId` / `settledSlug`).
 * * Dashboard polling still re-reads the selected task/note in the background
 *   without clearing the open drawer or resetting the open history page.
 * * A task action's outcome is still scoped to the task it was started for
 *   (`taskVisit`), so a slow clipboard/native result cannot land on another
 *   task after the owner selects a different one.
 *
 * @module @dsh-external/dsh-butler/client
 */
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  fetchNote, fetchOverview, fetchTask, taskAction,
  type Memo, type NoteEntry, type NoteResult, type Overview, type PendingItem, type TaskDetail,
} from './api.ts'
import { PANEL_ID } from './ids.ts'
import { shortTime } from './view.ts'
import { openButlerConversation, rememberReadySession } from './navigate.ts'
import { runtimeView } from './workbench-model.ts'
import { documentHidden, onDocumentVisible } from './visibility.ts'
import { taskDetailPane } from './workbench-details.ts'
import { continueTaskWithButler, copyTaskContinuation, openTaskFile, openTaskSourceConversation, subscribeTaskFiles, taskFileSnapshot, type TaskActionOutcome } from './workbench-actions.ts'
import {
  BUTLER_COLORS, BUTLER_SPACE,
  ButlerStyles, Drawer, ErrorState, InlineError, KeyValue, LoadingBlock, NoticeRegion, type NoticeItem,
} from './ui/index.ts'
import { decisionsZone, receiptRow, resourcesZone, systemZone, todayZone, type TaskActionHandler } from './workbench/zones.ts'
import { workbenchStatusBar } from './workbench/status-bar.ts'

/** Poll cadence while the seat is mounted (visible only; see the poll effect). */
const POLL_MS = 60000

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
  // 资料区列表很长（宿主最多 200 篇）：前端只按"搜索词 + 显示条数"切片，
  // 不重新请求，也不改变后端上限。切换搜索词时把条数重置回第一页。
  const [noteQuery, setNoteQuery] = useState('')
  const [noteLimit, setNoteLimit] = useState(20)
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [navProblem, setNavProblem] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(props.initialTaskId ?? null)
  const [task, setTask] = useState<TaskDetail | null>(null)
  const [taskProblem, setTaskProblem] = useState<string | null>(null)
  const [taskOutcome, setTaskOutcome] = useState<{ taskId: string; outcome: TaskActionOutcome } | null>(null)
  const [settledTaskId, setSettledTaskId] = useState<string | null>(null)
  const [settledSlug, setSettledSlug] = useState<string | null>(null)
  const [openMemo, setOpenMemo] = useState<Memo | null>(null)
  const [openApproval, setOpenApproval] = useState<PendingItem | null>(null)
  const [openNotice, setOpenNotice] = useState<{ title: string; detail: string } | null>(null)
  const [taskAttempt, setTaskAttempt] = useState(0)
  const [noteAttempt, setNoteAttempt] = useState(0)
  const [notices, setNotices] = useState<NoticeItem[]>([])
  /** Reminder ids the owner already acknowledged in this dashboard session. */
  const [dismissedDue, setDismissedDue] = useState<Record<string, true>>({})
  const loadVersion = useRef(0)
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

  /** Announce a completed/refused workbench action in the polite live region. */
  const notify = (tone: NoticeItem['tone'], text: string): void => {
    setNotices(previous => [...previous.slice(-2), { tone, text, at: Date.now() }])
  }

  /** One-click local bookkeeping; external actions never come through here. */
  const applyTaskAction: TaskActionHandler = (action, task) => {
    void (async () => {
      try {
        const result = await taskAction(action, task.id)
        if (!result.ok) { notify('error', `操作失败：${result.error ?? '未知原因'}`); return }
        notify('success', action === 'done' ? `已标记完成：${task.title}`
          : action === 'cancel' ? `已取消：${task.title}` : `已改期：${task.title}`)
        await load()
      } catch (cause) {
        notify('error', `操作失败：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    })()
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    // 60s 轮询只在界面可见时发请求；切回前台立刻补一次。响应带 ETag，
    // 内容没变时宿主直接 304，不重新渲染。
    const timer = window.setInterval(() => {
      if (documentHidden()) return
      void load(controller.signal)
    }, POLL_MS)
    const cancelVisible = onDocumentVisible(() => { void load(controller.signal) })
    return () => {
      controller.abort()
      window.clearInterval(timer)
      cancelVisible()
    }
  }, [])

  useEffect(() => {
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
  }, [openSlug, overview?.generatedAt, noteAttempt])

  useEffect(() => {
    taskVisit.current++
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
  }, [openTaskId, overview?.generatedAt, taskAttempt])

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
  const openNote = notes?.kind === 'note' && notes.slug === openSlug ? notes : null
  const controls = runtimeView(overview?.runtimeControls)
  const selectedTask = task?.task.id === openTaskId ? task : null
  const selectedProblem = settledTaskId === openTaskId ? taskProblem : null
  const noteError = openSlug !== null && settledSlug === openSlug && notes?.kind === 'error' ? notes.message : null
  const noteListError = openSlug === null && notes?.kind === 'error' ? notes.message : undefined
  const reviewCount = (ledger?.interrupted.length ?? 0) + (ledger?.pending.length ?? 0)
    + (ledger?.proposedMemos ?? []).length + controls.attention.length

  /** Close every detail drawer; used where a detail must not stack on another. */
  const openTaskDetail = (id: string): void => {
    setOpenSlug(null)
    setOpenMemo(null)
    setOpenApproval(null)
    setOpenNotice(null)
    setOpenTaskId(id)
  }
  const openNoteDetail = (slug: string): void => {
    setOpenTaskId(null)
    setOpenMemo(null)
    setOpenApproval(null)
    setOpenNotice(null)
    setOpenSlug(slug)
  }
  const openMemoDetail = (memo: Memo): void => {
    setOpenTaskId(null)
    setOpenSlug(null)
    setOpenApproval(null)
    setOpenNotice(null)
    setOpenMemo(memo)
  }
  const openApprovalDetail = (item: PendingItem): void => {
    setOpenTaskId(null)
    setOpenSlug(null)
    setOpenMemo(null)
    setOpenNotice(null)
    setOpenApproval(item)
  }
  const openNoticeDetail = (title: string, detail: string): void => {
    setOpenTaskId(null)
    setOpenSlug(null)
    setOpenMemo(null)
    setOpenApproval(null)
    setOpenNotice({ title, detail })
  }

  const statusBar = workbenchStatusBar({
    overview,
    controls,
    reviewCount,
    error,
    navProblem,
    onRefresh: () => { void load() },
    onTalk: () => {
      void openButlerConversation(ctx, overview?.session?.id).then((outcome) => {
        setNavProblem(outcome.ok ? null : (outcome.reason ?? '打不开管家会话'))
      })
    },
  })

  const noteFilter = noteQuery.trim().toLowerCase()
  const filteredNotes = noteFilter === ''
    ? noteEntries
    : noteEntries.filter(entry => entry.path.toLowerCase().includes(noteFilter))
  const visibleNotes = filteredNotes.slice(0, noteLimit)

  // Due reminders: the scheduler stores the rule, but the owner should see the
  // due moment without opening the isolated reminder session. Acknowledgement is
  // per dashboard session; a still-active rule reappears on the next load.
  const dueReminders = (overview?.reminders ?? []).filter(record => record.status !== 'inactive'
    && typeof record.scheduledAt === 'string' && Number.isFinite(Date.parse(record.scheduledAt))
    && Date.parse(record.scheduledAt) <= Date.now() && dismissedDue[record.id] !== true)
  const reminderBanner = dueReminders.length === 0 ? null : h('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.xs,
      padding: `${BUTLER_SPACE.sm} ${BUTLER_SPACE.md}`, borderRadius: '8px',
      border: `1px solid ${BUTLER_COLORS.warn}`, background: BUTLER_COLORS.bgLayer1,
    },
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: BUTLER_SPACE.xs } },
    h('strong', { style: { fontSize: '13px' } }, `到期提醒 ${dueReminders.length} 条`),
    h('span', { style: { flex: '1 1 auto' } }),
    h('button', { type: 'button', className: 'butler-btn butler-btn--secondary butler-btn--sm',
      onClick: () => { void openButlerConversation(ctx, overview?.session?.id) } }, '打开管家会话处理')),
  ...dueReminders.slice(0, 5).map((record, index) => h('div', {
    key: record.id ?? index,
    style: { display: 'flex', alignItems: 'center', gap: BUTLER_SPACE.xs, fontSize: '12px' },
  },
  h('span', { style: { flex: '1 1 auto', overflowWrap: 'anywhere' } },
    `${record.title ?? record.prompt ?? record.id} · 计划 ${shortTime(record.scheduledAt as string)}`),
  h('button', { type: 'button', className: 'butler-btn butler-btn--ghost butler-btn--sm',
    'aria-label': `知道了：${record.title ?? record.id}`,
    onClick: () => setDismissedDue(previous => ({ ...previous, [String(record.id)]: true })) }, '知道了'))))

  const body = overview === null
    ? error === null
      ? h('div', { style: { flex: '1 1 auto', minHeight: '0', padding: '16px' } },
        h(LoadingBlock, { label: '正在读取管家状态…', lines: 5 }))
      : h('div', { style: { flex: '1 1 auto', minHeight: '0', padding: '16px' } },
        h(ErrorState, {
          title: '管家状态读取失败',
          message: error,
          retry: () => { void load() },
          retryLabel: '重试',
          retained: '还没有可显示的管家快照；重试会重新读取。',
        }))
    : h('div', { className: 'butler-scroll', style: { flex: '1 1 auto', minHeight: '0', padding: '12px 16px' } },
      h('div', { className: 'butler-stack' },
        h(NoticeRegion, { notices }),
        reminderBanner,
        todayZone({ overview, openTask: openTaskDetail, selectedTaskId: openTaskId, taskActions: applyTaskAction }),
        decisionsZone({ overview, openTask: openTaskDetail, openMemo: openMemoDetail, openApproval: openApprovalDetail, openNotice: openNoticeDetail, selectedTaskId: openTaskId, taskActions: applyTaskAction }),
        resourcesZone({
          overview,
          notes: visibleNotes,
          notesError: noteListError,
          noteQuery,
          onNoteQuery: value => { setNoteQuery(value); setNoteLimit(20) },
          noteRemaining: Math.max(0, filteredNotes.length - visibleNotes.length),
          onShowMoreNotes: () => setNoteLimit(value => value + 20),
          onRetryNotes: () => setNoteAttempt(value => value + 1),
          openNote: openNoteDetail,
          selectedSlug: openSlug,
        }),
        systemZone({ overview, openTask: openTaskDetail, onRefresh: () => { void load() } })))

  const footerLine = overview === null
    ? (error === null ? '正在读取管家状态…' : '管家状态读取失败')
    : `数据目录 ${overview.vault.home} · 记录器版本 ${overview.runtimeControls?.version ?? '未提供'}`
  const footer = h('div', {
    className: 'butler-muted',
    style: {
      flex: '0 0 auto', padding: '8px 16px',
      borderTop: `1px solid ${BUTLER_COLORS.borderL1}`, overflowWrap: 'anywhere',
    },
  }, footerLine)

  const taskDrawer = openTaskId === null ? null : h(Drawer, {
    open: true,
    onClose: () => setOpenTaskId(null),
    title: selectedTask?.task.title ?? '任务详情',
    subtitle: selectedTask === null
      ? (selectedProblem === null ? '正在读取任务详情…' : '读取失败')
      : `任务 ${selectedTask.task.id} · 更新 ${shortTime(selectedTask.task.updatedAt)}`,
    size: 'lg',
    closeLabel: '关闭',
    id: 'butler-task-drawer',
  },
  selectedTask !== null
    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.md, minWidth: '0' } },
      // A poll can fail after a detail was settled; keep the snapshot on screen
      // and say so, instead of showing stale data silently or blanking it.
      selectedProblem === null
        ? null
        : h(InlineError, {
          message: `任务详情读取失败：${selectedProblem}；已保留上次快照。`,
          retry: () => setTaskAttempt(value => value + 1),
          retryLabel: '重试',
        }),
      taskDetailPane(selectedTask, () => setOpenTaskId(null), receiptRow, path => {
        const prefix = `${overview?.vault.home.replaceAll('\\', '/') ?? ''}/notes/`, normalized = path.replaceAll('\\', '/')
        if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
          const relative = normalized.slice(prefix.length)
          if (/^[^/]+\.md$/i.test(relative)) { openNoteDetail(relative.slice(0, -3)); return }
        }
        setTaskOutcome({
          taskId: selectedTask.task.id,
          outcome: { ok: false, message: '这个产物不在笔记目录，请用 DSH 打开文件或按记录路径打开。' },
        })
      }, {
        openFile: path => runTaskAction(selectedTask.task.id, () => openTaskFile(ctx, selectedTask.task.id, selectedTask.task.sessionId, path)),
        copyContinuation: () => runTaskAction(selectedTask.task.id, () => copyTaskContinuation(selectedTask.task.id)),
        continueWithButler: () => runTaskAction(selectedTask.task.id, () => continueTaskWithButler(ctx)),
        openSourceConversation: () => runTaskAction(selectedTask.task.id, () => openTaskSourceConversation(ctx, selectedTask.task.sessionId)),
        outcome: taskOutcome?.taskId === selectedTask.task.id ? taskOutcome.outcome : undefined,
      }))
    : selectedProblem !== null
      ? h(ErrorState, {
        title: '任务详情读取失败',
        message: selectedProblem,
        retry: () => setTaskAttempt(value => value + 1),
        retryLabel: '重试',
        retained: '来源记录仍保留在账本中；关闭抽屉不会改动任务。',
      })
      : h(LoadingBlock, { label: '正在读取所选任务…', lines: 4 }))

  const noteDrawer = openSlug === null ? null : h(Drawer, {
    open: true,
    onClose: () => setOpenSlug(null),
    title: openSlug,
    subtitle: openNote?.path ?? '正在读取笔记…',
    size: 'md',
    closeLabel: '关闭笔记详情',
    id: 'butler-note-drawer',
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.sm, minWidth: '0' } },
    h('div', { className: 'butler-row' },
      h('span', { style: { fontSize: '12px', lineHeight: '18px', color: BUTLER_COLORS.labelSecondary } },
        openNote?.path ?? '笔记'),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', {
        type: 'button',
        className: 'butler-btn butler-btn--secondary butler-btn--sm',
        onClick: () => setOpenSlug(null),
      }, '关闭')),
    noteError !== null
      ? h(ErrorState, {
        title: '笔记读取失败',
        message: noteError,
        retry: () => setNoteAttempt(value => value + 1),
        retryLabel: '重试',
        retained: '工作台其余部分不受影响；关闭抽屉不会改动笔记文件。',
      })
      : openNote === null
        ? h(LoadingBlock, { label: '正在读取所选笔记…', lines: 5 })
        : h('pre', {
          className: 'butler-scroll',
          style: {
            margin: '0', fontSize: '12px', lineHeight: '1.55', color: BUTLER_COLORS.labelPrimary,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 'calc(100vh - 220px)', overflow: 'auto',
          },
        }, openNote.text)))

  const memoDrawer = openMemo === null ? null : h(Drawer, {
    open: true,
    onClose: () => setOpenMemo(null),
    title: '记忆提案',
    subtitle: '待你确认',
    size: 'sm',
    closeLabel: '关闭',
    id: 'butler-memo-drawer',
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.sm, minWidth: '0' } },
    h(KeyValue, { label: '内容', value: openMemo.text }),
    h(KeyValue, { label: '来源', value: openMemo.source === 'user' ? '你的明确输入' : '管家提出' }),
    h(KeyValue, { label: '创建', value: shortTime(openMemo.createdAt) }),
    h(KeyValue, { label: '状态', value: '待确认', tone: 'warn' }),
    h('p', { className: 'butler-muted', style: { margin: '0' } }, '确认、更正与撤回通过对话的记忆工具处理，沿用可信用户确认。')))

  const approvalDrawer = openApproval === null ? null : h(Drawer, {
    open: true,
    onClose: () => setOpenApproval(null),
    title: openApproval.title,
    subtitle: '待你决定',
    size: 'sm',
    closeLabel: '关闭',
    id: 'butler-approval-drawer',
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.sm, minWidth: '0' } },
    h(KeyValue, { label: '原因', value: openApproval.reason }),
    h(KeyValue, { label: '状态', value: '待你决定', tone: 'warn' }),
    h(KeyValue, { label: '创建', value: shortTime(openApproval.createdAt) }),
    h(KeyValue, { label: '关联任务', value: openApproval.taskId ?? '未记录' }),
    openApproval.taskId === undefined
      ? null
      : h('button', {
        type: 'button',
        className: 'butler-btn butler-btn--secondary butler-btn--sm',
        onClick: () => { setOpenApproval(null); openTaskDetail(openApproval.taskId!) },
      }, '查看关联任务'),
    h('p', { className: 'butler-muted', style: { margin: '0' } }, '外部动作不会自己执行；批准与否通过对话中的审批工具完成。')))

  const noticeDrawer = openNotice === null ? null : h(Drawer, {
    open: true,
    onClose: () => setOpenNotice(null),
    title: openNotice.title,
    subtitle: '待核对',
    size: 'sm',
    closeLabel: '关闭',
    id: 'butler-notice-drawer',
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.sm, minWidth: '0' } },
    h(KeyValue, { label: '原因', value: openNotice.detail }),
    h(KeyValue, { label: '状态', value: '待核对', tone: 'warn' }),
    h('p', { className: 'butler-muted', style: { margin: '0' } }, '这是宿主记录的当前快照；核对完成前不会自动重试或外发。')))

  return h('div', {
    'data-dsh-plugin': PANEL_ID,
    'data-dsh-butler-view': '',
    className: 'butler-page',
  }, h(ButlerStyles), statusBar, body, footer, taskDrawer, noteDrawer, memoDrawer, approvalDrawer, noticeDrawer)
}
