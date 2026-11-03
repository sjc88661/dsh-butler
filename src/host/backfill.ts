/**
 * Startup backfill: the calls the live feed never saw.
 *
 * The recorder can only record what happens while it is attached, so every
 * plugin reload leaves a seam: a model call committed in that seam is missing
 * from the ledger forever, and the panel silently under-reports. The session log
 * is the authoritative record of every call, so at startup this module reads the
 * logs back and records what is missing.
 *
 * How it reads them (the format is not guesswork, it was measured):
 *  - a DSH session log lives at `<DSH_HOME>/sessions/<workspace>/<session>/session.v4.jsonl.zstd`;
 *  - the file is **several independent zstd frames back to back**, so the whole
 *    file cannot be handed to `zstdDecompressSync` (that decodes only the first
 *    frame and yields a single line); the frames are found by scanning for the
 *    zstd magic `28 b5 2f fd` and decompressed one by one;
 *  - each decoded frame holds whole JSONL rows `{type, seq, time, data}`, and a
 *    model call is `type === 'assistant/message'` with `data.usage`;
 *  - a call is identified by its session and native event sequence, with exact
 *    session/turn/step/time matching for legacy rows, so replay never adds the
 *    same call twice or transfers another call's task metadata.
 *
 * Two deliberate limits: only logs touched inside the backfill window are read
 * (an old log cannot differ from the ledger in any way that matters), and only
 * logs below a size cap (a runaway log is not worth stalling startup for). Both
 * are reported when they cause a skip.
 *
 * @module @dsh-external/dsh-butler/host/backfill
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { addReceipt, addUsageBatch, appendDaily, hasReportedUsage, usageKey, usageRecords, usageScope, type Usage } from './ledger.ts'
import { priceUsage } from './usage.ts'

/** Zstd frame magic, little-endian on disk. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** How far back a startup reads. Older logs cannot disagree with the ledger. */
export const BACKFILL_WINDOW_MS = 48 * 3_600_000

/** Largest log the backfill will read. */
export const BACKFILL_MAX_BYTES = 64 * 1024 * 1024

/** One model call read out of a session log. */
export interface LoggedCall {
  eventSeq?: number
  /** Session the call belongs to. */
  sessionId: string
  /** Turn number. */
  turn: number
  /** Step number. */
  step: number
  /** When the call was committed, ISO. */
  at: string
  /** Provider name, when the log names one. */
  provider?: string
  /** Model id, when the log names one. */
  model?: string
  /** Token counts, straight from the log. */
  tokens: Omit<
    Usage,
    'at' | 'sessionId' | 'turn' | 'step' | 'provider' | 'model' | 'origin' | 'scope' | 'cost' | 'costBasis'
  >
}

/** Outcome of one backfill run. Reported as-is, skips included. */
export interface BackfillResult {
  /** Calls added to the ledger. */
  added: number
  /** Existing unknown/legacy calls reconciled with their native event. */
  reconciled: number
  /** Legacy rows that cannot be reliably paired with the available native events. */
  ambiguousLegacy: number
  /** Calls the ledger already had. */
  already: number
  /** Calls read out of the logs inside the window. */
  scanned: number
  /** Log files read. */
  files: number
  /** Distinct sessions those files belonged to. */
  sessions: number
  /** Calls in the logs that carried no usage payload (unknown, not zero). */
  withoutUsage: number
  /** Added calls this table has no published price for (tokens real, money unknown). */
  unpriced: number
  /** Frames that failed to decompress. */
  badFrames: number
  /** Files skipped, with the reason. */
  skips: string[]
  /** Something that went wrong, verbatim. */
  problems: string[]
  /** Wall-clock milliseconds the run took. */
  ms: number
}

/** `DSH_HOME` when set, otherwise the default home. */
export function dshHome(): string {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Offsets where a zstd frame starts inside a file.
 * @param buffer - the whole file.
 * @returns ascending offsets, always starting at 0 for a well-formed log.
 */
function frameOffsets(buffer: Buffer): number[] {
  const offsets = [0]
  let index = buffer.indexOf(ZSTD_MAGIC, ZSTD_MAGIC.length)
  while (index >= 0) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length)
  }
  return offsets
}

