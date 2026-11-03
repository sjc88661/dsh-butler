/** Task-wide request admission. Counters survive reloads and automatic continuations. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface BudgetLimits {
  maxRequests: number
  maxTokens: number
  maxMs: number
  maxOutputTokens: number
  maxFailures: number
}

export const NORMAL_BUDGET: Readonly<BudgetLimits> = Object.freeze({
  maxRequests: 50, maxTokens: 2_000_000, maxMs: 15 * 60_000, maxOutputTokens: 8192, maxFailures: 3,
})
export const REMINDER_BUDGET: Readonly<BudgetLimits> = Object.freeze({
  maxRequests: 5, maxTokens: 64_000, maxMs: 60_000, maxOutputTokens: 1024, maxFailures: 3,
})

export interface BudgetState {
  taskId: string
  sessionId: string
  originId?: string
  kind: 'normal' | 'reminder'
  startedAt: number
  requests: number
  tokens: number
  reservedTokens: number
  pending: Record<string, number>
  failures: Record<string, number>
  blocked?: string
}

/** Saved counters only: old policy, end time, and remaining credit were not persisted. */
export interface HistoryBudget extends BudgetState { current: boolean }

/** Read-only effective policy and remaining admission capacity for one run. */
export interface BudgetReport extends BudgetState {
  limits: BudgetLimits
  remaining: { requests: number; tokens: number; ms: number }
  inFlight: number
}

export interface BudgetLease {
  taskId: string
  requestId: string
  sessionId: string
  maxOutputTokens: number
  remainingMs: number
}

interface BudgetFile {
  version: 1
  sessions: Record<string, string>
  tasks: Record<string, BudgetState>
}

export class BudgetExceeded extends Error {
  readonly code = 'BUDGET_EXCEEDED'
  constructor(reason: string, state: BudgetState) {
    super(`[BUDGET_EXCEEDED task=${state.taskId}] 任务已停止：${reason}；调用=${state.requests}，token=${state.tokens}，预留=${state.reservedTokens}。已保留当前进度，请根据失败原因明确安排下一项工作。`)
    this.name = 'BudgetExceeded'
  }
}

