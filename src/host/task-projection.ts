/** Read models only: never mutate task counters, usage records or execution budgets. */
import { receipts, usageRecords, usageTotals, type Receipt, type Task, type Usage } from './ledger.ts'
import type { HistoryBudget } from './budget.ts'
import type { TaskReadSnapshot, TaskReminderSnapshot } from '../shared/workbench.ts'

export interface TaskBudgetSnapshot { items?: HistoryBudget[]; error?: string }

export function readTaskBudgets(source?: () => HistoryBudget[]): TaskBudgetSnapshot {
  try {
    if (!source) throw new Error('保存的预算历史不可用')
    const items = source()
    if (!Array.isArray(items)) throw new Error('预算历史来源未返回有效记录')
    return { items }
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

/** Association requires a saved business/run identity; sharing a session is insufficient. */
export function taskRunIds(task: Task, taskReceipts: Receipt[], calls: Usage[]): Set<string> {
  return new Set([task.runId, ...taskReceipts.filter(row => row.taskId === task.id).map(row => row.runId),
    ...calls.filter(row => row.taskId === task.id).map(row => row.runId)].filter((run): run is string => !!run))
}

export function reminderLinkSnapshot(link: Task['reminder']): TaskReminderSnapshot['link'] {
  if (!link) return undefined
  const { outboundDestination: _destination, ...visible } = link
  return visible
}

export function projectTaskRead(task: Task, budgets: TaskBudgetSnapshot, taskReceipts = receipts(Number.MAX_SAFE_INTEGER), calls = usageRecords()): TaskReadSnapshot {
  const { modelTokens: _tokens, attempts: _attempts, cost: _cost, ownerId: _owner, channelOrigin: _origin, reminder, ...visible } = task
  const runs = taskRunIds(task, taskReceipts, calls)
  const saved = [...new Map((budgets.items ?? []).filter(row => runs.has(row.taskId)).map(row => [row.taskId, row])).values()]
  return { ...visible, ...(reminder ? { reminder: reminderLinkSnapshot(reminder) } : {}), usage: usageTotals(task.id),
    execution: saved.length ? { available: true, runCount: saved.length, requests: saved.reduce((total, row) => total + row.requests, 0) }
      : { available: false, reason: budgets.error ?? '没有已明确关联的保存预算，执行次数与请求计数未知' } }
}
