/** Complete, hash-checked note revisions for the existing single-process store. */
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { GuardRefusal, limitationsSection } from './guard.ts'
import { commitFiles, readCommittedOperation, recoverOperations, StorageError, type FileWrite, type OperationMetadata } from './store.ts'
import { ensureVault, sha256, statePath, STATE_HOME, vaultPath, VAULT_HOME } from './vault.ts'

export const NOTE_MAX_BYTES = 256 * 1024
const INDEX_MAX_BYTES = 1024 * 1024
const MAX_REVISIONS = 1024
const MAX_CONFLICTS = 256
const MAX_HISTORY_BYTES = 64 * 1024 * 1024
const hashText = (text: string): string => sha256(Buffer.from(text, 'utf8'))
const refusal = (code: string, message: string): never => { throw new GuardRefusal(`note.${code}`, message) }

interface Snapshot { text: string; hash: string | null }
interface Revision {
  rev: number
  sha256: string
  bytes: number
  time: string
  kind: 'write' | 'append' | 'restore' | 'import' | 'manual'
  restoredFrom?: number
}
interface Difference { added: string[]; removed: string[]; addedCount: number; removedCount: number; truncated: boolean }
interface Conflict {
  id: string
  time: string
  baseRevision: number | null
  currentSha256: string | null
  proposedSha256: string
  diff: Difference
}
interface Index { version: 1; slug: string; headRevision: number; revisions: Revision[]; conflicts: Conflict[] }
interface NoteInput extends OperationMetadata {
  slug: string
  title?: string
  markdown?: string
  sources?: string[]
  limitations?: string[]
  expectedSha256?: string
}
export type NoteWriteResult = { ok: true; slug: string; path: string; rev: number; sha256: string; revisionPath: string; preservedManualRevision?: number; preservedManualSha256?: string }
  | { ok: false; code: string; conflict: true; conflictId: string; path: string; slug: string; currentPath: string; proposedPath: string; diff: Difference; message: string }
type NoteAction = 'write' | 'append' | 'restore'
interface NoteOperationResult { version: 1; requestKind: NoteAction; requestSha256: string; result: NoteWriteResult }

