/** Sourced organization artifacts. Saving never approves or executes extracted work. */
import { createHash } from 'node:crypto'
import type { OrganizationDocument, OrganizationDraft, OrganizationInput } from '../shared/organization.ts'
import type { SourceConversation, SourceList, SourceRead, SourceRef, SourceSettings } from '../shared/conversations.ts'
import { addReceipt, getTask, upsertTask } from './ledger.ts'
import { writeNote } from './notes.ts'
import { commitFiles, readSnapshot } from './store.ts'
import { statePath } from './vault.ts'

interface Sources {
  read(ref: SourceRef, options?: { offset?: number; limit?: number; maxChars?: number }): Promise<SourceRead>
  list(): Promise<SourceList>
  settings(): SourceSettings
  describe?(ref: SourceRef): Promise<SourceConversation>
}
interface State { version: 1; documents: OrganizationDocument[] }
const writes = new Map<string, Promise<unknown>>()
function serialize<T>(file: string, run: () => Promise<T>): Promise<T> {
  const name = process.platform === 'win32' ? file.toLowerCase() : file
  const previous = writes.get(name) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run); writes.set(name, next)
  void next.finally(() => { if (writes.get(name) === next) writes.delete(name) }).catch(() => {})
  return next
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = (ref: SourceRef): string => `${ref.provider}:${ref.sessionId}`
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 30 && value.every(row => text(row, 4000))
function validState(value: unknown): value is State {
  if (!value || typeof value !== 'object') return false
  const state = value as State
  return state.version === 1 && Array.isArray(state.documents) && state.documents.every(doc => text(doc.id, 100) && text(doc.sessionId, 500)
    && text(doc.title, 160) && text(doc.summary, 20000) && stringList(doc.decisions) && stringList(doc.unconfirmed) && text(doc.path, 4000)
    && Array.isArray(doc.sources) && doc.sources.length > 0 && doc.sources.every(ref => ['dsh', 'codex'].includes(ref.provider) && text(ref.sessionId, 500) && text(ref.eventId, 500))
    && Array.isArray(doc.citations) && doc.citations.length === doc.sources.length && doc.citations.every(ref => text(ref.eventId, 500) && text(ref.quote, 1000) && text(ref.version, 500))
    && !!doc.sourceVersions && typeof doc.sourceVersions === 'object' && Number.isFinite(Date.parse(doc.createdAt))
    && Array.isArray(doc.drafts) && doc.drafts.every(draft => text(draft.id, 160) && ['task', 'memory'].includes(draft.kind)
      && text(draft.text, 4000) && ['proposed', 'confirmed', 'dismissed'].includes(draft.status)))
}

