/**
 * The butler's own conversation.
 *
 * The owner asked for it in as many words: "给管家做一个专属会话（独立聊天记录）".
 * The assistant's persona and tools are already installed into every session,
 * but a butler that only exists inside whatever conversation happens to be open
 * has no address — no single place to walk back to, and no separate history.
 * This module gives it one, by:
 *
 * 1. **Choosing a fixed session id** (`session-butler` by default). Fixed rather
 *    than minted, so the conversation can be found again from the id alone even
 *    if the small record file below is lost, and so a reader of the code can
 *    guess it.
 * 2. **Creating or resuming it through `agents`**, never through `sessions`.
 *    The `sessions` service says it plainly: "a session published outside that
 *    lifecycle persists nothing". `agents.create`/`agents.resume` go through
 *    the factory that attaches the session-log writer, which is what makes the
 *    history survive a restart.
 * 3. **Pinning the title with `sessionTitle.rename`**, which appends a
 *    `user`-sourced `session/title` event. Automatic naming is superseded, so
 *    the row in the sidebar keeps saying 管家 instead of being renamed after
 *    whatever the owner said first.
 * 4. **Writing down what happened** in `~/.dsh/butler/session.json` (id, title,
 *    cwd, last state), so the next activation can tell "we already have one"
 *    from "we have never made one" without guessing.
 *
 * Discipline: every failure here is reported, never swallowed. A missing
 * `agents` service, a failed resume, a title that could not be pinned — each
 * one lands in the returned note and reaches the panel, because "no dedicated
 * conversation" and "a dedicated conversation the owner cannot find" are
 * different problems and the owner should be told which one they have.
 *
 * @module @dsh-external/dsh-butler/host/session
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentPreparation, WorkspaceRegistryService } from './ctx.ts'
import type { Services } from './services.ts'
import { VAULT_HOME, readText, statePath, writeText } from './vault.ts'

/** How the butler's conversation was reached on this attempt. */
export type ButlerSessionState = 'live' | 'created' | 'resumed' | 'failed'

/** Finite acknowledgement consumed by the client immediately before navigation. */
export interface ButlerSessionReadiness {
  id: string
  canonicalCwd: string
  workspaceId: string
  attached: true
  flushed: true
}

/** What the panel and the tools are told about the butler's conversation. */
export interface ButlerSessionInfo {
  /** Session id the owner's chat happens in. */
  id: string
  /** Title pinned on that session. */
  title: string
  /** Whether it was already live, freshly created, resumed, or unreachable. */
  state: ButlerSessionState
  /** Working directory the session was created with, when one was resolved. */
  cwd?: string
  /** Anything the owner should know: a failure, or a fallback that was taken. */
  note?: string
  /** Whether the title is pinned as the owner's own rather than auto-generated. */
  titlePinned: boolean
  /** When this answer was produced. */
  at: string
  ready?: ButlerSessionReadiness
}

/** Options for {@link createButlerSession}. */
export interface ButlerSessionOptions {
  /** Title pinned on the conversation. */
  title: string
  /** Session id; the default is fixed so the conversation is findable by name. */
  id?: string
  /** Working directory, overriding the one derived from the vault. */
  cwd?: string
  /** Separate identity record for additional managed chats; legacy default is unchanged. */
  recordFile?: string
  /** Native workspace label used only when registering a new directory. */
  workspaceTitle?: string
  /** Mount the host preset and select its native default route on create/resume. */
  prepare?: (target: { id: string; existing: boolean }) => (AgentPreparation & { presetId?: string }) | Promise<AgentPreparation & { presetId?: string }>
  /** Reject a resident Agent whose native composition was never mounted. */
  verifyLive?: (id: string) => void
}

/** The handle the entry point keeps. */
export interface ButlerSessionManager {
  /** Create or resume the conversation; never rejects. */
  ensure(): Promise<ButlerSessionInfo>
  /** Flush, validate and durably account this exact Session before UI navigation. */
  ensureReady(request?: { force?: boolean }): Promise<ButlerSessionInfo>
  /** The last answer without touching the host, for synchronous readers. */
  peek(): ButlerSessionInfo | undefined
  /** Where the attempt was recorded, for the workbench footer. */
  readonly recordFile: string
}

/** The session id used when nothing else is configured. */
export const DEFAULT_BUTLER_SESSION_ID = 'session-butler'

