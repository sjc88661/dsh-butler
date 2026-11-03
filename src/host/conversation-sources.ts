/** Shared owner-scoped read boundary for DSH UI and model tools. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readText, statePath, VAULT_HOME, writeText } from './vault.ts'
import type { CodexConversationSource } from './codex-source.ts'
import type { SourceConversation, SourceFilters, SourceList, SourceMessage, SourceProvider, SourceRead, SourceReadOptions, SourceRef, SourceSettings, SourceStatus } from '../shared/conversations.ts'

type RecordValue = Record<string, unknown>
interface NativeQuery {
  listSessions(): Promise<unknown>
  readTitleSnapshots?(ids: string[]): Promise<unknown>
  readSurface?(id: string): Promise<unknown>
  readSession?(id: string): Promise<unknown>
  searchSessions?(request: RecordValue): Promise<unknown>
}
export interface ConversationSourceOptions {
  query(): unknown
  codex?: CodexConversationSource
  stateFile?: string
  indexFile?: string
}
export interface ConversationSources {
  list(filters?: SourceFilters): Promise<SourceList>
  search(filters: SourceFilters): Promise<SourceList>
  describe(ref: SourceRef): Promise<SourceConversation>
  read(ref: SourceRef, options?: SourceReadOptions): Promise<SourceRead>
  settings(): SourceSettings
  configure(patch: Partial<SourceSettings>): SourceSettings
  select(butlerSessionId: string, refs: SourceRef[]): Promise<SourceRef[]>
  selected(butlerSessionId: string): SourceRef[]
  /** Native event metadata can advance freshness without materializing history. */
  noteChanged(sessionId: string, at?: number, eventType?: string): void
  dispose(): void
}
export class SourceAccessError extends Error {
  readonly code: 'SOURCE_DENIED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_INVALID'
  constructor(message: string, code: SourceAccessError['code'] = 'SOURCE_UNAVAILABLE') { super(message); this.name = 'SourceAccessError'; this.code = code }
}
const obj = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const timestamp = (value: unknown): string => {
  const date = new Date(typeof value === 'number' || typeof value === 'string' ? value : 0)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\\]/.test(value) || value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.')) throw new SourceAccessError('来源标识格式无效', 'SOURCE_INVALID')
  return value
}
function reference(value: unknown): SourceRef {
  const row = obj(value)
  if (!row || row['provider'] !== 'dsh' && row['provider'] !== 'codex') throw new SourceAccessError('来源提供方无效', 'SOURCE_INVALID')
  return { provider: row['provider'], sessionId: identity(row['sessionId']), ...(row['eventId'] === undefined ? {} : { eventId: identity(row['eventId']) }) }
}
const keyOf = (ref: SourceRef): string => `${ref.provider}:${ref.sessionId}`
const canonicalWorkspace = (value: string): string => process.platform === 'win32' ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : value.replace(/\/+$/, '')
const sameWorkspace = (a: string, b: string): boolean => canonicalWorkspace(a) === canonicalWorkspace(b)
function validSettings(value: unknown): SourceSettings {
  const row = obj(value)
  if (!row || typeof row['codexEnabled'] !== 'boolean' || !Array.isArray(row['excludedWorkspaces']) || !Array.isArray(row['excludedConversations'])) throw new SourceAccessError('来源设置格式损坏，原件已保留', 'SOURCE_INVALID')
  const excludedWorkspaces = [...new Set(row['excludedWorkspaces'].map(value => {
    if (typeof value !== 'string' || !/^(dsh|codex):.+/.test(value) || value.length > 4096 || /[\u0000-\u001f]/.test(value)) throw new SourceAccessError('排除工作区格式无效', 'SOURCE_INVALID')
    return value
  }))]
  const excludedConversations = [...new Set(row['excludedConversations'].map(value => {
    if (typeof value !== 'string' || !/^(dsh|codex):.+/.test(value)) throw new SourceAccessError('排除对话格式无效', 'SOURCE_INVALID')
    identity(value.slice(value.indexOf(':') + 1)); return value
  }))]
  if (excludedWorkspaces.length > 2000 || excludedConversations.length > 10000) throw new SourceAccessError('排除设置超过上限', 'SOURCE_INVALID')
  return { codexEnabled: row['codexEnabled'], excludedWorkspaces, excludedConversations }
}
function nativeQuery(value: unknown): NativeQuery {
  const row = obj(value)
  if (!row || typeof row['listSessions'] !== 'function') throw new SourceAccessError('DSH 原生会话查询不可用')
  return value as NativeQuery
}
function nativeConversation(value: unknown): SourceConversation {
  const record = obj(value), header = obj(record?.['header']) ?? obj(record?.['session']) ?? record
  if (!header) throw new SourceAccessError('DSH 会话元数据格式无效')
  const id = identity(header['id']), cwd = str(header['cwd']), parent = str(header['parentSession']) ?? str(header['parentId'])
  return { key: `dsh:${id}`, provider: 'dsh', sessionId: id, title: str(header['title']) || '未命名 DSH 对话', project: cwd ?? '无工作区', ...(cwd ? { cwd } : {}), ...(parent ? { parentId: parent } : {}),
    updatedAt: timestamp(header['updatedAt'] ?? header['createdAt']), available: record?.['live'] === true || record?.['persisted'] === true || !('live' in (record ?? {})) }
}
function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => {
    const row = obj(block)
    if (row?.['type'] === 'text' && typeof row['text'] === 'string') return [row['text']]
    if (row?.['type'] === 'tool-result') return [textContent(row['content'])]
    return []
  }).filter(Boolean).join('\n')
}
/** Extract the user-visible projection only, retaining distinct native seqs. */
function nativeMessages(snapshot: RecordValue): SourceMessage[] {
  const header = obj(snapshot['session']) ?? {}, events = snapshot['events']
  if (!Array.isArray(events)) throw new SourceAccessError('DSH 原文事件格式无效')
  const boundary = snapshot['inheritedEventCount'] ?? header['inheritedEventCount'] ?? header['seedLength']
  if (header['isSeeded'] === true && boundary === undefined) throw new SourceAccessError('DSH 继承事件边界缺失，拒绝猜测父级内容')
  const inherited = Number(boundary ?? 0)
  if (!Number.isSafeInteger(inherited) || inherited < 0) throw new SourceAccessError('DSH 继承事件边界无效')
  const seen = new Set<string>(), messages: SourceMessage[] = []
  for (const value of events) {
    const event = obj(value); if (!event) continue
    const seq = event['seq']; if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < inherited) continue
    const type = event['type'], data = obj(event['data'])
    let role: SourceMessage['role'] | undefined, text = ''
    if (type === 'user/message' && obj(data?.['source'])?.['kind'] === 'user') { role = 'user'; text = textContent(data?.['content']) }
    else if (type === 'assistant/message') { role = 'assistant'; text = textContent(obj(data?.['message'])?.['content']) }
    else if (type === 'tool/result') { role = 'tool'; const result = obj(data?.['message']) ?? obj(data?.['result']) ?? data; text = textContent(result?.['content']) }
    if (!role || !text || seen.has(String(seq))) continue
    seen.add(String(seq)); messages.push({ id: String(seq), role, text, ...(event['time'] === undefined ? {} : { at: timestamp(event['time']) }) })
  }
  return messages
}
function boundedRead(conversation: SourceConversation, all: SourceMessage[], version: string, ref: SourceRef, options: SourceReadOptions): SourceRead {
  const list = ref.eventId === undefined ? all : all.filter(row => row.id === ref.eventId)
  const offset = Math.max(0, Math.floor(options.offset ?? 0)), limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50))), maxChars = Math.min(100000, Math.max(1, Math.floor(options.maxChars ?? 24000)))
  if (![offset, limit, maxChars].every(Number.isFinite)) throw new SourceAccessError('读取窗口无效', 'SOURCE_INVALID')
  const messages: SourceMessage[] = []; let index = offset, remaining = maxChars, clipped = false
  for (; index < list.length && messages.length < limit && remaining > 0; index++) {
    const row = list[index]!, text = row.text.slice(0, remaining)
    messages.push({ ...row, text }); remaining -= text.length
    if (text.length < row.text.length) { clipped = true; index++; break }
  }
  return { conversation: structuredClone(conversation), messages, version, truncated: clipped || index < list.length, ...(index < list.length ? { nextOffset: index } : {}) }
}

