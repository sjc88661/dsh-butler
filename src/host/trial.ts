/**
 * Optional daily trial layer: real admission on the model request path.
 *
 * This is the in-package, productised form of the isolated daily-trial
 * composition layer (`diagnostics/daily-trial-20261022/controller.mjs` +
 * `policy.mjs`). It keeps that layer's semantics, which the native task
 * budgets alone do not provide:
 *
 *  - two budgets at once: one per user turn (`maxRequests` / `maxTokens` /
 *    `maxMs`) and one per Beijing calendar day (`dailyRequests` / `dailyTokens`);
 *  - reserve before dispatch (input upper bound + requested output) and settle
 *    afterwards from the provider's real usage; a missing usage keeps the
 *    whole reservation charged, never a fake zero;
 *  - counters live in `state/trial-budget.json` and are reloaded at boot, so a
 *    restart neither resets the day nor refunds an interrupted request;
 *  - a corrupt counter file fails closed: the layer refuses to reset and
 *    blocks model requests instead of silently granting a fresh allowance;
 *  - the layer is scoped: only the explicitly allowed session ids are governed,
 *    so installing it for one trial topic does not touch the owner's own chats.
 *
 * It is optional by construction: without a complete `trial` config nothing is
 * published (`butlerDailyTrial`), no hook is installed, and the workbench is
 * told `available:false` with a concrete reason.
 *
 * @module @dsh-external/dsh-butler/host/trial
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SourceRef } from '../shared/conversations.ts'
import type { DailyTrialSnapshot, TrialAvailability, TrialAvailabilityCode } from '../shared/trial.ts'
import { reserveInput } from './runtime-controls.ts'

/** Cordis service name the workbench consumes through `ctx.get(..., false)`. */
export const TRIAL_SERVICE_NAME = 'butlerDailyTrial'

/** Reference defaults from the isolated daily trial (6 请求 / 160k / 3 分钟 / 每日 20 次 / 480k). */
export const DEFAULT_TRIAL_LIMITS: Readonly<TrialLimits> = Object.freeze({
  maxRequests: 6, maxTokens: 160_000, maxMs: 180_000, maxOutputTokens: 1536, dailyRequests: 20, dailyTokens: 480_000,
})

/** Per-turn and per-day admission limits. */
export interface TrialLimits {
  maxRequests: number
  maxTokens: number
  maxMs: number
  maxOutputTokens: number
  dailyRequests: number
  dailyTokens: number
}

/**
 * Plugin option shape (`options.trial`).
 *
 * The host schema fills limit defaults, but this layer also accepts a plain JS
 * object (tests / manual composition) and degrades explicitly when the
 * identity fields are missing.
 */
export interface TrialConfigInput {
  enabled?: boolean
  provider?: string
  model?: string
  maxRequests?: number
  maxTokens?: number
  maxMs?: number
  maxOutputTokens?: number
  dailyRequests?: number
  dailyTokens?: number
  /** Allowed butler session ids (array, or comma/space separated string). Required when enabled. */
  allowedSessionIds?: string[] | string
  /** Exact source refs: `provider:sessionId[:eventId]` strings or `{provider,sessionId,eventId}` objects. */
  allowedSourceRefs?: Array<string | SourceRef> | string
  /** Display labels aligned with `allowedSourceRefs`; derived from the refs when omitted. */
  sourceTitles?: string[] | string
  reasoningEffort?: string
}

/** A complete, admitted trial policy. */
export interface ResolvedTrialConfig {
  provider: string
  model: string
  limits: TrialLimits
  sessionIds: string[]
  refs: SourceRef[]
  sourceTitles: string[]
  reasoningEffort?: string
}

/** Resolution result: either a usable policy or an explicit reason it is off. */
export type TrialConfigResolution =
  | { ok: true; config: ResolvedTrialConfig }
  | { ok: false; availability: TrialAvailability }