/** A decoded log line, as much of it as this module reads. */
interface LogRow {
  seq?: number
  type?: string
  time?: number
  data?: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read every model call out of one session log.
 *
 * @param path - the log file.
 * @param fallbackSessionId - id to use when the log's own session row is missing.
 * @returns the calls, plus how many frames failed to decode.
 */
export function readSessionLog(
  path: string,
  fallbackSessionId?: string,
): { calls: LoggedCall[]; withoutUsage: number; badFrames: number } {
  const calls: LoggedCall[] = []
  const steps = sessionLogSteps(path, fallbackSessionId)
  let next = steps.next()
  while (!next.done) {
    if (next.value !== undefined) calls.push(next.value)
    next = steps.next()
  }
  return { calls, ...next.value }
}

/** Yield at row/frame boundaries so the background driver can share the host event loop. */
function* sessionLogSteps(
  path: string,
  fallbackSessionId?: string,
): Generator<LoggedCall | undefined, { withoutUsage: number; badFrames: number }> {
  let withoutUsage = 0
  let badFrames = 0
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return { withoutUsage, badFrames }
  }
  const offsets = frameOffsets(buffer)
  let sessionId = fallbackSessionId ?? ''
  let carry = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index] as number
    const end = index + 1 < offsets.length ? (offsets[index + 1] as number) : buffer.length
    let text: string
    try {
      text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      badFrames += 1
      yield undefined
      continue
    }
    const chunk = carry + text
    const lines = chunk.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) {
      yield undefined
      const trimmed = line.trim()
      if (trimmed === '') continue
      let row: LogRow
      try {
        row = JSON.parse(trimmed) as LogRow
      } catch {
        continue
      }
      const data = asRecord(row.data)
      if (data === undefined) continue
      if (row.type === 'session') {
        const id = asString(data['id'])
        if (id !== undefined) sessionId = id
        continue
      }
      if (row.type !== 'assistant/message') continue
      const usage = asRecord(data['usage']) ?? {}
      const turn = asNumber(data['turn'])
      const step = asNumber(data['step'])
      if (turn === undefined || step === undefined) {
        withoutUsage += 1
        continue
      }
      const source = asRecord(asRecord(data['message'])?.['source'])
      const at = row.time === undefined ? undefined : new Date(row.time).toISOString()
      if (at === undefined) {
        withoutUsage += 1
        continue
      }
      const call: LoggedCall = {
        sessionId,
        turn,
        step,
        at,
        tokens: {},
      }
      const seq = asNumber(row.seq)
      if (seq !== undefined) call.eventSeq = seq
      const provider = asString(source?.['provider'])
      if (provider !== undefined) call.provider = provider
      const model = asString(source?.['model'])
      if (model !== undefined) call.model = model
      const inputTokens = asNumber(usage['inputTokens'])
      if (inputTokens !== undefined) call.tokens.inputTokens = inputTokens
      const outputTokens = asNumber(usage['outputTokens'])
      if (outputTokens !== undefined) call.tokens.outputTokens = outputTokens
      const totalTokens = asNumber(usage['totalTokens'])
      if (totalTokens !== undefined) call.tokens.totalTokens = totalTokens
      const cacheReadTokens = asNumber(usage['cacheReadTokens'])
      if (cacheReadTokens !== undefined) call.tokens.cacheReadTokens = cacheReadTokens
      const cacheWriteTokens = asNumber(usage['cacheWriteTokens'])
      if (cacheWriteTokens !== undefined) call.tokens.cacheWriteTokens = cacheWriteTokens
      const reasoningTokens = asNumber(usage['reasoningTokens'])
      if (reasoningTokens !== undefined) call.tokens.reasoningTokens = reasoningTokens
      call.tokens.usageState = [inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens].some(value => value !== undefined) ? 'reported' : 'unknown'
      if (call.tokens.usageState === 'unknown') withoutUsage += 1
      yield call
    }
    yield undefined
  }
  return { withoutUsage, badFrames }
}

/** Session logs under one home, newest first, inside the window and size cap. */
function sessionLogs(home: string, sinceMs: number, maxBytes: number): { files: string[]; skips: string[] } {
  const files: string[] = []
  const skips: string[] = []
  const root = join(home, 'sessions')
  let workspaces: string[]
  try {
    workspaces = readdirSync(root)
  } catch {
    return { files, skips: [`会话目录读不到：${root}`] }
  }
  for (const workspace of workspaces) {
    const workspacePath = join(root, workspace)
    let sessions: string[]
    try {
      sessions = readdirSync(workspacePath)
    } catch {
      continue
    }
    for (const session of sessions) {
      const path = join(workspacePath, session, 'session.v4.jsonl.zstd')
      let info: { size: number; mtimeMs: number }
      try {
        const stat = statSync(path)
        info = { size: stat.size, mtimeMs: stat.mtimeMs }
      } catch {
        continue
      }
      if (info.mtimeMs < sinceMs) continue
      if (info.size > maxBytes) {
        skips.push(`${session}：日志 ${Math.round(info.size / 1_048_576)}MB 超过上限，没读`)
        continue
      }
      files.push(path)
    }
  }
  return { files, skips }
}

/**
 * Record every model call from the session logs that the ledger does not have.
 *
 * Safe to call on every startup: it only appends ledger rows, it never re-runs a
 * tool, and its identity check makes a second run a no-op.
 *
 * @param options - window, caps, instant to measure from, and the butler's own
 *   session id so recovered calls can be attributed to the right side.
 * @returns what the run did, including its skips.
 */
