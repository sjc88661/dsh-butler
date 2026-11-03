/** Memory decisions use native user evidence and one recoverable local transaction. */
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ContextExecution, ExecutionContexts, ExecutionIdentity, OriginUser, UserInputView } from './execution-context.ts'
import { executionKey } from './execution-context.ts'
import type { Memo, PendingItem } from './ledger.ts'
import { commitFiles, readSnapshot, type FileWrite, type ReadOptions } from './store.ts'
import { MEMORY_INDEX_FILE, PROFILE_FILE, VAULT_HOME, statePath, vaultPath } from './vault.ts'
import { isBoundary, relevance, selectText } from './memory-retrieval.ts'

export type MemoryDecision = 'approved' | 'declined'
export interface MemoryQuestion {
  id: string
  question: string
  options: Array<{ label: string }>
  multi_select: false
}
export interface MemoryDecisionRecord {
  source: 'user-input' | 'native-question'
  sessionId: string
  messageId: string
  decidedAt: string
  decision: MemoryDecision
  factDigest: string
  callId?: string
  executionKey?: string
  argumentsDigest?: string
  questionId?: string
}
export interface MemoryProposal extends PendingItem {
  kind: 'memory'
  memoId: string
  factDigest: string
  identity: ExecutionIdentity
  question: MemoryQuestion
  decision?: MemoryDecisionRecord
  action?: 'remember' | 'correct' | 'withdraw'
  targetMemoId?: string
  targetDigest?: string
  payloadDigest?: string
}
/** Native input reference; the memo text already contains the exact fact. */
export interface MemoryOrigin extends Omit<ExecutionIdentity, 'sessionId' | 'rootSessionId' | 'originMessageId'> {
  source: 'user'
  sessionId: string
  messageId: string
  rootSessionId: string
  executionSessionId?: string
  rpcId?: string
}
export interface MemoryMemo extends Memo {
  origin?: MemoryOrigin
  scope?: 'profile' | 'topic'
  topic?: string
  key?: string
  projection?: { path: string; entry: string }
  confirmation?: MemoryDecisionRecord
  retraction?: MemoryDecisionRecord
  supersedes?: string
  supersededBy?: string
  updatedAt?: string
}
export interface MemoryResult {
  memo: MemoryMemo
  proposal?: MemoryProposal
  wroteProfile: boolean
  duplicate: boolean
}
export interface MemoryDecisionResult extends MemoryResult { proposal: MemoryProposal }
export interface MemoryOptions {
  contexts: ExecutionContexts
  timeZone?: string
}
export interface RememberOptions {
  identity?: ExecutionIdentity
  userEvidence?: { messageId: string; text: string }
  /** Compatibility inputs are deliberately not authorization. */
  source?: unknown
  approved?: unknown
  scope?: 'profile' | 'topic'
  topic?: string
  /** A stable preference slot; changing its value creates a replacement proposal. */
  key?: string
}
export interface MemoryProof { kind?: string; [key: string]: unknown }
export interface MemorySource {
  kind: 'user-input' | 'native-question' | 'local-file' | 'unverified'
  sessionId?: string
  messageId?: string
}
export interface MemoryHit {
  id: string
  title: string
  status: Memo['status']
  scope: 'profile' | 'topic'
  topic?: string
  path: string
  text: string
  source: MemorySource
  memoIds: string[]
  score: number
}
export interface MemorySearchOptions { maxItems?: number; maxBytes?: number; includeInactive?: boolean; scope?: 'profile' | 'topic' }
export interface MemoryContextOptions { maxBytes?: number; profileBytes?: number; maxTopics?: number }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const instant = (value: unknown): boolean => nonempty(value) && Number.isFinite(Date.parse(value))
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const isMemo = (value: unknown): boolean => record(value) && nonempty(value['id']) && typeof value['text'] === 'string'
  && instant(value['createdAt']) && ['user', 'butler'].includes(String(value['source'])) && ['proposed', 'confirmed', 'rejected', 'retracted'].includes(String(value['status']))
  && (value['scope'] === undefined || ['profile', 'topic'].includes(String(value['scope'])))
  && ['topic', 'key', 'supersedes', 'supersededBy'].every(key => value[key] === undefined || nonempty(value[key]))
  && (value['updatedAt'] === undefined || instant(value['updatedAt']))
  && (value['scope'] !== 'topic' || nonempty(value['topic']))
  && (value['projection'] === undefined || (record(value['projection']) && nonempty(value['projection']['path']) && nonempty(value['projection']['entry'])))
const isPending = (value: unknown): boolean => record(value) && nonempty(value['id']) && typeof value['title'] === 'string'
  && typeof value['reason'] === 'string' && instant(value['createdAt']) && ['pending', 'approved', 'declined'].includes(String(value['status']))
