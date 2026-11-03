/**
 * @dsh-external/dsh-butler - client half.
 * Build: tsdown -> lib/client.js (window.__ModuleLoader__.load registration).
 *
 * Contributes native navigation, composer scope and a right-hand page through
 * `slots.inject`, so load order against the
 * shell plugins does not matter and a shell that cannot serve a seat simply
 * leaves that one absent instead of failing its boot:
 *
 *   `conversation.session.header.actions`  the 管家模式 button (one click in)
 *   `sidebar.panellist`               a 管家 row beside Plugins/Schedule/Task board
 *   `main` (keyed by PANEL_ID)        the dedicated-chat navigation launchpad
 *   `conversation.view` (id butler)   the same workbench as a Conversation View tab
 *   `conversation.input.dock`        selected references and an unsent instruction
 *   `sidebar.right.pane.tab`         sources, organization and the workbench
 *
 * The `name:` literals below are deliberately written at the call site: the
 * injector's pre-injection check greps the BUILT bundle for `name: '<seat>'`,
 * and a named constant is folded into a bare identifier by the bundler - the
 * runtime is fine either way, but a folded name fails that check and blocks
 * injection (learned the hard way on the first P0 build).
 *
 * React is NOT bundled: the factory receives it from the web shell's module
 * loader (`require('react')`, same as every shipped client plugin), which is
 * why `react` is neither a dependency nor a build input here.
 *
 * @module @dsh-external/dsh-butler/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { ButlerHeaderAction } from './header.ts'
import { ButlerPanelIcon } from './icon.ts'
import { PANEL_ID, PANEL_ORDER } from './ids.ts'
import { ButlerWorkbench } from './panel.ts'
import { clientService } from './navigate.ts'
import { ButlerRightPane, ButlerSourceDock, ButlerSourcesEntry, ButlerWorkspaceEntry } from './workspace-panel.ts'

/** Required core services; optional native workspace/rightbar faces are resolved per action. */
export const inject = ['slots', 'layout']

/**
 * One seat contribution: the human name used in the console report, the
 * component it renders, and the registration options the shell reads.
 */
interface SeatContribution {
  /** Human name used in the console report. */
  label: string
  /** The workbench page or the sidebar glyph. */
  component: unknown
  /** Registration options, minus the seat name that is written at the call. */
  options: Record<string, unknown>
}

/** The four seats this plugin occupies, in contribution order. */
const CONTRIBUTIONS: readonly SeatContribution[] = [
  // Header button: the owner's requested one-click way in.
  {
    label: '会话头部按钮',
    component: ButlerHeaderAction,
    options: { id: PANEL_ID, order: 40, label: () => '管家模式' },
  },
  // Sidebar row: the shell owns the button box, label, tooltip and active
  // highlight; this contribution is only the id, the order and the glyph.
  {
    label: '侧栏行',
    component: ButlerPanelIcon,
    options: { id: PANEL_ID, order: PANEL_ORDER, label: () => '管家' },
  },
  // Center-column page: mounted by the layout only while this panel is
  // selected, so the Conversation keeps the center column the rest of the time.
  {
    label: '专属工作区入口',
    component: ButlerWorkspaceEntry,
    options: { key: PANEL_ID },
  },
  // Conversation View tab: the same workbench inside a chat session, beside the
  // shipped 对话 / 轨迹 views.
  {
    label: '对话视图',
    component: ButlerWorkbench,
    options: { id: PANEL_ID, order: 90, label: () => '管家' },
  },
]

/**
 * Mount the butler's sidebar row, workbench page and Conversation View tab.
 *
 * Each seat is registered inside its own `slots.inject` (the callback runs only
 * once the owner declares the seat) and inside its own try/catch: a plugin's
 * `apply` throwing fails the whole web boot, so one unavailable seat must not
 * cost the others.
 *
 * The seat names are spelled at the `register(` call rather than read from the
 * table above on purpose: the injector's pre-injection check greps the built
 * bundle with `register\(\{[\s\S]*?name:\s*['"](<known seat>)['"]`, whose
 * lazy-but-unanchored middle spans anywhere in the file, so a `name:` written
 * next to its own `register(` is what keeps that check honest.
 * @param ctx - client root context (service: slots).
 */
