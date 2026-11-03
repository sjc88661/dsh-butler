/**
 * 会话头部：一个「管家」主按钮 + 一个「⋯」操作菜单。
 *
 * 0.1.0 的入口收敛把原来头部并排的 4 个按钮合成「一个主入口 + 一个菜单」：
 * 主按钮只做一件事（打开管家对话，失败时回落到工作台并说明原因），
 * 其余低频动作（工作台、整理与资料、新建主题、交给管家整理）进菜单，
 * 从而在会话头部只占一个控件宽度。
 *
 * 文件交接（useTaskFileHandoff）的反馈仍显示在同一行：它来自任务详情里的
 * 「用 DSH 打开文件」，必须等原生会话渲染后才真正打开，失败时用 alert 角色
 * 报告，不能静默失败。
 *
 * @module @dsh-external/dsh-butler/client
 */
import { createElement as h, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_ID } from './ids.ts'
import { ButlerBellGlyph } from './icon.ts'
import { useTaskFileHandoff } from './workbench-actions.ts'
import { openButlerConversation, selectWorkbench } from './navigate.ts'
import { handoffSourceToWorkspace, openWorkspaceSidebar } from './workspace-actions.ts'
import { ButlerStyles, Button, MenuButton } from './ui/index.ts'
import type { MenuEntry } from './ui/index.ts'

/** 头部席位拿到的 props：面板上下文，以及当前原生会话（可能没有）。 */
export interface ButlerHeaderProps {
  ctx?: Context
  sessionId?: string
}

/** 页面动作的统一返回形状（与 workspace-actions 的 WorkspaceOutcome 同构）。 */
interface ActionOutcome {
  ok: boolean
  message?: string
  reason?: string
}

/**
 * 会话头部入口。
 * @param props - 面板上下文与当前会话 id。
 * @returns 头部控件行。
 */
export function ButlerHeaderAction(props: ButlerHeaderProps): unknown {
  const ctx = props.ctx as Context
  const panel = ctx.layout?.panelInfo
  const active = useSyncExternalStore(() => () => {}, () => panel?.getSnapshot().activePanelId ?? null)
  const handoff = useTaskFileHandoff(ctx)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [noticeFailed, setNoticeFailed] = useState(false)

  const report = (outcome: ActionOutcome | undefined): void => {
    if (outcome === undefined) return
    const text = outcome.ok ? outcome.message : (outcome.message ?? outcome.reason)
    setNotice(text === undefined || text === '' ? undefined : text)
    setNoticeFailed(outcome.ok !== true)
  }

  const run = (job: () => Promise<ActionOutcome>): void => {
    if (busy) return
    setBusy(true)
    void job().then(report, error => report({ ok: false, message: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false))
  }

  const items: MenuEntry[] = [
    { id: 'workbench', label: '打开管家工作台' },
    { type: 'separator', id: 'sep-primary' },
    { id: 'organize', label: '整理与资料' },
    { id: 'new-topic', label: '新建主题' },
  ]
  if (props.sessionId !== undefined) {
    items.push({ type: 'separator', id: 'sep-handoff' }, { id: 'handoff', label: '交给管家整理' })
  }

  const onSelect = (id: string): void => {
    switch (id) {
      case 'workbench': {
        const outcome = selectWorkbench(ctx)
        report({ ok: outcome.ok, message: outcome.ok ? '已打开管家工作台。' : outcome.reason })
        break
      }
      case 'organize': report(openWorkspaceSidebar(ctx, 'results')); break
      case 'new-topic': report(openWorkspaceSidebar(ctx, 'workspace')); break
      case 'handoff': {
        const sessionId = props.sessionId
        if (sessionId !== undefined) run(() => handoffSourceToWorkspace(ctx, { provider: 'dsh', sessionId }))
        break
      }
      default: break
    }
  }

  return h('div', {
    'data-dsh-butler-entry': PANEL_ID,
    'data-dsh-butler-active': active,
    className: 'butler-headerbar',
  },
  h(ButlerStyles),
  h(Button, {
    variant: 'primary',
    size: 'sm',
    icon: h(ButlerBellGlyph, { size: 14 }),
    busy,
    title: '打开管家对话',
    onClick: () => run(() => openButlerConversation(ctx)),
  }, '管家'),
  h(MenuButton, {
    label: '⋯',
    ariaLabel: '更多管家操作',
    items,
    onSelect,
    variant: 'secondary',
    size: 'sm',
    align: 'end',
  }),
  notice === undefined ? null : h('span', {
    role: noticeFailed ? 'alert' : 'status',
    className: 'butler-headerbar__notice',
    title: notice,
  }, notice),
  handoff === undefined ? null : h('span', {
    role: handoff.outcome.ok ? 'status' : 'alert',
    className: 'butler-headerbar__notice',
    title: `${handoff.outcome.message}\n${handoff.path}`,
  }, handoff.outcome.message, h('code', { className: 'butler-headerbar__path' }, handoff.path)))
}
