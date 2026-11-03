/** Official local Codex App Server read methods; never resumes or starts a turn. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SourceConversation, SourceMessage, SourceRead, SourceReadOptions, SourceRef } from '../shared/conversations.ts'

export interface CodexConversationSource {
  readonly truncated?: boolean
  list(): Promise<SourceConversation[]>
  read(ref: SourceRef, options?: SourceReadOptions): Promise<SourceRead>
  dispose(): void
}
export interface CodexSourceOptions {
  executable?: string
  home?: string
  timeoutMs?: number
  maxPages?: number
  /** Injectable JSON-RPC boundary for offline tests; production uses stdio. */
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Injectable process boundary for deterministic stdio/resource regressions. */
  spawnProcess?: (executable: string, args: string[], options: { windowsHide: true; stdio: 'pipe'; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams
}
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const time = (value: unknown): string => {
  const date = new Date(typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? value : 0)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}
const readonlyMethods = new Set(['initialize', 'thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list'])
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']

function executablePath(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.DSH_BUTLER_CODEX_BIN) return process.env.DSH_BUTLER_CODEX_BIN
  if (process.platform !== 'win32') return 'codex'
  const root = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
  if (existsSync(root)) {
    const choices = readdirSync(root, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => join(root, row.name, 'codex.exe')).filter(path => existsSync(path))
    if (choices.length === 1) return choices[0]!
    if (choices.length > 1) throw new Error('发现多个 Codex 版本，请在隔离配置中指定 DSH_BUTLER_CODEX_BIN')
  }
  return 'codex.exe'
}

