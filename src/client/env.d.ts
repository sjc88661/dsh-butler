/**
 * Client-half ambient declarations.
 *
 * This file is reachable only from `tsconfig.client.json` (`include:
 * src/client`), because the host tsconfig excludes `src/client` - the host
 * program must not grow browser members, and vice versa.
 *
 * The client runtime's real Context merge (`ctx.slots`, the `slots/changed`
 * event) does not survive an ambient merge here, so this shape is declared
 * explicitly instead of relying on `@deepseek-ai/dsh-client-runtime/client` to
 * be readable - it is not on this machine (the checkout's node_modules is a
 * self-referential junction chain and the desktop profile ships no
 * `@deepseek-ai/dsh-client-*` at all). Every member below was read off the
 * shipped implementations:
 *   - `slots.inject(key, cb)` / `slots.register(options, component)` and the
 *     `{ name, id, key, order, label }` option shape:
 *     `@linxin666/dsh-client-ui-task-board/src/client/native-panel.tsx:99-124`.
 *   - `layout.selectPanel(id)` (optional: the shipped `ILayout` in
 *     `packages/client/ui-layout/src/client/service.ts:23-30` exposes only
 *     toggleSidebar/openDetails/closeDetails, while the running desktop build
 *     also carries `selectPanel`/`activePanelId`):
 *     `@linxin666/dsh-client-ui-task-board/src/client/index.ts:252-253`.
 *
 * @module @dsh-external/dsh-butler/client
 */

/** Options accepted by {@link SlotFace.register}. */
export interface SlotRegisterOptions {
  /** The declared seat this entry occupies. */
  name: string
  /** Cell key inside a list seat (`id`) or the dispatch key of a keyed seat (`key`). */
  id?: string
  /** Dispatch key of a keyed seat such as `main`. */
  key?: string
  /** Position among the seat's entries, ascending. */
  order?: number
  /** Display text, or a thunk re-read on every projection. */
  label?: string | (() => string)
  /** Locale namespace. */
  locale?: string
  /**
   * Extra props handed to the component, read on each render.
   *
   * This is how a slot entry passes its own context down: the task board does
   * `inject: () => ({ controller })` (`@linxin666/dsh-client-ui-task-board`,
   * `src/client/native-panel.tsx:99-124`), and the header action uses it to
   * reach `ctx` (the seat's owner props are a marker field only).
   */
  inject?: () => Record<string, unknown>
}

/** The slot registry the shell exposes on the client Context. */
export interface SlotFace {
  /** Run `callback` once the seat is declared; returns its own disposer. */
  inject(key: string, callback: () => () => void): () => void
  /** Occupy a declared seat; returns the registration's disposer. */
  register(options: SlotRegisterOptions, component: unknown): () => void
}

/** The subset of the layout service this plugin drives. */
export interface LayoutFace {
  /** Select a registered panel page by id, or `null` for the conversation. */
  selectPanel?(id: string | null): void
  /** The currently selected panel id, when the build reports one. */
  activePanelId?: string | null
}

/** A read-only snapshot store, as the client runtime hands them out. */
export interface SnapshotFace<T> {
  getSnapshot(): T
}

/** The subset of the layout service as the running desktop build shapes it. */
export interface LayoutRuntime {
  /** Current selection: a panel id, or `null` for the Conversation. */
  panelInfo?: SnapshotFace<{ activePanelId: string | null }>
  /** Select a registered panel page by id, or `null` for the conversation. */
  selectPanel?(id: string | null): void
}

/**
 * The subset of `uiWorkspace` the header button uses.
 *
 * `openSession` is the documented "select a Session and show its Conversation
 * as one UI navigation action" (`Service.listService { service: 'uiWorkspace' }`
 * on the running build), which is what makes a jump back to the butler chat a
 * single navigation instead of a session switch this plugin would have to fake.
 */
export interface UiWorkspaceFace {
  /** Select a Session and show its Conversation. */
  openSession?(target: string): void
  /** Start a new Session flow and navigate to it; returns nothing. */
  startSession?(workspaceId?: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ported by the client runtime; the seat this plugin registers into. */
    slots: SlotFace
    /** Root-scope layout service; absent on shells without panel switching. */
    layout?: LayoutFace & LayoutRuntime
    /** Workspace/session navigation service; absent on shells without one. */
    uiWorkspace?: UiWorkspaceFace
  }
}
