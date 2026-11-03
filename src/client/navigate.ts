/**
 * Where the butler's doors lead.
 *
 * Two different destinations, deliberately kept apart:
 *
 * - **The conversation** (`session-butler`) is where the owner talks. The host
 *   creates or resumes it (see `src/host/session.ts`) and reports its id on the
 *   read API; this module turns that id into one UI navigation with
 *   `uiWorkspace.openSession`, the documented "select a Session and show its
 *   Conversation as one UI navigation action".
 * - **The workbench** is the dashboard: what is open, what is waiting on the
 *   owner, which documents exist, what just ran. It is a `main` panel page,
 *   selected with `layout.selectPanel(PANEL_ID)`.
 *
 * The client cannot make the conversation exist - only the host can reach the
 * agent factory - so when the id cannot be read this module never pretends the
 * jump happened: it falls back to the workbench and returns the reason for the
 * caller to display.
 *
 * @module @dsh-external/dsh-butler/client
 */
import type { Context } from '@deepseek-ai/cordis'
import { fetchOverview, type ButlerSession } from './api.ts'
import { PANEL_ID } from './ids.ts'

/** What a navigation attempt did, in terms the owner can be shown. */
export interface NavOutcome {
  /** Whether the intended destination was reached. */
  ok: boolean
  /** Why not, when it was not - shown in the tooltip rather than swallowed. */
  reason?: string
  /** The conversation id, when one is known. */
  sessionId?: string
  /** What actually happened: the intended jump, or the fallback that was taken. */
  via?: 'conversation' | 'workbench'
}

/** Last fully acknowledged conversation id, used only as a display hint. */
let lastSessionId: string | undefined

/** An id alone is a hint; only a complete native acknowledgement can enter this cache. */
export function rememberReadySession(session: ButlerSession | undefined): string | undefined {
  const ready = session?.ready
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
  lastSessionId = session?.state !== 'failed' && text(session?.id) && ready?.id === session.id
    && text(ready.workspaceId) && text(ready.canonicalCwd) && ready.attached === true && ready.flushed === true
    ? session.id : undefined
  return lastSessionId
}

/** The last conversation id seen, if any. */
export function cachedSessionId(): string | undefined {
  return lastSessionId
}

/** The subset of `uiWorkspace` used here; optional because shells differ. */
interface UiWorkspaceFace {
  openSession?(target: string): void
}

/**
 * Reach a client service without failing the fiber that asks.
 *
 * `ctx.get(name, false)` is the lenient lookup: it answers for a mounted
 * service whether or not this plugin declared it in `inject`, and returns
 * `undefined` instead of throwing when the shell has no such service.
 * @param ctx - the client context.
 * @param name - service key.
 * @returns the service, or `undefined`.
 */
export function clientService<T>(ctx: Context, name: string): T | undefined {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = (ctx as unknown as { get?(key: string, strict?: boolean): unknown }).get?.(name, false)
    if (viaGet !== undefined && viaGet !== null) return viaGet as T
  } catch {
    // Fall through to the property access below.
  }
  const direct = (ctx as unknown as Record<string, unknown>)[name]
  return (direct ?? undefined) as T | undefined
}

/**
 * Select the workbench panel.
 * @param ctx - the client context carrying `layout`.
 * @returns the outcome, with the layout's own error text when it refuses.
 */
export function selectWorkbench(ctx: Context): NavOutcome {
  const layout = ctx.layout as (Context['layout'] & { selectPanel?(id: string | null): void }) | undefined
  if (layout === undefined || typeof layout.selectPanel !== 'function') {
    return { ok: false, reason: '这个界面没有面板切换能力（layout.selectPanel 不存在）', via: 'workbench' }
  }
  try {
    layout.selectPanel(PANEL_ID)
    return { ok: true, via: 'workbench' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), via: 'workbench' }
  }
}

/**
 * Open the butler's own conversation, falling back to the workbench.
 * @param ctx - the client context.
 * @param _known - a previous UI hint; fresh host readiness always selects the destination.
 * @returns the outcome to report.
 */
export async function openButlerConversation(ctx: Context, _known?: string): Promise<NavOutcome> {
  let id: string | undefined
  let readError: string | undefined
  try {
    const overview = await fetchOverview()
    id = rememberReadySession(overview.ok === true ? overview.session : undefined)
    if (id === undefined) {
      readError = overview.sessionError ?? overview.session?.note ?? '管家会话还没完成原生工作区准备'
    }
  } catch (error) {
    rememberReadySession(undefined)
    readError = `读管家接口失败：${error instanceof Error ? error.message : String(error)}`
  }

  const workspace = clientService<UiWorkspaceFace>(ctx, 'uiWorkspace')
  if (id !== undefined && workspace !== undefined && typeof workspace.openSession === 'function') {
    try {
      workspace.openSession(id)
      return { ok: true, via: 'conversation', sessionId: id }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const fallback = selectWorkbench(ctx)
      return { ok: false, reason: `打不开管家会话（${reason}）`, via: fallback.via }
    }
  }

  // No conversation to open: say why, then still take the owner somewhere
  // useful instead of leaving the click with no effect at all.
  const why = id === undefined
    ? (readError ?? '还不知道管家会话的 id')
    : '这个界面没有会话导航能力（uiWorkspace.openSession 不存在）'
  const fallback = selectWorkbench(ctx)
  return {
    ok: false,
    reason: fallback.ok ? `${why}；已改为打开管家工作台` : `${why}；工作台也打不开：${fallback.reason ?? '未知原因'}`,
    via: fallback.via,
  }
}
