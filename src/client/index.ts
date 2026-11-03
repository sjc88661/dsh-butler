/**
 * @dsh-external/dsh-butler - client half.
 * Build: tsdown -> lib/client.js (window.__ModuleLoader__.load registration).
 *
 * 0.1.0 入口收敛后只保留四个对外入口（外加两个"只在你需要时出现"的挂载点）：
 *
 *   `conversation.session.header.actions`  「管家」主按钮 + 「⋯」菜单（一个控件宽）
 *   `sidebar.panellist`                    左侧栏一行「管家」，打开下面的工作台页
 *   `main`（keyed by PANEL_ID）            管家工作台页（不再挂载即跳转）
 *   `conversation.view`（id butler）       与工作台同一组件，放进对话视图页签
 *   `conversation.input.dock`              参考范围条：只在管家主题会话渲染
 *   `sidebar.right.pane.tab`               右栏「管家资料」页签
 *
 * 「对话来源」原来单独占一个侧栏行 + 一个 main 页；现在合并进工作台页与右栏，
 * 侧栏不再出现两个同样式、只差跳转目标的入口。
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
import { ButlerRightPane, ButlerSourceDock, ButlerWorkspacePage } from './workspace-panel.ts'

/** Required core services; optional native workspace/rightbar faces are resolved per action. */
export const inject = ['slots', 'layout']

/**
 * 一次席位贡献：控制台报告用的人名、渲染的组件、外壳读取的注册选项。
 */
interface SeatContribution {
  /** Human name used in the console report. */
  label: string
  /** The workbench page or the sidebar glyph. */
  component: unknown
  /** Registration options, minus the seat name that is written at the call. */
  options: Record<string, unknown>
}

/** 四个入口席位，按贡献顺序排列。 */
const CONTRIBUTIONS: readonly SeatContribution[] = [
  // 会话头部主入口：一个「管家」按钮 + 一个「⋯」菜单。
  {
    label: '会话头部入口',
    component: ButlerHeaderAction,
    options: { id: PANEL_ID, order: 40, label: () => '管家' },
  },
  // 侧栏行：外壳拥有按钮盒、标签、提示与选中高亮；这里只给 id、顺序和 glyph。
  {
    label: '侧栏行',
    component: ButlerPanelIcon,
    options: { id: PANEL_ID, order: PANEL_ORDER, label: () => '管家' },
  },
  // 中栏工作台页：由 layout 只在选中该面板时挂载，其余时间对话保留中栏。
  {
    label: '工作台页面',
    component: ButlerWorkspacePage,
    options: { key: PANEL_ID },
  },
  // 对话视图页签：同一个工作台，放在会话的「对话 / 轨迹 / 管家」页签里。
  {
    label: '对话视图',
    component: ButlerWorkbench,
    options: { id: PANEL_ID, order: 90, label: () => '管家' },
  },
]

/**
 * 挂载管家的四个入口席位与两个上下文挂载点。
 *
 * 每个席位在自己的 `slots.inject` 与自己的 try/catch 里注册：一个席位不可用
 * 不能让整个 web boot 失败，也不该连带其它席位。
 * @param ctx - client root context (service: slots).
 */
export function apply(ctx: Context): void {
  const slots = ctx.slots
  const disposers: Array<() => void> = []

  const butlerHeaderAction = (): () => void => {
    try {
      return slots.register({ name: 'conversation.session.header.actions', ...CONTRIBUTIONS[0]!.options, inject: () => ({ ctx }) }, ButlerHeaderAction as never)
    } catch (error) {
      console.error('[dsh-butler] 会话头部入口 注册失败：', error)
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
      // The page gets `ctx` so its 和管家说话 button can navigate; the layout
      // passes `inject` results to the component as props.
      return slots.register({ name: 'main', ...CONTRIBUTIONS[2]!.options, inject: () => ({ ctx }) }, ButlerWorkspacePage as never)
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

  ctx.effect(() => {
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'dsh-butler: seats')

  ctx.logger.info('[dsh-butler] 客户端已挂载：会话头部入口、侧栏行、工作台页、对话视图、参考范围与右栏')
}
