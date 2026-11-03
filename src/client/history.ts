/**
 * History paging browser and its lightweight first-screen preview.
 *
 * The browser owns one immutable projection revision and its own page offset;
 * dashboard polling never resets either, and a failed page keeps the last
 * successful snapshot on screen. Styling is the design system's: the paging
 * controls are host `<button>` elements carrying `butler-btn` classes (the
 * panel harness addresses them by accessible name), and failures use the
 * shared `InlineError` component instead of a one-off red line.
 *
 * @module @dsh-external/dsh-butler/client
 */
import { createElement as h, useEffect, useState } from 'react'
import { fetchHistory, type HistoryKind, type HistoryPage } from './api.ts'
import { InlineError, LoadingBlock } from './ui/index.ts'
import { BUTLER_SPACE } from './ui/index.ts'

/** Shared compact control classes. */
const controlClass = 'butler-btn butler-btn--secondary butler-btn--sm'

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
  return h('div', { 'data-butler-history': `${kind}:${taskId ?? ''}`, style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.xs, minWidth: '0' } },
    h('div', { className: 'butler-row', style: { padding: '5px 0' } },
      h('button', { type: 'button', className: controlClass, disabled: loading || !!problem || !visible || visible.offset === 0, onClick: () => move(Math.max(0, visible!.offset - visible!.limit)) }, '上一页'),
      h('button', { type: 'button', className: controlClass, disabled: loading || !!problem || visible?.nextOffset === undefined, onClick: () => move(visible!.nextOffset!) }, '下一页'),
      h('button', { type: 'button', className: controlClass, disabled: loading, onClick: refresh }, '刷新历史'),
      h('span', { className: 'butler-muted' }, visible ? `${visible.total ? visible.offset + 1 : 0}–${visible.offset + visible.items.length} / ${visible.total} 项` : '尚未读取')),
    loading ? h(LoadingBlock, { label: '正在读取历史…', lines: 2 }) : null,
    problem === null ? null : h(InlineError, {
      message: `${problem}；已显示的内容保留为上次快照，请刷新历史。`,
      retry: refresh,
      retryLabel: '重试',
    }),
    visible ? h('div', { key: `${visible.revision}:${visible.offset}` }, renderPage(visible)) : null)
}

/** Keep the cheap first-screen preview until the owner explicitly browses its history. */
export function HistorySection<K extends HistoryKind>(props: HistoryProps<K> & { preview: unknown }): unknown {
  const [browsing, setBrowsing] = useState(false)
  return browsing
    ? h(HistoryBrowser<K>, { ...props, key: `${props.kind}:${props.taskId ?? ''}` })
    : h('div', { style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.xs, minWidth: '0' } }, props.preview,
      h('button', { type: 'button', className: controlClass, onClick: () => setBrowsing(true) }, '浏览完整历史'))
}