const rows = (check: (value: unknown) => boolean) => (value: unknown): boolean => Array.isArray(value) && value.every(check)
const memoSpec = () => ({ path: statePath('memos.json'), format: 'json' as const, fallback: [] as MemoryMemo[], validate: rows(isMemo) })
const pendingSpec = () => ({ path: statePath('pending.json'), format: 'json' as const, fallback: [] as PendingItem[], validate: rows(isPending) })
function isProposal(item: PendingItem): item is MemoryProposal {
  const row = item as unknown as Record<string, unknown>
  return row['kind'] === 'memory' && nonempty(row['memoId']) && nonempty(row['factDigest']) && record(row['identity'])
    && record(row['question']) && nonempty(row['question']['id']) && nonempty(row['question']['question']) && Array.isArray(row['question']['options'])
}
function appendFact(profile: string, fact: string): string {
  const original = profile === '' ? '# 管家档案\n' : profile
  return `${original}${original.endsWith('\n') ? '' : '\n'}- ${fact.replace(/\r?\n/g, '\n  ')}\n`
}
function questionFor(id: string, fact: string, action: MemoryProposal['action'] = 'remember', target?: MemoryMemo): MemoryQuestion {
  const change = action === 'withdraw' ? `是否撤回这条记忆，不再用于回答？\n${target?.id}：${fact}`
    : action === 'correct' ? `是否更正这条记忆？\n原值 ${target?.id}：${target?.text}\n新值：${fact}` : `是否将这条事实写入管家记忆？\n${fact}`
  return { id: `memory-${digest(id).slice(0, 24)}`, question: `${change}\n提案：${id}`,
    options: [{ label: action === 'withdraw' ? '确认撤回' : action === 'correct' ? '确认更正' : '确认记住' }, { label: '拒绝' }], multi_select: false }
}

const factEntry = (text: string): string => `- ${text.replace(/\r?\n/g, '\n  ')}\n`
function entryOffsets(text: string, entry: string): number[] {
  const positions: number[] = []
  for (let at = text.indexOf(entry); at >= 0; at = text.indexOf(entry, at + entry.length)) {
    if (at === 0 || text[at - 1] === '\n') positions.push(at)
  }
  return positions
}
const topicPath = (topic: string): string => vaultPath('memory', `topic-${digest(topic.normalize('NFKC').trim()).slice(0, 20)}.md`)
const projectionPath = (memo: MemoryMemo): string => memo.scope === 'topic' ? topicPath(memo.topic!) : PROFILE_FILE()
const targetDigest = (memo: MemoryMemo): string => digest(canonical({ id: memo.id, text: memo.text, scope: memo.scope, topic: memo.topic, key: memo.key, projection: memo.projection }))
const payloadDigest = (proposal: MemoryProposal, memo: MemoryMemo): string => digest(canonical({ action: proposal.action ?? 'remember',
  targetMemoId: proposal.targetMemoId, targetDigest: proposal.targetDigest, text: memo.text, scope: memo.scope, topic: memo.topic, key: memo.key }))
function sourceFor(memo: MemoryMemo): MemorySource {
  if (memo.origin) return { kind: 'user-input', sessionId: memo.origin.sessionId, messageId: memo.origin.messageId }
  if (memo.confirmation) return { kind: memo.confirmation.source, sessionId: memo.confirmation.sessionId, messageId: memo.confirmation.messageId }
  return { kind: 'unverified' }
}
function knownSlot(text: string): string | undefined {
  return /(?:回复|回答|答复|repl|response)/iu.test(text) && /简|短|详细|冗长|长篇|concise|brief|verbose|detail/iu.test(text) ? 'reply-length'
    : /中文|英文|chinese|english/iu.test(text) && /回复|回答|交流|说话|language|respond/iu.test(text) ? 'language'
      : /发送|发消息|发邮件|send|email/iu.test(text) && /确认|询问|授权|自动|禁止|允许/u.test(text) ? 'boundary:send'
        : /花钱|下单|支付|购买|spend|payment/iu.test(text) && /确认|询问|授权|自动|禁止|允许/u.test(text) ? 'boundary:spending' : undefined
}
const memoKey = (memo: Pick<MemoryMemo, 'text' | 'key'>): string => knownSlot(memo.text) ?? memo.key ?? digest(memo.text).slice(0, 24)
/** Every confirmed value may share a future request, regardless of its file placement. */
function assertSlotAvailable(candidate: MemoryMemo, memos: MemoryMemo[], retiringId?: string): void {
  const slot = memoKey(candidate)
  const conflict = memos.find(row => row.status === 'confirmed' && row.id !== candidate.id && row.id !== retiringId && memoKey(row) === slot)
  if (conflict) throw new Error(`同一偏好槽 ${slot} 已有有效记忆 ${conflict.id}；请读取并更正该目标，不能同时确认相反值。`)
}
function placement(text: string, options: RememberOptions, memos: MemoryMemo[]): Pick<MemoryMemo, 'scope' | 'topic' | 'key'> {
  const suppliedKey = options.key?.normalize('NFKC').trim().slice(0, 100), slot = knownSlot(text)
  const key = slot || suppliedKey || digest(text).slice(0, 24)
  const existing = memos.find(row => row.status === 'confirmed' && memoKey(row) === key && (slot !== undefined || !options.topic || row.topic === options.topic))
  if (existing) return { scope: existing.scope ?? 'profile', ...(existing.topic ? { topic: existing.topic } : {}), key }
  let scope = isBoundary(text) ? 'profile' : options.scope ?? (options.topic || /项目|研究|论文|资料|数据集/u.test(text) || text.length > 400 ? 'topic' : 'profile')
  if (scope === 'profile' && !isBoundary(text) && memos.filter(row => row.status === 'confirmed' && row.scope !== 'topic').length >= 12) scope = 'topic'
  const topic = scope === 'topic' ? (options.topic?.normalize('NFKC').replace(/[\r\n\[\]\\]/g, ' ').trim().slice(0, 100) || '其他背景') : undefined
  return { scope, ...(topic ? { topic } : {}), key }
}
function plainMutation(text: string, action: 'correct' | 'withdraw', target: string, fact: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/[。.!！]$/, '')
  const normalized = normalize(text)
  const expected = action === 'withdraw' ? [`撤回 ${target}`, `撤回：${target}`, `withdraw ${target}`]
    : [`更正 ${target}：${fact}`, `更正 ${target}: ${fact}`, `correct ${target}: ${fact}`]
  // Normalize complete commands equally; literal templates retain one optional outer ending.
  return expected.some(command => normalized === command || normalized === normalize(command))
}