/** Minimal context surface this layer needs; the real Cordis context satisfies it. */
export interface TrialContext {
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
  get(name: string, strict?: boolean): unknown
  /** Uploads the optional Cordis service; absent in non-Cordis synthetic hosts. */
  provide?(name: string, value: unknown): () => void
  logger?: { info?(format: string, ...args: unknown[]): void; warn?(format: string, ...args: unknown[]): void; error?(format: string, ...args: unknown[]): void }
}

/** Options for {@link installTrial}. */
export interface TrialInstallOptions {
  /** Raw `options.trial` value; parsed defensively. */
  raw: unknown
  /** `trial-budget.json` path; omitted keeps counters in memory only (tests). */
  file?: string
  /** Clock seam for the Beijing day key and per-turn deadline. */
  now?: () => number
}

/** Handle for the installed layer. */
export interface TrialInstallation {
  availability(): TrialAvailability
  /** Workbench snapshot, or undefined when the layer is not installed. */
  snapshot(sessionId?: string): DailyTrialSnapshot | undefined
  status(): Record<string, unknown>
  stop(): void
}

interface TrialAgent {
  id: string
  session?: { requestContext?(): { contextWindow?: number; provider?: string; model?: string } }
}
interface TrialRegistry {
  currentInitiator?(): TrialAgent | undefined
  list?(): TrialAgent[]
}

interface TrialDayBucket { requests: number; chargedTokens: number }
interface TrialRunState { originId: string; startedAt: number; requests: number; chargedTokens: number }
interface TrialLease { id: string; day: string; sessionId: string; originId: string; reserved: number }
interface TrialFile {
  version: 1
  days: Record<string, TrialDayBucket>
  runs: Record<string, TrialRunState>
  pending: Record<string, TrialLease>
  recoveredUnknownRequests: number
}

/** What the ledger reports; remaining values are derived against the configured limits. */
export interface TrialLedgerStatus {
  day: string
  daily: { requests: number; chargedTokens: number }
  pending: number
  recoveredUnknownRequests: number
}

/**
 * A refused trial request. `code` is stable and machine-readable; the message
 * always starts with it so logs and the agent error carry the reason.
 */
export class TrialDenied extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`[${code}] ${detail}`)
    this.name = 'TrialDenied'
    this.code = code
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const nonEmpty = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Beijing calendar day (`Asia/Shanghai` has had no DST since 1991: fixed UTC+8, same as the reference layer). */
export function beijingDayKey(at: number): string {
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10)
}

const LIMIT_KEYS = ['maxRequests', 'maxTokens', 'maxMs', 'maxOutputTokens', 'dailyRequests', 'dailyTokens'] as const

/**
 * Parse and validate `options.trial` without touching disk.
 *
 * Enabled-but-incomplete is a degraded state, never a silently permissive one:
 * the reason names the missing fields so an operator can fix the config.
 * @param raw - the raw config value.
 * @returns the resolved policy or the availability reason it is off.
 */
