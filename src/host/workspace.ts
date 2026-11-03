/** Native chats plus owner-readable snapshots; no model turns or history rewrites. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Services } from './services.ts'
import { createButlerSession, type ButlerSessionInfo, type ButlerSessionOptions } from './session.ts'
import { withJournalLock } from './store-lock.ts'
import { STATE_HOME, VAULT_HOME, readText, sha256, statePath, writeText } from './vault.ts'
import type { ButlerConversationArchive, ButlerWorkspaceSession, ButlerWorkspaceSnapshot } from '../shared/workspace.ts'

export type { ButlerConversationArchive, ButlerWorkspaceSession, ButlerWorkspaceSnapshot } from '../shared/workspace.ts'
export const BUTLER_HOME_SESSION_ID = 'session-butler-home'

interface ArchiveRecord { baseHash?: string; generated?: { path: string; hash: string } }
interface Registry extends ButlerWorkspaceSnapshot {
  version: 1
  archives: Record<string, ArchiveRecord>
  [key: string]: unknown
}
interface SurfaceRead { session: { id: string; cwd?: string }; events: unknown[] }
export interface ButlerWorkspaceOptions extends Pick<ButlerSessionOptions, 'prepare' | 'verifyLive'> {
  /** Test/composition seam; must remain beneath STATE_HOME. */
  registryFile?: string
}
export interface ButlerWorkspace {
  snapshot(): ButlerWorkspaceSnapshot
  open(id?: string): Promise<ButlerSessionInfo>
  create(title: string): Promise<ButlerSessionInfo>
  rename(id: string, title: string): Promise<void>
  archive(id: string): Promise<ButlerConversationArchive>
  archiveAll(): Promise<Array<{ id: string; archive?: ButlerConversationArchive; error?: string }>>
  ids(): string[]
  owns(id: string): boolean
}

const queues = new Map<string, Promise<unknown>>()
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\r\n\0]/.test(value)
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const samePath = (left: string, right: string): boolean => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
const fileName = (id: string): string => `conversation-${encodeURIComponent(id).replace(/\./g, '%2E')}`

/** Windows junction 不被 lstat 报告为符号链接，只有 realpathSync.native 会解析它。 */
function assertNotLinked(path: string): void {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let physical: string
  try { physical = realpathSync.native(path) } catch (error) {
    // 已存在却无法解析（悬空 junction）同样 fail closed。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('工作区文件路径包含链接，保留原件')
    throw error
  }
  // 普通路径满足 native(path) === native(parent)/basename；junction/符号链接会跳到别处。
  if (stat.isSymbolicLink() || physical.toLowerCase() !== join(realpathSync.native(dirname(path)), basename(path)).toLowerCase()) {
    throw new Error('工作区文件路径包含链接，保留原件')
  }
}

/** Reject links and path traversal before reading or publishing our own files. */
function guard(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('工作区文件路径越界')
  let cursor = resolve(path)
  while (true) {
    if (existsSync(cursor)) assertNotLinked(cursor)
    if (samePath(cursor, resolve(root))) break
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error('工作区文件路径无效')
    cursor = parent
  }
}
function title(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 100 || /[\r\n\0]/.test(value)) throw new Error('对话标题无效（应为 1–100 个字符）')
  return value.trim()
}
function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  queues.set(key, next)
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
  return next
}