export function apply(ctx: Context): void {
  const slots = ctx.slots
  const disposers: Array<() => void> = []

  const butlerHeaderAction = (): () => void => {
    try {
      return slots.register({ name: 'conversation.session.header.actions', ...CONTRIBUTIONS[0]!.options, inject: () => ({ ctx }) }, ButlerHeaderAction as never)
    } catch (error) {
      console.error('[dsh-butler] 会话头部按钮 注册失败：', error)
      return () => {}
    }
  }

  disposers.push(slots.inject('conversation.session.header.actions', butlerHeaderAction))

  disposers.push(slots.inject('sidebar.panellist', () => {
    try {
      return slots.register({ name: 'sidebar.panellist', ...CONTRIBUTIONS[1]!.options }, ButlerPanelIcon)
    } catch (error) {
      console.error('[dsh-butler] 侧栏行 注册失败：', error)
      return () => {}
    }
  }))

  disposers.push(slots.inject('main', () => {
    try {
      // The workbench gets `ctx` so its 和管家说话 button can navigate; the
      // layout passes `inject` results to the component as props, the same way
      // the task board hands its controller to the `main` page.
      return slots.register({ name: 'main', ...CONTRIBUTIONS[2]!.options, inject: () => ({ ctx }) }, ButlerWorkspaceEntry as never)
    } catch (error) {
      console.error('[dsh-butler] 工作台页面 注册失败：', error)
      return () => {}
    }
  }))

  disposers.push(slots.inject('conversation.view', () => {
    try {
      return slots.register({ name: 'conversation.view', ...CONTRIBUTIONS[3]!.options, inject: () => ({ ctx }) }, ButlerWorkbench as never)
    } catch (error) {
      console.error('[dsh-butler] 对话视图 注册失败：', error)
      return () => {}
    }
  }))

  disposers.push(slots.inject('conversation.input.dock', () => {
    try {
      return slots.register({ name: 'conversation.input.dock', id: 'butler-reference-scope', order: 65, inject: () => ({ ctx }) }, ButlerSourceDock as never)
    } catch (error) {
      console.error('[dsh-butler] 参考范围输入栏 注册失败：', error)
      return () => {}
    }
  }))

  disposers.push(slots.inject('sidebar.right.pane.tab', () => {
    try {
      const tabs = clientService<{ register(definition: { id: string; kind: string; title(): string }): () => void }>(ctx, 'sidebarRightTabs')
      if (!tabs) return () => {}
      const definition = tabs.register({ id: '@dsh-external/dsh-butler/workspace', kind: 'butler-workspace', title: () => '管家资料' })
      try {
        const body = slots.register({ name: 'sidebar.right.pane.tab', key: '@dsh-external/dsh-butler/workspace', inject: () => ({ ctx }) }, ButlerRightPane as never)
        return () => { body(); definition() }
      } catch (error) { definition(); throw error }
    } catch (error) {
      console.error('[dsh-butler] 管家右栏 注册失败：', error)
      return () => {}
    }
  }))

  // A first-level source entry in the native left navigation. Its landing page
  // opens a managed chat, then the arriving native composer opens the right page.
  disposers.push(slots.inject('sidebar.panellist', () => {
    try { return slots.register({ name: 'sidebar.panellist', id: 'butler-sources', order: PANEL_ORDER + 1, label: () => '对话来源' }, ButlerPanelIcon) }
    catch (error) { console.error('[dsh-butler] 对话来源入口 注册失败：', error); return () => {} }
  }))
  disposers.push(slots.inject('main', () => {
    try { return slots.register({ name: 'main', key: 'butler-sources', inject: () => ({ ctx }) }, ButlerSourcesEntry as never) }
    catch (error) { console.error('[dsh-butler] 对话来源导航 注册失败：', error); return () => {} }
  }))

  ctx.effect(() => {
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'dsh-butler: seats')

  ctx.logger.info('[dsh-butler] 客户端已挂载：专属工作区入口、会话头部、参考范围、原生右栏及工作台')
}
