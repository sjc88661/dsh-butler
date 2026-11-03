/**
 * Real usage recording.
 *
 * DSH publishes every committed session event through the `session/event`
 * feed, and the `assistant/message` event carries the provider's own
 * `TokenUsage` (see `dsh-agent-preset-registry/lib/typert.host.js`:
 * `'assistant/message': { turn; step; message; stream; usage?: TokenUsage;
 * interrupted?: true }`). That payload is the only honest source of token
 * numbers for assistant replies. Native title and compaction requests instead
 * report their TokenUsage through `llm/stream`; this module observes those two
 * verified auxiliary purposes without recording a second assistant row.
 *
 * Two things it deliberately does not do:
 *  - it never *invents* a cost. DSH exposes no price anywhere (searched the whole
 *    runtime for `inputPrice` / `costUsd`: no hits), so a price can only come
 *    from the provider's published table - `./pricing.ts`, which cites the page
 *    and the effective date, and which only applies to the provider it names.
 *    A call to any other provider keeps its real tokens and stays unpriced,
 *    because borrowing DeepSeek's numbers for someone else's model is a lie;
 *  - it does not turn a missing usage field into zero tokens. A call that
 *    reported no usage is counted separately, so "unknown" never reads as "free".
 *
 * Assistant rows retain their native event identity for startup backfill.
 * Auxiliary attempts use an independent UUID, including retries and agentless
 * title requests that occur before any task. Unknown request purposes and
 * unmarked non-assistant streams are not covered by this observer.
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { addUsage, hasPriceableUsage, usageScope, type Usage } from './ledger.ts'
import { estimateSpend, isPriced, isPricedModel, priceBasis } from './pricing.ts'
import type { ContextAgent, ExecutionIdentity } from './execution-context.ts'

/**
 * Price one call with the published table, when this module is allowed to.
 *
 * Exported because the startup backfill records rows of the same shape and must
 * price them the same way - two code paths that price differently would make the
 * roll-up meaningless.
 *
 * @param row - the call's tokens and its provider/model.
 * @param atMs - the call's instant, which picks the peak or off-peak column.
 * @returns the cost fields, or nothing when the provider has no published price
 *   here (the tokens are still recorded; only the money column stays empty).
 */
export function priceUsage(row: Omit<Usage, 'at'>, atMs: number): Pick<Usage, 'cost' | 'costBasis'> {
  if (!hasPriceableUsage(row) || !isPriced(row.provider) || !isPricedModel(row.model)) return {}
  const estimate = estimateSpend(row, atMs, row.model)
  if (estimate === undefined) return {}
  return { cost: estimate.cost, costBasis: priceBasis(estimate) }
}

/** What the recorder has seen so far. Reported as-is; never smoothed over. */
export interface UsageRecorderStatus {
  /** Whether the `session/event` feed is attached. */
  listening: boolean
  /** Whether verified auxiliary llm/stream purposes are observed. */
  auxiliaryListening: boolean
  /** Non-empty unrecognized purposes: deliberately not counted as auxiliary calls. */
  uncoveredPurposeStreams: number
  /** Calls whose usage was written to the ledger. */
  recorded: number
  /** Recorded calls that could be priced from the published table. */
  priced: number
  /** Recorded calls whose provider has no published price here: tokens real, money unknown. */
  unpriced: number
  /** Calls that arrived without a usage payload (unknown, not zero). */
  withoutUsage: number
  /** Events from other types (context, not a problem). */
  ignored: number
  /** Events that threw while being read. */
  failed: number
  /** Most recent recorded instant, ISO. */
  lastAt?: string
  /** Why the feed could not be attached, when that happened. */
  problem?: string
  auxiliaryProblem?: string
}

/** Handle for the installed recorder. */
export interface UsageRecorder {
  /** Current counters. */
  status(): UsageRecorderStatus
  /** Detach from the feed. */
  stop(): void
}