/** The default title; the owner may change it through the plugin config. */
export const DEFAULT_BUTLER_SESSION_TITLE = '管家'

/**
 * How long a fully-validated readiness stays valid for pollers.
 *
 * The read API is polled; re-running flush/readSession/attachSession every poll
 * was measurable CPU and I/O. Failures are never cached, and explicit
 * navigation can force a fresh check.
 */
export const READY_CACHE_MS = 5 * 60 * 1000

/** Human-readable form of an unknown throwable. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function canonicalDirectory(path: unknown): string {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('原生会话没有可核验的工作目录')
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error('管家工作目录不是目录')
  return canonical
}

function sameDirectory(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function checkHeader(value: unknown, id: string, canonicalCwd: string): void {
  const header = object(value)
  if (header?.['id'] !== id) throw new Error('原生会话 ID 与专属会话不一致')
  if (!sameDirectory(canonicalDirectory(header['cwd']), canonicalCwd)) throw new Error('原生会话工作目录与保存的工作目录不一致')
}

function nativeNotFound(error: unknown): boolean {
  const row = object(error)
  return row?.['name'] === 'SessionQueryError' && row['code'] === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/**
 * The project directory the butler conversation belongs to.
 *
 * The vault lives in `<project>/.butler/vault`, so the project is two levels up
 * — that is the workspace the session is filed under in the sidebar, which is
 * what makes the 管家 row appear next to the owner's other work instead of in
 * an ungrouped bucket. Falls back to the first registered workspace, and then
 * to nothing at all rather than inventing a path.
 * @param ctx - the plugin's context.
 * @returns an existing absolute directory, or `undefined`.
 */
function resolveWorkspaceCwd(ctx: Context): string | undefined {
  const fromVault = dirname(dirname(VAULT_HOME))
  try {
    if (existsSync(fromVault)) return fromVault
  } catch {
    // A broken path is not a reason to fail: fall through to the registry.
  }
  try {
    const registry = (ctx as unknown as { get?(key: string, strict?: boolean): unknown })
      .get?.('workspaceRegistry', false) as WorkspaceRegistryService | undefined
    const first = registry?.list?.()[0]
    if (typeof first?.path === 'string' && first.path !== '') return first.path
  } catch {
    // Optional lookup; no registry means the session simply has no cwd.
  }
  return undefined
}

/**
 * Create the manager for the butler's conversation.
 *
 * Idempotent by construction: concurrent callers share one in-flight attempt,
 * and a later call re-checks the live session rather than creating a second one.
 * @param ctx - the plugin's context (for logging only).
 * @param services - late-bound host services, so a late `agents` still works.
 * @param options - title, id and cwd overrides.
 * @returns the manager the entry point holds on to.
 */
