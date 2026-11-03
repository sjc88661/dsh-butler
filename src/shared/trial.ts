import type { SourceRef } from './conversations.ts'

/** Optional deployment policy supplied by an isolated host, never a grant from the model. */
export interface DailyTrialSnapshot {
  enabled: boolean
  sessionAllowed: boolean
  provider: string
  model: string
  refs: SourceRef[]
  sourceTitles: string[]
  limits: { maxRequests: number; maxTokens: number; maxMs: number; maxOutputTokens: number; dailyRequests: number; dailyTokens: number }
  daily: { requests: number; chargedTokens: number; remainingRequests: number; remainingTokens: number }
  channel: 'connected' | 'connecting' | 'disconnected' | 'unknown'
  skills?: { names: string[]; available: number; resourceAccess: 'read-only'; loading: 'on-demand' }
  reason?: string
}

/**
 * Why the optional trial layer is (not) available.
 *
 * The workbench reads this instead of inventing limits: only an `available`
 * trial may render numbers, and an unavailable one must say 试用限额未启用
 * together with the concrete reason.
 */
export type TrialAvailabilityCode =
  | 'trial-not-configured'
  | 'trial-disabled'
  | 'trial-config-incomplete'
  | 'trial-state-unreadable'
  | 'trial-provider-unavailable'

/** Machine-readable availability plus one human sentence, never a fabricated policy. */
export interface TrialAvailability {
  available: boolean
  code?: TrialAvailabilityCode
  reason?: string
}

/** Response body of GET /dsh-butler/api/workspace/trial. */
export interface DailyTrialView extends TrialAvailability {
  sessionId: string
  /** Present only when a service is installed; degraded views keep it null. */
  trial: DailyTrialSnapshot | null
}