export function resolveTrialConfig(raw: unknown): TrialConfigResolution {
  const input = asRecord(raw)
  if (input === undefined) {
    return { ok: false, availability: { available: false, code: 'trial-not-configured', reason: '未配置插件 trial 选项：试用限额未启用，按宿主默认预算运行。' } }
  }
  if (input['enabled'] !== true) {
    if (input['enabled'] === false) {
      return { ok: false, availability: { available: false, code: 'trial-disabled', reason: 'trial.enabled=false：试用限额未启用。' } }
    }
    return { ok: false, availability: { available: false, code: 'trial-not-configured', reason: 'trial.enabled 未开启：试用限额未启用。' } }
  }
  const invalid: string[] = []
  const provider = nonEmpty(input['provider'])
  const model = nonEmpty(input['model'])
  if (provider === undefined) invalid.push('provider')
  if (model === undefined) invalid.push('model')
  const limits = {} as TrialLimits
  for (const key of LIMIT_KEYS) {
    const supplied = input[key]
    const value = supplied === undefined ? DEFAULT_TRIAL_LIMITS[key] : Number(supplied)
    if (!Number.isSafeInteger(value) || value <= 0) invalid.push(key)
    else limits[key] = value
  }
  const sessionIds = sessionIdList(input['allowedSessionIds'])
  if (sessionIds.length === 0) invalid.push('allowedSessionIds')
  const parsedRefs = sourceRefList(input['allowedSourceRefs'])
  if (!parsedRefs.ok) invalid.push('allowedSourceRefs')
  if (invalid.length > 0 || provider === undefined || model === undefined || !parsedRefs.ok) {
    const missing = [...new Set(invalid)]
    return { ok: false, availability: { available: false, code: 'trial-config-incomplete',
      reason: `trial 配置不完整或无效（${missing.join('、')}）：试用限额未启用，不发布服务、不展示限额。` } }
  }
  const titles = sourceTitleList(input['sourceTitles'])
  const reasoningEffort = nonEmpty(input['reasoningEffort'])
  return { ok: true, config: { provider, model, limits, sessionIds, refs: parsedRefs.refs, sourceTitles: titles,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }
}

function sessionIdList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/).filter(item => item !== '') : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '' || entry.length > 512 || /[\r\n\0]/.test(entry)) continue
    if (!seen.has(entry)) { seen.add(entry); result.push(entry) }
  }
  return result
}
function sourceTitleList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split('|') : []
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
}
function parseSourceRef(value: unknown): SourceRef | undefined {
  if (typeof value === 'string') {
    const parts = value.trim().split(':')
    if (parts.length < 2) return undefined
    const provider = parts[0] ?? ''
    const sessionId = parts[1] ?? ''
    const eventId = parts.length > 2 ? parts.slice(2).join(':') : undefined
    if ((provider !== 'dsh' && provider !== 'codex') || sessionId === '') return undefined
    return { provider, sessionId, ...(eventId === undefined || eventId === '' ? {} : { eventId }) }
  }
  const row = asRecord(value)
  if (row === undefined) return undefined
  const provider = row['provider']
  const sessionId = nonEmpty(row['sessionId'])
  const eventId = row['eventId']
  if (provider !== 'dsh' && provider !== 'codex') return undefined
  if (sessionId === undefined) return undefined
  if (eventId !== undefined && (typeof eventId !== 'string' || eventId.trim() === '')) return undefined
  return { provider, sessionId, ...(eventId === undefined ? {} : { eventId: eventId as string }) }
}
function sourceRefList(value: unknown): { ok: true; refs: SourceRef[] } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, refs: [] }
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/).filter(item => item !== '') : undefined
  if (entries === undefined) return { ok: false }
  const refs: SourceRef[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const ref = parseSourceRef(entry)
    if (ref === undefined) return { ok: false }
    const key = `${ref.provider}:${ref.sessionId}:${ref.eventId ?? ''}`
    if (!seen.has(key)) { seen.add(key); refs.push(ref) }
  }
  return { ok: true, refs }
}

const emptyTrialFile = (): TrialFile => ({ version: 1, days: {}, runs: {}, pending: {}, recoveredUnknownRequests: 0 })

function validateTrialFile(value: unknown): TrialFile {
  const file = asRecord(value)
  if (file === undefined) throw new Error('不是 JSON 对象')
  if (file['version'] !== 1) throw new Error('版本号不是 1')
  const days = asRecord(file['days'])
  const runs = asRecord(file['runs'])
  const pending = asRecord(file['pending'])
  const recovered = file['recoveredUnknownRequests']
  if (days === undefined || runs === undefined || pending === undefined) throw new Error('缺少 days/runs/pending')
  if (!count(recovered)) throw new Error('recoveredUnknownRequests 无效')
  const result: TrialFile = { version: 1, days: {}, runs: {}, pending: {}, recoveredUnknownRequests: recovered }
  for (const [key, value] of Object.entries(days)) {
    const row = asRecord(value)
    if (row === undefined || !count(row['requests']) || !count(row['chargedTokens'])) throw new Error(`日计数 ${key} 无效`)
    result.days[key] = { requests: row['requests'], chargedTokens: row['chargedTokens'] }
  }
  for (const [key, value] of Object.entries(runs)) {
    const row = asRecord(value)
    if (row === undefined || nonEmpty(row['originId']) === undefined || !count(row['startedAt']) || !count(row['requests']) || !count(row['chargedTokens'])) {
      throw new Error(`任务计数 ${key} 无效`)
    }
    result.runs[key] = { originId: row['originId'] as string, startedAt: row['startedAt'], requests: row['requests'], chargedTokens: row['chargedTokens'] }
  }
  for (const [key, value] of Object.entries(pending)) {
    const row = asRecord(value)
    if (row === undefined || nonEmpty(row['day']) === undefined || nonEmpty(row['sessionId']) === undefined
      || nonEmpty(row['originId']) === undefined || !count(row['reserved'])) throw new Error(`在途预留 ${key} 无效`)
    if (result.days[row['day'] as string] === undefined) throw new Error(`在途预留 ${key} 指向未知日期`)
    result.pending[key] = { id: key, day: row['day'] as string, sessionId: row['sessionId'] as string, originId: row['originId'] as string, reserved: row['reserved'] }
  }
  return result
}