export function createButlerSession(
  ctx: Context,
  services: Services,
  options: ButlerSessionOptions,
): ButlerSessionManager {
  const recordFile = options.recordFile ?? statePath('session.json')
  const fallbackId = options.id ?? DEFAULT_BUTLER_SESSION_ID
  const fallbackTitle = options.title
  let cached: ButlerSessionInfo | undefined
  let inflight: Promise<ButlerSessionInfo> | undefined
  let readyInflight: Promise<ButlerSessionInfo> | undefined
  /** When the last fully-validated readiness was confirmed, for the poll TTL. */
  let readyAt: number | undefined
  const recordVersions = new WeakMap<ButlerSessionInfo, string | undefined>()

  /** Read the record written by the previous attempt. */
  function readRecord(): { text: string | undefined; value: Record<string, unknown> } {
    const text = readText(recordFile)
    if (text === undefined) return { text, value: {} }
    const value = object(JSON.parse(text))
    if (value === undefined) throw new Error('专属会话记录格式损坏，原件已保留')
    for (const key of ['id', 'title', 'cwd']) {
      const field = value[key]
      if (field === undefined || key === 'cwd' && field === null) continue
      if (typeof field !== 'string' || field.trim() === '') throw new Error(`专属会话记录 ${key} 无效，原件已保留`)
    }
    return { text, value }
  }

  /** Remember the answer and write it down. */
  function remember(info: ButlerSessionInfo, previous: ReturnType<typeof readRecord>): ButlerSessionInfo {
    if (readText(recordFile) !== previous.text) throw new Error('专属会话记录在准备期间发生变化，保留新原件并停止')
    // Live/time are observations, not new durable identity. In particular a
    // workbench GET must not rewrite a resumed record or erase owner fields.
    if (previous.value['id'] !== info.id || previous.value['title'] !== info.title
      || previous.value['cwd'] !== (info.cwd ?? null) || previous.value['titlePinned'] !== info.titlePinned) {
      writeText(recordFile, `${JSON.stringify({ ...previous.value,
        id: info.id,
        title: info.title,
        cwd: info.cwd ?? null,
        state: info.state,
        titlePinned: info.titlePinned,
        at: info.at,
      }, null, 2)}\n`)
    }
    cached = info
    recordVersions.set(info, readText(recordFile))
    return info
  }

  function failed(error: unknown, info?: ButlerSessionInfo): ButlerSessionInfo {
    const result: ButlerSessionInfo = { id: info?.id ?? fallbackId, title: info?.title ?? fallbackTitle, state: 'failed',
      titlePinned: info?.titlePinned ?? false, at: new Date().toISOString(),
      ...(info?.cwd === undefined ? {} : { cwd: info.cwd }), note: `专属会话尚未准备好：${message(error)}` }
    cached = result
    return result // Failed observations never replace the previous identity record.
  }

  /**
   * Pin the title on a live session.
   * @param session - the live session object.
   * @param title - the title the owner should see.
   * @returns whether it is pinned, and why not when it is not.
   */
  function pinTitle(session: unknown, title: string): { ok: boolean; note?: string } {
    const titles = services.sessionTitle.get()
    if (titles === undefined) {
      return { ok: false, note: `标题服务这次没有解析到（${services.sessionTitle.why()}）：会话标题暂时由 DSH 自动命名。` }
    }
    try {
      const current = titles.get(session)
      if (current?.title === title && current.source?.kind === 'user') return { ok: true }
      titles.rename(session, title)
      return { ok: true }
    } catch (error) {
      return { ok: false, note: `标题钉住失败：${message(error)}` }
    }
  }

  /** One full attempt: find it live, else resume it, else create it. */
  async function run(): Promise<ButlerSessionInfo> {
    const record = readRecord()
    const id = record.value['id'] as string | undefined ?? fallbackId
    const title = record.value['title'] as string | undefined ?? fallbackTitle
    const cwd = options.cwd ?? (record.value['cwd'] as string | undefined) ?? resolveWorkspaceCwd(ctx)
    const canonicalCwd = canonicalDirectory(cwd)
    const at = new Date().toISOString()
    const sessions = services.sessions.get()
    const agents = services.agents.get()

    if (agents === undefined) {
      return failed(new Error(`agent 服务这次没有解析到（${services.agents.why()}）`), {
        id,
        title,
        state: 'failed',
        titlePinned: false,
        at,
        ...(cwd === undefined ? {} : { cwd }),
        note: `agent 服务这次没有解析到（${services.agents.why()}）：专属会话既不能创建也不能恢复，管家眼下只能在当前对话里干活。`,
      })
    }

    // Already live in this process: nothing to create, only the title to check.
    const live = sessions?.get?.(id)
    if (live !== undefined) {
      checkHeader(object(live)?.['header'], id, canonicalCwd)
      options.verifyLive?.(id)
      const pinned = pinTitle(live, title)
      return remember({
        id,
        title,
        state: 'live',
        titlePinned: pinned.ok,
        at,
        ...(cwd === undefined ? {} : { cwd }),
        ...(pinned.note === undefined ? {} : { note: pinned.note }),
      }, record)
    }

    let handle: AgentHandle | undefined
    let state: ButlerSessionState = 'resumed'
    let note: string | undefined
    const query = services.sessionQuery?.get()
    if (query === undefined || typeof query.readSession !== 'function') throw new Error('原生会话查询服务不可用，不能把恢复失败当作不存在')
    let absent = false
    try { checkHeader((await query.readSession(id)).session, id, canonicalCwd) }
    catch (error) { if (!nativeNotFound(error)) throw error; absent = true }
    if (readText(recordFile) !== record.text) throw new Error('专属会话记录在原生查询期间发生变化，停止创建或恢复')
    const { presetId, ...preparation } = await options.prepare?.({ id, existing: !absent }) ?? {}
    if (readText(recordFile) !== record.text) throw new Error('专属会话记录在 preset 准备期间发生变化，停止创建或恢复')
    if (absent) {
      handle = await agents.create({ sessionId: id, ...preparation,
        ...(cwd === undefined ? {} : { meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) } }) })
      state = 'created'; note = '原生查询已确认没有这条会话，已新建一条。'
    } else handle = await agents.resume({ resumeSessionId: id, ...preparation })
    if (handle.agent?.id !== id) throw new Error('agent 恢复/创建返回了另一条会话 ID')

    const session = services.sessions.get()?.get?.(id) ?? sessions?.get?.(id)
    if (session === undefined) {
      throw new Error('原生创建/恢复之后没有对应的 resident Session')
    }
    checkHeader(object(session)?.['header'], id, canonicalCwd)
    const pinned = pinTitle(session, title)
    return remember({
      id,
      title,
      state,
      titlePinned: pinned.ok,
      at,
      ...(cwd === undefined ? {} : { cwd }),
      ...(pinned.note === undefined ? {} : { note: pinned.note }),
      ...(note === undefined ? {} : { note: `${note}${pinned.note === undefined ? '' : ` ${pinned.note}`}` }),
    }, record)
  }

  return {
    recordFile,
    peek: () => cached,
    async ensure(): Promise<ButlerSessionInfo> {
      if (inflight !== undefined) return await inflight
      inflight = run().catch(error => failed(error)).finally(() => {
        inflight = undefined
      })
      return await inflight
    },
    async ensureReady(request?: { force?: boolean }): Promise<ButlerSessionInfo> {
      // The panel polls the read API; a readiness that was fully validated a
      // moment ago stays valid for a while, so polling stops re-running
      // flush/readSession/attachSession every time. Failures are never cached.
      if (request?.force !== true && cached?.ready !== undefined && readyAt !== undefined && Date.now() - readyAt < READY_CACHE_MS) return cached
      if (readyInflight !== undefined) return await readyInflight
      readyInflight = (async () => {
        let info: ButlerSessionInfo | undefined
        try {
          const sessions = services.sessions.get(), query = services.sessionQuery?.get(), registry = services.workspaceRegistry?.get()
          if (sessions === undefined || typeof sessions.flush !== 'function' || typeof sessions.get !== 'function'
            || query === undefined || typeof query.readSession !== 'function' || registry === undefined
            || typeof registry.resolveByPath !== 'function' || typeof registry.create !== 'function') {
            throw new Error('缺少原生 flush、sessionQuery 或 workspaceRegistry 能力')
          }
          info = await this.ensure()
          if (info.state === 'failed') return info
          const cwd = canonicalDirectory(info.cwd), live = sessions.get(info.id)
          checkHeader(object(live)?.['header'], info.id, cwd)
          if (await sessions.flush(live) !== true) throw new Error('原生 Session 没有持久化监听器或 flush 未成功')
          checkHeader((await query.readSession(info.id)).session, info.id, cwd)
          const workspace = await registry.resolveByPath(cwd) ?? await registry.create(cwd, options.workspaceTitle)
          const workspaceId = workspace.id
          if (typeof workspaceId !== 'string' || workspaceId.trim() === '' || !sameDirectory(canonicalDirectory(workspace.path), cwd)
            || typeof workspace.attachSession !== 'function') throw new Error('工作区实体与专属会话目录不一致')
          await workspace.attachSession(info.id)
          if (workspace.id !== workspaceId || !sameDirectory(canonicalDirectory(workspace.path), cwd)
            || !workspace.sessionIds.includes(info.id)) throw new Error('原生工作区没有确认专属会话的成员关系')
          if (sessions.get(info.id) !== live) throw new Error('原生 Session 在准备期间被替换，需重新准备')
          checkHeader(object(live)?.['header'], info.id, cwd)
          if (readText(recordFile) !== recordVersions.get(info)) throw new Error('专属会话记录在准备期间发生变化，保留新原件并停止')
          const result: ButlerSessionInfo = { ...info, ready: { id: info.id, canonicalCwd: cwd, workspaceId, attached: true, flushed: true } }
          cached = result
          readyAt = Date.now()
          return result
        } catch (error) { return failed(error, info) }
      })().finally(() => { readyInflight = undefined })
      return await readyInflight
    },
  }
}
