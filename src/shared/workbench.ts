/** Type-only HTTP contracts, shared by host and client. No host code enters the browser bundle. */
import type { BudgetReport, BudgetState, HistoryBudget } from '../host/budget.ts'
export type { HistoryBudget } from '../host/budget.ts'
import type { Task, Receipt, Usage, UsageTotals } from '../host/ledger.ts'
import type { RegisteredEvidence } from '../host/evidence-store.ts'
import type { ReminderOperation, ReminderTaskLink, ReminderDeliveryState } from '../host/reminder-operations.ts'
import type { ReminderOutboundRecord } from '../host/reminder-delivery.ts'
import type { ReminderSessions } from '../host/reminder-session.ts'
import type { ScheduleDeliveryReceipt } from '../host/ctx.ts'
import type { storageStatus } from '../host/store.ts'

export interface RuntimeControlsSnapshot {
  controlScope?: string
  layer?: { mode?: string; normalTokenBudget?: number | null; normalExecutionPolicy?: string; toolRegistration?: string; toolCount?: number; sessions?: string[] }
  active: boolean
  version?: string
  blocked?: boolean
  unavailable?: boolean
  error?: string
  contextTokens?: number
  taskBudgets?: Readonly<BudgetState>[]
  budgetReports?: BudgetReport[]
  storage?: ReturnType<typeof storageStatus>
  workflows?: { active: boolean; nativeActionGuard?: boolean; error?: string; errors?: Record<string, string> }
  executionContext?: { active: boolean; error?: string; sessions?: number; callPositions?: number; executions?: number }
  channels?: { active: boolean; enabled?: boolean; configuredOwner?: boolean; received?: number; accepted?: number; nativeMapped?: number; acceptedWithoutNative?: number; pending?: number; uncertain?: number; bindings?: number; error?: string }
  toolLoading?: { enabled?: boolean; registered: boolean; error?: string }
  skillLoading?: { enabled?: boolean; registered: boolean; error?: string }
  reminders?: ReturnType<ReminderSessions['status']>
  reminderOperations?: ReminderOperationSnapshot[]
  reminderOperationsError?: string
  reminderError?: string
}

export interface ArtifactSnapshot {
  kind?: string
  reference?: string
  path?: string
  sha256?: string
  evidenceId?: string
}

export interface TaskReminderSnapshot {
  link?: Omit<ReminderTaskLink, 'outboundDestination'>
  history: { available: boolean; deliveryState: ReminderDeliveryState; records?: ScheduleDeliveryReceipt[]; reason?: string }
  outbound?: ReminderOutboundSnapshot[]
  outboundError?: string
}

/** Platform receipts only; private transport destinations never enter the workbench. */
export type ReminderOutboundSnapshot = Pick<ReminderOutboundRecord, 'key' | 'state' | 'createdAt' | 'updatedAt' | 'receipt' | 'audit'> & {
  provider?: 'lark'
  /** Safe pointer to the original host failure; raw errors can contain private targets or bodies. */
  failure?: { kind: 'send-failed' | 'legacy-unknown'; at: string }
}
export type ReminderOperationSnapshot = Omit<ReminderOperation, 'outboundDestination' | 'outbound' | 'task' | 'identity'> & {
  identity: Omit<ReminderOperation['identity'], 'ownerId' | 'channelOrigin'>
  outbound?: ReminderOutboundSnapshot[]
}

export type TaskExecutionSnapshot = { available: true; runCount: number; requests: number } | { available: false; reason: string }
export type ReceiptReadSnapshot = Omit<Receipt, 'ownerId' | 'channelOrigin'>
export type UsageReadSnapshot = Omit<Usage, 'ownerId' | 'channelOrigin'>

/** Old task counters remain in storage; actual usage and saved run counters are separate read models. */
export type TaskReadSnapshot = Omit<Task, 'modelTokens' | 'attempts' | 'cost' | 'ownerId' | 'channelOrigin' | 'reminder'> & {
  reminder?: TaskReminderSnapshot['link']
  usage: UsageTotals
  execution: TaskExecutionSnapshot
}

export type HistoryKind = 'tasks' | 'budgets' | 'recentReceipts' | 'receipts' | 'usageRecords' | 'evidence' | 'artifacts' | 'taskBudgets' | 'reminderOperations'

export interface HistoryItems {
  tasks: TaskReadSnapshot
  budgets: HistoryBudget
  recentReceipts: ReceiptReadSnapshot
  receipts: ReceiptReadSnapshot
  usageRecords: UsageReadSnapshot
  evidence: RegisteredEvidence
  artifacts: ArtifactSnapshot
  taskBudgets: HistoryBudget
  reminderOperations: ReminderOperationSnapshot
}

export interface HistoryPage<K extends HistoryKind = HistoryKind> {
  ok: true
  kind: K
  taskId?: string
  items: HistoryItems[K][]
  total: number
  offset: number
  limit: number
  revision: string
  nextOffset?: number
}

export interface TaskDetail {
  ok: true
  generatedAt: string
  task: TaskReadSnapshot
  receipts: ReceiptReadSnapshot[]
  receiptCount: number
  evidenceAvailable: boolean
  evidence?: RegisteredEvidence[]
  evidenceCount?: number
  evidenceError?: string
  artifacts: ArtifactSnapshot[]
  artifactCount: number
  usage: UsageTotals
  usageRecords: UsageReadSnapshot[]
  usageRecordCount: number
  budgets: BudgetReport[]
  budgetHistory?: HistoryBudget[]
  budgetHistoryError?: string
  reminder?: TaskReminderSnapshot
  reminderOperations: ReminderOperationSnapshot[]
  reminderOperationsAvailable?: boolean
  reminderOperationsError?: string
  controlsError?: string
  storage: ReturnType<typeof storageStatus>
  limits: { receipts: number; usageRecords: number; evidence: number; artifacts: number }
}
