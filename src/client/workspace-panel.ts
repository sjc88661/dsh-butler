import { createElement as h, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { clientService } from './navigate.ts'
import { ButlerWorkbench } from './panel.ts'
import { openTaskFile, useTaskFileHandoff } from './workbench-actions.ts'
import { ButlerSources } from './workspace-sources.ts'
import { ButlerWorkspaceUsage } from './workspace-usage.ts'
import { ButlerDailyTrial } from './daily-trial.ts'
import { decideOrganization, fetchOrganizations, fetchSources, fetchWorkspace, selectSources, workspaceAction, type SourceRef, type WorkspaceSnapshot } from './workspace-api.ts'
import { clearWorkspaceDraft, consumeWorkspacePaneHandoff, consumeWorkspacePaneRequest, copyWorkspaceText, handoffSourceToWorkspace, insertWorkspaceDraft, openWorkspaceConversation, openWorkspaceSidebar, prepareWorkspaceDraft, refreshWorkspaceUi, workspaceDraft, workspacePaneRequest, type WorkspaceInputActions } from './workspace-actions.ts'
import { uiButton, uiCard, uiError, uiInput, uiMuted, uiRow, uiStatus, useWorkspaceOperation, useWorkspaceRead, useWorkspaceRevision } from './workspace-components.ts'
import { ButlerStyles, Button, EmptyState, Tablist, TextArea } from './ui/index.ts'
import { setRightPaneVisible } from './visibility.ts'
import { shortTime, STATUS_LABEL, T } from './view.ts'

export interface WorkspaceSlotProps { ctx?: Context; sessionId?: string; inputActions?: WorkspaceInputActions; useTabInfo?: () => { tab: { visible?: boolean } } }
const currentSession = (props: WorkspaceSlotProps): string | undefined => props.sessionId ?? clientService<{ mounted?: { getSnapshot(): string | undefined } }>(props.ctx as Context, 'sidebarRight')?.mounted?.getSnapshot()

/** Native workspace rows own the left-hand chat list; this is its management view. */
function WorkspaceChats(props: { ctx: Context }): unknown {
  const revision = useWorkspaceRevision(), state = useWorkspaceRead(fetchWorkspace, [revision])
  const operation = useWorkspaceOperation([props.ctx])
  const [title, setTitle] = useState(''), [filter, setFilter] = useState(''), [renameId, setRenameId] = useState<string | undefined>(undefined), [renameTitle, setRenameTitle] = useState('')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | undefined>(undefined)
  const execute = (job: (isCurrent: () => boolean) => Promise<unknown>, done: string): void => {
    if (busy) return
    const isCurrent = operation()
    setBusy(true); setMessage(undefined)
    void job(isCurrent).then(() => { if (isCurrent()) { if (done) setMessage(done); refreshWorkspaceUi() } }, error => { if (isCurrent()) setMessage(error instanceof Error ? error.message : String(error)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  const snapshot = state.data?.workspace
  return h('section', { 'aria-label': '管家工作区与主题对话' },
    h('p', { style: uiMuted }, '左侧“管家”工作区保存日常对话与主题对话；中间继续使用 DSH 原生聊天。'),
    snapshot ? h('code', { style: { ...uiMuted, display: 'block', marginBottom: '12px' } }, snapshot.root) : null,
    h('form', { style: { ...uiRow, alignItems: 'flex-end' }, onSubmit: (event: { preventDefault(): void }) => {
      event.preventDefault(); if (!title.trim()) return
      execute(async isCurrent => { const result = await workspaceAction('create', { title: title.trim() }); if (!isCurrent()) return; if (!result.session?.id || result.session.state === 'failed') throw new Error(result.session?.note ?? '主题会话创建失败'); setTitle(''); const outcome = await openWorkspaceConversation(props.ctx, result.session.id, undefined, isCurrent); if (!outcome.ok) throw new Error(outcome.message) }, '主题对话已创建。')
    } }, h('label', { style: { flex: '1 1 150px' } }, '新主题对话', h('input', { value: title, maxLength: 120, style: uiInput, placeholder: '例如：科研文献、学习计划', onChange: (event: { target: { value: string } }) => setTitle(event.target.value) })), h('button', { type: 'submit', style: uiButton, disabled: busy || !title.trim() }, '新建')),
    uiError(state.error), uiStatus(message),
    h('label', { style: { display: 'block', marginTop: '14px' } }, '查找管家历史', h('input', { value: filter, style: uiInput, onChange: (event: { target: { value: string } }) => setFilter(event.target.value) })),
    ...(snapshot?.sessions ?? []).filter(item => `${item.title} ${item.id}`.toLowerCase().includes(filter.toLowerCase())).map(item => h('article', { key: item.id, style: uiCard },
      h('div', { style: uiRow }, h('strong', null, item.title), h('span', { style: uiMuted }, item.kind === 'legacy' ? '原工作区历史' : item.kind === 'daily' ? '常驻入口' : '主题对话')),
      h('code', { style: { ...uiMuted, display: 'block' } }, item.id),
      h('div', { style: uiMuted }, shortTime(item.updatedAt)),
      h('div', { style: { ...uiRow, marginTop: '8px' } },
        h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => execute(async isCurrent => { const result = await openWorkspaceConversation(props.ctx, item.id, undefined, isCurrent); if (!result.ok) throw new Error(result.message) }, '已打开原生对话。') }, '打开对话'),
        item.kind !== 'legacy' ? h('button', { type: 'button', style: uiButton, onClick: () => { setRenameId(item.id); setRenameTitle(item.title) } }, '重命名') : null,
        h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => execute(async isCurrent => { const result = await workspaceAction('archive', { sessionId: item.id }); if (isCurrent()) setMessage(`可读归档：${result.archive?.path ?? '已生成'}${result.archive?.conflict ? '（手改原件保留，已另存版本）' : ''}`) }, '') }, '导出可读归档')),
      renameId === item.id ? h('form', { style: { ...uiRow, marginTop: '8px' }, onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); execute(async isCurrent => { await workspaceAction('rename', { sessionId: item.id, title: renameTitle.trim() }); if (isCurrent()) setRenameId(undefined) }, '主题标题已更新。') } },
        h('input', { value: renameTitle, maxLength: 120, 'aria-label': '主题新标题', style: { ...uiInput, flex: '1 1 150px' }, onChange: (event: { target: { value: string } }) => setRenameTitle(event.target.value) }),
        h('button', { type: 'submit', style: uiButton, disabled: busy || !renameTitle.trim() }, '保存'), h('button', { type: 'button', style: uiButton, onClick: () => setRenameId(undefined) }, '取消')) : null)))
}