function safeSlug(slug: string): string {
  if (Buffer.byteLength(slug, 'utf8') > 240) return refusal('slug', '笔记 slug 超过 240 UTF-8 字节。')
  const value = slug.replace(/[\x00-\x1f\\/:*?"<>|]+/g, '-').trim().replace(/[. ]+$/, '')
  if (!value || value === '.' || value === '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return refusal('slug', '需要有效的笔记文件名。')
  return value
}
const notePath = (slug: string): string => vaultPath('notes', `${slug}.md`)
const revisionRoot = (slug: string): string => statePath('note-revisions', hashText(slug))
const indexPath = (slug: string): string => resolve(revisionRoot(slug), 'index.json')
const revisionPath = (slug: string, rev: number): string => resolve(revisionRoot(slug), `rev-${rev}.md`)
const conflictPath = (slug: string, id: string, side: 'current' | 'proposed'): string => resolve(revisionRoot(slug), `conflict-${id}.${side}.md`)

/** Fixed paths only; also reject a note/history junction that escapes its root. */
function checkPath(path: string): void {
  const roots = [resolve(VAULT_HOME), resolve(STATE_HOME)]
  let ancestor = resolve(path)
  while (!roots.includes(ancestor)) {
    let exists = false
    try {
      const stat = lstatSync(ancestor)
      exists = true
      if (stat.isSymbolicLink()) return refusal('path', '笔记或历史路径含符号链接/junction；保留现有文件，拒绝访问。')
      // Windows junction 的 lstat 不是符号链接，只有 realpathSync.native 会解析它。
      // 普通路径满足 native(ancestor) === native(parent)/basename，跳到别处即拒绝。
      const physical = realpathSync.native(ancestor)
      if (physical.toLowerCase() !== join(realpathSync.native(dirname(ancestor)), basename(ancestor)).toLowerCase()) {
        return refusal('path', '笔记或历史路径含符号链接/junction；保留现有文件，拒绝访问。')
      }
    } catch (error) {
      if (error instanceof GuardRefusal) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      // 已存在却无法解析（悬空 junction）必须 fail closed，不能当作缺失路径继续向上找。
      if (exists) return refusal('path', '笔记或历史路径含悬空符号链接/junction；保留现有文件，拒绝访问。')
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return refusal('path', '笔记路径超出配置的 vault/state 根目录。')
    ancestor = parent
  }
}

/** Read at most limit+1 bytes from one descriptor, including files changed during reading. */
function snapshot(path: string, limit: number): Snapshot {
  checkPath(path)
  let fd: number
  try { fd = openSync(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', hash: null }
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) return refusal('too_large', `${path} 不是普通文件或超过 ${limit} 字节上限；拒绝覆盖。`)
    const buffer = Buffer.alloc(limit + 1)
    let length = 0, count = 0
    do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count } while (count > 0 && length < buffer.length)
    if (length > limit) return refusal('too_large', `${path} 超过 ${limit} 字节上限；拒绝覆盖。`)
    const bytes = buffer.subarray(0, length)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return refusal('utf8', `${path} 不是有效 UTF-8；保留原始字节，拒绝覆盖。`) }
    return { text, hash: sha256(bytes) }
  } finally { closeSync(fd) }
}

const frontmatter = (text: string): RegExpExecArray | null => /^\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
const field = (text: string, name: string): string | undefined => new RegExp(`^${name}:\\s*([^\\r\\n]*)$`, 'm').exec(frontmatter(text)?.[1] ?? '')?.[1]?.trim()
export function noteRev(text: string): number {
  const value = field(text, 'rev')
  if (value === undefined) return 0
  const rev = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(rev) || rev < 0) return refusal('revision', '笔记 rev 无效；保留原件，拒绝覆盖。')
  return rev
}
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function loadIndex(slug: string): { index: Index | undefined; hash: string | null } {
  const current = snapshot(indexPath(slug), INDEX_MAX_BYTES)
  if (current.hash === null) return { index: undefined, hash: null }
  let value: unknown
  try { value = JSON.parse(current.text) } catch { return refusal('history_corrupt', '笔记历史索引 JSON 损坏；拒绝写入。') }
  if (!object(value) || value.version !== 1 || value.slug !== slug || !Number.isSafeInteger(value.headRevision)
    || !Array.isArray(value.revisions) || value.revisions.length === 0 || value.revisions.length > MAX_REVISIONS
    || !Array.isArray(value.conflicts) || value.conflicts.length > MAX_CONFLICTS) return refusal('history_corrupt', '笔记历史索引结构损坏或超限；拒绝写入。')
  const revisions = new Set<number>()
  let bytes = 0
  for (const row of value.revisions) {
    if (!object(row) || !Number.isSafeInteger(row.rev) || (row.rev as number) < 0 || revisions.has(row.rev as number)
      || !isHash(row.sha256) || !Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0 || (row.bytes as number) > NOTE_MAX_BYTES
      || typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time)) || !['write', 'append', 'restore', 'import', 'manual'].includes(String(row.kind))
      || (row.restoredFrom !== undefined && (!Number.isSafeInteger(row.restoredFrom) || (row.restoredFrom as number) < 0))) return refusal('history_corrupt', '笔记 revision 记录损坏；拒绝写入。')
    revisions.add(row.rev as number); bytes += row.bytes as number
  }
  if (!revisions.has(value.headRevision as number) || Math.max(...revisions) !== value.headRevision || bytes > MAX_HISTORY_BYTES) return refusal('history_corrupt', '笔记历史 head 或容量无效；拒绝写入。')
  const conflicts = new Set<string>()
  for (const row of value.conflicts) {
    if (!object(row) || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id) || conflicts.has(row.id)
      || typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time)) || !isHash(row.proposedSha256)
      || (row.currentSha256 !== null && !isHash(row.currentSha256)) || !object(row.diff) || !Array.isArray(row.diff.added) || !Array.isArray(row.diff.removed)) return refusal('history_corrupt', '笔记冲突记录损坏；拒绝写入。')
    conflicts.add(row.id)
  }
  return { index: value as unknown as Index, hash: current.hash }
}

