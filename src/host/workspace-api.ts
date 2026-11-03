/** Local owner UI: navigation, source scope and internal proposals, never external execution. */
import type { WebServerLike, HttpRequestLike, HttpResponseLike } from './api.ts'
import type { ButlerWorkspace } from './workspace.ts'
import type { ConversationSources } from './conversation-sources.ts'
import type { OrganizationService } from './organization.ts'
import type { SourceConversation, SourceList, SourceProvider, SourceRef } from '../shared/conversations.ts'
import { sessionUsageTotals, setButlerSessionIds } from './ledger.ts'
import type { DailyTrialSnapshot, TrialAvailability } from '../shared/trial.ts'

interface Request extends HttpRequestLike {
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
}
interface Dependencies {
  workspace: ButlerWorkspace
  sources: ConversationSources
  organization: OrganizationService
  trial?(sessionId?: string): DailyTrialSnapshot | undefined
  /** Why the optional trial layer is (not) available; never a fabricated policy. */
  trialAvailability?(): TrialAvailability
}
class InputError extends Error {}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求必须是对象')
  return value as Record<string, unknown>
}
function json(res: HttpResponseLike, status: number, body: unknown): void {
  res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff'); res.end(JSON.stringify(body))
}
function localRequest(req: Request): boolean {
  const address = req.socket?.remoteAddress
  if (!address || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false
  const host = req.headers?.['host'], origin = req.headers?.['origin'], site = req.headers?.['sec-fetch-site']
  if (typeof host !== 'string' || site === 'cross-site') return false
  try {
    const url = new URL(`http://${host}`)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') return false
    if (origin !== undefined && origin !== url.origin && origin !== `https://${host}`) return false
  } catch { return false }
  if (req.method === 'POST' && (req.headers?.['x-butler-ui'] !== '1' || !String(req.headers?.['content-type']).toLowerCase().startsWith('application/json'))) return false
  return true
}
async function body(req: Request): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let data = '', bytes = 0
    req.on('data', chunk => { bytes += Buffer.byteLength(String(chunk)); if (bytes > 128 * 1024) { reject(new InputError('请求体过大')); return }; data += String(chunk) })
    req.on('error', reject)
    req.on('end', () => { try { resolve(record(JSON.parse(data))) } catch { reject(new InputError('请求 JSON 无效')) } })
  })
}
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) throw new InputError('会话或草稿标识无效')
  return value
}
const number = (value: string | null, max: number): number | undefined => {
  if (value === null) return undefined
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new InputError('分页参数无效'); return n
}
function provider(value: unknown): SourceProvider | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (value !== 'dsh' && value !== 'codex') throw new InputError('来源提供方无效')
  return value
}