/** Collect projection edits first; the store validates all preimages before changing any file. */
function projectionChanges(added?: MemoryMemo, removed?: MemoryMemo): { memo?: MemoryMemo; writes: FileWrite[] } {
  const files = new Map<string, { value: string; expectedBefore: string | null }>()
  const read = (path: string): { value: string; expectedBefore: string | null } => {
    let file = files.get(path)
    if (!file) { const snapshot = readSnapshot({ path, format: 'text', fallback: '' }); file = { value: snapshot.value, expectedBefore: snapshot.expectedBefore }; files.set(path, file) }
    return file
  }
  if (removed) {
    const path = projectionPath(removed)
    if (removed.projection && (resolve(removed.projection.path) !== resolve(path) || removed.projection.entry !== factEntry(removed.text))) throw new Error('记忆投影记录已变化，需要核对。')
    const file = read(path), entry = removed.projection?.entry ?? factEntry(removed.text), positions = entryOffsets(file.value, entry), at = positions[0]!
    if (positions.length !== 1) throw new Error('记忆正文已手改或存在重复，拒绝覆盖；请先核对差异。')
    file.value = file.value.slice(0, at) + file.value.slice(at + entry.length)
  }
  let memo = added
  if (added) {
    const path = projectionPath(added), file = read(path), entry = factEntry(added.text)
    if (file.value === '' && added.scope === 'topic') file.value = `# ${added.topic}\n\n`
    file.value = appendFact(file.value, added.text)
    memo = { ...added, projection: { path, entry } }
    if (added.scope === 'topic') {
      const index = read(MEMORY_INDEX_FILE()), line = `- [${added.topic}](${path.split(/[\\/]/).at(-1)})`
      if (!index.value.split(/\r?\n/).includes(line)) index.value = `${index.value || '# 记忆索引\n'}${index.value && !index.value.endsWith('\n') ? '\n' : ''}${line}\n`
    }
  }
  return { ...(memo ? { memo } : {}), writes: [...files].map(([path, file]) => ({ path, format: 'text', content: file.value, expectedBefore: file.expectedBefore })) }
}

function projectionState(memo: MemoryMemo, options: ReadOptions = {}): 'matched' | 'changed' | 'inactive' {
  if (memo.status !== 'confirmed') return 'inactive'
  const path = projectionPath(memo)
  if (memo.projection && resolve(memo.projection.path) !== resolve(path)) throw new Error('记忆投影路径已变化，需要核对。')
  const text = readSnapshot({ path, format: 'text', fallback: '' }, options).value
  return entryOffsets(text, memo.projection?.entry ?? factEntry(memo.text)).length === 1 ? 'matched' : 'changed'
}

/** Read-only views may be reused by the workbench without constructing an authorization context. */
export function readMemory(id: string): { memo: MemoryMemo; source: MemorySource; projectionState: ReturnType<typeof projectionState>; proposal?: MemoryProposal } | undefined {
  const memo = readSnapshot(memoSpec()).value.find(row => row.id === id)
  if (!memo) return undefined
  const proposal = readSnapshot(pendingSpec()).value.find((row): row is MemoryProposal => isProposal(row) && row.memoId === id && row.status === 'pending')
  return { memo, source: sourceFor(memo), projectionState: projectionState(memo), ...(proposal ? { proposal } : {}) }
}
export function readMemoryStatus(maxEntries = 100, options: ReadOptions = {}): {
  counts: Record<Memo['status'], number>
  entries: Array<MemoryMemo & { provenance: MemorySource; projectionState: ReturnType<typeof projectionState> }>
  total: number
} {
  const memos = readSnapshot(memoSpec(), options).value, counts: Record<Memo['status'], number> = { confirmed: 0, proposed: 0, rejected: 0, retracted: 0 }
  for (const memo of memos) counts[memo.status]++
  return { counts, total: memos.length, entries: [...memos].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(200, maxEntries))).map(memo => ({ ...memo, provenance: sourceFor(memo), projectionState: projectionState(memo, options) })) }
}