function checkedRevision(slug: string, revision: Revision): Snapshot {
  const current = snapshot(revisionPath(slug, revision.rev), NOTE_MAX_BYTES)
  if (current.hash !== revision.sha256 || Buffer.byteLength(current.text, 'utf8') !== revision.bytes) return refusal('history_corrupt', `笔记 rev ${revision.rev} 的完整备份缺失或 SHA256 不符；拒绝写入/恢复。`)
  return current
}

function validateInput(input: NoteInput, kind: NoteAction): void {
  if (kind !== 'restore' && !input.markdown?.trim()) return refusal('empty', '笔记正文不能为空。')
  if (input.markdown !== undefined) validateText(input.markdown)
  for (const lines of [input.sources ?? [], input.limitations ?? []]) {
    if (lines.length > 100 || lines.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0) > NOTE_MAX_BYTES) return refusal('too_large', '笔记来源或限制超过行数/字节上限。')
  }
  if (input.expectedSha256 !== undefined && !isHash(input.expectedSha256)) return refusal('hash', 'expectedSha256 必须是完整的 SHA256。')
  if (input.operationId !== undefined && (!input.operationId.trim() || Buffer.byteLength(input.operationId) > 4096)) return refusal('operation_id', 'operationId 为空或超过4096字节。')
}

/** Hash the caller's request, not values derived from today's note or clock. */
function requestDigest(input: NoteInput, kind: NoteAction, revision?: number): string {
  return hashText(JSON.stringify([1, kind, input.slug, input.title ?? null, input.markdown ?? null, input.sources ?? [],
    input.limitations ?? [], input.expectedSha256 ?? null, input.time ?? null, revision ?? null]))
}