/**
 * Durable admission ledger for the optional trial.
 *
 * Same contract as the reference `TrialPolicy`: reserve before dispatch, settle
 * from provider usage (absent usage keeps the reservation), recover unfinished
 * reservations as spent on boot, and refuse to read a corrupt counter file.
 */
export class TrialLedger {
  private data: TrialFile = emptyTrialFile()
  private readonly file?: string
  private readonly now: () => number
  private readonly limits: TrialLimits

  constructor(options: { file?: string; now?: () => number; limits: TrialLimits }) {
    this.file = options.file
    this.now = options.now ?? Date.now
    this.limits = options.limits
    this.refresh()
    const unsettled = Object.keys(this.data.pending)
    if (unsettled.length > 0) {
      // 预留已经计入当日账；中断的请求无法确认实际用量，按预留上界保留，绝不退还。
      this.data.recoveredUnknownRequests += unsettled.length
      this.data.pending = {}
      this.save()
    }
  }

  private refresh(): void {
    if (this.file === undefined || !existsSync(this.file)) return
    try {
      this.data = validateTrialFile(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      throw new Error(`试用计数不可读，拒绝重置 trial-budget：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private save(): void {
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.data)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
  }

  /** Current Beijing day bucket, created on first read for today. */
  bucket(): TrialDayBucket {
    const key = beijingDayKey(this.now())
    return (this.data.days[key] ??= { requests: 0, chargedTokens: 0 })
  }

  /** Persisted per-turn window for one session, if any. */
  run(sessionId: string): TrialRunState | undefined {
    this.refresh()
    const row = this.data.runs[sessionId]
    return row === undefined ? undefined : { ...row }
  }

  /** Start (or keep) the per-turn window. A new trusted human message starts a new window. */
  begin(sessionId: string, originId: string): void {
    this.refresh()
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('试用任务缺少会话标识')
    if (typeof originId !== 'string' || originId === '') throw new Error('试用任务缺少可信初始消息')
    if (this.data.runs[sessionId]?.originId === originId) return
    this.data.runs[sessionId] = { originId, startedAt: this.now(), requests: 0, chargedTokens: 0 }
    this.save()
  }

  /**
   * Reserve `inputTokens + outputTokens` before dispatch and count one request.
   * Throws {@link TrialDenied} before any counter changes when the budget is out.
   * @param input - exact session id and conservative input/output upper bounds.
   * @returns the lease to settle after the stream ends.
   */
  admit(input: { sessionId: string; inputTokens: number; outputTokens: number }): TrialLease {
    this.refresh()
    const now = this.now()
    const limits = this.limits
    const run = this.data.runs[input.sessionId]
    if (run === undefined) throw new TrialDenied('TRIAL_NO_RUN', '试用任务没有可信的初始消息，拒绝模型请求（请从用户消息开始本轮任务）。')
    if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0 || !Number.isSafeInteger(input.outputTokens) || input.outputTokens <= 0) {
      throw new TrialDenied('TRIAL_OUTPUT_INVALID', '试用预留预算无效，拒绝模型请求。')
    }
    if (input.outputTokens > limits.maxOutputTokens) {
      throw new TrialDenied('TRIAL_OUTPUT_INVALID', `试用单次输出上限 ${limits.maxOutputTokens}，本次请求声明 ${input.outputTokens}；拒绝调用。`)
    }
    if (now - run.startedAt >= limits.maxMs) {
      throw new TrialDenied('TRIAL_TIME_EXCEEDED', `试用任务时长预算 ${Math.floor(limits.maxMs / 60000)} 分钟已用尽；请明确安排下一项工作。`)
    }
    const dayKey = beijingDayKey(now)
    const day = (this.data.days[dayKey] ??= { requests: 0, chargedTokens: 0 })
    if (day.requests >= limits.dailyRequests) {
      throw new TrialDenied('TRIAL_DAILY_REQUESTS', `试用每日请求预算 ${limits.dailyRequests} 次已达上限（北京时间自然日）。`)
    }
    if (run.requests >= limits.maxRequests) {
      throw new TrialDenied('TRIAL_RUN_REQUESTS', `试用任务请求预算 ${limits.maxRequests} 次已达上限。`)
    }
    const reserved = input.inputTokens + input.outputTokens
    if (run.chargedTokens + reserved > limits.maxTokens) {
      throw new TrialDenied('TRIAL_RUN_TOKENS', `试用任务 token 预算不足（保守预留，非实际消耗）：已记 ${run.chargedTokens}，本次预留 ${reserved}，上限 ${limits.maxTokens}。`)
    }
    if (day.chargedTokens + reserved > limits.dailyTokens) {
      throw new TrialDenied('TRIAL_DAILY_TOKENS', `试用每日 token 预算不足（保守预留，非实际消耗）：已记 ${day.chargedTokens}，本次预留 ${reserved}，上限 ${limits.dailyTokens}。`)
    }
    const lease: TrialLease = { id: randomUUID(), day: dayKey, sessionId: input.sessionId, originId: run.originId, reserved }
    day.requests += 1
    day.chargedTokens += reserved
    run.requests += 1
    run.chargedTokens += reserved
    this.data.pending[lease.id] = lease
    this.save()
    return { ...lease }
  }

  /**
   * Settle one lease against the provider's usage total.
   * @param lease - admission returned by {@link admit}.
   * @param usageTokens - provider total; absent/unsafe keeps the reservation charged.
   */
  finish(lease: TrialLease, usageTokens?: number): void {
    try { this.refresh() } catch { return }
    const saved = this.data.pending[lease.id]
    if (saved === undefined) return
    const charged = count(usageTokens) ? usageTokens : saved.reserved
    const delta = charged - saved.reserved
    const day = this.data.days[saved.day]
    const run = this.data.runs[saved.sessionId]
    if (day !== undefined) day.chargedTokens += delta
    if (run !== undefined && run.originId === saved.originId) run.chargedTokens += delta
    delete this.data.pending[lease.id]
    this.save()
  }

  status(): TrialLedgerStatus {
    this.refresh()
    const day = this.bucket()
    return { day: beijingDayKey(this.now()), daily: { requests: day.requests, chargedTokens: day.chargedTokens },
      pending: Object.keys(this.data.pending).length, recoveredUnknownRequests: this.data.recoveredUnknownRequests }
  }
}

/** Total tokens of one provider usage payload; undefined when the payload is not fully readable. */
function usageTotal(usage: Record<string, unknown> | undefined): number | undefined {
  if (usage === undefined) return undefined
  const total = usage['totalTokens']
  if (count(total)) return total
  const input = usage['inputTokens'], output = usage['outputTokens']
  if (!count(input) || !count(output)) return undefined
  let sum = input + output
  for (const key of ['cacheReadTokens', 'cacheWriteTokens']) {
    const value = usage[key]
    if (count(value)) sum += value
  }
  return sum
}

/** Exact-or-not-at-all reference check: a configured event id is never widened. */
function refAllowed(allowed: SourceRef[], value: Record<string, unknown> | undefined): boolean {
  if (value === undefined) return false
  const provider = value['provider'], sessionId = value['sessionId'], eventId = value['eventId']
  if (typeof provider !== 'string' || typeof sessionId !== 'string') return false
  return allowed.some(ref => ref.provider === provider && ref.sessionId === sessionId
    && (ref.eventId === undefined || ref.eventId === eventId))
}

/**
 * Minimal source gate: with configured refs, only exact references may be read
 * and only those references may be cited when saving an organized note. An
 * empty ref list means "no additional source restriction".
 */
function sourceViolation(refs: SourceRef[], name: unknown, args: unknown): string | undefined {
  if (refs.length === 0 || typeof name !== 'string') return undefined
  const input = asRecord(args) ?? {}
  const denied = '隔离试用只允许读取配置中列出的精确来源引用；批量枚举、越界读取或引用未批准来源会绕过白名单，已拒绝。'
  if (name === 'butler_conversations') {
    const action = input['action']
    if (action === 'selected') return undefined
    if (action === 'read') return refAllowed(refs, input) ? undefined : denied
    return denied
  }
  if (name === 'butler_organize') {
    if (input['action'] !== 'save') return undefined
    const sources = input['sources']
    if (!Array.isArray(sources)) return undefined
    if (sources.length > refs.length) return denied
    return sources.every(item => refAllowed(refs, asRecord(item))) ? undefined : denied
  }
  return undefined
}

function sourceLabel(ref: SourceRef): string {
  return `${ref.provider}:${ref.sessionId}${ref.eventId === undefined ? '' : `:${ref.eventId}`}`
}

/** No hooks, no service, no numbers — only the concrete reason it is off. */
function unavailableInstallation(availability: TrialAvailability): TrialInstallation {
  return {
    availability: () => availability,
    snapshot: () => undefined,
    status: () => ({ ...availability }),
    stop: () => {},
  }
}

/**
 * Fail closed when the trial is configured but cannot be trusted.
 *
 * A corrupt counter file must not be treated as "fresh allowance". The layer
 * keeps blocking model requests (like the native budget failure guard) while
 * telling the workbench the exact reason.
 * @param ctx - host context.
 * @param error - the failure that prevented a trusted ledger.
 * @param code - availability code reported to the UI.
 * @returns an installation that denies every model request.
 */
export function installTrialFailure(ctx: TrialContext, error: unknown, code: TrialAvailabilityCode = 'trial-state-unreadable'): TrialInstallation {
  const detail = error instanceof Error ? error.message : String(error)
  const denialCode = code === 'trial-provider-unavailable' ? 'TRIAL_PROVIDER_UNAVAILABLE' : 'TRIAL_STATE_UNREADABLE'
  const reason = `${denialCode === 'TRIAL_PROVIDER_UNAVAILABLE' ? '试用限额无法发布为宿主服务' : '试用限额账本不可用'}，已阻止模型请求：${detail}`
  const availability: TrialAvailability = { available: false, code, reason }
  const denied = () => { throw new TrialDenied(denialCode, reason) }
  const deniedStream = () => (async function* () { throw new TrialDenied(denialCode, reason) })()
  const disposers = [
    ctx.on('agent/pre-step', denied, { prepend: true, global: true }),
    ctx.on('agent/request', denied, { prepend: true, global: true }),
    ctx.on('llm/stream', deniedStream, { prepend: true, global: true }),
    ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason }), { prepend: true, global: true }),
  ]
  return {
    availability: () => availability,
    snapshot: () => undefined,
    status: () => ({ ...availability }),
    stop: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

/**
 * Install the optional trial layer on a Cordis context.
 *
 * Provides `ctx.butlerDailyTrial` (when available) and real hooks:
 * `agent/pre-step` (per-turn window), `agent/request` (route + output cap),
 * `llm/stream` (reserve/settle/deny on the actual model call) and
 * `tools/pre-execute` (source scope).
 * @param ctx - host context.
 * @param options - raw config, state file, clock.
 * @returns a handle whose `stop()` unwinds everything (service included).
 */
export function installTrial(ctx: TrialContext, options: TrialInstallOptions): TrialInstallation {
  const resolved = resolveTrialConfig(options.raw)
  if (!resolved.ok) return unavailableInstallation(resolved.availability)
  const config = resolved.config
  let ledger: TrialLedger
  try {
    ledger = new TrialLedger({ file: options.file, now: options.now, limits: config.limits })
  } catch (error) {
    ctx.logger?.error?.('[dsh-butler] 试用限额账本不可读，所有模型请求将被阻止：%s', String(error))
    return installTrialFailure(ctx, error)
  }
  if (typeof ctx.provide !== 'function') {
    return installTrialFailure(ctx, new Error('宿主上下文不支持 ctx.provide，无法发布 butlerDailyTrial 服务'), 'trial-provider-unavailable')
  }

  const allowed = (sessionId: unknown): sessionId is string => typeof sessionId === 'string' && config.sessionIds.includes(sessionId)
  const sourceTitles = config.refs.map((ref, index) => config.sourceTitles[index] ?? sourceLabel(ref))
  const snapshot = (sessionId?: string): DailyTrialSnapshot => {
    const state = ledger.status()
    const sessionAllowed = sessionId === undefined ? true : allowed(sessionId)
    return {
      enabled: true,
      sessionAllowed,
      provider: config.provider,
      model: config.model,
      refs: config.refs.map(ref => ({ ...ref })),
      sourceTitles: [...sourceTitles],
      limits: { ...config.limits },
      daily: {
        requests: state.daily.requests,
        chargedTokens: state.daily.chargedTokens,
        remainingRequests: Math.max(0, config.limits.dailyRequests - state.daily.requests),
        remainingTokens: Math.max(0, config.limits.dailyTokens - state.daily.chargedTokens),
      },
      channel: 'unknown',
      ...(sessionAllowed ? {} : { reason: `该主题不在试用允许的会话列表内（允许 ${config.sessionIds.length} 个会话）。` }),
    }
  }
  const availability = (): TrialAvailability => ({ available: true })
  const status = () => ({ available: true, provider: config.provider, model: config.model, limits: { ...config.limits },
    sessions: config.sessionIds.length, refs: config.refs.length, ...ledger.status() })

  let disposeService: (() => void) | undefined
  try {
    disposeService = ctx.provide(TRIAL_SERVICE_NAME, { snapshot, availability, status })
    const disposeHooks = installTrialHooks(ctx, config, ledger)
    return {
      availability, snapshot, status,
      stop: () => { disposeHooks(); disposeService?.() },
    }
  } catch (error) {
    ctx.logger?.error?.('[dsh-butler] 试用限额装配失败，所有模型请求将被阻止：%s', String(error))
    try { disposeService?.() } catch { /* 已失效的服务注册不阻塞故障关闭 */ }
    return installTrialFailure(ctx, error, 'trial-provider-unavailable')
  }
}

function installTrialHooks(ctx: TrialContext, config: ResolvedTrialConfig, ledger: TrialLedger): () => void {
  const limits = config.limits
  const allowed = (sessionId: unknown): sessionId is string => typeof sessionId === 'string' && config.sessionIds.includes(sessionId)
  const logger = ctx.logger
  const registry = (): TrialRegistry | undefined => {
    try { return ctx.get('agents', false) as TrialRegistry | undefined } catch { return undefined }
  }
  const currentAgent = (): TrialAgent | undefined => {
    try { return registry()?.currentInitiator?.() } catch { return undefined }
  }
  const agentById = (sessionId: unknown): TrialAgent | undefined => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try { return registry()?.list?.().find(agent => agent?.id === sessionId) } catch { return undefined }
  }
  /** The agent on whose behalf this stream runs; unknown means "outside the trial scope" for non-allowlisted ids. */
  const agentFor = (request: unknown): TrialAgent | undefined => {
    const direct = currentAgent()
    if (direct?.id) return direct
    return agentById(asRecord(request)?.['sessionId'])
  }
  const disposers: Array<() => void> = []

  // 1. Per-turn window: a trusted human message starts (or keeps) the run.
  disposers.push(ctx.on('agent/pre-step', (payload: unknown, next: () => unknown) => {
    try {
      const record = asRecord(payload)
      const agent = asRecord(record?.['agent'])
      const sessionId = agent?.['id']
      if (allowed(sessionId)) {
        const messages = Array.isArray(record?.['messages']) ? record!['messages'] as unknown[] : []
        const human = messages.findLast(message => {
          const row = asRecord(message)
          const source = asRecord(row?.['source'])
          return source?.['kind'] === 'user' && nonEmpty(row?.['id']) !== undefined
        })
        const originId = nonEmpty(asRecord(human)?.['id'])
        if (originId !== undefined) ledger.begin(sessionId, originId)
      }
    } catch (error) {
      // 失败关闭：运行窗口记录不上时，后续模型请求会因缺少可信身份被拒绝。
      logger?.warn?.('[dsh-butler] 试用运行窗口记录失败（模型请求将被拒绝）：%s', String(error))
    }
    return next()
  }, { prepend: true, global: true }))

  // 2. Native request config does not know the trial: lock the route and cap output here.
  disposers.push(ctx.on('agent/request', async (payload: unknown, next: () => Promise<unknown>) => {
    const nativeConfig = await next()
    try {
      const sessionId = asRecord(asRecord(payload)?.['agent'])?.['id']
      if (!allowed(sessionId)) return nativeConfig
      const requested = Number(asRecord(nativeConfig)?.['maxTokens'])
      const maxTokens = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, limits.maxOutputTokens) : limits.maxOutputTokens
      return { ...(asRecord(nativeConfig) ?? {}), provider: config.provider, model: config.model, maxTokens,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }
    } catch (error) {
      logger?.warn?.('[dsh-butler] 试用请求路由收敛失败，沿用宿主配置：%s', String(error))
      return nativeConfig
    }
  }, { prepend: true, global: true }))

  // 3. The money path: reserve before dispatch, settle from real usage, deny before next().
  disposers.push(ctx.on('llm/stream', (request: unknown, next: () => AsyncIterable<unknown>) => {
    const agent = agentFor(request)
    if (agent?.id === undefined || !allowed(agent.id)) return next()
    const sessionId = agent.id
    return (async function* () {
      const input = asRecord(request) ?? {}
      if (input['provider'] !== config.provider || input['model'] !== config.model) {
        throw new TrialDenied('TRIAL_ROUTE_DENIED', `试用限额只允许 ${config.provider} / ${config.model}，本次请求是 ${String(input['provider'])} / ${String(input['model'])}；拒绝调用。`)
      }
      const output = input['maxTokens']
      if (typeof output !== 'number' || !Number.isSafeInteger(output) || output <= 0) {
        throw new TrialDenied('TRIAL_OUTPUT_INVALID', '试用要求模型请求显式声明正整数 maxTokens；拒绝调用。')
      }
      const context = agent.session?.requestContext?.()
      const inputTokens = reserveInput(input, context)
      const lease = ledger.admit({ sessionId, inputTokens, outputTokens: output })
      let total: number | undefined
      try {
        for await (const chunk of next()) {
          try {
            const row = asRecord(chunk)
            if (row?.['type'] === 'usage') {
              const value = usageTotal(asRecord(row['usage']))
              if (value !== undefined) total = value
            }
          } catch {
            // 观察用量失败不能掩盖原流。
          }
          yield chunk
        }
      } finally {
        ledger.finish(lease, total)
      }
    })()
  }, { prepend: true, global: true }))

  // 4. Source scope: only exact approved refs may be read or cited before a tool runs.
  disposers.push(ctx.on('tools/pre-execute', async (exec: unknown, next: () => unknown) => {
    try {
      const row = asRecord(exec) ?? {}
      if (!allowed(asRecord(row['agent'])?.['id'])) return next()
      const reason = sourceViolation(config.refs, row['name'], row['arguments'])
      if (reason !== undefined) return { kind: 'deny', reason }
    } catch (error) {
      return { kind: 'deny', reason: `试用来源门控无法读取工具参数，已拒绝：${error instanceof Error ? error.message : String(error)}` }
    }
    return next()
  }, { prepend: true, global: true }))

  return () => { for (const dispose of disposers.reverse()) dispose() }
}