function stdio(options: CodexSourceOptions): { request(method: string, params: Record<string, unknown>): Promise<unknown>; dispose(): void } {
  let child: ChildProcessWithoutNullStreams | undefined
  let initialized: Promise<void> | undefined
  let sequence = 0, closed = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const timeout = Math.min(30000, Math.max(500, options.timeoutMs ?? 15000))
  const fail = (error: Error): void => { for (const row of pending.values()) { clearTimeout(row.timer); row.reject(error) }; pending.clear() }
  const dispose = (): void => { closed = true; fail(new Error('Codex 只读连接已关闭')); child?.stdin.end(); child?.kill(); child = undefined }
  const raw = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!readonlyMethods.has(method)) return Promise.reject(new Error('拒绝非只读 Codex 方法'))
    if (!child || child.killed || closed) return Promise.reject(new Error('Codex 只读连接不可用'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex 只读请求超时：${method}`)); child?.kill(); fail(new Error('Codex 只读连接超时')); child = undefined; initialized = undefined }, timeout)
      pending.set(id, { resolve, reject, timer })
      child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error) } })
    })
  }
  const connect = async (): Promise<void> => {
    if (closed) throw new Error('Codex 只读连接已关闭')
    const args = ['app-server', '--stdio']
    child = (options.spawnProcess ?? spawn)(executablePath(options.executable), args, { windowsHide: true, stdio: 'pipe', env: { ...process.env, ...(options.home ? { CODEX_HOME: options.home } : {}) } })
    // Keep a bounded diagnostic in memory; only known CLI validation labels
    // may be shown. Arbitrary stderr can contain private account details.
    let diagnostic = ''
    child.stderr.on('data', (chunk: Buffer) => { if (diagnostic.length < 8192) diagnostic += chunk.toString('utf8').slice(0, 8192 - diagnostic.length) })
    const processHandle = child
    const reader = createInterface({ input: child.stdout })
    reader.on('line', line => {
      // Limit each protocol frame, not lifetime traffic from healthy polling.
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) { fail(new Error('Codex 返回超出单包读取上限')); processHandle.kill(); return }
      let packet: Record<string, unknown>
      try { packet = obj(JSON.parse(line)) } catch { return }
      const id = packet['id']; if (typeof id !== 'number') return
      const row = pending.get(id); if (!row) return
      clearTimeout(row.timer); pending.delete(id)
      if (packet['error']) { const error = obj(packet['error']); row.reject(new Error(str(error['message']) ?? 'Codex 只读请求失败')) }
      else row.resolve(packet['result'])
    })
    child.on('error', error => { if (child !== processHandle) return; fail(new Error(`Codex 只读连接失败：${error.message}`)); initialized = undefined; child = undefined })
    child.on('exit', (code, signal) => {
      if (child !== processHandle) return
      const badArgument = diagnostic.match(/(?:unexpected|unrecognized) argument ['"](--[a-z-]+)['"](?: found)?/i)?.[1]
      const detail = badArgument ? `；当前版本不支持参数 ${badArgument}` : /(?:error loading configuration|failed to load configuration)/i.test(diagnostic) ? '；Codex 配置加载失败' : ''
      fail(new Error(`Codex 只读进程已退出（退出码 ${code ?? 'unknown'}${signal ? `，信号 ${signal}` : ''}）${detail}`)); initialized = undefined; child = undefined
    })
    await raw('initialize', { clientInfo: { name: 'dsh_butler_readonly', title: '管家只读来源', version: '1.0.0' }, capabilities: { experimentalApi: false } })
    if (!child) throw new Error('Codex 初始化后已断开')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
  }
  return {
    async request(method, params) {
      if (!readonlyMethods.has(method)) throw new Error('拒绝非只读 Codex 方法')
      initialized ??= connect().catch(error => { initialized = undefined; throw error })
      await initialized
      return await raw(method, params)
    },
    dispose,
  }
}

function conversation(value: unknown): SourceConversation {
  const row = obj(value), id = str(row['id'])
  if (!id || id.length > 512 || /[\u0000-\u001f]/.test(id)) throw new Error('Codex 会话标识无效')
  const cwd = str(row['cwd']), subagent = obj(obj(row['source'])['subAgent']), spawned = obj(subagent['thread_spawn'])
  const parentId = str(row['parentThreadId']) ?? str(spawned['parent_thread_id']) ?? str(row['forkedFromId'])
  return { key: `codex:${id}`, provider: 'codex', sessionId: id, title: str(row['name']) || str(row['preview'])?.slice(0, 200) || '未命名 Codex 对话', project: cwd ?? '无工作区', ...(cwd ? { cwd } : {}),
    ...(parentId ? { parentId } : {}), updatedAt: time(row['updatedAt'] ?? row['createdAt']), available: true }
}
function content(value: unknown): string {
  return array(value).flatMap(block => { const row = obj(block); return row['type'] === 'text' && typeof row['text'] === 'string' ? [row['text']] : [] }).join('\n')
}
function messages(turns: unknown[]): SourceMessage[] {
  const rows: SourceMessage[] = [], seen = new Set<string>()
  for (const value of turns) {
    const turn = obj(value), turnId = str(turn['id']); if (!turnId) continue
    for (const entry of array(turn['items'])) {
      const item = obj(entry), itemId = str(item['id']); if (!itemId) continue
      let role: SourceMessage['role'] | undefined, text = ''
      if (item['type'] === 'userMessage') { role = 'user'; text = content(item['content']) }
      if (item['type'] === 'agentMessage') { role = 'assistant'; text = str(item['text']) ?? '' }
      // Reasoning, command output, auth and environment records are not chat text.
      if (!role || !text) continue
      const id = `${turnId}:${itemId}`; if (seen.has(id)) continue; seen.add(id)
      rows.push({ id, role, text, ...(item['createdAt'] ? { at: time(item['createdAt']) } : {}) })
    }
  }
  return rows
}
export function createCodexSource(options: CodexSourceOptions = {}): CodexConversationSource {
  const transport = options.request ? { request: options.request, dispose() {} } : stdio(options)
  const maxPages = Math.min(20, Math.max(1, options.maxPages ?? 10))
  let disposed = false, inventoryTruncated = false
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (disposed) throw new Error('Codex 只读来源已关闭')
    return await transport.request(method, params)
  }
  return {
    get truncated() { return inventoryTruncated },
    async list() {
      const rows = new Map<string, SourceConversation>(); inventoryTruncated = false
      for (const archived of [false, true]) {
        let cursor: string | undefined
        for (let page = 0; page < maxPages; page++) {
          const result = obj(await request('thread/list', { limit: 100, useStateDbOnly: true, sourceKinds, archived, sortKey: 'updated_at', sortDirection: 'desc', ...(cursor ? { cursor } : {}) }))
          if (!Array.isArray(result['data'])) throw new Error('Codex 会话列表格式不受支持')
          for (const value of result['data']) { const row = conversation(value); rows.set(row.key, row) }
          const next = str(result['nextCursor']); if (!next) break
          if (page + 1 >= maxPages || next === cursor) { inventoryTruncated = true; break }; cursor = next
        }
      }
      return [...rows.values()]
    },
    async read(ref, limits = {}) {
      if (ref.provider !== 'codex' || !ref.sessionId) throw new Error('Codex 来源标识无效')
      const offset = Math.max(0, Math.floor(limits.offset ?? 0)), limit = Math.min(100, Math.max(1, Math.floor(limits.limit ?? 50))), maxChars = Math.min(100000, Math.max(1, Math.floor(limits.maxChars ?? 24000)))
      if (![offset, limit, maxChars].every(Number.isFinite)) throw new Error('Codex 读取窗口无效')
      let readBytes = 0
      const readRequest = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const response = await request(method, params)
        readBytes += Buffer.byteLength(JSON.stringify(response) ?? '')
        if (readBytes > 8 * 1024 * 1024) throw new Error('Codex 本次历史读取超出字节预算，请缩小引用范围')
        return obj(response)
      }
      const result = await readRequest('thread/read', { threadId: ref.sessionId, includeTurns: false })
      const meta = conversation(result['thread']); if (meta.sessionId !== ref.sessionId) throw new Error('Codex 返回另一条会话')
      const separator = ref.eventId?.indexOf(':') ?? -1
      if (ref.eventId && (separator <= 0 || separator === ref.eventId.length - 1)) throw new Error('Codex 引用消息标识无效')
      const targetTurn = ref.eventId?.slice(0, separator)
      const all: SourceMessage[] = [], seen = new Set<string>()
      let cursor: string | undefined, remoteTruncated = false, scanCapped = false
      const enough = (): boolean => all.length - offset >= limit || all.slice(offset).reduce((count, message) => count + message.text.length, 0) >= maxChars
      const append = (rows: SourceMessage[]): void => { for (const row of rows) if (!seen.has(row.id)) { seen.add(row.id); all.push(row) } }
      for (let page = 0; page < maxPages; page++) {
        // Summary is first-user/last-assistant display data, deliberately a
        // partial read. It avoids hydrating entire tool-heavy turns.
        const response = await readRequest('thread/turns/list', { threadId: ref.sessionId, limit: Math.min(4, Math.max(1, Math.ceil((offset + limit) / 2))), sortDirection: 'asc', itemsView: 'summary', ...(cursor ? { cursor } : {}) })
        if (!Array.isArray(response['data'])) throw new Error('Codex 只读历史接口不受支持')
        const turns = response['data']
        if (ref.eventId) {
          const target = turns.find(turn => obj(turn)['id'] === targetTurn)
          if (target) { append(messages([target]).filter(row => row.id === ref.eventId)); remoteTruncated = false; break }
        } else append(messages(turns))
        const next = str(response['nextCursor']); remoteTruncated = Boolean(next)
        scanCapped = Boolean(next) && (page + 1 >= maxPages || next === cursor)
        if (!ref.eventId && enough() || !next || next === cursor) break
        cursor = next
      }
      if (ref.eventId && all.length === 0) {
        // The stable API has no type filter or direct item-read method. Exact
        // citations outside display summaries therefore use one item/page,
        // confined to their original turn and a fixed request/byte budget.
        let itemCursor: string | undefined, exhausted = false
        for (let page = 0; page < maxPages; page++) {
          const response = await readRequest('thread/items/list', { threadId: ref.sessionId, turnId: targetTurn, limit: 1, sortDirection: 'asc', ...(itemCursor ? { cursor: itemCursor } : {}) })
          if (!Array.isArray(response['data'])) throw new Error('Codex 精确消息只读接口不受支持')
          for (const entry of response['data']) {
            const item = obj(entry)
            if (item['turnId'] !== targetTurn) throw new Error('Codex 引用回查跨越了原始轮次')
            append(messages([{ id: targetTurn, items: [item['item']] }]).filter(row => row.id === ref.eventId))
          }
          if (all.length) break
          const next = str(response['nextCursor'])
          if (!next) { exhausted = true; break }
          if (next === itemCursor) break
          itemCursor = next
        }
        if (!all.length) throw new Error(exhausted ? 'Codex 引用消息不存在或不是可见对话文字' : 'Codex 引用未在有界读取窗口内找到，请缩小引用范围')
        remoteTruncated = false
      }
      const selected: SourceMessage[] = []; let chars = 0, index = offset
      for (; index < all.length && selected.length < limit; index++) {
        const row = all[index]!; if (chars >= maxChars) break
        const text = row.text.slice(0, maxChars - chars); selected.push({ ...row, text }); chars += text.length
        if (text.length < row.text.length) { index++; break }
      }
      // Metadata identifies the source revision independently of page/window;
      // exact evidence still binds the preserved turn:item id and its text.
      return { conversation: meta, messages: selected, version: createHash('sha256').update(JSON.stringify({ sessionId: meta.sessionId, updatedAt: meta.updatedAt })).digest('hex'),
        truncated: !ref.eventId || remoteTruncated || index < all.length || selected.some(row => row.text.length < (all.find(original => original.id === row.id)?.text.length ?? 0)),
        ...(index < all.length || remoteTruncated && !scanCapped && index > offset ? { nextOffset: index } : {}) }
    },
    dispose() { disposed = true; transport.dispose() },
  }
}
