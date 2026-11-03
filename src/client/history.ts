import { createElement as h, useEffect, useState } from 'react'
import { fetchHistory, type HistoryKind, type HistoryPage } from './api.ts'
import { buttonStyle, emptyLine, T } from './view.ts'

interface HistoryProps<K extends HistoryKind> {
  kind: K
  taskId?: string
  limit?: number
  renderPage: (page: HistoryPage<K>) => unknown
}

/** A browser owns one scope and one projection revision, independent of dashboard polling. */
export function HistoryBrowser<K extends HistoryKind>({ kind, taskId, limit = 100, renderPage }: HistoryProps<K>): unknown {
  const [page, setPage] = useState<HistoryPage<K> | null>(null)
  const [request, setRequest] = useState<{ offset: number; revision?: string; refresh: number }>({ offset: 0, refresh: 0 })
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setProblem(null)
    void fetchHistory(kind, { ...(taskId === undefined ? {} : { taskId }), offset: request.offset, limit, revision: request.revision }, controller.signal).then(next => {
      if (!controller.signal.aborted) { setPage(next); setLoading(false) }
    }, (error: unknown) => {
      if (!controller.signal.aborted) { setProblem(error instanceof Error ? error.message : String(error)); setLoading(false) }
    })
    return () => controller.abort()
  }, [kind, taskId, limit, request])
  const visible = page?.kind === kind && page.taskId === taskId ? page : null
  const move = (offset: number): void => {
    if (visible) { setLoading(true); setRequest({ offset, revision: visible.revision, refresh: request.refresh }) }
  }
  const refresh = (): void => {
    setPage(null); setLoading(true)
    setRequest(previous => ({ offset: 0, refresh: previous.refresh + 1 }))
  }
  return h('div', { 'data-butler-history': `${kind}:${taskId ?? ''}` },
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', padding: '5px 0' } },
      h('button', { type: 'button', style: buttonStyle, disabled: loading || !!problem || !visible || visible.offset === 0, onClick: () => move(Math.max(0, visible!.offset - visible!.limit)) }, '上一页'),
      h('button', { type: 'button', style: buttonStyle, disabled: loading || !!problem || visible?.nextOffset === undefined, onClick: () => move(visible!.nextOffset!) }, '下一页'),
      h('button', { type: 'button', style: buttonStyle, disabled: loading, onClick: refresh }, '刷新历史'),
      emptyLine(visible ? `${visible.total ? visible.offset + 1 : 0}–${visible.offset + visible.items.length} / ${visible.total} 项` : '尚未读取')),
    loading ? emptyLine('正在读取历史…') : null,
    problem ? h('div', { role: 'alert', style: { color: T.warn, fontSize: '12px', wordBreak: 'break-word' } }, `${problem}；已显示的内容保留为上次快照，请刷新历史。`) : null,
    visible ? h('div', { key: `${visible.revision}:${visible.offset}` }, renderPage(visible)) : null)
}

/** Keep the cheap first-screen preview until the owner explicitly browses its history. */
export function HistorySection<K extends HistoryKind>(props: HistoryProps<K> & { preview: unknown }): unknown {
  const [browsing, setBrowsing] = useState(false)
  return browsing ? h(HistoryBrowser<K>, { ...props, key: `${props.kind}:${props.taskId ?? ''}` }) : h('div', {}, props.preview,
    h('button', { type: 'button', style: buttonStyle, onClick: () => setBrowsing(true) }, '浏览完整历史'))
}