export function createConversationSources(options: ConversationSourceOptions): ConversationSources {
  const stateFile = options.stateFile ?? statePath('conversation-sources.json'), indexFile = options.indexFile ?? join(VAULT_HOME, 'sources', 'index.json')
  let stateText = readText(stateFile), indexText = readText(indexFile), disposed = false
  let settings: SourceSettings = { codexEnabled: false, excludedWorkspaces: [], excludedConversations: [] }
  let selections: Record<string, SourceRef[]> = Object.create(null) as Record<string, SourceRef[]>
  const cache = new Map<string, SourceConversation>()
  const observedTitles = new Set<string>(), dirtyTitles = new Map<string, number>()
  const failedTitles = new Map<string, { error: string; at: number }>()
  let titleRevision = 0
  if (stateText !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(stateText) } catch { throw new SourceAccessError('来源设置 JSON 损坏，原件已保留', 'SOURCE_INVALID') }
    const row = obj(parsed)
    if (row?.['version'] !== 1 || !obj(row['selections'])) throw new SourceAccessError('来源设置格式损坏，原件已保留', 'SOURCE_INVALID')
    settings = validSettings(row['settings'])
    for (const [sessionId, value] of Object.entries(obj(row['selections'])!)) {
      identity(sessionId); if (!Array.isArray(value) || value.length > 50) throw new SourceAccessError('来源选择记录损坏，原件已保留', 'SOURCE_INVALID')
      selections[sessionId] = value.map(reference)
    }
  }
  const permitted = (row: SourceConversation): boolean => (row.provider !== 'codex' || settings.codexEnabled)
    && !settings.excludedConversations.includes(row.key)
    && !settings.excludedWorkspaces.some(value => { const split = value.indexOf(':'); return value.slice(0, split) === row.provider && sameWorkspace(value.slice(split + 1), row.project) })
  if (indexText !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(indexText) } catch { throw new SourceAccessError('来源索引 JSON 损坏，原件已保留', 'SOURCE_INVALID') }
    const row = obj(parsed)
    if (row?.['version'] !== 1 || !Array.isArray(row['items'])) throw new SourceAccessError('来源索引格式损坏，原件已保留', 'SOURCE_INVALID')
    for (const item of row['items']) {
      const entry = obj(item), ref = reference(entry)
      if (entry?.['key'] !== keyOf(ref) || typeof entry['title'] !== 'string' || typeof entry['project'] !== 'string' || typeof entry['updatedAt'] !== 'string' || typeof entry['available'] !== 'boolean') throw new SourceAccessError('来源索引记录损坏，原件已保留', 'SOURCE_INVALID')
      const record = entry as unknown as SourceConversation; if (permitted(record)) cache.set(record.key, structuredClone(record))
    }
  }
  const ensureOpen = (): void => { if (disposed) throw new SourceAccessError('来源读取服务已关闭') }
  const writeState = (): void => {
    if (readText(stateFile) !== stateText) throw new SourceAccessError('来源设置被其他进程修改，原件已保留')
    const next = `${JSON.stringify({ version: 1, settings, selections }, null, 2)}\n`
    if (next !== stateText) { writeText(stateFile, next); stateText = next }
  }
  const writeIndex = (): void => {
    if (readText(indexFile) !== indexText) throw new SourceAccessError('来源索引被其他进程修改，原件已保留')
    const next = `${JSON.stringify({ version: 1, items: [...cache.values()].filter(permitted).sort((a, b) => a.key.localeCompare(b.key)) }, null, 2)}\n`
    if (next !== indexText) { writeText(indexFile, next); indexText = next }
  }
  const assertAllowed = (row: SourceConversation): void => { ensureOpen(); if (!permitted(row)) throw new SourceAccessError('来源已被排除或未启用，拒绝读取', 'SOURCE_DENIED') }
  const put = (row: SourceConversation): void => {
    if (!permitted(row)) return
    const old = cache.get(row.key)
    cache.set(row.key, { ...row, updatedAt: old && old.updatedAt > row.updatedAt ? old.updatedAt : row.updatedAt })
  }
  const readDSH = async (row: SourceConversation, ref: SourceRef, limits: SourceReadOptions): Promise<SourceRead> => {
    const query = nativeQuery(options.query()), reader = query.readSurface ?? query.readSession
    if (typeof reader !== 'function') throw new SourceAccessError('DSH 原生只读历史接口不可用')
    assertAllowed(row)
    const snapshot = obj(await reader.call(query, row.sessionId)); assertAllowed(row)
    if (!snapshot || obj(snapshot['session'])?.['id'] !== row.sessionId) throw new SourceAccessError('DSH 返回另一条来源会话')
    const actualCwd = str(obj(snapshot['session'])?.['cwd']) ?? '无工作区'
    const actual = { ...row, project: actualCwd, ...(actualCwd === '无工作区' ? {} : { cwd: actualCwd }) }; assertAllowed(actual)
    const messages = nativeMessages(snapshot)
    const latest = messages.map(message => message.at ?? '').sort().at(-1)
    if (latest && latest > actual.updatedAt) actual.updatedAt = latest
    put(actual); writeIndex()
    const version = createHash('sha256').update(JSON.stringify({ seq: snapshot['capturedThroughSeq'], messages })).digest('hex')
    return boundedRead(actual, messages, version, ref, limits)
  }
  const providerList = async (provider: SourceProvider): Promise<SourceStatus> => {
    if (provider === 'codex' && !settings.codexEnabled) return { provider, enabled: false, available: false }
    try {
      let items: SourceConversation[]
      if (provider === 'dsh') {
        const query = nativeQuery(options.query()), records = await query.listSessions()
        if (!Array.isArray(records)) throw new SourceAccessError('DSH 会话列表格式无效')
        items = records.map(nativeConversation).filter(permitted)
        for (const row of items) {
          const old = cache.get(row.key); if (old) row.title = old.title
          const failure = failedTitles.get(row.sessionId); if (failure) { row.available = false; row.error = failure.error }
        }
        const needed = items.filter(row => !observedTitles.has(row.sessionId) || dirtyTitles.has(row.sessionId)
          || (failedTitles.has(row.sessionId) && Date.now() - failedTitles.get(row.sessionId)!.at > 300000))
        if (query.readTitleSnapshots && needed.length) {
          const requestedRevisions = new Map(needed.map(row => [row.sessionId, dirtyTitles.get(row.sessionId)]))
          const results = await query.readTitleSnapshots(needed.map(row => row.sessionId))
          if (!Array.isArray(results)) throw new SourceAccessError('DSH 标题查询格式无效')
          const byId = new Map(items.map(row => [row.sessionId, row]))
          for (const result of results) {
            const entry = obj(result), target = byId.get(str(entry?.['sessionId']) ?? '')
            if (!target) continue
            observedTitles.add(target.sessionId)
            if (dirtyTitles.get(target.sessionId) === requestedRevisions.get(target.sessionId)) dirtyTitles.delete(target.sessionId)
            if (entry?.['status'] === 'rejected') {
              target.available = false; target.error = errorText(entry['reason']); failedTitles.set(target.sessionId, { error: target.error, at: Date.now() }); continue
            }
            failedTitles.delete(target.sessionId); target.available = true; delete target.error
            const value = obj(entry?.['value']), title = obj(value?.['title']), label = str(title?.['title'])
            target.title = label || '未命名 DSH 对话'
            const updatedAt = timestamp(title?.['time'] ?? title?.['updatedAt']); if (updatedAt > target.updatedAt) target.updatedAt = updatedAt
          }
        }
      } else {
        if (!options.codex) throw new SourceAccessError('本机 Codex 只读来源未配置')
        items = await options.codex.list()
      }
      ensureOpen()
      for (const row of items) { const previous = cache.get(row.key); if (previous && previous.updatedAt > row.updatedAt) row.updatedAt = previous.updatedAt }
      for (const [key, row] of cache) if (row.provider === provider) cache.delete(key)
      for (const row of items) { reference(row); if (row.key !== keyOf(row)) throw new SourceAccessError('来源元数据身份不一致'); put(row) }
      return { provider, available: true, enabled: true, ...(provider === 'codex' && options.codex?.truncated ? { truncated: true } : {}) }
    } catch (error) {
      for (const [key, row] of cache) if (row.provider === provider) cache.set(key, { ...row, available: false, error: errorText(error) })
      return { provider, available: false, enabled: true, error: errorText(error) }
    }
  }
  let pendingList: Promise<SourceStatus[]> | undefined
  const refresh = async (): Promise<SourceStatus[]> => {
    ensureOpen()
    pendingList ??= Promise.all([providerList('dsh'), providerList('codex')]).then(status => { ensureOpen(); writeIndex(); return status }).finally(() => { pendingList = undefined })
    return await pendingList
  }
  const filtered = (filters: SourceFilters): SourceConversation[] => {
    const q = filters.q?.trim().toLocaleLowerCase() ?? ''
    return [...cache.values()].filter(row => permitted(row) && (!filters.provider || row.provider === filters.provider)
      && (!filters.project || sameWorkspace(row.project, filters.project)) && (!filters.since || row.updatedAt >= filters.since)
      && (!q || `${row.title}\n${row.sessionId}\n${row.project}`.toLocaleLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
  }
  const resultPage = (items: SourceConversation[], status: SourceStatus[], filters: SourceFilters): SourceList => {
    const offset = Math.max(0, Math.floor(filters.offset ?? 0)), limit = Math.min(500, Math.max(1, Math.floor(filters.limit ?? 200)))
    if (![offset, limit].every(Number.isFinite)) throw new SourceAccessError('来源列表窗口无效', 'SOURCE_INVALID')
    return { items: structuredClone(items.slice(offset, offset + limit)), status, ...(offset + limit < items.length ? { truncated: true, nextOffset: offset + limit } : status.some(row => row.truncated) ? { truncated: true } : {}) }
  }
  const manager: ConversationSources = {
    async list(filters = {}) { const status = await refresh(); return resultPage(filtered(filters), status, filters) },
    async describe(input) {
      ensureOpen(); const ref = reference(input), key = keyOf(ref)
      if (settings.excludedConversations.includes(key) || ref.provider === 'codex' && !settings.codexEnabled) throw new SourceAccessError('来源已被排除或未启用，拒绝读取', 'SOURCE_DENIED')
      if (!cache.has(key)) await refresh()
      const row = cache.get(key); if (!row) throw new SourceAccessError('来源不可用或已被排除，拒绝读取', 'SOURCE_DENIED')
      assertAllowed(row); return structuredClone(row)
    },
    async search(filters) {
      const q = filters.q?.trim(); if (!q) return await manager.list(filters)
      const status = await refresh(), matches = new Map(filtered(filters).map(row => [row.key, row]))
      const candidates = filtered({ ...filters, q: undefined }), dsh = candidates.filter(row => row.provider === 'dsh' && row.available)
      const query = options.query() as NativeQuery | undefined
      if (dsh.length && typeof query?.searchSessions === 'function') {
        try {
          const response = obj(await query.searchSessions({ query: q, sessionFilters: [{ kind: 'id', values: dsh.map(row => row.sessionId) }], eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message', 'tool/result'] }, { kind: 'surface', values: ['current'] }], limit: 100 }))
          if (!Array.isArray(response?.['items'])) throw new SourceAccessError('DSH 搜索结果格式无效')
          for (const hit of response['items']) { const id = str(obj(obj(hit)?.['header'])?.['id']); const row = dsh.find(row => row.sessionId === id); if (row && permitted(row)) matches.set(row.key, row) }
          if (response['nextCursor']) status.find(row => row.provider === 'dsh')!.truncated = true
        } catch (error) { const entry = status.find(row => row.provider === 'dsh')!; entry.error = `全文搜索不可用：${errorText(error)}` }
      } else {
        // The bounded fallback runs only for an explicit search, never indexing.
        for (const row of dsh.slice(0, 20)) {
          if (matches.has(row.key) || !permitted(row)) continue
          try { const read = await readDSH(row, row, { limit: 100, maxChars: 100000 }); if (read.messages.some(message => message.text.toLocaleLowerCase().includes(q.toLocaleLowerCase()))) matches.set(row.key, row) }
          catch (error) { if (error instanceof SourceAccessError && error.code === 'SOURCE_DENIED') continue; const entry = status.find(item => item.provider === 'dsh')!; entry.error = `部分来源读取失败：${errorText(error)}` }
        }
        if (dsh.length > 20) status.find(row => row.provider === 'dsh')!.truncated = true
      }
      const codex = candidates.filter(row => row.provider === 'codex' && row.available)
      for (const row of codex.slice(0, 10)) {
        if (matches.has(row.key) || !permitted(row)) continue
        try { const read = await manager.read(row, { limit: 100, maxChars: 100000 }); if (read.messages.some(message => message.text.toLocaleLowerCase().includes(q.toLocaleLowerCase()))) matches.set(row.key, row) }
        catch (error) { if (error instanceof SourceAccessError && error.code === 'SOURCE_DENIED') continue; status.find(item => item.provider === 'codex')!.error = `部分来源读取失败：${errorText(error)}` }
      }
      if (codex.length > 10) status.find(row => row.provider === 'codex')!.truncated = true
      return resultPage([...matches.values()].filter(permitted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), status, filters)
    },
    async read(input, limits = {}) {
      ensureOpen(); const ref = reference(input), key = keyOf(ref)
      if (settings.excludedConversations.includes(key) || ref.provider === 'codex' && !settings.codexEnabled) throw new SourceAccessError('来源已被排除或未启用，拒绝读取', 'SOURCE_DENIED')
      if (!cache.has(key)) await refresh()
      const row = cache.get(key); if (!row) throw new SourceAccessError('来源不可用或已被排除，拒绝读取', 'SOURCE_DENIED')
      assertAllowed(row)
      if (ref.provider === 'dsh') return await readDSH(row, ref, limits)
      if (!options.codex) throw new SourceAccessError('本机 Codex 只读来源未配置')
      const result = await options.codex.read(ref, limits); assertAllowed(row); assertAllowed(result.conversation)
      if (result.conversation.provider !== 'codex' || result.conversation.sessionId !== ref.sessionId) throw new SourceAccessError('Codex 返回另一条来源会话')
      put(result.conversation); writeIndex(); return result
    },
    settings() { ensureOpen(); return structuredClone(settings) },
    configure(patch) {
      ensureOpen()
      const next = validSettings({ ...settings, ...patch }), previous = settings, previousSelections = selections
      settings = next; selections = Object.fromEntries(Object.entries(selections).map(([id, refs]) => [id, refs.filter(ref => { const row = cache.get(keyOf(ref)); return row && permitted(row) })]))
      try { writeState() } catch (error) { settings = previous; selections = previousSelections; throw error }
      for (const [key, row] of cache) if (!permitted(row)) { cache.delete(key); if (row.provider === 'dsh') { observedTitles.delete(row.sessionId); dirtyTitles.delete(row.sessionId); failedTitles.delete(row.sessionId) } }
      writeIndex()
      return structuredClone(settings)
    },
    async select(butlerSessionId, values) {
      ensureOpen(); identity(butlerSessionId)
      if (!Array.isArray(values) || values.length > 50) throw new SourceAccessError('来源选择超过上限', 'SOURCE_INVALID')
      const unique = new Map(values.map(value => { const ref = reference(value); return [`${keyOf(ref)}:${ref.eventId ?? ''}`, ref] }))
      if ([...unique.values()].some(ref => !cache.has(keyOf(ref)))) await refresh()
      for (const ref of unique.values()) { const row = cache.get(keyOf(ref)); if (!row) throw new SourceAccessError('来源不可用或已被排除，拒绝选择', 'SOURCE_DENIED'); assertAllowed(row) }
      const previous = selections[butlerSessionId]; selections[butlerSessionId] = [...unique.values()]
      try { writeState() } catch (error) { if (previous === undefined) delete selections[butlerSessionId]; else selections[butlerSessionId] = previous; throw error }
      return manager.selected(butlerSessionId)
    },
    selected(butlerSessionId) { ensureOpen(); identity(butlerSessionId); return structuredClone((selections[butlerSessionId] ?? []).filter(ref => { const row = cache.get(keyOf(ref)); return row && permitted(row) })) },
    noteChanged(sessionId, at = Date.now(), eventType) {
      if (disposed || !Number.isFinite(at)) return
      const row = cache.get(`dsh:${sessionId}`); if (!row || !permitted(row)) return
      if (eventType === 'session/title') dirtyTitles.set(sessionId, ++titleRevision)
      const next = timestamp(at); if (next > row.updatedAt) { cache.set(row.key, { ...row, updatedAt: next }); writeIndex() }
    },
    dispose() { disposed = true; options.codex?.dispose() },
  }
  return manager
}