/** Recover and resolve the original local result before any stale-SHA/state branches. */
function replayResult(input: NoteInput, kind: NoteAction, slug: string, requestSha256: string): NoteWriteResult | undefined {
  if (input.operationId === undefined) return undefined
  // The core summary lookup verifies content identity, fences durability and
  // recovers pending local writes without materializing historical snapshots.
  const previous = readCommittedOperation(input.operationId)
  if (!object(previous)) return undefined
  if (previous.targetId !== slug || (previous.kind !== `note.${kind}` && previous.kind !== 'note.conflict')) return refusal('operation_conflict', 'operationId 已用于其他笔记目标或动作；拒绝重复请求。')
  const saved = previous.result
  if (!object(saved) || saved.version !== 1 || !isHash(saved.requestSha256) || !object(saved.result)) return refusal('operation_unverified', '已有 operationId 缺少可核验的原请求指纹；不能猜测重放或覆盖。')
  if (saved.requestKind !== kind || saved.requestSha256 !== requestSha256) return refusal('operation_conflict', '相同 operationId 的请求 payload 已改变；保留原结果，拒绝重复写入。')
  const result = saved.result, index = loadIndex(slug).index
  if (!index || result.slug !== slug || result.path !== notePath(slug)) return refusal('history_corrupt', '已提交笔记结果或历史索引不匹配；拒绝重放。')
  for (const entry of index.revisions) checkedRevision(slug, entry)
  // A later human edit may remain current; it is never replaced by a replay.
  // Invalid or oversized current bytes still retain the ordinary read fence.
  snapshot(notePath(slug), NOTE_MAX_BYTES)
  if (result.ok === true) {
    const entry = index.revisions.find(row => row.rev === result.rev)
    if (previous.kind !== `note.${kind}` || !entry || result.sha256 !== entry.sha256 || result.revisionPath !== revisionPath(slug, entry.rev)) return refusal('history_corrupt', '已提交 revision 与原结果 SHA256 不匹配；拒绝重放。')
    if (result.preservedManualRevision !== undefined) {
      const manual = index.revisions.find(row => row.rev === result.preservedManualRevision)
      if (!manual || manual.kind !== 'manual' || result.preservedManualSha256 !== manual.sha256) return refusal('history_corrupt', '已提交手改预像与原结果不匹配；拒绝重放。')
    }
  } else {
    const conflict = index.conflicts.find(row => row.id === result.conflictId)
    if (previous.kind !== 'note.conflict' || result.ok !== false || result.code !== 'note.conflict' || result.conflict !== true || !conflict
      || result.currentPath !== conflictPath(slug, conflict.id, 'current') || result.proposedPath !== conflictPath(slug, conflict.id, 'proposed')
      || JSON.stringify(result.diff) !== JSON.stringify(conflict.diff)) return refusal('history_corrupt', '已提交冲突结果与历史不匹配；拒绝重放。')
    const current = snapshot(result.currentPath as string, NOTE_MAX_BYTES), proposed = snapshot(result.proposedPath as string, NOTE_MAX_BYTES)
    if ((conflict.currentSha256 === null ? current.text !== '' : current.hash !== conflict.currentSha256) || proposed.hash !== conflict.proposedSha256) return refusal('history_corrupt', '冲突完整副本缺失或 SHA256 不匹配；拒绝重放。')
  }
  return structuredClone(result) as unknown as NoteWriteResult
}

function validateText(text: string): string {
  if (Buffer.byteLength(text, 'utf8') > NOTE_MAX_BYTES) return refusal('too_large', `笔记最多 ${NOTE_MAX_BYTES} UTF-8 字节；未写入。`)
  return text
}

function render(input: NoteInput, previous: string, rev: number, time: string): string {
  const title = (input.title ?? field(previous, 'title') ?? input.slug).replace(/[\r\n]+/g, ' ').slice(0, 500)
  const header = `---\ntitle: ${title}\nslug: ${input.slug}\nrev: ${rev}\ncreated: ${field(previous, 'created') ?? time}\nupdated: ${time}\n---\n`
  const sources = input.sources ?? [], limitations = input.limitations ?? []
  if (sources.length > 100 || limitations.length > 100) return refusal('too_large', '来源和限制各最多 100 行。')
  const sourceBlock = sources.length ? `## 来源\n\n${sources.map(line => `- ${line}`).join('\n')}\n` : '## 来源\n\n- 本次没有可列出的来源。\n'
  const addition = `${input.markdown?.trim() ?? ''}\n\n${sourceBlock}\n${limitationsSection(limitations)}`
  return validateText(`${header}${addition}`)
}

function restored(slug: string, original: string, rev: number, time: string): string {
  const header = frontmatter(original)
  if (!header) return validateText(`---\ntitle: ${slug}\nslug: ${slug}\nrev: ${rev}\ncreated: ${time}\nupdated: ${time}\n---\n${original}`)
  let metadata = header[1]
  for (const [name, value] of [['rev', String(rev)], ['updated', time]]) {
    const pattern = new RegExp(`^${name}:[^\\r\\n]*`, 'm')
    metadata = pattern.test(metadata) ? metadata.replace(pattern, `${name}: ${value}`) : `${metadata}\n${name}: ${value}`
  }
  return validateText(`---\n${metadata}\n---\n${original.slice(header[0].length)}`)
}