function recallFiles(memos: MemoryMemo[], scope?: 'profile' | 'topic'): MemoryHit[] {
  const active = memos.filter(memo => memo.status === 'confirmed')
  // Proposed/rejected facts were never projected. Their text cannot mask owner-written files.
  const retired = memos.filter(memo => memo.status === 'retracted' && memo.projection !== undefined
    && memo.projection.entry === factEntry(memo.text) && resolve(memo.projection.path) === resolve(projectionPath(memo))
    && memo.retraction?.decision === 'approved' && ['user-input', 'native-question'].includes(memo.retraction.source)
    && nonempty(memo.retraction.sessionId) && nonempty(memo.retraction.messageId) && instant(memo.retraction.decidedAt))
  const clean = (body: string, path: string): string => retired.filter(memo => resolve(memo.projection!.path) === resolve(path)
    && !active.some(row => row.text === memo.text && resolve(projectionPath(row)) === resolve(path)))
    .reduce((text, memo) => {
      const entry = memo.projection?.entry ?? factEntry(memo.text)
      for (const at of entryOffsets(text, entry).reverse()) text = text.slice(0, at) + text.slice(at + entry.length)
      return text
    }, body)
  const profilePath = PROFILE_FILE(), profile = clean(readSnapshot({ path: profilePath, format: 'text', fallback: '' }).value, profilePath)
  const output: MemoryHit[] = scope === 'topic' ? [] : [{ id: 'profile', title: '用户偏好与边界', status: 'confirmed', scope: 'profile', path: profilePath, text: profile,
    source: { kind: 'local-file' }, memoIds: active.filter(memo => memo.scope !== 'topic').map(memo => memo.id), score: 0 }]
  if (scope === 'profile') return output
  let files: import('node:fs').Dirent[]
  try { files = readdirSync(vaultPath('memory'), { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return output; throw error }
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.isFile() || !file.name.endsWith('.md') || file.name === 'index.md') continue
    const path = join(VAULT_HOME, 'memory', file.name), body = clean(readSnapshot({ path, format: 'text', fallback: '' }).value, path)
    const associated = active.filter(memo => resolve(projectionPath(memo)) === resolve(path))
    const title = associated[0]?.topic ?? body.match(/^#\s+(.+)$/m)?.[1] ?? file.name
    if (!selectText(body, '', 256)) continue
    const unchanged = associated.filter(memo => entryOffsets(body, memo.projection?.entry ?? factEntry(memo.text)).length === 1)
    // A hand-edited topic is an explicit local file source, never retroactively native-user evidence.
    const unmanaged = body.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).join('\n')
    const expected = unchanged.map(memo => (memo.projection?.entry ?? factEntry(memo.text)).trim()).join('\n')
    output.push({ id: `topic:${file.name}`, title, status: 'confirmed', scope: 'topic', topic: title, path, text: body,
      source: unchanged.length && unmanaged.trim() === expected.trim() ? sourceFor(unchanged[0]!) : { kind: 'local-file' }, memoIds: associated.map(memo => memo.id), score: 0 })
  }
  return output
}
export function searchMemory(query: string, options: MemorySearchOptions = {}): { items: MemoryHit[]; text: string; bytes: number; truncated: boolean } {
  const memos = readSnapshot(memoSpec()).value, limit = Math.max(0, Math.min(20, options.maxItems ?? 5)), maxBytes = Math.max(0, Math.min(16000, options.maxBytes ?? 4000))
  const candidates = recallFiles(memos, options.scope)
  if (options.includeInactive) for (const memo of memos.filter(row => row.status !== 'confirmed' && (options.scope === undefined || (row.scope ?? 'profile') === options.scope))) candidates.push({ id: memo.id, title: memo.topic ?? memo.text,
    status: memo.status, scope: memo.scope ?? 'profile', ...(memo.topic ? { topic: memo.topic } : {}), path: projectionPath(memo), text: memo.text, source: sourceFor(memo), memoIds: [memo.id], score: 0 })
  const ranked = candidates.map(hit => ({ ...hit, score: relevance(query, hit.text, hit.title) }))
    .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || (a.source.kind === 'unverified' ? 1 : 0) - (b.source.kind === 'unverified' ? 1 : 0) || a.path.localeCompare(b.path) || a.id.localeCompare(b.id))
  const items: MemoryHit[] = []; let text = ''
  for (const hit of ranked) {
    if (items.length >= limit) break
    const heading = `${text ? '\n\n' : ''}[${hit.status}] ${hit.title}（${hit.source.kind}；${hit.path}）\n`
    const remaining = maxBytes - Buffer.byteLength(text + heading)
    if (remaining <= 0) break
    const excerpt = selectText(hit.text, query, remaining, hit.scope === 'profile')
    if (!excerpt) continue
    text += `${heading}${excerpt}`; items.push({ ...hit, text: excerpt })
  }
  return { items, text, bytes: Buffer.byteLength(text), truncated: items.length < ranked.length || items.some(hit => Buffer.byteLength(hit.text) < Buffer.byteLength(candidates.find(row => row.id === hit.id)?.text ?? '')) }
}
export function readMemoryContext(query: string, options: MemoryContextOptions = {}): { profile: string; topics: MemoryHit[]; text: string; bytes: number; truncated: boolean } {
  const maxBytes = Math.max(0, Math.min(16000, options.maxBytes ?? 6000)), memos = readSnapshot(memoSpec()).value
  const profileFile = recallFiles(memos, 'profile')[0]!
  const profile = selectText(profileFile.text, query, Math.min(maxBytes, options.profileBytes ?? 2000), true)
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(profile) - (profile ? 2 : 0))
  const topics = remaining > 0 && options.maxTopics !== 0 ? searchMemory(query, { scope: 'topic', maxItems: options.maxTopics ?? 3, maxBytes: remaining })
    : { items: [], text: '', bytes: 0, truncated: false }
  const text = `${profile}${profile && topics.text ? '\n\n' : ''}${topics.text}`
  return { profile, topics: topics.items, text, bytes: Buffer.byteLength(text), truncated: topics.truncated || Buffer.byteLength(profile) < Buffer.byteLength(profileFile.text) }
}
function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  return ['sessionId', 'rootSessionId', 'taskId', 'runId', 'originMessageId'].every(key => a[key as keyof ExecutionIdentity] === b[key as keyof ExecutionIdentity])
}
function plainConfirmation(text: string, target: string, decision: MemoryDecision): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const verb = decision === 'approved' ? '(?:确认记住|同意记住|确认|同意|批准|记住|approve|confirm(?: remember)?|remember)'
    : '(?:拒绝|不记住|不要记住|不同意|否决|reject|decline)'
  // Whole-input grammar excludes quoted text, instructions about approvals and bare "yes".
  return new RegExp(`^(?:请)?${verb}\\s*[:：]?\\s*${escaped}[。.!！]?$`, 'iu').test(text.trim())
    || new RegExp(`^${escaped}\\s*[:：]?\\s*${verb}[。.!！]?$`, 'iu').test(text.trim())
}

