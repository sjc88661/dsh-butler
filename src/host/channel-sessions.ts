/**
 * Sessions owned by an external chat channel rather than by the butler's own
 * desktop workspace.
 *
 * `dsh-lark-channel` derives every chat session id as `lark-<conversation key>`
 * (`sessionIdFor()` prepends the literal `lark-`), so the prefix is the
 * channel's own stable identity, not a heuristic about titles.
 *
 * Treating these sessions as butler-owned makes the butler layer mount its
 * scoped tools, prompt guidance and ledger hooks on the agent the channel
 * creates. The channel keeps its own conversation window and its own model
 * composition; the butler contributes capabilities and shared state. The
 * alternative — pointing the channel at the butler's dedicated desktop session —
 * makes two independent agent factories share one live session, which the
 * session store refuses once either side reloads (its detached-session guard).
 *
 * @module @dsh-external/dsh-butler/host/channel-sessions
 */

/** Prefix `dsh-lark-channel` prepends to every session id it derives. */
export const LARK_SESSION_PREFIX = 'lark-'

/**
 * Whether one session id belongs to a chat channel this host serves.
 * @param id - host session id.
 * @returns true for channel-derived sessions.
 */
export function isChannelSession(id: string): boolean {
  return id.startsWith(LARK_SESSION_PREFIX)
}