function OrganizationResults(props: { ctx: Context; sessionId: string; showSource(ref: SourceRef): void; showTask(id: string): void }): unknown {
  const revision = useWorkspaceRevision(), state = useWorkspaceRead(() => fetchOrganizations(props.sessionId), [props.sessionId, revision], 15000)
  const fileResult = useTaskFileHandoff(props.ctx)
  const operation = useWorkspaceOperation([props.ctx, props.sessionId])
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | undefined>(undefined)
  useEffect(() => { setBusy(false); setMessage(undefined) }, [props.ctx, props.sessionId])
  const decide = (action: 'confirm' | 'dismiss', id: string): void => {
    if (busy) return
    const isCurrent = operation()
    setBusy(true); setMessage(undefined)
    void decideOrganization(action, id, props.sessionId).then(result => {
      if (!isCurrent()) return
      if (result.confirmationText) {
        if (workspaceDraft(props.sessionId)) { setMessage('已有待发送指令，请先处理后再准备记忆确认；原指令已保留。'); return }
        prepareWorkspaceDraft(props.sessionId, result.confirmationText); setMessage('记忆确认指令已放在输入框上方，由你核对并发送。')
      }
      else setMessage(result.draft.status === 'dismissed' ? '已忽略此草稿。' : '此建议已加入正式待办；执行状态见任务详情。')
      refreshWorkspaceUi()
    }, error => { if (isCurrent()) setMessage(error instanceof Error ? error.message : String(error)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  const documents = state.data?.documents ?? [], standaloneDrafts = state.data?.drafts ?? []
  const renderDraft = (draft: typeof standaloneDrafts[number]): unknown => h('div', { key: draft.id, style: { ...uiCard, padding: '8px 0' } },
    h('div', null, `${draft.kind === 'memory' ? '记忆建议' : '待办建议'}：${draft.text}`),
    draft.status === 'proposed' ? h('div', { style: { ...uiRow, marginTop: '6px' } },
      h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => decide('confirm', draft.id) }, draft.kind === 'memory' ? '准备记忆确认' : '加入正式待办'),
      h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => decide('dismiss', draft.id) }, '忽略')) : h('div', { style: uiMuted },
        draft.status === 'confirmed' ? draft.kind === 'task' ? `已加入正式待办 · ${draft.taskStatus ? STATUS_LABEL[draft.taskStatus] : '任务状态暂不可读'}` : '已确认' : '已忽略'),
    draft.status === 'confirmed' && draft.taskId ? h('div', { style: { ...uiRow, marginTop: '6px' } },
      h('code', { style: uiMuted }, draft.taskId),
      h('button', { type: 'button', style: uiButton, disabled: draft.taskUnavailable === true, onClick: () => props.showTask(draft.taskId!) }, '查看正式待办')) : null)
  return h('section', { 'aria-label': '整理结果与待办草稿' }, uiError(state.error), uiStatus(message),
    h('p', { style: uiMuted }, '在原生对话中发送整理要求后，结果会显示在这里。索引不调用模型；待办和记忆由你确认。'),
    documents.length === 0 && !state.loading ? h('p', { style: uiMuted }, '本对话尚无整理产物。可先选择参考对话，再发送“整理最近进展”。') : null,
    ...documents.map(document => h('article', { key: document.id, style: uiCard },
      h('div', { style: uiRow }, h('strong', null, document.title), document.updated ? h('span', { style: { ...uiMuted, color: T.warn } }, '来源有新内容') : null),
      document.sourceUnavailable ? h('p', { style: { ...uiMuted, color: T.warn } }, '部分来源当前不可读取，原整理产物保留，不能据此认定来源已更新。') : null,
      h('div', { style: uiMuted }, shortTime(document.createdAt)),
      h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: '1.6' } }, document.summary),
      document.decisions.length ? h('div', null, h('strong', null, '已作决策'), h('ul', null, ...document.decisions.map((text, index) => h('li', { key: index, style: { marginTop: '6px' } }, text)))) : null,
      document.unconfirmed.length ? h('div', null, h('strong', null, '未确认项'), h('ul', null, ...document.unconfirmed.map((text, index) => h('li', { key: index, style: { marginTop: '6px' } }, text)))) : null,
      h('div', { style: uiRow }, ...document.sources.map((source, index) => h('button', { key: `${source.provider}:${source.sessionId}:${source.eventId ?? index}`, type: 'button', style: uiButton, title: `${source.provider}:${source.sessionId}${source.eventId ? ` · ${source.eventId}` : ''}`, onClick: () => props.showSource(source) }, `来源 ${index + 1} · ${source.provider.toUpperCase()}`))),
      document.citations?.length ? h('details', { style: { marginTop: '8px' } }, h('summary', { style: { cursor: 'pointer' } }, '查看原文依据与版本'), ...document.citations.map((citation, index) => h('div', { key: `${citation.provider}:${citation.sessionId}:${citation.eventId ?? index}`, style: { marginTop: '8px' } }, h('button', { type: 'button', style: uiButton, onClick: () => props.showSource(citation) }, `${citation.title} · ${citation.eventId ?? citation.sessionId}`), h('blockquote', { style: { margin: '6px 0', paddingLeft: '10px', borderLeft: `2px solid ${T.border2}`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, citation.quote), h('code', { style: uiMuted }, `读取版本 ${citation.version}`)))) : null,
      document.path ? h('div', { style: { marginTop: '8px' } },
        h('code', { style: { ...uiMuted, display: 'block' } }, document.path),
        h('button', { type: 'button', style: { ...uiButton, marginTop: '6px' }, onClick: () => { openTaskFile(props.ctx, document.id, document.sessionId, document.path) } }, '用 DSH 打开文件'),
        fileResult?.taskId === document.id ? (fileResult.outcome.ok ? uiStatus(fileResult.outcome.message) : uiError(fileResult.outcome.message)) : null) : null,
      ...(document.drafts ?? []).map(renderDraft))),
    ...standaloneDrafts.filter(draft => !documents.some(document => document.drafts?.some(item => item.id === draft.id))).map(renderDraft))
}