export class MemoryService {
  private readonly contexts: ExecutionContexts
  constructor(options: MemoryOptions) { this.contexts = options.contexts }

  /** Never trust source='user' or approved=true supplied in a model tool call. */
  remember(text: string, options: RememberOptions = {}): MemoryResult { return this.create(text, options, false) }
  propose(text: string, options: RememberOptions = {}): MemoryResult { return this.create(text, options, true) }
  read(id: string): ReturnType<typeof readMemory> { return readMemory(id) }
  search(query: string, options: MemorySearchOptions = {}): ReturnType<typeof searchMemory> { return searchMemory(query, options) }
  retrieve(query: string, options: MemoryContextOptions = {}): ReturnType<typeof readMemoryContext> { return readMemoryContext(query, options) }
  status(maxEntries = 100): ReturnType<typeof readMemoryStatus> { return readMemoryStatus(maxEntries) }
  correct(id: string, text: string, options: RememberOptions = {}): MemoryResult { return this.create(text, options, false, id) }
  withdraw(id: string, options: RememberOptions = {}): MemoryResult {
    const identity = { ...(options.identity ?? this.contexts.current() ?? {}) }, user = this.latestUser(identity)?.user
    const pending = readSnapshot(pendingSpec()), memos = readSnapshot(memoSpec()), memo = memos.value.find(row => row.id === id)
    if (!memo) throw new Error(`没有记忆 ${id}。`)
    const proposalId = `memo:withdraw-${digest(canonical([identity.sessionId, identity.originMessageId ?? identity.callId ?? randomUUID(), id])).slice(0, 24)}`
    const existing = pending.value.find(row => row.id === proposalId)
    if (existing && isProposal(existing)) {
      if (existing.status === 'approved' && memo.status === 'retracted') return { memo, proposal: existing, wroteProfile: false, duplicate: true }
      return { memo, proposal: existing, wroteProfile: false, duplicate: true }
    }
    if (memo.status !== 'confirmed') throw new Error('只有已确认且有效的记忆可以撤回。')
    const proposal: MemoryProposal = { id: proposalId, kind: 'memory', memoId: id, action: 'withdraw', factDigest: digest(memo.text), targetMemoId: id,
      targetDigest: targetDigest(memo), title: `撤回：${memo.text}`, reason: '撤回后不再用于回答，保留原文与来源供核对。', status: 'pending',
      createdAt: new Date().toISOString(), identity, ...(identity.taskId ? { taskId: identity.taskId } : {}), question: questionFor(proposalId, memo.text, 'withdraw', memo) }
    proposal.payloadDigest = payloadDigest(proposal, memo)
    const result = commitFiles({ kind: 'memory.withdraw.propose', targetId: id, operationId: `memory.propose:${proposalId}`,
      writes: [{ ...pendingSpec(), content: json([...pending.value, proposal]), expectedBefore: pending.expectedBefore }],
      result: { memo, proposal, wroteProfile: false, duplicate: false } })
    return user && plainMutation(user.text, 'withdraw', id, memo.text) ? this.decide(proposalId, 'approved', {}, identity) : result
  }

