/** Owner-visible native Butler chats. Original histories remain in DSH. */
export interface ButlerWorkspaceSession {
  id: string
  title: string
  cwd: string
  kind: 'daily' | 'topic' | 'legacy'
  createdAt: string
  updatedAt: string
}

export interface ButlerWorkspaceSnapshot {
  root: string
  defaultSessionId: string
  activeSessionId: string
  sessions: ButlerWorkspaceSession[]
}

/** Exporting is a readable snapshot, never DSH's archive/stop operation. */
export interface ButlerConversationArchive {
  path: string
  conflict: boolean
}
