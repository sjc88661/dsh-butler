/** Read-only source identity, shared by the workbench and scoped host tools. */
export type SourceProvider = 'dsh' | 'codex'
export interface SourceRef { provider: SourceProvider; sessionId: string; eventId?: string }
export interface SourceConversation {
  key: string
  provider: SourceProvider
  sessionId: string
  title: string
  project: string
  cwd?: string
  parentId?: string
  updatedAt: string
  available: boolean
  error?: string
}
export interface SourceMessage { id: string; role: 'user' | 'assistant' | 'tool'; text: string; at?: string }
export interface SourceRead {
  conversation: SourceConversation
  messages: SourceMessage[]
  version: string
  truncated: boolean
  nextOffset?: number
}
export interface SourceStatus { provider: SourceProvider; available: boolean; enabled: boolean; error?: string; truncated?: boolean }
export interface SourceSettings { codexEnabled: boolean; excludedWorkspaces: string[]; excludedConversations: string[] }
export interface SourceFilters { provider?: SourceProvider; q?: string; project?: string; since?: string; limit?: number; offset?: number }
export interface SourceReadOptions { offset?: number; limit?: number; maxChars?: number }
export interface SourceList { items: SourceConversation[]; status: SourceStatus[]; truncated?: boolean; nextOffset?: number }