/** Stateful registration never changes the native cwd of a pre-existing session. */
export function createButlerWorkspace(ctx: Context, services: Services, options: ButlerWorkspaceOptions = {}): ButlerWorkspace {
  const registryFile = resolve(options.registryFile ?? statePath('workspace.json'))
  const root = resolve(VAULT_HOME)
  guard(STATE_HOME, registryFile)
  const recordsDirectory = statePath('workspace-sessions')
  const archiveDirectory = join(root, 'conversations')
  const recordPath = (id: string): string => join(recordsDirectory, fileName(id) + '.json')

  function initial(): Registry {
    const now = new Date().toISOString()
    const sessions: ButlerWorkspaceSession[] = [{ id: BUTLER_HOME_SESSION_ID, title: '日常管家', cwd: root, kind: 'daily', createdAt: now, updatedAt: now }]
    const legacyText = readText(statePath('session.json'))
    if (legacyText !== undefined) {
      const legacy = object(JSON.parse(legacyText))
      if (!legacy || !validId(legacy['id']) || typeof legacy['cwd'] !== 'string' || !isAbsolute(legacy['cwd'])) throw new Error('原管家会话记录无效，原件已保留')
      if (legacy['id'] !== BUTLER_HOME_SESSION_ID) sessions.push({ id: legacy['id'], title: typeof legacy['title'] === 'string' ? title(legacy['title']) : '历史管家',
        cwd: legacy['cwd'], kind: 'legacy', createdAt: date(legacy['at']) ? legacy['at'] : now, updatedAt: date(legacy['at']) ? legacy['at'] : now })
    }
    return { version: 1, root, defaultSessionId: BUTLER_HOME_SESSION_ID, activeSessionId: BUTLER_HOME_SESSION_ID, sessions, archives: {} }
  }
  function read(): Registry {
    guard(STATE_HOME, registryFile)
    const text = readText(registryFile)
    if (text === undefined) return initial()
    const value = object(JSON.parse(text))
    if (!value || value['version'] !== 1 || typeof value['root'] !== 'string' || !samePath(resolve(value['root']), root)
      || value['defaultSessionId'] !== BUTLER_HOME_SESSION_ID || !validId(value['activeSessionId']) || !Array.isArray(value['sessions']) || !object(value['archives'])) throw new Error('管家工作区登记无效或损坏，原件已保留')
    const ids = new Set<string>()
    for (const raw of value['sessions']) {
      const row = object(raw)
      if (!row || !validId(row['id']) || ids.has(row['id']) || typeof row['title'] !== 'string' || title(row['title']) !== row['title'] || typeof row['cwd'] !== 'string'
        || !isAbsolute(row['cwd']) || !['daily', 'topic', 'legacy'].includes(String(row['kind'])) || !date(row['createdAt']) || !date(row['updatedAt'])
        || row['kind'] !== 'legacy' && !samePath(resolve(row['cwd']), root)) throw new Error('管家工作区对话记录无效，原件已保留')
      ids.add(row['id'])
    }
    if (!ids.has(BUTLER_HOME_SESSION_ID) || !ids.has(value['activeSessionId'])) throw new Error('管家工作区默认或活动对话无效，原件已保留')
    for (const raw of Object.values(value['archives'] as Record<string, unknown>)) {
      const row = object(raw)
      if (!row || row['baseHash'] !== undefined && (typeof row['baseHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['baseHash']))) throw new Error('对话归档记录无效')
      if (row['generated'] !== undefined) {
        const generated = object(row['generated'])
        if (!generated || typeof generated['path'] !== 'string' || typeof generated['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(generated['hash'])) throw new Error('对话归档版本记录无效')
        guard(archiveDirectory, generated['path'])
      }
    }
    return value as unknown as Registry
  }
  function mutate<T>(fn: (value: Registry) => T): T {
    return withJournalLock(registryFile, path => guard(STATE_HOME, path), () => {
      const value = read(), before = JSON.stringify(value), result = fn(value)
      if (JSON.stringify(value) !== before || readText(registryFile) === undefined) writeText(registryFile, JSON.stringify(value, null, 2) + '\n')
      return result
    })
  }
  function find(id: string): ButlerWorkspaceSession {
    const row = read().sessions.find(item => item.id === id)
    if (!row) throw new Error('该会话不属于管家工作区')
    return row
  }
  function manager(row: ButlerWorkspaceSession) {
    const recordFile = recordPath(row.id)
    guard(STATE_HOME, recordFile)
    return createButlerSession(ctx, services, { id: row.id, title: row.title, cwd: row.cwd, recordFile, workspaceTitle: row.kind === 'legacy' ? undefined : '管家',
      ...(options.prepare ? { prepare: options.prepare } : {}), ...(options.verifyLive ? { verifyLive: options.verifyLive } : {}) })
  }
  async function openRow(row: ButlerWorkspaceSession): Promise<ButlerSessionInfo> {
    const result = await manager(row).ensureReady()
    if (result.state !== 'failed' && result.ready) mutate(value => {
      const current = value.sessions.find(item => item.id === row.id)
      if (!current) value.sessions.push({ ...row })
      else if (current.cwd !== row.cwd || current.title !== row.title) throw new Error('对话登记在准备期间发生变化，保留新记录')
      value.activeSessionId = row.id
    })
    return result
  }
  async function archiveRow(id: string): Promise<ButlerConversationArchive> {
    const row = find(id)
    const query = services.sessionQuery.get() as unknown as { readSurface?(id: string): Promise<SurfaceRead> } | undefined
    if (typeof query?.readSurface !== 'function') throw new Error('原生当前会话表层读取不可用，未生成猜测归档')
    const source = await query.readSurface(id)
    if (source.session?.id !== id || typeof source.session.cwd !== 'string' || !samePath(realpathSync(source.session.cwd), realpathSync(row.cwd)) || !Array.isArray(source.events)) throw new Error('归档来源会话身份不一致')
    const text = renderArchive(row, source.events)
    const hash = sha256(Buffer.from(text))
    const basePath = join(archiveDirectory, fileName(id) + '.md')
    guard(root, basePath)
    return mutate(value => {
      const updatedAt = source.events.reduce<number>((latest, raw) => { const event = object(raw), time = event?.['time']; return typeof time === 'number' && Number.isFinite(time) ? Math.max(latest, time) : latest }, 0)
      const session = value.sessions.find(item => item.id === id)
      if (session && updatedAt > Date.parse(session.updatedAt)) session.updatedAt = new Date(updatedAt).toISOString()
      const meta = value.archives[id] ?? {}, existing = readText(basePath)
      if (existing === undefined || meta.baseHash && sha256(Buffer.from(existing)) === meta.baseHash) {
        if (existing !== text) writeText(basePath, text)
        value.archives[id] = { ...meta, baseHash: hash }
        return { path: basePath, conflict: false }
      }
      if (meta.generated?.hash === hash) {
        guard(root, meta.generated.path)
        if (readText(meta.generated.path) === text) return { path: meta.generated.path, conflict: true }
      }
      let generated = join(archiveDirectory, `${fileName(id)}.generated-${hash.slice(0, 16)}.md`)
      guard(root, generated)
      if (readText(generated) !== undefined && readText(generated) !== text) generated = join(archiveDirectory, `${fileName(id)}.generated-${randomUUID()}.md`)
      guard(root, generated)
      if (readText(generated) !== text) writeText(generated, text)
      value.archives[id] = { ...meta, generated: { path: generated, hash } }
      return { path: generated, conflict: true }
    })
  }

  return {
    snapshot() { const value = read(); return structuredClone({ root: value.root, defaultSessionId: value.defaultSessionId, activeSessionId: value.activeSessionId, sessions: value.sessions }) },
    open(id) { return serialize(registryFile, async () => { const value = read(); return await openRow(find(id ?? value.activeSessionId)) }) },
    create(name) { return serialize(registryFile, async () => { const label = title(name), now = new Date().toISOString(); read(); return await openRow({ id: 'session-butler-topic-' + randomUUID(), title: label, cwd: root, kind: 'topic', createdAt: now, updatedAt: now }) }) },
    rename(id, name) { return serialize(registryFile, async () => {
      const label = title(name), row = find(id), ready = await manager(row).ensureReady()
      if (ready.state === 'failed' || !ready.ready) throw new Error(ready.note ?? '会话未准备好，未重命名')
      const live = services.sessions.get()?.get(id), titles = services.sessionTitle.get()
      if (!live || !titles) throw new Error('原生标题服务不可用')
      titles.rename(live, label)
      if (titles.get(live)?.title !== label) throw new Error('原生标题尚未确认，未保存新标题')
      if (await services.sessions.get()?.flush(live) !== true) throw new Error('原生标题未能持久化，未保存工作区新标题')
      mutate(value => {
        const current = value.sessions.find(item => item.id === id)
        if (!current || current.title !== row.title || current.cwd !== row.cwd) throw new Error('对话在重命名前发生变化')
        const path = recordPath(id); guard(STATE_HOME, path)
        const record = object(JSON.parse(readText(path) ?? '{}'))
        if (!record || record['id'] !== id) throw new Error('对话身份记录无效，未覆盖')
        writeText(path, JSON.stringify({ ...record, title: label, titlePinned: true }, null, 2) + '\n')
        current.title = label; current.updatedAt = new Date().toISOString()
      })
    }) },
    archive(id) { return serialize(registryFile, () => archiveRow(id)) },
    async archiveAll() {
      const rows: Array<{ id: string; archive?: ButlerConversationArchive; error?: string }> = []
      for (const id of read().sessions.filter(row => row.kind !== 'legacy').map(row => row.id)) {
        try { rows.push({ id, archive: await serialize(registryFile, () => archiveRow(id)) }) } catch (error) { rows.push({ id, error: message(error) }) }
      }
      return rows
    },
    ids() { return read().sessions.map(row => row.id) },
    owns(id) { return read().sessions.some(row => row.id === id) },
  }
}

/** Export text blocks only: internal reasoning and hidden prompt messages stay out. */
function visibleText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap(raw => {
    const block = object(raw)
    if (block?.['type'] === 'text' && typeof block['text'] === 'string') return [block['text']]
    if (block?.['type'] === 'tool-result') return [visibleText(block['content'])]
    return []
  }).filter(Boolean).join('\n')
}

function renderArchive(row: ButlerWorkspaceSession, events: unknown[]): string {
  const lines = [`# ${row.title}`, '', `- 原生会话：\`${row.id}\``, `- 原生工作目录：\`${row.cwd}\``, '- 本文件为可读归档；原生会话记录由 DSH 保存。', '']
  const seen = new Set<number>()
  for (const raw of events) {
    const event = object(raw), type = event?.['type'], seq = event?.['seq']
    if (!event || !['user/message', 'assistant/message', 'tool/result'].includes(String(type)) || !Number.isSafeInteger(seq) || seen.has(seq as number)) continue
    const data = object(event['data']), message = type === 'user/message' ? data : object(data?.['message']), blocks = message?.['content']
    if (type === 'user/message' && object(data?.['source'])?.['kind'] !== 'user') continue
    const text = visibleText(blocks)
    if (text === '') continue
    seen.add(seq as number)
    const role = type === 'user/message' ? '用户' : type === 'assistant/message' ? '管家' : '工具结果'
    const time = typeof event['time'] === 'number' && Number.isFinite(event['time']) ? ` · ${new Date(event['time']).toISOString()}` : ''
    lines.push(`## ${role} · #${seq}${time}`, '', text, '')
  }
  return lines.join('\n') + '\n'
}