function limits(defaults: Readonly<BudgetLimits>, supplied?: Partial<BudgetLimits>): BudgetLimits {
  const value = { ...defaults, ...supplied }
  for (const [key, n] of Object.entries(value)) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid task budget ${key}`)
  }
  return value
}

export class TaskBudgets {
  private data: BudgetFile = { version: 1, sessions: {}, tasks: {} }
  private readonly file?: string
  private readonly now: () => number
  private readonly normal: BudgetLimits
  private readonly reminder: BudgetLimits

  constructor(options: { file?: string; now?: () => number; normal?: Partial<BudgetLimits>; reminder?: Partial<BudgetLimits> } = {}) {
    this.file = options.file
    this.now = options.now ?? Date.now
    this.normal = limits(NORMAL_BUDGET, options.normal)
    this.reminder = limits(REMINDER_BUDGET, options.reminder)
    this.refresh()
  }

  /** Read-only configured policy, without creating a task or changing counters. */
  limitsFor(kind: BudgetState['kind']): BudgetLimits {
    return { ...(kind === 'reminder' ? this.reminder : this.normal) }
  }

  private refresh(): void {
    if (this.file !== undefined && existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as BudgetFile
        if (data.version !== 1 || !data.sessions || !data.tasks) throw new Error('unsupported budget format')
        for (const state of Object.values(data.tasks)) {
          for (const value of [state.requests, state.tokens, state.reservedTokens, state.startedAt]) {
            if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid budget counter')
          }
          if (!state.pending || !state.failures || !['normal', 'reminder'].includes(state.kind)) throw new Error('invalid budget task')
        }
        for (const id of Object.values(data.sessions)) if (!data.tasks[id]) throw new Error('missing budget task')
        this.data = data
      } catch (error) {
        throw new Error(`预算记录无法读取，拒绝重置 budget：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Only a fresh direct human message or a distinct scheduled occurrence starts a task. */
  begin(sessionId: string, input: { humanMessageId?: string; scheduleMessageId?: string }): BudgetState {
    this.refresh()
    const current = this.get(sessionId)
    const originId = input.humanMessageId ?? input.scheduleMessageId
    if (current !== undefined && (originId === undefined || current.originId === originId)) return structuredClone(current)
    const task: BudgetState = {
      taskId: randomUUID(), sessionId, ...(originId === undefined ? {} : { originId }),
      kind: input.scheduleMessageId === undefined ? 'normal' : 'reminder',
      startedAt: this.now(), requests: 0, tokens: 0, reservedTokens: 0, pending: {}, failures: {},
    }
    this.data.tasks[task.taskId] = task
    this.data.sessions[sessionId] = task.taskId
    this.save()
    return structuredClone(task)
  }

  status(sessionId: string): Readonly<BudgetState> | undefined {
    this.refresh()
    const state = this.get(sessionId)
    return state === undefined ? undefined : structuredClone(state)
  }

  all(): Readonly<BudgetState>[] {
    this.refresh()
    return structuredClone(Object.values(this.data.sessions).map(id => this.data.tasks[id]!))
  }

  history(): HistoryBudget[] {
    this.refresh()
    const current = new Set(Object.values(this.data.sessions))
    return structuredClone(Object.values(this.data.tasks).map(state => ({ ...state, current: current.has(state.taskId) })))
  }

  reports(): BudgetReport[] {
    const states = this.all(), at = this.now()
    return states.map(state => {
      const policy = this.policy(state), available = state.blocked === undefined
      return { ...state, limits: { ...policy }, inFlight: Object.keys(state.pending).length,
        remaining: { requests: available ? Math.max(0, policy.maxRequests - state.requests) : 0,
          tokens: available ? Math.max(0, policy.maxTokens - state.tokens - state.reservedTokens) : 0,
          ms: available ? Math.max(0, policy.maxMs - (at - state.startedAt)) : 0 } }
    })
  }

  remainingMs(sessionId: string): number {
    this.refresh()
    const state = this.require(sessionId)
    return this.policy(state).maxMs - (this.now() - state.startedAt)
  }

  /** Persist a non-retryable task failure without granting fresh credit. */
  halt(sessionId: string, reason: string, taskId: string): void {
    this.refresh()
    const state = this.get(sessionId)
    if (state === undefined || state.taskId !== taskId || state.blocked !== undefined) return
    state.blocked = reason
    this.save()
  }

  check(sessionId: string): void {
    this.refresh()
    const state = this.require(sessionId)
    if (state.blocked !== undefined) throw new BudgetExceeded(state.blocked, state)
    const policy = this.policy(state)
    if (this.now() - state.startedAt >= policy.maxMs) this.stop(state, 'time 时长预算已用尽')
    if (state.requests >= policy.maxRequests) this.stop(state, `request 调用预算已达 ${policy.maxRequests} 次`)
    if (state.tokens + state.reservedTokens >= policy.maxTokens) this.stop(state, 'token 预算已用尽')
  }

  /** Reserve before dispatch, including input and bounded output, to cover concurrent calls. */
  admit(sessionId: string, inputTokens: number, requestedOutput: number, options: { requireFullOutput?: boolean } = {}): BudgetLease {
    this.check(sessionId)
    const state = this.require(sessionId)
    const policy = this.policy(state)
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error('invalid budget input token estimate')
    if (!Number.isSafeInteger(requestedOutput) || requestedOutput <= 0) throw new Error('invalid budget output limit')
    const remaining = policy.maxTokens - state.tokens - state.reservedTokens
    const maxOutputTokens = Math.min(policy.maxOutputTokens, requestedOutput, remaining - inputTokens)
    if (maxOutputTokens <= 0 || options.requireFullOutput && maxOutputTokens !== requestedOutput) {
      this.stop(state, `token 发送前预检未通过：输入上界=${inputTokens}，输出额度=${requestedOutput}，可用=${remaining}（保守预留，非实际消耗）`)
    }
    const requestId = randomUUID()
    state.pending[requestId] = inputTokens + maxOutputTokens
    state.reservedTokens += inputTokens + maxOutputTokens
    state.requests++
    this.save()
    return { taskId: state.taskId, requestId, sessionId, maxOutputTokens, remainingMs: policy.maxMs - (this.now() - state.startedAt) }
  }

  /** One provider usage total per call; absent usage keeps its conservative reservation. */
  finish(lease: BudgetLease, usageTokens?: number): void {
    this.refresh()
    const state = this.data.tasks[lease.taskId]
    const reserved = state?.pending[lease.requestId]
    if (state === undefined || reserved === undefined) return
    const tokens = usageTokens === undefined ? reserved : usageTokens
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('invalid provider token usage')
    state.reservedTokens -= reserved
    state.tokens += tokens
    delete state.pending[lease.requestId]
    if (state.tokens + state.reservedTokens >= this.policy(state).maxTokens) state.blocked = 'token 预算已用尽'
    this.save()
  }

  observeTool(sessionId: string, name: string, ok: boolean): void {
    this.refresh()
    const state = this.require(sessionId)
    state.failures[name] = ok ? 0 : (state.failures[name] ?? 0) + 1
    if (state.failures[name] >= this.policy(state).maxFailures) state.blocked = `工具 ${name} 连续失败 ${state.failures[name]} 次`
    this.save()
  }

  private get(sessionId: string): BudgetState | undefined {
    const id = this.data.sessions[sessionId]
    return id === undefined ? undefined : this.data.tasks[id]
  }
  private require(sessionId: string): BudgetState {
    if (this.get(sessionId) === undefined) this.begin(sessionId, {})
    return this.get(sessionId) as BudgetState
  }
  private policy(state: BudgetState): BudgetLimits { return state.kind === 'reminder' ? this.reminder : this.normal }
  private stop(state: BudgetState, reason: string): never {
    state.blocked = reason
    this.save()
    throw new BudgetExceeded(reason, state)
  }
  private save(): void {
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.data)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
  }
}
