import { createElement as h, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_ID } from './ids.ts'
import { useTaskFileHandoff } from './workbench-actions.ts'
import { ButlerWorkspaceHeader, type WorkspaceSlotProps } from './workspace-panel.ts'
import { uiMuted } from './workspace-components.ts'

/** Native header; file handoffs wait for the arriving Session to render. */
export function ButlerHeaderAction(props: WorkspaceSlotProps): unknown {
  const ctx = props.ctx as Context
  const panel = ctx.layout?.panelInfo
  const active = useSyncExternalStore(() => () => {}, () => panel?.getSnapshot().activePanelId ?? null)
  const result = useTaskFileHandoff(ctx)
  return h('div', { 'data-dsh-butler-entry': PANEL_ID, 'data-dsh-butler-active': active, style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0', flexWrap: 'wrap' } },
    h(ButlerWorkspaceHeader, props as unknown as Record<string, unknown>),
    result ? h('span', { role: result.outcome.ok ? 'status' : 'alert', style: { ...uiMuted, maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      title: `${result.outcome.message}\n${result.path}` }, result.outcome.message, h('code', { style: { marginLeft: '6px' } }, result.path)) : null)
}