export interface BackfillRunOptions {
  windowMs?: number
  maxBytes?: number
  home?: string
  now?: number
  butlerSession?: () => string | undefined
}

export function runUsageBackfill(options: BackfillRunOptions = {}): BackfillResult {
  const steps = usageBackfillSteps(options)
  let next = steps.next()
  while (!next.done) next = steps.next()
  return next.value
}

const BACKFILL_BATCH_SIZE = 64

/** Shared reconciliation; the CLI drains it synchronously, the host uses bounded slices. */
function* usageBackfillSteps(options: BackfillRunOptions): Generator<void, BackfillResult> {
  const started = Date.now()
  const now = options.now ?? started
  const butlerSession = options.butlerSession
  const windowMs = options.windowMs ?? BACKFILL_WINDOW_MS
  const maxBytes = options.maxBytes ?? BACKFILL_MAX_BYTES
  const home = options.home ?? dshHome()
  const result: BackfillResult = {
    added: 0,
    reconciled: 0,
    ambiguousLegacy: 0,
    already: 0,
    scanned: 0,
    files: 0,
    sessions: 0,
    withoutUsage: 0,
    unpriced: 0,
    badFrames: 0,
    skips: [],
    problems: [],
    ms: 0,
  }
  const { files, skips } = sessionLogs(home, now - windowMs, maxBytes)
  result.skips.push(...skips)
  const existing = usageRecords()
  const keyFor = (row: Usage): string | undefined => row.sessionId !== undefined && row.turn !== undefined && row.step !== undefined
    ? usageKey(row.sessionId, row.turn, row.step, row.eventSeq, row.at) : undefined
  const records = new Map(existing.map(row => [keyFor(row), row] as const).filter(([key]) => key !== undefined))
  const nativePositions = new Set<string>()
  const idless = new Map<string, number>()
  let pending: Usage[] = []
  const flush = (): void => {
    // Resolve legacy aliases/metadata only inside the synchronous append batch.
    // A live event may have claimed a legacy row since this log slice was read.
    const writes = addUsageBatch(pending, row => {
      if (row.scope === undefined) Object.assign(row, usageScope(row, butlerSession?.()))
      return row.cost === undefined ? { ...row, ...priceUsage(row, Date.parse(row.at)) } : row
    })
    for (const write of writes) {
      if (!write.appended) result.already += 1
      else {
        if (write.previous !== undefined) result.reconciled += 1
        else result.added += 1
        if (write.row.cost === undefined) result.unpriced += 1
      }
      const key = keyFor(write.row)
      if (key !== undefined) records.set(key, write.row)
      if (write.row.replacesKey !== undefined) records.delete(write.row.replacesKey)
    }
    pending = []
  }
  for (const path of files) {
    // The directory name *is* the session id - including the older logs whose
    // own `session` row carries an empty payload and no id at all (measured:
    // `--E-deepseek--/<uuid>/session.v4.jsonl.zstd`, and the projection cache
    // keys those sessions by the same bare uuid).
    const sessionName = path.split(/[\\/]/).slice(-2, -1)[0] ?? ''
    const fallback = sessionName === '' ? undefined : sessionName
    const steps = sessionLogSteps(path, fallback)
    let touchedSession = false
    try {
      let next = steps.next()
      while (!next.done) {
        const call = next.value
        if (call !== undefined && Date.parse(call.at) >= now - windowMs) {
          result.scanned += 1
          touchedSession = true
          if (call.sessionId === '') {
            idless.set(path, (idless.get(path) ?? 0) + 1)
          } else {
            const key = usageKey(call.sessionId, call.turn, call.step, call.eventSeq, call.at)
            if (call.eventSeq !== undefined) nativePositions.add(usageKey(call.sessionId, call.turn, call.step))
            const previous = records.get(key)
            if (previous && (hasReportedUsage(previous) || call.tokens.usageState === 'unknown')) {
              result.already += 1
            } else {
              const row: Usage = {
                at: call.at,
                sessionId: call.sessionId,
                turn: call.turn,
                step: call.step,
                ...(call.eventSeq === undefined ? {} : { eventSeq: call.eventSeq }),
                ...call.tokens,
                origin: 'backfill',
              }
              if (call.provider !== undefined) row.provider = call.provider
              if (call.model !== undefined) row.model = call.model
              pending.push(row)
              records.set(key, row)
              if (pending.length >= BACKFILL_BATCH_SIZE) flush()
            }
          }
        }
        yield
        next = steps.next()
      }
      result.files += 1
      result.badFrames += next.value.badFrames
      result.withoutUsage += next.value.withoutUsage
    } catch (error) {
      result.problems.push(`读日志失败 ${path}：${String(error)}`)
      continue
    }
    if (touchedSession) result.sessions += 1
  }
  flush()
  for (const [path, count] of idless) {
    result.problems.push(`${path}：${count} 次调用读不出会话 id（没写进账本，如实报在这里）`)
  }
  result.ambiguousLegacy = usageRecords().filter(row => row.eventSeq === undefined && row.sessionId !== undefined && row.turn !== undefined
    && row.step !== undefined && nativePositions.has(usageKey(row.sessionId, row.turn, row.step))).length
  if (result.ambiguousLegacy) result.problems.push(`${result.ambiguousLegacy} 条旧调用缺少可匹配的原生事件时间，已保留原记录；可能与回填调用重叠，总数待核对。`)
  result.ms = Date.now() - started
  return result
}

