import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { subscribeWorkspaceUi, workspaceUiRevision } from './workspace-actions.ts'
import { documentHidden, onDocumentVisible, rightPaneVisible } from './visibility.ts'
import { buttonStyle, T } from './view.ts'

export const uiButton = { ...buttonStyle, minHeight: '32px', color: T.text }
export const uiInput = { boxSizing: 'border-box', minWidth: '0', width: '100%', minHeight: '34px', borderRadius: '6px', padding: '6px 8px', background: T.bg, color: T.text, border: `1px solid ${T.border2}`, font: 'inherit' }
export const uiCard = { borderBottom: `1px solid ${T.border}`, padding: '12px 0', minWidth: '0' }
export const uiRow = { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }
export const uiMuted = { color: T.dim, fontSize: '12px', overflowWrap: 'anywhere' }
export const uiError = (text: string | undefined): unknown => text ? h('div', { role: 'alert', style: { ...uiMuted, color: T.err, padding: '8px 0' } }, text) : null
export const uiStatus = (text: string | undefined): unknown => text ? h('div', { role: 'status', style: { ...uiMuted, padding: '8px 0' } }, text) : null
export function useWorkspaceRevision(): number { return useSyncExternalStore(subscribeWorkspaceUi, workspaceUiRevision, workspaceUiRevision) }
/** A new operation or a changed/unmounted owner invalidates earlier async UI work. */
export function useWorkspaceOperation(deps: readonly unknown[]): () => () => boolean {
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, deps)
  return () => { const request = ++generation.current; return () => generation.current === request }
}
/** Read effects discard stale results when the Session, query or UI revision changes. */
export function useWorkspaceRead<T>(read: () => Promise<T>, deps: readonly unknown[], intervalMs?: number): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  useEffect(() => {
    let current = true, generation = 0
    setState({ loading: true })
    const load = (): void => {
      const request = ++generation
      void read().then(data => { if (current && generation === request) setState({ data, loading: false }) }, error => {
        if (current && generation === request) setState({ error: error instanceof Error ? error.message : String(error), loading: false })
      })
    }
    load()
    // 轮询只在"界面确实可见"时发请求：后台标签页与隐藏的右栏页签都跳过；
    // 回到可见时立即补一次，避免等下一个周期才刷新。
    const poll = intervalMs === undefined ? undefined : window.setInterval(() => {
      if (documentHidden() || !rightPaneVisible()) return
      load()
    }, intervalMs)
    const cancelVisible = intervalMs === undefined ? undefined : onDocumentVisible(() => {
      if (rightPaneVisible()) load()
    })
    return () => {
      current = false
      if (poll !== undefined) window.clearInterval(poll)
      cancelVisible?.()
    }
  }, deps)
  return state
}
