import type { ButlerSession, UsageTotals } from './api.ts'
import type { SourceRef, SourceSettings, SourceRead, SourceConversation, SourceStatus } from '../shared/conversations.ts'
import type { ButlerWorkspaceSnapshot as WorkspaceSnapshot } from '../shared/workspace.ts'
import type { OrganizationDocument, OrganizationDraft } from '../shared/organization.ts'
export type { SourceProvider, SourceRef, SourceSettings, SourceRead, SourceConversation, SourceStatus } from '../shared/conversations.ts'
export type { ButlerWorkspaceSnapshot as WorkspaceSnapshot, ButlerWorkspaceSession as WorkspaceSession } from '../shared/workspace.ts'
export type { OrganizationDocument, OrganizationDraft } from '../shared/organization.ts'
export interface ApiResult { ok: boolean; error?: string; message?: string; code?: string }
export interface WorkspaceResult extends ApiResult { workspace: WorkspaceSnapshot; session?: ButlerSession; archive?: { path: string; conflict: boolean } }
export interface SourcesResult extends ApiResult { items: SourceConversation[]; status: SourceStatus[]; settings: SourceSettings; selected: SourceRef[]; truncated?: boolean; nextOffset?: number }
export interface OrganizationResult extends ApiResult { documents: OrganizationDocument[]; drafts: OrganizationDraft[]; confirmationText?: string }
export interface OrganizationDecision extends ApiResult { draft: OrganizationDraft; confirmationText?: string }

/** Every browser-owned change carries the local UI capability and same-origin credentials. */
export async function workspaceRequest<T extends ApiResult>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/dsh-butler/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Butler-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json() as T
  if (!response.ok || result.ok !== true) throw new Error(result.error ?? result.message ?? `请求失败（${response.status}）`)
  return result
}

export const fetchWorkspace = (): Promise<WorkspaceResult> => workspaceRequest('workspace')
export async function fetchWorkspaceUsage(sessionId: string): Promise<ApiResult & { sessionId: string; usage: UsageTotals }> {
  const result = await workspaceRequest<ApiResult & { sessionId: string; usage: UsageTotals }>(`workspace/usage?${new URLSearchParams({ sessionId })}`)
  if (result.sessionId !== sessionId) throw new Error('主题用量身份不匹配，请重新打开管家资料。')
  return result
}
export const workspaceAction = (action: string, fields: { sessionId?: string; title?: string } = {}): Promise<WorkspaceResult> => workspaceRequest('workspace/action', { action, ...fields })
export function fetchSources(filters: Record<string, string | undefined> = {}): Promise<SourcesResult> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value)
  return workspaceRequest(`sources?${query}`)
}
export const readSource = (ref: SourceRef, offset = 0): Promise<ApiResult & SourceRead> => workspaceRequest(`source?${new URLSearchParams({ provider: ref.provider, sessionId: ref.sessionId, offset: String(offset), limit: '40', ...(ref.eventId ? { eventId: ref.eventId } : {}) })}`)
export const selectSources = (butlerSessionId: string, refs: SourceRef[]): Promise<ApiResult & { selected: SourceRef[] }> => workspaceRequest('sources/select', { butlerSessionId, refs })
export const configureSources = (settings: Partial<SourceSettings>): Promise<ApiResult & { settings: SourceSettings }> => workspaceRequest('sources/settings', settings)
export const fetchOrganizations = (sessionId: string): Promise<OrganizationResult> => workspaceRequest(`organize?${new URLSearchParams({ sessionId })}`)
export const decideOrganization = (action: 'confirm' | 'dismiss', id: string, sessionId?: string): Promise<OrganizationDecision> => workspaceRequest('organize', { action, id, ...(sessionId ? { sessionId } : {}) })
