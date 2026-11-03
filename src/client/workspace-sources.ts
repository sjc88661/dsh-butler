import { createElement as h, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { clientService } from './navigate.ts'
import { configureSources, fetchSources, readSource, selectSources, type SourceConversation, type SourceRead, type SourceRef } from './workspace-api.ts'
import { prepareOrganizationDraft, refreshWorkspaceUi } from './workspace-actions.ts'
import { uiButton, uiCard, uiError, uiInput, uiMuted, uiRow, uiStatus, useWorkspaceOperation, useWorkspaceRead, useWorkspaceRevision } from './workspace-components.ts'
import { shortTime, T } from './view.ts'

const sameSource = (a: SourceRef, b: SourceRef): boolean => a.provider === b.provider && a.sessionId === b.sessionId && a.eventId === b.eventId
const sameConversation = (a: SourceRef, b: SourceRef): boolean => a.provider === b.provider && a.sessionId === b.sessionId
interface SourceViewState { query: string; project: string; provider: string; since: string; filters: Record<string, string>; visible: number; pages: string[] }
/** View metadata only, bounded per browser runtime; raw source messages are never cached here. */
const sourceViews = new Map<string, SourceViewState>()
const initialView = (sessionId: string): SourceViewState => sourceViews.get(sessionId) ?? { query: '', project: '', provider: '', since: '', filters: {}, visible: 30, pages: [] }
function rememberView(sessionId: string, view: SourceViewState): void {
  sourceViews.delete(sessionId); sourceViews.set(sessionId, { ...view, filters: { ...view.filters }, pages: [...view.pages] })
  if (sourceViews.size > 32) sourceViews.delete(sourceViews.keys().next().value!)
}
export function sourceDisplayRows(items: SourceConversation[]): Array<{ item: SourceConversation; depth: number }> {
  const known = new Map(items.map(item => [`${item.provider}:${item.sessionId}`, item])), visited = new Set<string>(), result: Array<{ item: SourceConversation; depth: number }> = []
  const add = (item: SourceConversation, depth: number): void => {
    if (visited.has(item.key)) return
    visited.add(item.key); result.push({ item, depth: Math.min(depth, 6) })
    for (const child of items) if (child.provider === item.provider && child.parentId === item.sessionId) add(child, depth + 1)
  }
  for (const item of items) if (!item.parentId || !known.has(`${item.provider}:${item.parentId}`)) add(item, 0)
  for (const item of items) add(item, 0)
  return result
}

export function ButlerSources(props: { ctx: Context; sessionId: string; canSelect: boolean; initialRef?: SourceRef }): unknown {
  const revision = useWorkspaceRevision()
  const operation = useWorkspaceOperation([props.ctx, props.sessionId])
  const [query, setQuery] = useState(() => initialView(props.sessionId).query), [project, setProject] = useState(() => initialView(props.sessionId).project), [provider, setProvider] = useState(() => initialView(props.sessionId).provider), [since, setSince] = useState(() => initialView(props.sessionId).since)
  const [filters, setFilters] = useState<Record<string, string>>(() => initialView(props.sessionId).filters), [visible, setVisible] = useState(() => initialView(props.sessionId).visible)
  const [pages, setPages] = useState<string[]>(() => initialView(props.sessionId).pages)
  const [detail, setDetail] = useState<SourceRead | undefined>(undefined), [detailRef, setDetailRef] = useState<SourceRef | undefined>(undefined)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | undefined>(undefined)
  const readGeneration = useRef(0)
  const state = useWorkspaceRead(() => fetchSources({ ...filters, butlerSessionId: props.sessionId }), [props.sessionId, filters, revision])
  const data = state.data
  useEffect(() => { rememberView(props.sessionId, { query, project, provider, since, filters, visible, pages }) }, [props.sessionId, query, project, provider, since, filters, visible, pages])
  const action = (job: (isCurrent: () => boolean) => Promise<unknown>, success: string, refresh = true): void => {
    if (busy) return
    const isCurrent = operation()
    setBusy(true); setMessage(undefined)
    void job(isCurrent).then(() => {
      if (!isCurrent()) return
      setMessage(success)
      if (refresh) { readGeneration.current++; setDetail(undefined); setDetailRef(undefined); refreshWorkspaceUi() }
    }, error => { if (isCurrent()) setMessage(error instanceof Error ? error.message : String(error)) }).finally(() => { if (isCurrent()) setBusy(false) })
  }
  const show = (ref: SourceRef, offset = 0): void => {
    const request = ++readGeneration.current
    setDetail(undefined); setDetailRef(ref); setMessage('正在读取来源…')
    void readSource(ref, offset).then(result => { if (readGeneration.current === request) { setDetail(result); setMessage(undefined) } }, error => {
      if (readGeneration.current === request) setMessage(error instanceof Error ? error.message : String(error))
    })
  }
  const selected = data?.selected ?? []
  const openOriginal = (sessionId: string): void => {
    const isCurrent = operation()
    void (async () => {
      try {
        const workspace = clientService<{ openSession(id: string): void | Promise<void> }>(props.ctx, 'uiWorkspace')
        if (!workspace) throw new Error('当前界面无法打开原会话。')
        await workspace.openSession(sessionId)
      } catch (error) { if (isCurrent()) setMessage(error instanceof Error ? error.message : String(error)) }
    })()
  }
  useEffect(() => { readGeneration.current++; setDetail(undefined); setDetailRef(undefined); return () => { readGeneration.current++ } }, [revision, props.sessionId])
  useEffect(() => { if (props.initialRef) show(props.initialRef) }, [props.initialRef?.provider, props.initialRef?.sessionId, props.initialRef?.eventId])
  const toggle = (ref: SourceRef): void => action(() => selectSources(props.sessionId, selected.some(item => sameSource(item, ref)) ? selected.filter(item => !sameSource(item, ref)) : [...selected, ref]), '参考范围已更新。')
  return h('section', { 'aria-label': '其他对话与来源设置' },
    h('h2', { style: { margin: '0 0 8px', fontSize: '14px', lineHeight: '22px', fontWeight: 600, color: T.text } }, '对话来源'),
    props.canSelect ? h('section', { 'aria-label': '本次整理参考范围', style: uiCard },
      h('strong', null, `本次参考 ${selected.length} 项`),
      h('p', { style: uiMuted }, '指定消息与整段对话分别列出；准备指令只生成未发送草稿。'),
      ...selected.map(ref => h('div', { key: JSON.stringify(ref), style: { marginTop: '8px' } },
        h('div', { style: uiMuted }, `${ref.provider.toUpperCase()} · ${data?.items.find(item => sameConversation(item, ref))?.title ?? ref.sessionId}`),
        h('code', { style: { ...uiMuted, display: 'block' } }, ref.eventId ? `仅消息 ${ref.eventId}` : '整段对话（按需有界读取）'),
        h('div', { style: { ...uiRow, marginTop: '4px' } },
          h('button', { type: 'button', style: uiButton, onClick: () => show(ref) }, '查看已选原文'),
          h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => toggle(ref) }, '移除此项')))),
      h('button', { type: 'button', style: { ...uiButton, marginTop: '8px' }, disabled: busy || state.loading || !selected.length, onClick: () => action(async isCurrent => {
        const result = await prepareOrganizationDraft(props.sessionId, isCurrent); if (!result.ok) throw new Error(result.message)
      }, '整理指令已备好；请在原生输入框上方核对后发送。', false) }, '准备整理指令')) : null,
    h('form', { onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); setFilters({ q: query, project, provider, since }); setVisible(30); setPages([]) }, style: { display: 'grid', gap: '8px' } },
      h('label', null, '查找对话', h('input', { style: uiInput, value: query, onChange: (event: { target: { value: string } }) => setQuery(event.target.value), placeholder: '标题或内容关键词' })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
        h('label', null, '来源', h('select', { value: provider, style: uiInput, onChange: (event: { target: { value: string } }) => setProvider(event.target.value) }, h('option', { value: '' }, '全部'), h('option', { value: 'dsh' }, 'DSH'), h('option', { value: 'codex' }, 'Codex'))),
        h('label', null, '更新起始日期', h('input', { type: 'date', value: since, style: uiInput, onChange: (event: { target: { value: string } }) => setSince(event.target.value) }))),
      h('label', null, '项目 / 工作区', h('input', { style: uiInput, value: project, onChange: (event: { target: { value: string } }) => setProject(event.target.value), placeholder: '项目路径或名称' })),
      h('button', { type: 'submit', style: uiButton, disabled: state.loading }, state.loading ? '正在更新索引…' : '搜索 / 刷新')),
    // 读失败与"正在读取来源…"都进同一个 polite 区域：读屏用户不会漏掉异步结果。
    h('div', { 'aria-live': 'polite', 'aria-atomic': 'false' }, uiError(state.error), uiStatus(message)),
    data ? h('details', { style: uiCard }, h('summary', { style: { cursor: 'pointer' } }, '来源设置与读取范围'),
      h('p', { style: uiMuted }, '索引更新不调用模型；整理时按需读取。其他对话中的内容只作资料参考。'),
      h('label', { style: uiRow }, h('input', { type: 'checkbox', checked: data.settings.codexEnabled, disabled: busy, onChange: (event: { target: { checked: boolean } }) => action(() => configureSources({ codexEnabled: event.target.checked }), 'Codex 来源设置已更新。') }), '允许只读本机 Codex 已保存对话'),
      ...data.status.map(status => h('div', { key: status.provider, style: { ...uiMuted, marginTop: '6px' } }, `${status.provider.toUpperCase()}：${!status.enabled ? '未启用' : status.available ? '可读取' : '不可用'}${status.error ? ` · ${status.error}` : ''}`)),
      ...data.settings.excludedConversations.map(key => h('div', { key, style: { ...uiRow, marginTop: '8px' } }, h('code', { style: { ...uiMuted, flex: '1 1 150px' } }, key), h('button', { type: 'button', disabled: busy, style: uiButton, onClick: () => action(() => configureSources({ excludedConversations: data.settings.excludedConversations.filter(value => value !== key) }), '已恢复此对话读取。') }, '恢复读取'))),
      ...data.settings.excludedWorkspaces.map(key => h('div', { key, style: { ...uiRow, marginTop: '8px' } }, h('code', { style: { ...uiMuted, flex: '1 1 150px' } }, key), h('button', { type: 'button', disabled: busy, style: uiButton, onClick: () => action(() => configureSources({ excludedWorkspaces: data.settings.excludedWorkspaces.filter(value => value !== key) }), '已恢复此工作区读取。') }, '恢复工作区读取')))) : null,
    detail && detailRef ? h('article', { style: uiCard, 'aria-label': '只读来源原文' },
      h('div', { style: uiRow }, h('strong', null, detail.conversation.title), h('button', { type: 'button', style: uiButton, onClick: () => { readGeneration.current++; setDetail(undefined); setDetailRef(undefined) } }, '关闭原文')),
      h('code', { style: { ...uiMuted, display: 'block' } }, `${detailRef.provider}:${detailRef.sessionId}`),
      detailRef.provider === 'dsh' ? h('button', { type: 'button', style: { ...uiButton, marginTop: '6px' }, onClick: () => openOriginal(detailRef.sessionId) }, '打开原会话') : null,
      h('p', { style: uiMuted }, `读取版本 ${detail.version}`),
      ...detail.messages.map(item => h('div', { key: item.id, style: { borderTop: `1px solid ${T.border}`, marginTop: '10px', paddingTop: '8px' } },
        h('div', { style: uiMuted }, `${item.role} · ${item.id}${item.at ? ` · ${shortTime(item.at)}` : ''}`),
        h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', lineHeight: '1.6', margin: '6px 0' } }, item.text))),
      detail.truncated ? h('div', { style: uiRow }, h('span', { style: uiMuted }, '当前为有界片段。'), detail.nextOffset === undefined ? null : h('button', { type: 'button', style: uiButton, onClick: () => show(detailRef, detail.nextOffset) }, '下一页原文')) : null) : null,
    data?.items.length === 0 ? h('p', { style: uiMuted }, '当前范围没有匹配对话；来源不可用时请查看上方状态。') : null,
    ...sourceDisplayRows(data?.items ?? []).slice(0, visible).map(({ item, depth }) => {
      const ref: SourceRef = { provider: item.provider, sessionId: item.sessionId }, isSelected = selected.some(value => sameConversation(value, ref))
      return h('article', { key: item.key, style: { ...uiCard, paddingLeft: `${Math.min(depth, 3) * 12}px` } },
        h('div', { style: uiRow }, h('strong', { style: { flex: '1 1 180px', overflowWrap: 'anywhere' } }, item.title), h('span', { style: uiMuted }, item.provider.toUpperCase())),
        h('div', { style: uiMuted }, `${item.parentId ? '子智能体 · ' : ''}${item.project || '未指定项目'} · ${shortTime(item.updatedAt)}`),
        h('code', { style: { ...uiMuted, display: 'block', fontSize: '11px' } }, item.sessionId), item.error ? uiError(item.error) : null,
        h('div', { style: { ...uiRow, marginTop: '8px' } },
          h('button', { type: 'button', style: uiButton, onClick: () => show(ref) }, '查看原文'),
          props.canSelect ? h('button', { type: 'button', style: uiButton, disabled: busy, 'aria-pressed': isSelected, onClick: () => action(() => selectSources(props.sessionId, isSelected ? selected.filter(value => !sameConversation(value, ref)) : [...selected, ref]), '参考范围已更新。') }, isSelected ? '移出此对话' : '加入参考范围') : null,
          item.provider === 'dsh' ? h('button', { type: 'button', style: uiButton, onClick: () => openOriginal(item.sessionId) }, '打开原会话') : null),
        h('details', { style: { marginTop: '8px', ...uiMuted } }, h('summary', { style: { cursor: 'pointer' } }, '读取权限'), h('div', { style: { ...uiRow, marginTop: '6px' } },
          h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => action(() => configureSources({ excludedConversations: [...data!.settings.excludedConversations, item.key] }), '已排除此对话，后续检索与上下文立即生效。') }, '不读取此对话'),
          item.project ? h('button', { type: 'button', style: uiButton, disabled: busy, onClick: () => action(() => configureSources({ excludedWorkspaces: [...data!.settings.excludedWorkspaces, `${item.provider}:${item.project}`] }), '已排除此工作区。') }, '不读取此工作区') : null)))
    }),
    (data?.items.length ?? 0) > visible ? h('button', { type: 'button', style: uiButton, onClick: () => setVisible(value => value + 30) }, '显示更多对话') : null,
    h('div', { style: { ...uiRow, marginTop: '12px' } },
      pages.length ? h('button', { type: 'button', style: uiButton, disabled: state.loading, onClick: () => { const previous = pages.at(-1) ?? '0'; setPages(current => current.slice(0, -1)); setFilters(current => ({ ...current, offset: previous })); setVisible(30) } }, '上一页对话') : null,
      data?.nextOffset === undefined ? null : h('button', { type: 'button', style: uiButton, disabled: state.loading, onClick: () => { setPages(current => [...current, filters.offset ?? '0']); setFilters(current => ({ ...current, offset: String(data.nextOffset) })); setVisible(30) } }, '下一页对话'),
      data?.truncated && data.nextOffset === undefined ? h('span', { style: uiMuted }, '结果已达读取上限，请缩小筛选范围。') : null))
}