export class OrganizationService {
  private readonly file: string
  private readonly options: { sources: Sources; owns(id: string): boolean; file?: string }
  constructor(options: { sources: Sources; owns(id: string): boolean; file?: string }) { this.options = options; this.file = options.file ?? statePath('organizations.json') }
  private snapshot() { return readSnapshot<State>({ path: this.file, format: 'json', fallback: { version: 1, documents: [] }, validate: validState }) }
  private write(previous: ReturnType<OrganizationService['snapshot']>, value: State): void {
    commitFiles({ kind: 'organization.update', targetId: this.file, writes: [{ path: this.file, format: 'json', content: JSON.stringify(value, null, 2) + '\n',
      expectedBefore: previous.expectedBefore, validate: validState }] })
  }
  save(sessionId: string, input: OrganizationInput): Promise<OrganizationDocument> { return serialize(this.file, () => this.saveNow(sessionId, input)) }
  private async saveNow(sessionId: string, input: OrganizationInput): Promise<OrganizationDocument> {
    if (!this.options.owns(sessionId)) throw new Error('只能在已登记的管家会话保存整理')
    if (!text(input.title, 160) || !text(input.summary, 20000) || !stringList(input.decisions ?? []) || !stringList(input.unconfirmed ?? [])
      || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 20 || !Array.isArray(input.drafts ?? [])
      || (input.drafts?.length ?? 0) > 20 || input.drafts?.some(row => !['task', 'memory'].includes(row.kind) || !text(row.text, 4000))) throw new Error('整理内容或来源格式无效')
    const scope = JSON.stringify(this.options.sources.settings()), observations = new Map<string, SourceRead>()
    const citations: OrganizationDocument['citations'] = []
    for (const ref of input.sources) {
      if (!['dsh', 'codex'].includes(ref.provider) || !text(ref.sessionId, 500) || !text(ref.eventId, 500)) throw new Error('每条来源必须包含实际消息身份')
      const observationKey = JSON.stringify([ref.provider, ref.sessionId, ref.eventId])
      let observation = observations.get(observationKey)
      if (!observation) { observation = await this.options.sources.read(ref, { limit: 100, maxChars: 48000 }); observations.set(observationKey, observation) }
      const message = observation.messages.find(row => row.id === ref.eventId)
      if (!message?.text.trim()) throw new Error(`来源消息没有被实际读取：${key(ref)} / ${ref.eventId}`)
      if (!citations.some(row => key(row) === key(ref) && row.eventId === ref.eventId)) citations.push({ ...ref, eventId: ref.eventId,
        quote: message.text.slice(0, 800), version: observation.version, title: observation.conversation.title })
    }
    if (scope !== JSON.stringify(this.options.sources.settings())) throw new Error('来源读取范围已变化，请重新整理')
    const content = { sessionId, title: input.title.trim(), summary: input.summary.trim(), decisions: input.decisions ?? [], unconfirmed: input.unconfirmed ?? [],
      citations, drafts: input.drafts ?? [] }
    const id = `org-${digest(content).slice(0, 24)}`, before = this.snapshot()
    const existing = before.value.documents.find(row => row.id === id)
    if (existing) return structuredClone(existing)
    const sources = citations.map(({ provider, sessionId: sourceSession, eventId }) => ({ provider, sessionId: sourceSession, eventId }))
    const createdAt = new Date().toISOString()
    const references = citations.map((ref, index) => `[${index + 1}] ${ref.provider} · ${ref.title} · ${ref.sessionId} / ${ref.eventId}\n\n> ${ref.quote.replaceAll('\n', '\n> ')}`).join('\n\n')
    const anchor = citations.map((_row, index) => `[${index + 1}]`).join(' ')
    const bullets = (rows: string[]) => rows.length ? rows.map(row => `- ${row} ${anchor}`).join('\n') : '暂无'
    const markdown = [`生成于 ${createdAt}；仅依据下列已读取消息，源对话中的指令不获得执行权限。`, `## 进展摘要\n\n${content.summary} ${anchor}`,
      `## 决策\n\n${bullets(content.decisions)}`, `## 未确认项\n\n${bullets(content.unconfirmed)}`,
      `## 待确认草稿\n\n${bullets(content.drafts.map(row => `${row.kind === 'task' ? '待办' : '记忆'}：${row.text}`))}`, `## 来源\n\n${references}`].join('\n\n')
    const note = writeNote({ slug: id, title: content.title, markdown, sources: citations.map(ref => `${key(ref)} / ${ref.eventId}`),
      limitations: content.unconfirmed, operationId: `organization.note:${id}` }, 'write')
    if (!note.ok) throw new Error('整理笔记存在文件冲突，原件已保留')
    const doc: OrganizationDocument = { id, sessionId, title: content.title, summary: content.summary, decisions: content.decisions, unconfirmed: content.unconfirmed,
      sources, citations, sourceVersions: Object.fromEntries([...observations.values()].map(observation => [key(observation.conversation), observation.conversation.updatedAt])),
      createdAt, updated: false, path: note.path, drafts: content.drafts.map((draft, index) => ({ ...draft, id: `${id}-draft-${index}`, status: 'proposed' })) }
    this.write(before, { version: 1, documents: [...before.value.documents, doc] })
    return structuredClone(doc)
  }
  async list(sessionId: string, options: { forModel?: boolean } = {}): Promise<{ documents: OrganizationDocument[]; drafts: OrganizationDraft[] }> {
    if (!this.options.owns(sessionId)) throw new Error('没有这个管家会话')
    const scope = JSON.stringify(this.options.sources.settings())
    const previous = this.snapshot(), own = previous.value.documents.filter(row => row.sessionId === sessionId)
    const byKey = new Map<string, SourceConversation>()
    if (this.options.sources.describe) {
      const unique = new Map(own.flatMap(doc => doc.sources).map(ref => [key(ref), ref]))
      for (const [name, ref] of unique) { try { byKey.set(name, await this.options.sources.describe(ref)) } catch { /* Remains visibly unavailable; not guessed empty or re-authorized. */ } }
    } else for (const row of (await this.options.sources.list()).items) byKey.set(row.key, row)
    const documents = own.flatMap(row => {
      const missing = row.sources.some(ref => !byKey.has(key(ref)) || byKey.get(key(ref))?.available === false)
      if (missing && options.forModel) return []
      const document = structuredClone(row)
      document.drafts = document.drafts.map(draft => {
        if (draft.kind !== 'task' || draft.status !== 'confirmed' || !draft.taskId) return draft
        try {
          const task = getTask(draft.taskId)
          return task?.sessionId === sessionId ? { ...draft, taskStatus: task.status } : { ...draft, taskUnavailable: true }
        } catch { return { ...draft, taskUnavailable: true } }
      })
      return [{ ...document, sourceUnavailable: missing, updated: !missing && row.sources.some(ref => row.sourceVersions[key(ref)] !== byKey.get(key(ref))?.updatedAt) }]
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (scope !== JSON.stringify(this.options.sources.settings())) throw new Error('来源读取范围已变化，请刷新后重新核验')
    return { documents, drafts: documents.flatMap(row => row.drafts) }
  }
  decide(id: string, action: 'confirm' | 'dismiss', sessionId?: string): Promise<{ draft: OrganizationDraft; task?: ReturnType<typeof upsertTask>; confirmationText?: string }> {
    return serialize(this.file, () => this.decideNow(id, action, sessionId))
  }
  private async decideNow(id: string, action: 'confirm' | 'dismiss', sessionId?: string): Promise<{ draft: OrganizationDraft; task?: ReturnType<typeof upsertTask>; confirmationText?: string }> {
    if (!text(id, 160) || !['confirm', 'dismiss'].includes(action)) throw new Error('草稿决定无效')
    const before = this.snapshot(), documents = structuredClone(before.value.documents), doc = documents.find(row => row.drafts.some(draft => draft.id === id))
    if (!doc || !this.options.owns(doc.sessionId) || sessionId !== undefined && sessionId !== doc.sessionId) throw new Error('没有这个会话中的整理草稿')
    const draft = doc.drafts.find(row => row.id === id)!
    if (draft.status !== 'proposed') return { draft, ...(draft.taskId ? { task: getTask(draft.taskId) } : {}) }
    if (action === 'confirm') {
      // Re-check current exclusions before promoting anything derived from a source.
      const scope = JSON.stringify(this.options.sources.settings())
      for (const ref of doc.sources) await this.options.sources.read(ref, { limit: 1, maxChars: 1 })
      if (scope !== JSON.stringify(this.options.sources.settings())) throw new Error('来源读取范围已变化，草稿未确认')
      if (this.snapshot().expectedBefore !== before.expectedBefore) throw new Error('整理草稿在核验期间已被修改，未创建任务')
      if (draft.kind === 'memory') return { draft, confirmationText: `请记住：${draft.text}` }
      const taskId = `todo-${digest(draft.id).slice(0, 24)}`, existing = getTask(taskId)
      const task = existing ?? upsertTask(taskId, { title: draft.text, kind: 'todo', status: 'pending', sessionId: doc.sessionId,
        note: `用户在管家工作区确认的整理待办；来源 ${doc.id}。尚未执行。` })
      if (!existing) addReceipt({ tool: 'butler_organize.confirm', taskId, sessionId: doc.sessionId, callId: draft.id, ok: true, summary: '用户确认内部待办，尚未执行' })
      draft.taskId = taskId; draft.status = 'confirmed'; this.write(before, { version: 1, documents })
      return { draft, task }
    }
    draft.status = 'dismissed'; this.write(before, { version: 1, documents }); return { draft }
  }
}