  private latestUser(identity: ExecutionIdentity | undefined): (UserInputView & { user: OriginUser }) | undefined {
    if (!identity?.sessionId || !identity.originMessageId) return undefined
    const rootId = identity.rootSessionId ?? identity.sessionId
    const view = this.contexts.readUserInputView(identity)
    if (!view || view.root.originMessageId !== identity.originMessageId || view.caller.originMessageId !== identity.originMessageId
      || (identity.taskId !== undefined && view.caller.taskId !== identity.taskId)) return undefined
    const user = view.user
    return user?.sessionId === rootId && user.messageId === identity.originMessageId ? { ...view, user: { ...user } } : undefined
  }

  private create(suppliedText: string, options: RememberOptions, forceProposal: boolean, targetId?: string): MemoryResult {
    const text = suppliedText.trim()
    if (text.length < 2) throw new Error('要记住的内容太短。')
    const identity = { ...(options.identity ?? this.contexts.current() ?? {}) }
    const user = this.latestUser(identity)?.user, evidence = options.userEvidence
    const memos = readSnapshot(memoSpec()), pending = readSnapshot(pendingSpec())
    let target = targetId === undefined ? undefined : memos.value.find(row => row.id === targetId)
    if (targetId && !target) throw new Error(`没有记忆 ${targetId}。`)
    const location = target ? { scope: target.scope ?? 'profile', ...(target.topic ? { topic: target.topic } : {}), key: knownSlot(text) ?? memoKey(target) } : placement(text, options, memos.value)
    if (!target) target = memos.value.find(row => row.status === 'confirmed' && memoKey(row) === location.key && (row.scope ?? 'profile') === location.scope && row.topic === location.topic && row.text !== text)
    const action = target ? 'correct' : 'remember'
    const confirmed = !target && !forceProposal && user?.text === text && (evidence === undefined || (evidence.messageId === user.messageId && evidence.text === user.text))
    const key = identity.sessionId && identity.originMessageId ? [identity.sessionId, identity.rootSessionId, identity.originMessageId, text, action, target?.id, location]
      : identity.sessionId && identity.callId ? [identity.sessionId, identity.callId, text, action, target?.id, location] : [randomUUID(), text, action, target?.id, location]
    const id = `memo-${digest(JSON.stringify(key)).slice(0, 24)}`, proposalId = `memo:${id}`
    const existing = memos.value.find(row => row.id === id)
    if (existing) {
      if (existing.text !== text) throw new Error('记忆内容已手改，拒绝覆盖。')
      const proposal = pending.value.find(row => row.id === proposalId)
      return { memo: existing, ...(proposal && isProposal(proposal) ? { proposal } : {}), wroteProfile: false, duplicate: true }
    }
    if (target && target.status !== 'confirmed') throw new Error('更正目标已变化或撤回；请读取当前有效记忆。')
    if (!target && !forceProposal) {
      const same = memos.value.find(row => row.text === text && memoKey(row) === location.key && row.topic === location.topic && row.status !== 'retracted')
      if (same) {
        const proposal = pending.value.find((row): row is MemoryProposal => isProposal(row) && row.memoId === same.id)
        return { memo: same, ...(proposal ? { proposal } : {}), wroteProfile: false, duplicate: true }
      }
    }
    const now = new Date().toISOString()
    let origin: MemoryOrigin | undefined
    if (confirmed && user) {
      origin = { source: 'user', sessionId: user.sessionId, messageId: user.messageId, rootSessionId: identity.rootSessionId ?? user.sessionId,
        ...(identity.sessionId !== user.sessionId ? { executionSessionId: identity.sessionId } : {}), ...(user.rpcId === undefined ? {} : { rpcId: user.rpcId }) }
      for (const field of ['runId', 'taskId', 'callId', 'turn', 'step'] as const) {
        if (identity[field] !== undefined) Object.assign(origin, { [field]: identity[field] })
      }
    }
    let memo: MemoryMemo = { id, text, source: confirmed ? 'user' : 'butler', createdAt: now, status: confirmed ? 'confirmed' : 'proposed',
      ...location, ...(origin === undefined ? {} : { origin }), ...(target ? { supersedes: target.id } : {}) }
    if (confirmed) assertSlotAvailable(memo, memos.value)
    const proposal: MemoryProposal | undefined = confirmed ? undefined : { id: proposalId, kind: 'memory', memoId: id, factDigest: digest(text),
      action, ...(target ? { targetMemoId: target.id, targetDigest: targetDigest(target) } : {}),
      title: `${target ? '更正' : '记住'}：${text}`, reason: '这条记忆需要用户确认后才应用到档案或主题正文。', status: 'pending', createdAt: now,
      ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }), identity, question: questionFor(proposalId, text, action, target) }
    if (proposal) proposal.payloadDigest = payloadDigest(proposal, memo)
    const projection = confirmed ? projectionChanges(memo) : { writes: [] }
    if ('memo' in projection && projection.memo) memo = projection.memo
    const result: MemoryResult = { memo, ...(proposal === undefined ? {} : { proposal }), wroteProfile: confirmed && memo.scope !== 'topic', duplicate: false }
    const writes: FileWrite[] = [{ ...memoSpec(), content: json([...memos.value, memo]), expectedBefore: memos.expectedBefore }]
    if (proposal) writes.push({ ...pendingSpec(), content: json([...pending.value, proposal]), expectedBefore: pending.expectedBefore })
    else writes.push(...projection.writes)
    const saved = commitFiles({ kind: 'memory.remember', targetId: id, operationId: `memory.remember:${id}`, writes, result })
    return target && !forceProposal && user && plainMutation(user.text, 'correct', target.id, text) ? this.decide(proposalId, 'approved', {}, identity) : saved
  }

  /** The proof argument cannot contain a decision; native user input is independently resolved. */
  decide(id: string, decision: MemoryDecision, proof: MemoryProof = {}, suppliedIdentity?: ExecutionIdentity): MemoryDecisionResult {
    if (!['approved', 'declined'].includes(decision)) throw new Error('无效的记忆决定。')
    const supplied = suppliedIdentity ?? this.contexts.current(), identity = supplied === undefined ? undefined : { ...supplied }
    const proofKind = proof.kind
    if (proofKind !== undefined && proofKind !== 'user-input') throw new Error('缺少可核验的原生用户确认凭据。')
    const pending = readSnapshot(pendingSpec()), memos = readSnapshot(memoSpec())
    const input = this.latestUser(identity), user = input?.user
    if (!input || !user) throw new Error('缺少可核验的原生用户确认凭据。')
    const original = pending.value.find(row => row.id === id)
    let item = original && isProposal(original) ? original : undefined
    if (!item && original && !('kind' in original) && original.status !== 'declined' && id.startsWith('memo:')) {
      const legacyMemo = memos.value.find(row => row.id === id.slice('memo:'.length))
      // A fresh native confirmation can repair the old pending-only approval bug.
      // The legacy title is the only original fact binding; a changed fact fails closed.
      if (legacyMemo?.status === 'proposed' && original.title === `记住：${legacyMemo.text}`) item = { ...original, kind: 'memory', memoId: legacyMemo.id,
        factDigest: digest(legacyMemo.text), status: 'pending', identity: { ...identity }, question: questionFor(id, legacyMemo.text) }
    }
    if (!item) throw new Error(`没有可核验的记忆提案 ${id}。`)
    const memo = memos.value.find(row => row.id === item.memoId)
    if (!memo || digest(memo.text) !== item.factDigest) throw new Error('提案的记忆内容已变化；需要重新确认。')
    const proposalRoot = item.identity.rootSessionId ?? item.identity.sessionId
    const latest = input.caller
    if (proposalRoot !== user.sessionId || item.identity.sessionId !== identity!.sessionId
      || (latest.taskId !== undefined && item.taskId !== latest.taskId)) throw new Error('用户确认与提案的会话或任务不匹配。')
    const action = item.action ?? 'remember'
    const explicitMutation = decision === 'approved' && action !== 'remember' && item.targetMemoId && plainMutation(user.text, action, item.targetMemoId, memo.text)
    if (!plainConfirmation(user.text, id, decision) && !(action === 'remember' && plainConfirmation(user.text, memo.text, decision)) && !explicitMutation) throw new Error('用户原话没有明确确认或拒绝这条提案。')
    return this.commitDecision(item, memo, decision, { source: 'user-input', sessionId: user.sessionId, messageId: user.messageId,
      decidedAt: new Date().toISOString(), decision, factDigest: item.factDigest, ...(identity!.callId ? { callId: identity!.callId } : {}) }, pending, memos)
  }

  /** Call only from the native final tools/result observer, never a model-facing tool argument. */
  observeToolResult(exec: ContextExecution, result: unknown, suppliedIdentity?: ExecutionIdentity): MemoryDecisionResult[] {
    if (exec.name !== 'ask_user_question' || !record(result) || result['isError'] === true || result['ok'] === false) return []
    const value = result['value']
    if (!record(value) || value['ok'] === false || !Array.isArray(value['answers']) || !record(exec['arguments']) || !Array.isArray(exec['arguments']['questions'])) return []
    const [, call] = this.contexts.capture(exec), identity = call.identity
    if (suppliedIdentity && !sameIdentity(suppliedIdentity, identity)) return []
    const user = this.latestUser(identity)?.user, key = executionKey(identity)
    if (!user || !key || !identity.callId) return []
    const questions = exec['arguments']['questions'] as unknown[], answers = value['answers'] as unknown[]
    const output: MemoryDecisionResult[] = []
    for (const answer of answers) {
      if (!record(answer) || !Array.isArray(answer['selected']) || answer['selected'].length !== 1
        || (answer['custom'] !== undefined && answer['custom'] !== '')) continue
      const label = answer['selected'][0], decision = ['确认记住', '确认更正', '确认撤回'].includes(String(label)) ? 'approved' : label === '拒绝' ? 'declined' : undefined
      if (!decision || !nonempty(answer['id']) || answers.filter(row => record(row) && row['id'] === answer['id']).length !== 1) continue
      const pending = readSnapshot(pendingSpec()), memos = readSnapshot(memoSpec())
      const proposal = pending.value.find((row): row is MemoryProposal => isProposal(row) && row.question.id === answer['id'])
      if (!proposal || !sameIdentity(proposal.identity, identity)) continue
      if (decision === 'approved' && label !== proposal.question.options[0]?.label) continue
      const matching = questions.filter(row => record(row) && row['id'] === answer['id'])
      if (matching.length !== 1 || canonical(matching[0]) !== canonical(proposal.question)) continue
      const memo = memos.value.find(row => row.id === proposal.memoId)
      if (!memo || digest(memo.text) !== proposal.factDigest) continue
      const argumentsDigest = digest(canonical(exec['arguments']))
      if (proposal.decision && (proposal.decision.decision !== decision || proposal.decision.source !== 'native-question'
        || proposal.decision.executionKey !== key || proposal.decision.argumentsDigest !== argumentsDigest)) continue
      output.push(this.commitDecision(proposal, memo, decision, { source: 'native-question', sessionId: user.sessionId, messageId: user.messageId,
        decidedAt: new Date().toISOString(), decision, factDigest: proposal.factDigest, callId: identity.callId, executionKey: key,
        argumentsDigest, questionId: proposal.question.id }, pending, memos))
    }
    return output
  }

  private commitDecision(proposal: MemoryProposal, memo: MemoryMemo, decision: MemoryDecision, proof: MemoryDecisionRecord,
    pending: ReturnType<typeof readSnapshot<PendingItem[]>>, memos: ReturnType<typeof readSnapshot<MemoryMemo[]>>): MemoryDecisionResult {
    const action = proposal.action ?? 'remember'
    if (proposal.payloadDigest && proposal.payloadDigest !== payloadDigest(proposal, memo)) throw new Error('提案的记忆内容或维护参数已变化；需要重新确认。')
    const expectedStatus = decision === 'approved' ? action === 'withdraw' ? 'retracted' : 'confirmed' : action === 'withdraw' ? memo.status : 'rejected'
    if (proposal.status !== 'pending') {
      const superseded = decision === 'approved' && action !== 'withdraw' && memo.status === 'retracted' && memo.retraction !== undefined
      if (proposal.status !== decision || (memo.status !== expectedStatus && !superseded) || !proposal.decision) throw new Error('提案已经决定或记录不一致；拒绝修改原决定。')
      return { memo, proposal, wroteProfile: false, duplicate: true }
    }
    const decliningRetiredWithdrawal = action === 'withdraw' && decision === 'declined' && memo.status === 'retracted'
    if (memo.status !== (action === 'withdraw' ? 'confirmed' : 'proposed') && !decliningRetiredWithdrawal) throw new Error('记忆状态已经变化，需要重新确认。')
    const target = proposal.targetMemoId ? memos.value.find(row => row.id === proposal.targetMemoId) : undefined
    if (decision === 'approved' && action !== 'remember' && (!target || target.status !== 'confirmed' || targetDigest(target) !== proposal.targetDigest)) throw new Error('更正或撤回的目标记忆已变化，需要重新确认。')
    if (decision === 'approved' && action !== 'withdraw') assertSlotAvailable(memo, memos.value, action === 'correct' ? target?.id : undefined)
    let updatedMemo: MemoryMemo = { ...memo, status: expectedStatus, updatedAt: proof.decidedAt,
      ...(decision === 'approved' ? action === 'withdraw' ? { retraction: proof } : { confirmation: proof } : {}) }
    let retired: MemoryMemo | undefined
    let projection: ReturnType<typeof projectionChanges> = { writes: [] }
    if (decision === 'approved') {
      projection = projectionChanges(action === 'withdraw' ? undefined : updatedMemo, action === 'remember' ? undefined : target)
      if (projection.memo) updatedMemo = projection.memo
      if (action === 'correct') retired = { ...target!, status: 'retracted', supersededBy: memo.id, retraction: proof, updatedAt: proof.decidedAt }
    }
    const updatedProposal: MemoryProposal = { ...proposal, status: decision, decision: proof }
    const writes: FileWrite[] = [
      { ...memoSpec(), content: json(memos.value.map(row => row.id === memo.id ? updatedMemo : retired && row.id === retired.id ? retired : row)), expectedBefore: memos.expectedBefore },
      { ...pendingSpec(), content: json(pending.value.map(row => row.id === proposal.id ? updatedProposal : row)), expectedBefore: pending.expectedBefore },
    ]
    writes.push(...projection.writes)
    const result: MemoryDecisionResult = { memo: updatedMemo, proposal: updatedProposal, wroteProfile: decision === 'approved' && memo.scope !== 'topic', duplicate: false }
    return commitFiles({ kind: 'memory.decide', targetId: proposal.id, operationId: `memory.decide:${proposal.id}`, writes, result })
  }
}