/** Bounded line comparison, retaining full copies separately. */
function difference(current: string, proposed: string): Difference {
  const lines = (text: string) => {
    const head = frontmatter(text)
    // Generated rev/time changes should not hide the actual edited lines.
    return head ? [...head[1].split(/\r?\n/).filter(line => !/^(?:rev|updated):/.test(line)), ...text.slice(head[0].length).split(/\r?\n/)] : text.split(/\r?\n/)
  }
  const left = lines(current), right = lines(proposed)
  let start = 0, endLeft = left.length, endRight = right.length
  while (start < endLeft && start < endRight && left[start] === right[start]) start += 1
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft -= 1; endRight -= 1 }
  const removed = left.slice(start, endLeft), added = right.slice(start, endRight)
  return { added: added.slice(0, 12).map(line => line.slice(0, 300)), removed: removed.slice(0, 12).map(line => line.slice(0, 300)),
    addedCount: added.length, removedCount: removed.length, truncated: added.length > 12 || removed.length > 12 || [...added.slice(0, 12), ...removed.slice(0, 12)].some(line => line.length > 300) }
}

/** Read current text or an immutable, hash-checked historical copy. */
export function readNote(rawSlug: string, revision?: number) {
  ensureVault(); recoverOperations()
  const slug = safeSlug(rawSlug), currentPath = notePath(slug)
  if (revision === undefined) {
    const current = snapshot(currentPath, NOTE_MAX_BYTES)
    if (current.hash === null) return refusal('not_found', `没有 notes/${slug}.md。`)
    return { ok: true as const, slug, path: currentPath, rev: noteRev(current.text), body: current.text, sha256: current.hash }
  }
  if (!Number.isSafeInteger(revision) || revision < 0) return refusal('revision', 'revision 必须是非负整数。')
  const entry = loadIndex(slug).index?.revisions.find(row => row.rev === revision)
  if (!entry) return refusal('revision_not_found', `没有笔记 rev ${revision}。`)
  const stored = checkedRevision(slug, entry)
  return { ok: true as const, slug, path: revisionPath(slug, revision), currentPath, rev: revision, body: stored.text, sha256: stored.hash }
}

/** History pagination never reads every historical body into memory. */
export function noteHistory(rawSlug: string, limit = 30, beforeRevision?: number) {
  ensureVault(); recoverOperations()
  const slug = safeSlug(rawSlug), index = loadIndex(slug).index
  const count = Math.max(1, Math.min(100, Math.floor(limit)))
  const selected = (index?.revisions ?? []).filter(row => beforeRevision === undefined || row.rev < beforeRevision).sort((a, b) => b.rev - a.rev).slice(0, count)
  return { ok: true as const, slug, headRevision: index?.headRevision ?? null, totalRevisions: index?.revisions.length ?? 0,
    revisions: selected.map(row => ({ ...row, path: revisionPath(slug, row.rev) })), nextBeforeRevision: selected.length === count ? selected.at(-1)?.rev ?? null : null,
    conflicts: (index?.conflicts ?? []).slice(-count).reverse().map(row => ({ ...row, currentPath: conflictPath(slug, row.id, 'current'), proposedPath: conflictPath(slug, row.id, 'proposed') })) }
}