/** Options for {@link installUsageRecorder}. */
export interface UsageRecorderOptions {
  /** @deprecated Session-wide task guesses are ignored; use the exact context hook. */
  taskId?: () => string | undefined
  /**
   * Model route seen on the last streamed call, used only when the event itself
   * does not name one. The event is preferred: it is the truth for that call,
   * while this is a best-effort echo of the request.
   */
  route?: (sessionId: string, turn?: number, step?: number) => { sessionId: string; provider?: string; model?: string } | undefined
  /**
   * The butler's own session id, when it is already known. The feed carries
   * every session on the machine, so this is what decides whether a call is
   * charged to the butler or to the owner's own sessions.
   */
  butlerSession?: () => string | undefined
  /** Exact request snapshot; never falls back to a session's later active task. */
  context?: (sessionId: string, turn: number, step: number) => ExecutionIdentity | undefined
  /** Snapshot for the exact native initiator at auxiliary dispatch; title calls never inherit it. */
  auxiliaryContext?: (agent: ContextAgent) => ExecutionIdentity | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/** Like the native BlockAssembler, each usage chunk replaces the previous snapshot. */
function tokenSnapshot(value: unknown): Pick<Usage, typeof tokenFields[number] | 'usageState'> {
  const source = asRecord(value), row: Pick<Usage, typeof tokenFields[number] | 'usageState'> = {}
  for (const field of tokenFields) {
    const count = asNumber(source?.[field])
    if (count !== undefined) row[field] = count
  }
  row.usageState = tokenFields.slice(0, 5).some(field => row[field] !== undefined) ? 'reported' : 'unknown'
  return row
}

/** Installed native contracts: session-title-llm:195-210; compaction-basic:319-323. */
function auxiliaryPurpose(request: Record<string, unknown>): 'session-title' | 'compaction' | undefined {
  if (request['purpose'] === 'session-title' || request['purpose'] === 'compaction') return request['purpose']
  const messages = request['messages']
  if (Array.isArray(messages) && messages.some(message => {
    const row = asRecord(message)
    return row?.['role'] === 'user' && asRecord(row['source'])?.['kind'] === 'dsh-session-title-llm'
  })) return 'session-title'
  return undefined
}

function isCancelled(request: unknown, error?: unknown): boolean {
  // Error/signal inspection is observation too: a getter must not mask the
  // original stream or synchronous middleware failure.
  try {
    const signal = asRecord(asRecord(request)?.['signal']), failure = asRecord(error)
    return signal?.['aborted'] === true || failure?.['name'] === 'AbortError'
      || failure?.['code'] === 'ABORTED' || failure?.['code'] === 'ABORT_ERR'
  } catch { return false }
}

/** Never look up a registry's most recent agent/task or trust attribution fields in the request. */
function auxiliaryRow(ctx: Context, options: UsageRecorderOptions, request: Record<string, unknown>, purpose: 'session-title' | 'compaction'): Omit<Usage, 'at'> {
  const registry = ctx.get?.('agents', false) as { currentInitiator?(): ContextAgent | undefined } | undefined
  const agent = registry?.currentInitiator?.()
  const agentSessionId = asString(agent?.session?.id) ?? asString(agent?.id)
  const sessionId = asString(request['sessionId']) ?? agentSessionId
  const row: Omit<Usage, 'at'> = { callKind: 'auxiliary', purpose, callId: randomUUID(), origin: 'live',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(asString(request['provider']) === undefined ? {} : { provider: asString(request['provider']) }),
    ...(asString(request['model']) === undefined ? {} : { model: asString(request['model']) }) }
  // Native title requests can be detached, or precede task/run creation. Their
  // session is explicit, but an inherited task/owner need not have caused them.
  if (purpose === 'compaction' && agent && agentSessionId === sessionId) {
    const identity = options.auxiliaryContext?.(agent)
    if (identity !== undefined && sessionId !== undefined && identity.sessionId === sessionId) {
      if (identity.rootSessionId !== undefined) row.rootSessionId = identity.rootSessionId
      // Only a host-validated run and origin can carry business/owner metadata.
      if (identity.runId !== undefined && identity.originMessageId !== undefined) {
        for (const field of ['ownerId', 'channelOrigin', 'runId', 'taskId', 'originMessageId'] as const) {
          if (identity[field] !== undefined) Object.assign(row, { [field]: structuredClone(identity[field]) })
        }
      }
    }
  }
  return row
}

/**
 * Build the ledger row for one `assistant/message` event.
 * @param session - the event's owning session (unknown shape, read defensively).
 * @param data - the event payload.
 * @returns the row, or undefined when the event carried no usage at all.
 */
function usageRow(
  session: unknown,
  data: Record<string, unknown>,
  route?: { sessionId: string; provider?: string; model?: string },
): Omit<Usage, 'at'> | undefined {
  const message = asRecord(data['message'])
  const source = asRecord(message?.['source'])
  const owner = asRecord(session)
  const row: Omit<Usage, 'at'> = { ...tokenSnapshot(data['usage']) }
  const sessionId = asString(owner?.['id'])
  if (sessionId !== undefined) row.sessionId = sessionId
  const turn = asNumber(data['turn'])
  if (turn !== undefined) row.turn = turn
  const step = asNumber(data['step'])
  if (step !== undefined) row.step = step
  const exactRoute = route?.sessionId === sessionId ? route : undefined
  const provider = asString(source?.['provider']) ?? exactRoute?.provider
  if (provider !== undefined) row.provider = provider
  const model = asString(source?.['model']) ?? exactRoute?.model
  if (model !== undefined) row.model = model
  return row
}

/**
 * Attach the recorder to the `session/event` feed.
 *
 * The subscription uses `{ global: true }` the same way DSH's own
 * `api-session-controller` does, so events from other contexts still arrive.
 * When the feed cannot be attached the reason is reported through
 * {@link UsageRecorderStatus.problem} instead of being swallowed: a footer that
 * says "0 tokens" must never be the result of a silent failure.
 *
 * @param ctx - host context.
 * @param options - attribution hooks.
 * @returns the recorder handle.
 */
export function installUsageRecorder(ctx: Context, options: UsageRecorderOptions = {}): UsageRecorder {
  const status: UsageRecorderStatus = {
    listening: false,
    auxiliaryListening: false,
    uncoveredPurposeStreams: 0,
    recorded: 0,
    priced: 0,
    unpriced: 0,
    withoutUsage: 0,
    ignored: 0,
    failed: 0,
  }
  const disposers: Array<() => void> = []
  const recordAuxiliary = (row: Omit<Usage, 'at'>): void => {
    try {
      const at = new Date().toISOString(), priced = priceUsage(row, Date.parse(at))
      addUsage({ ...row, ...usageScope(row, options.butlerSession?.()), ...priced, at })
      status.recorded += 1
      if (row.usageState === 'unknown') status.withoutUsage += 1
      if (priced.cost === undefined) status.unpriced += 1
      else status.priced += 1
      status.lastAt = at
    } catch (error) {
      status.failed += 1
      status.auxiliaryProblem = `保存辅助调用用量时出错：${String(error)}`
    }
  }
  try {
    disposers.push(ctx.on('llm/stream', (value: unknown, next: () => AsyncIterable<unknown>) => {
      let row: Omit<Usage, 'at'> | undefined
      try {
        const request = asRecord(value)
        if (request) {
          const purpose = auxiliaryPurpose(request)
          if (purpose) row = auxiliaryRow(ctx, options, request, purpose)
          else if (asString(request['purpose']) !== undefined) status.uncoveredPurposeStreams += 1
        }
      } catch (error) {
        status.failed += 1
        status.auxiliaryProblem = `读取辅助调用来源时出错：${String(error)}`
      }
      // Preserve synchronous middleware failures as synchronous failures.
      let stream: AsyncIterable<unknown>
      try { stream = next() } catch (error) {
        if (row) recordAuxiliary({ ...row, usageState: 'unknown', outcome: isCancelled(value, error) ? 'cancelled' : 'failed' })
        throw error
      }
      if (!row) return stream
      const captured = row
      return (async function* () {
        let tokens = tokenSnapshot(undefined), outcome: Usage['outcome'], exhausted = false
        try {
          for await (const chunk of stream) {
            // Read-only observation must never replace a chunk or mask an error.
            try {
              const event = asRecord(chunk)
              if (event?.['type'] === 'usage') tokens = tokenSnapshot(event['usage'])
              if (event?.['type'] === 'finish') {
                const kind = asRecord(event['reason'])?.['kind']
                if (kind === 'error') outcome = 'failed'
                else if (kind === 'aborted') outcome = 'cancelled'
                else if (kind === 'stop' || kind === 'max-tokens' || kind === 'tool-calls') outcome = 'completed'
              }
            } catch (error) {
              status.failed += 1
              status.auxiliaryProblem = `读取辅助流用量时出错：${String(error)}`
            }
            yield chunk
          }
          exhausted = true
        } catch (error) {
          outcome = isCancelled(value, error) ? 'cancelled' : 'failed'
          throw error
        } finally {
          recordAuxiliary({ ...captured, ...tokens, outcome: outcome ?? (isCancelled(value) || !exhausted ? 'cancelled' : 'completed') })
        }
      })()
    }, { global: true }))
    status.auxiliaryListening = true
  } catch (error) {
    status.auxiliaryProblem = `没能接上 llm/stream 辅助用量观察：${String(error)}`
  }
  try {
    disposers.push(ctx.on(
      'session/event',
      (session: unknown, event: unknown) => {
        try {
          const envelope = asRecord(event)
          if (envelope?.['type'] !== 'assistant/message') {
            status.ignored += 1
            return
          }
          const data = asRecord(envelope['data']) ?? {}
          const sessionId = asString(asRecord(session)?.['id'])
          const route = sessionId ? options.route?.(sessionId, asNumber(data['turn']), asNumber(data['step'])) : undefined
          const row = usageRow(session, data, route)
          if (row === undefined) {
            status.withoutUsage += 1
            return
          }
          // Attribution is best-effort and honest about it: when the butler's own
          // session id is not known yet the row stays unattributed, and the
          // roll-up reports it as such rather than assuming it was the owner's.
          const identity = row.sessionId !== undefined && row.turn !== undefined && row.step !== undefined
            ? options.context?.(row.sessionId, row.turn, row.step) : undefined
          const attributed = { ...row, ...(identity?.sessionId === row.sessionId ? identity : {}) }
          const at = new Date(asNumber(envelope['time']) ?? Date.now()).toISOString()
          const priced = priceUsage(attributed, Date.parse(at))
          const scope = usageScope(attributed, options.butlerSession?.())
          addUsage({ ...attributed, ...scope, ...priced, eventSeq: asNumber(envelope['seq']), origin: 'live', at })
          status.recorded += 1
          if (row.usageState === 'unknown') status.withoutUsage += 1
          if (priced.cost === undefined) status.unpriced += 1
          else status.priced += 1
          status.lastAt = at
        } catch (error) {
          status.failed += 1
          status.problem = `读取会话事件时出错：${String(error)}`
        }
      },
      { global: true },
    ))
    status.listening = true
  } catch (error) {
    status.problem = `没能接上 session/event 事件（用量会一直显示为未记录）：${String(error)}`
  }
  return {
    status: () => ({ ...status }),
    stop: () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* continue releasing the other listener */ }
      }
      status.listening = false
      status.auxiliaryListening = false
    },
  }
}
