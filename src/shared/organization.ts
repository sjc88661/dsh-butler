import type { SourceRef } from './conversations.ts'
import type { TaskStatus } from '../host/ledger.ts'

export interface OrganizationDraft {
  id: string
  kind: 'task' | 'memory'
  text: string
  status: 'proposed' | 'confirmed' | 'dismissed'
  taskId?: string
  /** Read-only ledger projection; never written back into the original organization. */
  taskStatus?: TaskStatus
  taskUnavailable?: boolean
}
export interface OrganizationCitation extends SourceRef { eventId: string; quote: string; version: string; title: string }
export interface OrganizationDocument {
  id: string
  sessionId: string
  title: string
  summary: string
  decisions: string[]
  unconfirmed: string[]
  sources: SourceRef[]
  citations: OrganizationCitation[]
  sourceVersions: Record<string, string>
  createdAt: string
  updated: boolean
  sourceUnavailable?: boolean
  path: string
  drafts: OrganizationDraft[]
}
export interface OrganizationInput {
  title: string
  summary: string
  decisions?: string[]
  unconfirmed?: string[]
  sources: SourceRef[]
  drafts?: Array<{ kind: 'task' | 'memory'; text: string }>
}