/** What the workbench reports about the backfill. */
export interface UsageBackfillState {
  /** Cancel a pending/in-flight run when the plugin's host effect is disposed. */
  stop(): void
  /** True while a run is in flight. */
  running: boolean
  /** How many calls the last run added. */
  added: number
  /** The last run's outcome, when one finished. */
  last?: BackfillResult
  /** Why the run failed, verbatim. */
  problem?: string
}

/** Dependencies the installer borrows from the host, all optional. */
export interface UsageBackfillOptions {
  /** Zone for the daily log line. */
  timeZone: string
  /** Delay before the run, so the first paint does not wait for log decoding. */
  afterMs?: number
  /** Host timer service, when there is one. */
  timer?: { setTimeout?(fn: () => void, ms: number): unknown }
  /** Host logger, when there is one. */
  logger?: { info?(message: string, ...args: unknown[]): void; warn?(message: string, ...args: unknown[]): void }
  /** Run the backfill now instead of waiting (used by tests and the CLI). */
  immediate?: boolean
  /**
   * The butler's own session id, when known. Recovered calls are split into
   * "the butler's own session" and "the owner's other sessions" with it, so the
   * panel can report the butler's real overhead instead of the whole machine.
   */
  butlerSession?: () => string | undefined
}

/**
 * Run the backfill once, a moment after startup.
 *
 * Deferred and sliced on purpose: frame decoding is synchronous work, so the
 * background driver shares the event loop between bounded batches. The run leaves a receipt and a daily-log
 * line, so "the numbers changed" is always traceable to something.
 *
 * @param options - zone, delay, and the host services to borrow.
 * @returns the live state, which the API reports to the panel.
 */
export function installUsageBackfill(options: UsageBackfillOptions): UsageBackfillState {
  let stopped = false
  let nativeTimer: ReturnType<typeof setTimeout> | undefined
  const state: UsageBackfillState = { running: false, added: 0, stop: () => {
    stopped = true
    state.running = false
    if (nativeTimer !== undefined) clearTimeout(nativeTimer)
  } }
  const run = async (): Promise<void> => {
    if (stopped) return
    state.running = true
    try {
      const steps = usageBackfillSteps({ butlerSession: options.butlerSession })
      let next: IteratorResult<void, BackfillResult>
      do {
        const started = Date.now()
        let count = 0
        do {
          if (stopped) return
          next = steps.next()
          count += 1
        } while (!next.done && count < BACKFILL_BATCH_SIZE && Date.now() - started < 8)
        if (!next.done) await new Promise<void>(resolve => setImmediate(resolve))
      } while (!next.done)
      if (stopped) return
      const result = next.value
      state.last = result
      state.added = result.added
      state.running = false
      const summary = `从会话日志核对用法：新增 ${result.added} 次调用、补全 ${result.reconciled} 次、已有 ${result.already} 次、读了 ${result.files} 个日志`
      if (result.added > 0 || result.reconciled > 0 || result.problems.length > 0 || result.skips.length > 0) {
        addReceipt({
          tool: 'usage-backfill',
          ok: result.problems.length === 0,
          ms: result.ms,
          summary: `${summary}${result.problems.length > 0 ? `；问题：${result.problems.join(' / ')}` : ''}`,
          ...(result.problems.length > 0 ? { error: result.problems.join(' / ') } : {}),
        })
        appendDaily(options.timeZone, `- [用量回填] ${summary}`)
      }
      if (result.problems.length > 0) options.logger?.warn?.('[dsh-butler] 用量回填有问题：%s', result.problems.join(' / '))
      else options.logger?.info?.('[dsh-butler] %s', summary)
    } catch (error) {
      if (stopped) return
      state.running = false
      state.problem = String(error)
      options.logger?.warn?.('[dsh-butler] 用量回填失败：%s', String(error))
    }
  }
  if (options.immediate === true) void run()
  else if (options.timer?.setTimeout !== undefined) options.timer.setTimeout(() => { void run() }, options.afterMs ?? 4_000)
  else nativeTimer = setTimeout(() => { void run() }, options.afterMs ?? 4_000)
  return state
}
