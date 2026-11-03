import type { BudgetLimits, BudgetState } from './budget.ts'

export interface BudgetPlan {
  remainingRequests: number
  remainingTokens: number
  finalize: boolean
  allowSummary: boolean
  inputTarget: number
  notice: string
}

/** Advisory planning only; TaskBudgets.admit remains the hard admission authority. */
export function planBudget(
  state: Pick<BudgetState, 'requests' | 'tokens' | 'reservedTokens' | 'blocked'>,
  limits: BudgetLimits,
  inputUpperBound: number,
): BudgetPlan {
  for (const [key, value] of Object.entries({ requests: state.requests, tokens: state.tokens, reservedTokens: state.reservedTokens, inputUpperBound })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid budget planning ${key}`)
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid budget planning ${key}`)
  }
  const stopped = state.blocked !== undefined
  const remainingRequests = stopped ? 0 : Math.max(0, limits.maxRequests - state.requests)
  const remainingTokens = stopped ? 0 : Math.max(0, limits.maxTokens - state.tokens - state.reservedTokens)
  const nextCost = inputUpperBound + limits.maxOutputTokens + 4096
  const finalize = stopped || remainingRequests <= 1 || remainingTokens < 2 * nextCost
  const allowSummary = !stopped && remainingRequests >= 3 && remainingTokens >= 3 * nextCost
  const inputTarget = Math.min(Math.floor(limits.maxTokens / 8), Math.max(1, Math.floor(remainingTokens / 8)))
  const guidance = stopped
    ? '任务已停止，不得发起新模型请求。'
    : finalize
      ? '本轮仅用现有证据生成最终答复，不调用工具；如实说明未完成或未核验事项。此计划不保证请求可准入，仍须硬预算检查。'
      : remainingRequests === 2
        ? '最后一轮查询后必须答复；有足够证据立即答复。'
        : '有足够证据立即答复。'
  const notice = `余请求=${remainingRequests}，余tokens=${remainingTokens}；摘要请求和token均计入预算，${allowSummary ? '可在额度内摘要' : '禁止付费摘要'}。${guidance}`
  return { remainingRequests, remainingTokens, finalize, allowSummary, inputTarget, notice }
}