/** A bounded flat scan of user-visible notes; revision storage is never searched. */
export function findNotes(query: string) {
  ensureVault(); recoverOperations()
  if (Buffer.byteLength(query, 'utf8') > 2000) return refusal('too_large', '笔记查询最多 2000 UTF-8 字节。')
  const notes: Array<{ path: string; size: number; modified: string }> = [], limitations: string[] = []
  const directory = opendirSync(vaultPath('notes'))
  let inspected = 0
  try {
    for (;;) {
      if (inspected >= 200) { limitations.push('本次最多检查 200 个目录条目；请用更具体的文件名查询或分批整理。'); break }
      const entry = directory.readSync()
      if (!entry) break
      inspected += 1
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const path = vaultPath('notes', entry.name)
      try {
        const current = snapshot(path, NOTE_MAX_BYTES)
        if (current.hash === null) continue
        if (query && !entry.name.toLowerCase().includes(query.toLowerCase()) && !current.text.toLowerCase().includes(query.toLowerCase())) continue
        const stat = statSync(path)
        notes.push({ path: `notes/${entry.name}`, size: stat.size, modified: stat.mtime.toISOString() })
      } catch (error) { limitations.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  } finally { directory.closeSync() }
  return { ok: true as const, notes: notes.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 30), limitations }
}

/** New content, legacy preimage and revision index commit together before replacement. */
function updateNote(input: NoteInput, kind: NoteAction, restoreRevision: number | undefined, retried: boolean, requestSha256: string, preparedContent?: string): NoteWriteResult {
  ensureVault(); recoverOperations()
  const slug = safeSlug(input.slug), path = notePath(slug), current = snapshot(path, NOTE_MAX_BYTES)
  const loaded = loadIndex(slug), index: Index = loaded.index ?? { version: 1, slug, headRevision: noteRev(current.text), revisions: [], conflicts: [] }
  if (!loaded.index && current.hash === null && input.expectedSha256 !== undefined) return refusal('not_found', '笔记不存在，expectedSha256 无法匹配；未写入。')
  const time = input.time ?? new Date().toISOString(), writes: FileWrite[] = []
  // Every retained preimage must remain intact before another destructive edit.
  for (const entry of index.revisions) checkedRevision(slug, entry)
  if (!loaded.index && current.hash !== null) {
    index.revisions.push({ rev: index.headRevision, sha256: current.hash, bytes: Buffer.byteLength(current.text, 'utf8'), time, kind: 'import' })
    writes.push({ path: revisionPath(slug, index.headRevision), content: current.text, expectedBefore: null })
  }
  const base = index.revisions.find(row => row.rev === index.headRevision)
  const restoreEntry = kind === 'restore' ? index.revisions.find(row => row.rev === restoreRevision) : undefined
  const changed = loaded.index !== undefined && current.hash !== base?.sha256
  const acceptManual = changed && current.hash !== null && input.expectedSha256 === current.hash
  let baseText = loaded.index && base ? checkedRevision(slug, base).text : current.text
  let rev = (base ? index.headRevision : 0) + 1
  let preservedManualRevision: number | undefined
  if (acceptManual) {
    // An explicit SHA confirms this exact human-edited preimage, not a future
    // edit. Preserve its original bytes separately before the requested write.
    preservedManualRevision = rev
    index.revisions.push({ rev, sha256: current.hash as string, bytes: Buffer.byteLength(current.text), time, kind: 'manual' })
    writes.push({ path: revisionPath(slug, rev), content: current.text, expectedBefore: null })
    baseText = current.text
    rev += 1
  }
  if (!Number.isSafeInteger(rev)) return refusal('revision', 'revision 已超出安全整数上限。')
  let content: string
  if (preparedContent !== undefined) content = preparedContent
  else if (kind === 'restore') {
    if (!restoreEntry) return refusal('revision_not_found', `没有笔记 rev ${String(restoreRevision)}。`)
    content = restored(slug, checkedRevision(slug, restoreEntry).text, rev, time)
  } else {
    content = render({ ...input, slug }, baseText, rev, time)
    if (kind === 'append' && baseText) {
      const oldBody = baseText.slice(frontmatter(baseText)?.[0].length ?? 0).trimEnd(), head = frontmatter(content)
      content = validateText(`${head?.[0] ?? ''}${oldBody}\n\n---\n\n## 补充（rev ${rev}）\n\n${content.slice(head?.[0].length ?? 0)}`)
    }
  }
  if ((changed && !acceptManual) || (input.expectedSha256 !== undefined && input.expectedSha256 !== current.hash)) {
    if (index.conflicts.length >= MAX_CONFLICTS) return refusal('history_full', '笔记冲突记录已达上限；保留当前内容，需先人工归档。')
    const id = randomUUID(), diff = difference(current.text, content), currentPath = conflictPath(slug, id, 'current'), proposedPath = conflictPath(slug, id, 'proposed')
    index.conflicts.push({ id, time, baseRevision: base?.rev ?? null, currentSha256: current.hash, proposedSha256: hashText(content), diff })
    const result = { ok: false as const, code: 'note.conflict', conflict: true as const, conflictId: id, path, slug, currentPath, proposedPath, diff,
      message: '笔记已被手改或调用方持有旧 SHA256；当前正文未覆盖。双方完整内容和行差异已保存，请核对冲突副本后再合并。' }
    const indexContent = `${JSON.stringify(index, null, 2)}\n`
    if (Buffer.byteLength(indexContent) > INDEX_MAX_BYTES) return refusal('history_full', '笔记历史索引已达容量上限；未覆盖正文。')
    return commitFiles<NoteOperationResult>({ operationId: input.operationId, time, kind: 'note.conflict', targetId: slug,
      result: { version: 1, requestKind: kind, requestSha256, result },
      writes: [...writes, { path: currentPath, content: current.text, expectedBefore: null }, { path: proposedPath, content, expectedBefore: null },
        { path: indexPath(slug), content: indexContent, format: 'json', expectedBefore: loaded.hash }] }).result
  }
  if (index.revisions.length >= MAX_REVISIONS || index.revisions.reduce((sum, row) => sum + row.bytes, 0) + Buffer.byteLength(content) > MAX_HISTORY_BYTES) return refusal('history_full', '笔记历史已达容量上限；保留旧版本，需先人工归档。')
  const entry: Revision = { rev, sha256: hashText(content), bytes: Buffer.byteLength(content), time, kind, ...(kind === 'restore' ? { restoredFrom: restoreRevision } : {}) }
  index.revisions.push(entry); index.headRevision = rev
  const indexContent = `${JSON.stringify(index, null, 2)}\n`
  if (Buffer.byteLength(indexContent) > INDEX_MAX_BYTES) return refusal('history_full', '笔记历史索引已达容量上限；未覆盖正文。')
  try {
    return commitFiles<NoteOperationResult>({ operationId: input.operationId, time, kind: `note.${kind}`, targetId: slug,
      writes: [...writes, { path: revisionPath(slug, rev), content, expectedBefore: null },
        { path: indexPath(slug), content: indexContent, format: 'json', expectedBefore: loaded.hash }, { path, content, expectedBefore: current.hash }],
      result: { version: 1, requestKind: kind, requestSha256, result: { ok: true as const, slug, path, rev, sha256: entry.sha256, revisionPath: revisionPath(slug, rev),
        ...(preservedManualRevision === undefined ? {} : { preservedManualRevision, preservedManualSha256: current.hash as string }) } } }).result
  } catch (error) {
    if (!retried && error instanceof StorageError && error.diagnostics.some(issue => resolve(issue.path) === resolve(path) && issue.kind === 'recovery' && /写入冲突/.test(issue.message))
      && snapshot(path, NOTE_MAX_BYTES).hash !== current.hash) {
      // Only a clean, unprepared failure can become a conflict-copy operation.
      // A prepared operation edited mid-commit stays degraded in the core store.
      recoverOperations()
      return updateNote({ ...input, expectedSha256: input.expectedSha256 ?? current.hash ?? undefined }, kind, restoreRevision, true, requestSha256, content)
    }
    throw error
  }
}

export function writeNote(input: NoteInput, kind: NoteAction, restoreRevision?: number): NoteWriteResult {
  ensureVault(); validateInput(input, kind)
  const slug = safeSlug(input.slug), requestSha256 = requestDigest(input, kind, restoreRevision)
  const replay = replayResult(input, kind, slug, requestSha256)
  return replay ?? updateNote(input, kind, restoreRevision, false, requestSha256)
}