/** 右栏四个视图；顺序即 tablist 顺序。 */
type RightView = 'workspace' | 'sources' | 'results' | 'workbench'
const RIGHT_TABS: readonly { id: RightView; label: string }[] = [
  { id: 'workspace', label: '工作区' },
  { id: 'sources', label: '其他对话' },
  { id: 'results', label: '整理结果' },
  { id: 'workbench', label: '任务与资料' },
]
/** 记住最后一次手动选择，避免同一页签的默认内容随"归属"漂移。 */
let lastRightView: RightView | undefined

/** Public SidebarRight page keeps the native conversation and composer in the center. */
export function ButlerRightPane(props: WorkspaceSlotProps): unknown {
  const ctx = props.ctx as Context, sessionId = currentSession(props), revision = useWorkspaceRevision()
  const [pane, setPane] = useState<{ sessionId?: string; view: RightView } | undefined>(() => {
    const view = sessionId ? workspacePaneRequest(sessionId) : undefined
    return view ? { sessionId, view } : undefined
  })
  const [source, setSource] = useState<{ sessionId: string; ref: SourceRef } | undefined>(undefined)
  const [task, setTask] = useState<{ sessionId: string; id: string } | undefined>(undefined)
  const workspace = useWorkspaceRead(fetchWorkspace, [revision])
  const lastWorkspace = useRef<WorkspaceSnapshot | undefined>(undefined)
  if (workspace.data) lastWorkspace.current = workspace.data.workspace
  const knownWorkspace = workspace.data?.workspace ?? lastWorkspace.current
  const owns = knownWorkspace?.sessions.some(item => item.id === sessionId) === true
  const requested = pane && pane.sessionId === sessionId ? pane.view : undefined
  const view: RightView = requested ?? (owns ? lastRightView ?? 'results' : 'sources')
  const setView = (next: RightView): void => { lastRightView = next; setPane({ sessionId, view: next }) }
  useEffect(() => { const next = sessionId ? consumeWorkspacePaneRequest(sessionId) : undefined; if (next) setView(next) }, [sessionId, revision])
  const tab = props.useTabInfo?.().tab
  // 右栏页签被隐藏时，让 useWorkspaceRead 的轮询停表（见 visibility.ts）。
  const paneVisible = tab?.visible !== false
  useEffect(() => {
    setRightPaneVisible(paneVisible)
    return () => setRightPaneVisible(true)
  }, [paneVisible])
  if (!sessionId) {
    return h('div', { className: 'butler-rightpane' }, h(ButlerStyles),
      h('div', { className: 'butler-rightpane__body' }, h(EmptyState, {
        title: '先打开一条会话',
        description: '管家资料依附在当前原生会话上：打开任意会话后，这里会显示它是否属于管家的主题、来源与整理结果。',
      })))
  }
  return h('div', {
    'data-dsh-butler-workspace': sessionId,
    className: 'butler-rightpane',
    style: tab?.visible === false ? { display: 'none' } : undefined,
  },
  h(ButlerStyles),
  h('div', { className: 'butler-rightpane__nav' }, h(Tablist, {
    items: RIGHT_TABS.map(item => ({ id: item.id, label: item.label })),
    activeId: view,
    onChange: (id: string) => setView(id as RightView),
    ariaLabel: '管家资料导航',
    idPrefix: `butler-right-${sessionId}`,
  })),
  owns ? h(ButlerDailyTrial, { key: `trial:${sessionId}`, sessionId }) : null,
  owns ? h(ButlerWorkspaceUsage, { key: sessionId, sessionId }) : null,
  h('div', { className: view === 'workbench' ? 'butler-rightpane__body butler-rightpane__body--flush' : 'butler-rightpane__body butler-scroll' },
    workspace.loading && !knownWorkspace ? uiStatus('正在读取管家工作区…') : workspace.error ? h('div', null, uiError(workspace.error),
      h('button', { type: 'button', style: uiButton, onClick: refreshWorkspaceUi }, '重新读取工作区'))
      : view === 'workspace' ? h(WorkspaceChats, { ctx }) : view === 'sources' ? h(ButlerSources, { key: sessionId, ctx, sessionId, canSelect: owns, initialRef: source?.sessionId === sessionId ? source.ref : undefined })
        : view === 'workbench' ? h(ButlerWorkbench, { key: sessionId, ctx, initialTaskId: task?.sessionId === sessionId ? task.id : undefined })
          : h(OrganizationResults, { key: sessionId, ctx, sessionId,
            showSource: (ref: SourceRef) => { setSource({ sessionId, ref }); setView('sources') },
            showTask: (id: string) => { setTask({ sessionId, id }); setView('workbench') } })))
}