export function registerWorkspaceApi(ctx: { webServer: WebServerLike }, deps: Dependencies): () => void {
  const disposers: Array<() => void> = []
  const scopedRef = (ref: SourceRef): SourceRef => {
    const trial = deps.trial?.()
    if (!trial) return ref
    const allowed = trial.refs.filter(item => item.provider === ref.provider && item.sessionId === ref.sessionId && (ref.eventId === undefined || ref.eventId === item.eventId))
    if (allowed.length === 1) return allowed[0]!
    throw Object.assign(new Error('隔离日常试用仅允许已批准的指定消息；尚未开放此来源范围。'), { code: 'SOURCE_DENIED' })
  }
  type Handler = (req: Request, query: URLSearchParams) => Promise<unknown> | unknown
  const handlers = new Map<string, Map<string, Handler>>()
  const route = (path: string, method: 'GET' | 'POST', run: Handler) => {
    const existing = handlers.get(path)
    if (existing) { existing.set(method, run); return }
    const methods = new Map<string, Handler>([[method, run]])
    handlers.set(path, methods)
    disposers.push(ctx.webServer.register({ kind: 'exact', path: `/dsh-butler/api/${path}`, handler: async (req: Request, res) => {
      const handler = methods.get(req.method ?? 'GET')
      if (!handler) { json(res, 405, { ok: false, error: `只支持 ${[...methods.keys()].join('、')}` }); return }
      if (!localRequest(req)) { json(res, 403, { ok: false, error: '仅允许本机同源管家界面访问' }); return }
      try { json(res, 200, { ok: true, ...record(await handler(req, new URL(req.url ?? '/', 'http://localhost').searchParams)) }) }
      catch (error) {
        const code = (error as { code?: string }).code
        json(res, error instanceof InputError || code === 'SOURCE_INVALID' ? 400 : code === 'SOURCE_DENIED' ? 403 : 503,
          { ok: false, error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) })
      }
    } }))
  }
  route('workspace', 'GET', () => ({ workspace: deps.workspace.snapshot() }))
  route('workspace/trial', 'GET', (_req, query) => {
    const sessionId = id(query.get('sessionId'))
    if (!deps.workspace.owns(sessionId)) throw new InputError('只能查看管家主题的试用策略')
    // Degrade explicitly: without a published service (or with one that failed
    // closed) the UI must say 试用限额未启用 instead of showing invented limits.
    const availability: TrialAvailability = deps.trialAvailability?.()
      ?? (deps.trial === undefined
        ? { available: false, code: 'trial-not-configured' as const, reason: '未提供试用限额服务：试用限额未启用。' }
        : { available: true })
    return { sessionId, available: availability.available,
      ...(availability.code === undefined ? {} : { code: availability.code }),
      ...(availability.reason === undefined ? {} : { reason: availability.reason }),
      trial: deps.trial?.(sessionId) ?? null }
  })
  route('workspace/usage', 'GET', (_req, query) => {
    const sessionId = id(query.get('sessionId'))
    if (!deps.workspace.owns(sessionId)) throw new InputError('只能查看管家主题的用量')
    return { sessionId, usage: sessionUsageTotals(sessionId) }
  })
  route('workspace/action', 'POST', async req => {
    const input = await body(req), action = input['action']
    let session, archive
    if (action === 'open') session = await deps.workspace.open(input['sessionId'] === undefined ? undefined : id(input['sessionId']))
    else if (action === 'create') session = await deps.workspace.create(id(input['title']))
    else if (action === 'rename') await deps.workspace.rename(id(input['sessionId']), id(input['title']))
    else if (action === 'archive') archive = await deps.workspace.archive(id(input['sessionId']))
    else throw new InputError('不支持这个工作区操作')
    setButlerSessionIds(deps.workspace.ids())
    return { workspace: deps.workspace.snapshot(), ...(session ? { session } : {}), ...(archive ? { archive } : {}) }
  })
  route('sources', 'GET', async (_req, query) => {
    const since = query.get('since') ?? undefined
    if (since !== undefined && !Number.isFinite(Date.parse(since))) throw new InputError('时间筛选无效')
    const filters = { provider: provider(query.get('provider')), q: query.get('q') ?? undefined, project: query.get('project') ?? undefined,
      since, offset: number(query.get('offset'), 100000), limit: number(query.get('limit'), 200) }
    const trial = deps.trial?.()
    let result: SourceList
    if (trial) {
      const unique = new Map(trial.refs.map(ref => [`${ref.provider}:${ref.sessionId}`, ref]))
      const items: SourceConversation[] = [], errors = new Map<SourceProvider, string>()
      for (const ref of unique.values()) {
        if (filters.provider && filters.provider !== ref.provider) continue
        try {
          const item = await deps.sources.describe(ref)
          if (filters.project && item.project !== filters.project || filters.since && item.updatedAt < filters.since) continue
          const query = filters.q?.trim().toLowerCase()
          if (query && !`${item.title}\n${item.project}`.toLowerCase().includes(query)) {
            const read = await deps.sources.read(ref, { limit: 1, maxChars: 48000 })
            if (!read.messages.some(message => message.text.toLowerCase().includes(query))) continue
          }
          items.push(item)
        } catch (error) { errors.set(ref.provider, error instanceof Error ? error.message : String(error)) }
      }
      const offset = filters.offset ?? 0, limit = filters.limit ?? 30
      result = { items: items.slice(offset, offset + limit), status: [...new Set(trial.refs.map(ref => ref.provider))].map(source => ({ provider: source, enabled: true, available: !errors.has(source), ...(errors.has(source) ? { error: errors.get(source) } : {}) })),
        ...(offset + limit < items.length ? { truncated: true, nextOffset: offset + limit } : {}) }
    } else result = filters.q ? await deps.sources.search(filters) : await deps.sources.list(filters)
    const sessionId = query.get('butlerSessionId')
    const items = trial ? result.items.filter(item => trial.refs.some(ref => ref.provider === item.provider && ref.sessionId === item.sessionId)) : result.items
    return { ...result, items, settings: deps.sources.settings(), selected: sessionId && deps.workspace.owns(sessionId) ? deps.sources.selected(sessionId) : [] }
  })
  route('source', 'GET', async (_req, query) => {
    const source = provider(query.get('provider')); if (!source) throw new InputError('缺少来源提供方')
    return await deps.sources.read(scopedRef({ provider: source, sessionId: id(query.get('sessionId')), ...(query.has('eventId') ? { eventId: id(query.get('eventId')) } : {}) }),
      { offset: number(query.get('offset'), 100000), limit: number(query.get('limit'), 100), maxChars: 48000 })
  })
  route('sources/settings', 'POST', async req => ({ settings: deps.sources.configure(await body(req)) }))
  route('sources/select', 'POST', async req => {
    const input = await body(req), sessionId = id(input['butlerSessionId'])
    if (!deps.workspace.owns(sessionId)) throw new InputError('只能为管家会话选择来源')
    if (!Array.isArray(input['refs']) || input['refs'].length > 20) throw new InputError('来源引用列表无效')
    return { selected: await deps.sources.select(sessionId, (input['refs'] as SourceRef[]).map(scopedRef)) }
  })
  route('organize', 'GET', async (_req, query) => await deps.organization.list(id(query.get('sessionId'))))
  route('organize', 'POST', async req => {
    const input = await body(req), action = input['action']
    if (action !== 'confirm' && action !== 'dismiss') throw new InputError('界面仅确认或忽略草稿，整理内容由对话工具保存')
    return await deps.organization.decide(id(input['id']), action, input['sessionId'] === undefined ? undefined : id(input['sessionId']))
  })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