/**
 * `main` 页：管家工作台本身。
 *
 * 页壳只负责一层全高容器：标题、状态 chips、「刷新 / 和管家说话」都由工作台
 * 自己的状态条提供，避免同一页出现两份标题和两个主按钮（第 4 步遗留的重复页头）。
 * 0.1.0 前这里是一块"跳板"：挂载即调用 openWorkspaceConversation 把页面换成
 * 某个管家会话；现在跳转只由用户点「和管家说话」触发。
 */
export function ButlerWorkspacePage(props: { ctx?: Context }): unknown {
  return h('div', { className: 'butler-page' }, h(ButlerWorkbench, { ctx: props.ctx }))
}

/** Source references and prepared text live above the native input, never in a second composer. */
export function ButlerSourceDock(props: WorkspaceSlotProps): unknown {
  const ctx = props.ctx as Context, sessionId = currentSession(props), revision = useWorkspaceRevision()
  const operation = useWorkspaceOperation([ctx, sessionId])
  const state = useWorkspaceRead(async () => {
    const workspace = await fetchWorkspace()
    if (!sessionId || !workspace.workspace.sessions.some(item => item.id === sessionId)) return undefined
    return await fetchSources({ butlerSessionId: sessionId })
  }, [sessionId, revision])
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setBusy(false); setMessage(undefined) }, [ctx, sessionId])
  useEffect(() => { if (sessionId) consumeWorkspacePaneHandoff(ctx, sessionId) }, [ctx, sessionId, revision])
  const selected = state.data?.selected ?? [], draft = sessionId ? workspaceDraft(sessionId) : undefined
  if (!state.data || !sessionId) return state.error ? uiError(state.error) : null
  const remove = (ref: SourceRef): void => {
    if (busy) return
    const isCurrent = operation(); setBusy(true)
    void selectSources(sessionId, selected.filter(item => !(item.provider === ref.provider && item.sessionId === ref.sessionId && item.eventId === ref.eventId)))
      .then(() => { if (isCurrent()) refreshWorkspaceUi() }, error => { if (isCurrent()) setMessage(String(error)) })
      .finally(() => { if (isCurrent()) setBusy(false) })
  }
  return h('div', { 'data-dsh-butler-reference-scope': sessionId, className: 'butler-dock' },
    h('div', { className: 'butler-dock__row' },
      h('span', { className: 'butler-surface__sub' }, `本次参考 ${selected.length} 项 · ${new Set(selected.map(ref => JSON.stringify([ref.provider, ref.sessionId]))).size} 条对话`),
      h(Button, { size: 'sm', variant: 'secondary', onClick: () => setMessage(openWorkspaceSidebar(ctx, 'sources').message) }, '选择来源'),
      ...selected.slice(0, 3).map(ref => { const title = state.data?.items.find(item => item.provider === ref.provider && item.sessionId === ref.sessionId)?.title ?? ref.sessionId
        return h(Button, {
          key: `${ref.provider}:${ref.sessionId}:${ref.eventId ?? ''}`,
          size: 'sm',
          variant: 'ghost',
          disabled: busy,
          title: `${ref.provider}:${ref.sessionId}${ref.eventId ? ` / 消息 ${ref.eventId}` : ' / 对话'}，点击移出本次参考`,
          onClick: () => remove(ref),
        }, `${ref.provider.toUpperCase()} · ${title}${ref.eventId ? ` · 消息 ${ref.eventId}` : ''} ×`)
      }),
      selected.length > 3 ? h(Button, { size: 'sm', variant: 'ghost', onClick: () => setMessage(openWorkspaceSidebar(ctx, 'sources').message) }, `另有 ${selected.length - 3} 条参考`) : null),
    draft ? h('div', { className: 'butler-dock__draft' },
      h('label', { htmlFor: 'butler-dock-draft', className: 'butler-surface__sub' }, '待发送的整理 / 确认指令'),
      h('textarea', {
        id: 'butler-dock-draft',
        readOnly: true,
        value: draft.text,
        rows: 2,
        className: 'butler-textarea',
        style: { maxHeight: '140px', resize: 'vertical' },
        'aria-label': '待发送的管家指令',
      }),
      h('div', { className: 'butler-dock__row' },
        h(Button, { size: 'sm', variant: 'primary', onClick: () => { const result = insertWorkspaceDraft(props.inputActions, draft.text); setMessage(result.message); if (result.ok) clearWorkspaceDraft(sessionId) } }, '加入原生输入框'),
        h(Button, { size: 'sm', variant: 'secondary', onClick: () => { const isCurrent = operation(); void copyWorkspaceText(draft.text).then(result => { if (isCurrent()) setMessage(result.message) }) } }, '复制指令'),
        h(Button, { size: 'sm', variant: 'ghost', onClick: () => clearWorkspaceDraft(sessionId) }, '收起指令'))) : null,
    uiStatus(message), uiError(state.error))
}

export function ButlerWorkspaceHeader(props: WorkspaceSlotProps): unknown {
  const ctx = props.ctx as Context, sessionId = currentSession(props), revision = useWorkspaceRevision(), workspace = useWorkspaceRead(fetchWorkspace, [revision])
  const operation = useWorkspaceOperation([ctx, sessionId])
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | undefined>(undefined)
  useEffect(() => { setBusy(false); setMessage(undefined) }, [ctx, sessionId])
  const owns = workspace.data?.workspace.sessions.some(item => item.id === sessionId) === true
  const act = (job: (isCurrent: () => boolean) => Promise<{ ok: boolean; message: string }>): void => { if (busy) return; const isCurrent = operation(); setBusy(true); void job(isCurrent).then(result => { if (isCurrent()) setMessage(result.message) }).finally(() => { if (isCurrent()) setBusy(false) }) }
  return h('div', { style: uiRow },
    h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => act(isCurrent => openWorkspaceConversation(ctx, undefined, undefined, isCurrent)) }, owns ? '管家工作区' : '打开管家'),
    sessionId && !owns ? h('button', { type: 'button', style: uiButton, disabled: busy || !workspace.data, onClick: () => act(isCurrent => handoffSourceToWorkspace(ctx, { provider: 'dsh', sessionId }, isCurrent)) }, '交给管家整理') : null,
    h('button', { type: 'button', style: uiButton, onClick: () => setMessage(openWorkspaceSidebar(ctx, owns ? 'results' : 'sources').message) }, '整理与资料'),
    owns ? h('button', { type: 'button', style: uiButton, onClick: () => setMessage(openWorkspaceSidebar(ctx, 'workspace').message) }, '新建主题') : null,
    message ? h('span', { role: 'status', title: message, style: { ...uiMuted, maxWidth: '240px' } }, message) : null,
    uiError(workspace.error))
}
