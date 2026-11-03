/**
 * Recoverable local state with one exclusive synchronous journal writer/recovery.
 * Prepared operations contain local file bytes only. Recovery never calls a
 * tool, a model, a scheduler, or any other external action.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { sha256, statePath, STATE_HOME, VAULT_HOME, writeBytes, writeText } from './vault.ts'
import { StorageBusyError, withJournalLock } from './store-lock.ts'
export { StorageBusyError } from './store-lock.ts'

export interface OperationMetadata {
  operationId?: string
  time?: string
}

export interface StorageDiagnostic {
  path: string
  kind: 'read' | 'json' | 'schema' | 'journal' | 'recovery' | 'backup' | 'write'
  message: string
  line?: number
  /** Semantic journal failures identify the exact observed bytes and operation. */
  code?: 'invalid-operation' | 'duplicate-operation' | 'invalid-writes' | 'empty-writes' | 'invalid-write' | 'invalid-commit' | 'torn-tail'
  operationId?: string
  firstLine?: number
  journalSha256?: string
  snapshotPath?: string
  captureError?: string
  /** Append-only receipt/usage damage is visible, but does not fence state writes. */
  blocking: boolean
}

const problems = new Map<string, StorageDiagnostic[]>()

export class StorageError extends Error {
  readonly diagnostics: StorageDiagnostic[]
  constructor(diagnostics: StorageDiagnostic[]) {
    super(`存储 degraded：${diagnostics.map(issue => `${issue.path}${issue.line === undefined ? '' : `:${issue.line}`} ${issue.message}`).join('；')}`)
    this.name = 'StorageError'
    this.diagnostics = diagnostics
  }
}

/** Current observed health; callers can filter to selected files. */
export function storageStatus(paths?: readonly string[]): {
  mode: 'healthy' | 'degraded'
  degraded: boolean
  writer: 'single-process'
  coordination: 'journal-lock'
  diagnostics: StorageDiagnostic[]
} {
  const selected = paths === undefined ? undefined : new Set(paths.map(path => resolve(path)))
  const diagnostics = [...problems.entries()]
    .filter(([path]) => selected === undefined || selected.has(path))
    .flatMap(([, issues]) => issues.map(issue => ({ ...issue })))
  const degraded = diagnostics.length > 0
  return { mode: degraded ? 'degraded' : 'healthy', degraded, writer: 'single-process', coordination: 'journal-lock', diagnostics }
}

function fail(path: string, kind: StorageDiagnostic['kind'], message: string, line?: number,
  evidence: Pick<StorageDiagnostic, 'code' | 'operationId' | 'firstLine' | 'journalSha256' | 'snapshotPath' | 'captureError'> = {}): never {
  const issue: StorageDiagnostic = { path: resolve(path), kind, message, blocking: true, ...(line === undefined ? {} : { line }), ...evidence }
  problems.set(resolve(path), [issue])
  throw new StorageError([issue])
}

function bytesAt(path: string): Buffer | undefined {
  try { return readFileSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return fail(path, 'read', `读取失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function decodeText(path: string, bytes: Buffer | undefined): string | undefined {
  if (bytes === undefined) return undefined
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    return fail(path, 'read', '文件不是有效 UTF-8；保留原始字节，拒绝覆盖')
  }
}

function textAt(path: string): string | undefined {
  return decodeText(path, bytesAt(path))
}

function parsedJson(path: string, text: string): unknown {
  try { return JSON.parse(text) as unknown } catch (error) {
    return fail(path, 'json', `JSON 损坏：${error instanceof Error ? error.message : String(error)}`)
  }
}

function parsedLineEntries<T>(path: string, text: string | undefined, validate?: (row: unknown) => boolean, strict = true): Array<{ value: T; line: number }> {
  const out: Array<{ value: T; line: number }> = []
  const issues: StorageDiagnostic[] = []
  for (const [index, line] of (text ?? '').split('\n').entries()) {
    if (line.trim() === '') continue
    let row: unknown
    try { row = JSON.parse(line) as unknown } catch (error) {
      issues.push({ path: resolve(path), kind: 'json', line: index + 1, blocking: strict, message: `JSONL 损坏：${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (validate !== undefined && !validate(row)) {
      issues.push({ path: resolve(path), kind: 'schema', line: index + 1, blocking: strict, message: 'JSONL 记录结构损坏' })
      continue
    }
    out.push({ value: row as T, line: index + 1 })
  }
  problems.set(resolve(path), issues)
  if (strict && issues.length > 0) throw new StorageError(issues)
  return out
}

function parsedLines<T>(path: string, text: string | undefined, validate?: (row: unknown) => boolean, strict = true): T[] {
  return parsedLineEntries<T>(path, text, validate, strict).map(entry => entry.value)
}

/** Dashboard snapshots can inspect persisted bytes without replaying pending writes. */
export interface ReadOptions { recover?: boolean }

export function readState<T>(path: string, fallback: T, validate?: (value: unknown) => boolean, options: ReadOptions = {}): T {
  if (options.recover !== false) recoverOperations()
  const text = textAt(path)
  if (text === undefined) { problems.delete(resolve(path)); return structuredClone(fallback) }
  const value = parsedJson(path, text)
  if (validate !== undefined && !validate(value)) return fail(path, 'schema', 'JSON 记录结构损坏')
  problems.delete(resolve(path))
  return value as T
}

export function readJsonLinesStrict<T>(path: string, validate?: (row: unknown) => boolean, options: ReadOptions = {}): T[] {
  if (options.recover !== false) recoverOperations()
  return parsedLines<T>(path, textAt(path), validate)
}

/** Damaged append-only evidence remains readable, with explicit skipped-line diagnostics. */
export function readJsonLinesLenient<T>(path: string, validate?: (row: unknown) => boolean): T[] {
  return parsedLines<T>(path, textAt(path), validate, false)
}

export function storageFiles(path: string): { backup: string; manifest: string } {
  return { backup: `${path}.backup-v1`, manifest: `${path}.migration-v1.json` }
}

type Format = 'json' | 'jsonl' | 'text'
export interface FileWrite {
  path: string
  content: string
  format?: Format
  /** Hash of the bytes used to derive this update; null means the file was absent. */
  expectedBefore?: string | null
  /** Checks the complete decoded value (JSONL is an array). */
  validate?: (value: unknown) => boolean
}

interface StoredWrite {
  path: string
  content: string
  format: Format
  beforeSha256: string | null
  afterSha256: string
}

interface PreparedOperation {
  version: 1
  phase: 'prepared'
  operationId: string
  time: string
  targetId: string
  kind: string
  writes: StoredWrite[]
  result?: unknown
}

interface CommittedOperation {
  version: 1
  phase: 'committed'
  operationId: string
  time: string
  targetId: string
  kind: string
}
/**
 * A compacted historical commit: identity and its idempotent result only.
 * Historical write bodies are intentionally not retained after compaction.
 */
interface CheckpointOperation {
  version: 1
  phase: 'checkpoint'
  operationId: string
  time: string
  targetId: string
  kind: string
  result?: unknown
}
type JournalRow = PreparedOperation | CommittedOperation | CheckpointOperation
type OperationSummary = Omit<PreparedOperation, 'writes'>
interface Journal {
  prepared: Map<string, OperationSummary>
  committed: Set<string>
  pending: Map<string, PreparedOperation>
}
// Retain one validated index, never the historical file bytes or committed snapshots.
// Every read hashes its observed bytes: timestamps cannot hide edits or corruption.
let journalCache: { path: string; digest: string; bytes: number; hashState: ReturnType<typeof createHash>; journal: Journal } | undefined

/** A cold/uncertain generation is not durable merely because its complete JSON is visible. */
function syncExisting(path: string, allowMissing = false): void {
  let fd: number
  try { fd = openSync(path, 'r+') } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** Validate cache identity without allocating another journal-sized buffer. */
function journalDigest(path: string): string {
  let fd: number
  try { fd = openSync(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sha256(Buffer.alloc(0))
    return fail(path, 'read', `读取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const size = readSync(fd, chunk, 0, chunk.length, null)
      if (size === 0) return hash.digest('hex')
      hash.update(chunk.subarray(0, size))
    }
  } catch (error) {
    return fail(path, 'read', `读取失败：${error instanceof Error ? error.message : String(error)}`)
  } finally { closeSync(fd) }
}
const defaultJournal = (): string => statePath('store-operations.jsonl')

/**
 * Retention limits keep every read/write fence proportional to a bounded journal.
 * Values are read per call so tests and hosts can tune them without a rebuild.
 */
function journalLimitBytes(): number {
  const configured = Number(process.env.DSH_BUTLER_JOURNAL_COMPACT_BYTES)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 8 * 1024 * 1024
}
function keepCommittedOperations(): number {
  const configured = Number(process.env.DSH_BUTLER_JOURNAL_KEEP_COMMITTED)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 5000
}
/** Journals above this size are not copied before compaction; the host must back up state. */
const COMPACT_BACKUP_LIMIT_BYTES = 64 * 1024 * 1024
const COMPACT_BACKUP_KEEP = 2
const hashAt = (path: string): string | null => {
  const bytes = bytesAt(path)
  return bytes === undefined ? null : sha256(bytes)
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Resolve links and Windows junctions; fall back when a wrapping probe strips `.native`. */
function realpathResolvingLinks(path: string): string {
  const native = (realpathSync as unknown as { native?: (path: string) => string }).native
  return typeof native === 'function' ? native.call(realpathSync, path) : realpathSync(path)
}

/** Resolve the closest existing ancestor, including junctions, before appending missing segments. */
function physicalPath(path: string, contention = false): string {
  let ancestor = resolve(path)
  const missing: string[] = []
  for (;;) {
    let observed: BigIntStats
    try { observed = lstatSync(ancestor, { bigint: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail(path, 'read', `路径检查失败：${error instanceof Error ? error.message : String(error)}`)
      const parent = dirname(ancestor)
      if (parent === ancestor) return fail(path, 'read', '无法解析路径根目录')
      missing.unshift(basename(ancestor))
      ancestor = parent
      continue
    }
    const isLink = observed.isSymbolicLink()
    // A dangling link must fail closed. An ordinary directory can disappear
    // between lstat and realpath when another owner releases an ephemeral lock.
    // `realpathSync.native` also resolves Windows junctions, which plain
    // `realpathSync` leaves as the junction path and would let escape the roots.
    try {
      const canonical = resolve(realpathResolvingLinks(ancestor))
      if (contention && canonical !== ancestor) {
        // NTFS may resolve a deleted open handle into $Extend/$Deleted. Check
        // identity before classifying a changed journal/lock as an escape.
        // Never accept that path or remove a replacement owner's directory.
        let current: BigIntStats
        try { current = lstatSync(ancestor, { bigint: true }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageBusyError(path, '路径在解析期间已被移除；本次停止')
          throw error
        }
        if (current.dev !== observed.dev || current.ino !== observed.ino) throw new StorageBusyError(path, '路径在解析期间已被替换；本次停止')
      }
      return resolve(canonical, ...missing)
    } catch (error) {
      if (error instanceof StorageBusyError) throw error
      const missingPath = (error as NodeJS.ErrnoException).code === 'ENOENT'
      if (contention || (!isLink && missingPath)) {
        let removed = false
        try {
          const current = lstatSync(ancestor, { bigint: true })
          if (contention && (current.dev !== observed.dev || current.ino !== observed.ino)) throw new StorageBusyError(path, '路径在解析期间已被替换；本次停止')
        } catch (again) {
          if (again instanceof StorageBusyError) throw again
          removed = (again as NodeJS.ErrnoException).code === 'ENOENT'
          if (!removed) return fail(path, 'read', `路径复查失败：${again instanceof Error ? again.message : String(again)}`)
        }
        if (removed && !isLink && missingPath && dirname(ancestor) !== ancestor) {
          missing.unshift(basename(ancestor))
          ancestor = dirname(ancestor)
          continue
        }
        // Windows can report EPERM or EBADF for the same disappearing handle.
        // Only an observed removal/replacement is contention; a stable path's
        // actual access or I/O error remains a blocking storage diagnostic.
        if (contention && removed) throw new StorageBusyError(path, '路径在解析期间已被移除；本次停止')
      }
      return fail(path, 'read', `禁止无法解析的真实路径：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function inside(root: string, path: string): boolean {
  const tail = relative(root, path)
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`))
}

function assertWithinRoots(path: string, contention = false): string {
  if (!isAbsolute(path)) return fail(path, 'journal', '禁止非绝对的存储路径')
  const absolute = resolve(path), physical = physicalPath(absolute, contention)
  const allowed = [VAULT_HOME, STATE_HOME].some(root => inside(resolve(root), absolute) && inside(physicalPath(root), physical))
  if (!allowed) return fail(path, 'journal', '禁止越过配置的 vault/state 根目录边界的路径（含 junction）')
  return physical
}
const assertLockPath = (path: string): string => assertWithinRoots(path, true)

const reservedSidecar = (path: string): boolean => /(?:\.backup-v\d+|\.migration-v\d+\.json)$/i.test(basename(path).replace(/[ .]+$/, ''))
const reservedJournal = (path: string): boolean => /(?:^store-operations\.jsonl$|\.operations\.jsonl$)/i.test(basename(path).replace(/[ .]+$/, ''))

function assertJournalPath(path: string): void {
  assertWithinRoots(path)
  if (reservedSidecar(path)) fail(path, 'journal', '禁止将备份或 SHA256 清单路径用作操作日志')
}

function assertWritePath(path: string, journalPath: string): void {
  const physical = assertWithinRoots(path)
  const journalPhysical = assertWithinRoots(journalPath)
  const journals = [journalPhysical, physicalPath(defaultJournal())]
  if (journals.some(journal => physical === journal || inside(`${journal}.lock`, physical) || physical.startsWith(`${journal}.lock.`))
    || reservedSidecar(path) || reservedSidecar(physical) || reservedJournal(path) || reservedJournal(physical)) {
    fail(path, 'journal', '禁止将操作日志、锁、迁移备份或 SHA256 清单作为业务写入路径')
  }
}

/** Preserve the bytes of a rejected read without replacing earlier evidence or the source journal. */
function captureJournalFailure(sourcePath: string, bytes: Buffer, evidence: Pick<StorageDiagnostic, 'code' | 'line' | 'operationId' | 'firstLine'>,
  journalSha256: string): Pick<StorageDiagnostic, 'snapshotPath' | 'captureError'> {
  const snapshotPath = statePath('store-failures', `${journalSha256}.jsonl`)
  const metadataPath = statePath('store-failures', `${journalSha256}.json`)
  let captured = false
  const existing = (path: string): Buffer | undefined => {
    try { return readFileSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  try {
    // Check both destinations before the first write, including existing junctions.
    assertWithinRoots(snapshotPath)
    assertWithinRoots(metadataPath)
    const previous = existing(snapshotPath)
    if (previous !== undefined && !previous.equals(bytes)) throw new Error('已有故障快照字节与 SHA256 文件名不匹配；保留原件')
    if (previous === undefined) {
      assertWithinRoots(snapshotPath)
      writeBytes(snapshotPath, bytes)
    }
    captured = true
    if (existing(metadataPath) === undefined) {
      assertWithinRoots(metadataPath)
      writeText(metadataPath, `${JSON.stringify({ ...evidence, time: new Date().toISOString(), sourcePath, journalSha256, snapshotPath }, null, 2)}\n`)
    }
    return { snapshotPath }
  } catch (error) {
    // Capturing evidence must never replace the original semantic validation failure.
    return { ...(captured ? { snapshotPath } : {}), captureError: error instanceof Error ? error.message : String(error) }
  }
}

function readJournal(path: string, locked = false): Journal {
  assertJournalPath(path)
  const absolute = resolve(path)
  if (journalCache?.path === absolute && journalCache.digest === journalDigest(path)) {
    problems.delete(absolute)
    return journalCache.journal
  }
  journalCache = undefined
  if (!locked) return withJournalLock(physicalPath(path, true), assertLockPath, () => readJournal(path, true))
  // Another process/module may observe a full append after its writer's fsync failed.
  // Fence that generation while holding the same physical lock, then validate it.
  try { syncExisting(path, true) } catch (error) {
    return fail(path, 'write', `日志 durability fence 失败，不能声称已提交：${error instanceof Error ? error.message : String(error)}`)
  }
  const bytes = bytesAt(path), hashState = createHash('sha256').update(bytes ?? Buffer.alloc(0)), digest = hashState.copy().digest('hex')
  const journalFail = (code: NonNullable<StorageDiagnostic['code']>, message: string, line: number, operationId?: string, firstLine?: number): never => {
    // Hash the same read that was parsed, and only on failure. A later read may observe a different writer.
    const journalSha256 = sha256(bytes ?? Buffer.alloc(0))
    const identity = { ...(operationId === undefined ? {} : { operationId }), ...(firstLine === undefined ? {} : { firstLine }) }
    const capture = captureJournalFailure(path, bytes ?? Buffer.alloc(0), { code, line, ...identity }, journalSha256)
    const context = [`code=${code}`, operationId === undefined ? '' : `operationId=${JSON.stringify(operationId)}`,
      firstLine === undefined ? '' : `首次位于第 ${firstLine} 行`, `journalSha256=${journalSha256}`,
      capture.snapshotPath === undefined ? '' : `snapshotPath=${capture.snapshotPath}`,
      capture.captureError === undefined ? '' : `证据保存失败=${capture.captureError}`].filter(Boolean).join('，')
    return fail(path, 'journal', `${message}（${context}）`, line,
      { code, journalSha256, ...identity, ...capture })
  }
  const prepared = new Map<string, OperationSummary>(), committed = new Set<string>()
  const pending = new Map<string, PreparedOperation>()
  const firstLines = new Map<string, number>()
  // A journal can contain hundreds of complete historical state snapshots.
  // Decode one physical line at a time instead of keeping a whole-file string,
  // its split strings, and all parsed write contents live together.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let start = 0, line = 0, lastComplete = 0
  while (bytes !== undefined && start < bytes.length) {
    const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline
    let text: string
    try { text = decoder.decode(bytes.subarray(start, end)) } catch {
      return fail(path, 'read', '文件不是有效 UTF-8；保留原始字节，拒绝覆盖')
    }
    if (start === 0 && text.startsWith('\uFEFF')) text = text.slice(1)
    start = end + 1
    line++
    if (text.trim() === '') {
      if (newline >= 0) lastComplete = end + 1
      continue
    }
    let value: unknown
    try { value = JSON.parse(text) as unknown } catch (error) {
      // A crash during one append can leave an unterminated torn tail. Complete
      // records before it are still valid; preserve the exact bytes as evidence,
      // then cut only that tail so the next write can proceed. Mid-file damage
      // and a torn first record stay fail-closed.
      if (newline < 0 && lastComplete > 0) return repairTornTail(path, bytes, lastComplete, line)
      return fail(path, 'json', `JSONL 损坏：${error instanceof Error ? error.message : String(error)}`, line)
    }
    if (!record(value) || value.version !== 1 || !nonempty(value.operationId) || !nonempty(value.targetId)
      || !nonempty(value.kind) || !nonempty(value.time) || !Number.isFinite(Date.parse(value.time))
      || (value.phase !== 'prepared' && value.phase !== 'committed' && value.phase !== 'checkpoint')) {
      return journalFail('invalid-operation', '操作日志结构损坏', line, record(value) && nonempty(value.operationId) ? value.operationId : undefined)
    }
    if (value.phase === 'checkpoint') {
      if (prepared.has(value.operationId) || committed.has(value.operationId)) {
        return journalFail('duplicate-operation', '操作日志含重复操作', line, value.operationId, firstLines.get(value.operationId))
      }
      const checkpoint = value as unknown as CheckpointOperation
      const { result, ...identity } = checkpoint
      // A checkpoint is a committed operation whose write bodies were compacted away.
      prepared.set(checkpoint.operationId, {
        version: 1, phase: 'prepared', operationId: checkpoint.operationId, time: checkpoint.time,
        targetId: checkpoint.targetId, kind: checkpoint.kind, ...(result === undefined ? {} : { result }),
      })
      committed.add(checkpoint.operationId)
      firstLines.set(checkpoint.operationId, line)
      if (newline >= 0) lastComplete = end + 1
      continue
    }
    if (value.phase === 'prepared') {
      if (prepared.has(value.operationId)) return journalFail('duplicate-operation', '操作日志含重复操作', line, value.operationId, firstLines.get(value.operationId))
      if (!Array.isArray(value.writes)) return journalFail('invalid-writes', '操作日志写入结构损坏', line, value.operationId)
      if (value.writes.length === 0) return journalFail('empty-writes', '操作日志含空写入', line, value.operationId)
      const paths = new Set<string>()
      for (const write of value.writes) {
        if (!record(write) || !nonempty(write.path) || !isAbsolute(write.path) || typeof write.content !== 'string'
          || !['text', 'json', 'jsonl'].includes(String(write.format)) || !hash(write.afterSha256)
          || (write.beforeSha256 !== null && !hash(write.beforeSha256))
          || sha256(Buffer.from(write.content, 'utf8')) !== write.afterSha256 || paths.has(resolve(write.path))) {
          return journalFail('invalid-write', '操作日志写入内容或 SHA256 损坏', line, value.operationId)
        }
        paths.add(resolve(write.path))
      }
      const operation = value as unknown as PreparedOperation
      const { writes: _snapshots, ...summary } = operation
      prepared.set(value.operationId, summary)
      pending.set(value.operationId, operation)
      firstLines.set(value.operationId, line)
    } else {
      const start = prepared.get(value.operationId)
      if (start === undefined || committed.has(value.operationId) || start.kind !== value.kind || start.targetId !== value.targetId || start.time !== value.time) {
        return journalFail('invalid-commit', '操作日志提交标记不匹配', line, value.operationId)
      }
      committed.add(value.operationId)
      pending.delete(value.operationId)
    }
    if (newline >= 0) lastComplete = end + 1
  }
  const journal = { prepared, committed, pending }
  problems.delete(absolute)
  journalCache = { path: absolute, digest, bytes: bytes?.length ?? 0, hashState, journal }
  return journal
}

function checkContent(write: FileWrite, content: string | undefined): void {
  if (content === undefined) return
  const format = write.format ?? 'text'
  const value = format === 'json' ? parsedJson(write.path, content)
    : format === 'jsonl' ? parsedLines<unknown>(write.path, content) : content
  if (write.validate !== undefined && !write.validate(value)) fail(write.path, 'schema', '记录结构损坏；拒绝覆盖')
}

function preserveOriginal(path: string, requireExisting = false): void {
  const files = storageFiles(path)
  assertWithinRoots(files.manifest)
  assertWithinRoots(files.backup)
  const manifestText = textAt(files.manifest)
  if (manifestText !== undefined) {
    const manifest = parsedJson(files.manifest, manifestText)
    const backup = bytesAt(files.backup)
    if (!record(manifest) || manifest.version !== 1 || manifest.originalPath !== path
      || typeof manifest.originalExists !== 'boolean'
      || (manifest.originalExists && (!hash(manifest.sha256) || backup === undefined || sha256(backup) !== manifest.sha256
        || manifest.backupPath !== files.backup || manifest.bytes !== backup.byteLength))
      || (!manifest.originalExists && (manifest.sha256 !== null || manifest.backupPath !== null || manifest.bytes !== 0 || backup !== undefined))) {
      fail(files.manifest, 'backup', '迁移备份或 SHA256 清单损坏；拒绝写入')
    }
    problems.delete(resolve(files.manifest))
    problems.delete(resolve(files.backup))
    return
  }
  if (requireExisting) fail(files.manifest, 'backup', '恢复所需的迁移备份 SHA256 清单缺失；保留现有字节')
  const original = bytesAt(path), existingBackup = bytesAt(files.backup)
  if (existingBackup !== undefined && (original === undefined || sha256(existingBackup) !== sha256(original))) {
    fail(files.backup, 'backup', '已有备份与迁移原件不匹配；保留两者')
  }
  if (original !== undefined && existingBackup === undefined) writeBytes(files.backup, original)
  writeText(files.manifest, `${JSON.stringify({
    version: 1, originalPath: path, originalExists: original !== undefined,
    backupPath: original === undefined ? null : files.backup,
    sha256: original === undefined ? null : sha256(original),
    bytes: original?.byteLength ?? 0, time: new Date().toISOString(),
  }, null, 2)}\n`)
}

/** Append only this owned record. Never replace/truncate a journal, even after a partial failure. */
function appendJournal(path: string, row: JournalRow): Journal {
  try {
    assertJournalPath(path)
    const cache = journalCache
    if (cache?.path !== resolve(path) || journalDigest(path) !== cache.digest) return fail(path, 'recovery', '操作日志在已验证 generation 后发生变化；保留当前字节')
    const recordBytes = Buffer.from(`${JSON.stringify(row)}\n`), serialized = JSON.parse(recordBytes.toString('utf8')) as JournalRow
    const previous = cache.journal.prepared.get(serialized.operationId)
    if (serialized.phase === 'prepared' ? previous !== undefined
      : previous === undefined || cache.journal.committed.has(serialized.operationId) || previous.kind !== serialized.kind || previous.targetId !== serialized.targetId || previous.time !== serialized.time) {
      return fail(path, 'journal', '禁止发布重复或不匹配的操作记录')
    }
    const fd = openSync(path, 'a+')
    let appended: Buffer
    try {
      const size = fstatSync(fd).size
      if (size !== cache.bytes) return fail(path, 'recovery', '操作日志长度已变化；保留当前字节')
      const last = Buffer.alloc(1)
      if (size > 0 && readSync(fd, last, 0, 1, size - 1) !== 1) return fail(path, 'read', '无法确认操作日志末尾')
      appended = size > 0 && last[0] !== 10 ? Buffer.concat([Buffer.from('\n'), recordBytes]) : recordBytes
      let offset = 0
      while (offset < appended.length) {
        const count = writeSync(fd, appended, offset, appended.length - offset, null)
        if (!Number.isSafeInteger(count) || count <= 0 || count > appended.length - offset) return fail(path, 'write', '操作日志写入没有有效 progress')
        offset += count
      }
      fsyncSync(fd)
    } finally { closeSync(fd) }
    const hashState = cache.hashState.copy().update(appended), digest = hashState.copy().digest('hex')
    if (journalDigest(path) !== digest) return fail(path, 'recovery', '操作日志 append 后内容不匹配；保留当前字节')
    const journal: Journal = { prepared: new Map(cache.journal.prepared), committed: new Set(cache.journal.committed), pending: new Map(cache.journal.pending) }
    if (serialized.phase === 'prepared') {
      const { writes: _, ...summary } = serialized
      journal.prepared.set(serialized.operationId, summary); journal.pending.set(serialized.operationId, serialized)
    } else {
      journal.committed.add(serialized.operationId); journal.pending.delete(serialized.operationId)
    }
    journalCache = { path: cache.path, digest, bytes: cache.bytes + appended.length, hashState, journal }
    return journal
  } catch (error) {
    // A complete row may be visible despite failed write/fsync/close. The next
    // reader, including a fresh module, must acquire a lock and fence it first.
    journalCache = undefined
    throw error
  }
}

function appendCommitted(path: string, operation: PreparedOperation): Journal {
  const { version, operationId, time, targetId, kind } = operation
  return appendJournal(path, { version, phase: 'committed', operationId, time, targetId, kind } satisfies CommittedOperation)
}

/**
 * Preserve a torn append's exact bytes, cut only that tail from the journal, and
 * record the repair. Only called while holding the physical journal lock and only
 * for an unterminated final line after at least one complete record.
 */
function repairTornTail(path: string, bytes: Buffer, keepBytes: number, line: number): Journal {
  const journalSha256 = sha256(bytes)
  const capture = captureJournalFailure(path, bytes, { code: 'torn-tail', line }, journalSha256)
  const truncatedBytes = bytes.length - keepBytes
  writeBytes(path, bytes.subarray(0, keepBytes))
  try {
    writeText(statePath('store-repairs', `${journalSha256.slice(0, 16)}.json`), `${JSON.stringify({
      version: 1, at: new Date().toISOString(), journalPath: path, journalSha256,
      truncatedBytes, keptBytes: keepBytes, line,
      snapshotPath: capture.snapshotPath ?? null, captureError: capture.captureError ?? null,
    }, null, 2)}\n`)
  } catch {
    // A lost repair record must not replace the recovered journal with a failure.
  }
  journalCache = undefined
  problems.delete(resolve(path))
  return readJournal(path, true)
}

function compactedJournalContent(journal: Journal): { content: string; kept: Array<[string, OperationSummary]>; dropped: number } {
  const committedEntries = [...journal.prepared.entries()].filter(([operationId]) => journal.committed.has(operationId))
  const kept = committedEntries.slice(Math.max(0, committedEntries.length - keepCommittedOperations()))
  const lines = kept.map(([, summary]) => JSON.stringify({
    version: 1, phase: 'checkpoint', operationId: summary.operationId, time: summary.time,
    targetId: summary.targetId, kind: summary.kind,
    ...(summary.result === undefined ? {} : { result: summary.result }),
  } satisfies CheckpointOperation))
  return { content: lines.length === 0 ? '' : `${lines.join('\n')}\n`, kept, dropped: journal.prepared.size - kept.length }
}

/** Keep at most COMPACT_BACKUP_KEEP pre-compaction copies; the metadata record stays. */
function pruneCompactionBackups(directory: string): void {
  try {
    const backups = readdirSync(directory).filter(name => name.startsWith('backup-')).sort()
    for (const name of backups.slice(0, Math.max(0, backups.length - COMPACT_BACKUP_KEEP))) {
      try { unlinkSync(resolve(directory, name)) } catch { /* best-effort retention */ }
    }
  } catch { /* retention must not fail compaction */ }
}

/** Called only under the physical journal lock. Rewrites committed history as checkpoints. */
function compactJournalLocked(journalPath: string): Journal {
  const journal = readJournal(journalPath, true)
  if (journal.pending.size > 0) return journal
  const bytes = bytesAt(journalPath) ?? Buffer.alloc(0)
  const beforeSha256 = sha256(bytes)
  const { content, kept, dropped } = compactedJournalContent(journal)
  const after = Buffer.from(content, 'utf8')
  const afterSha256 = sha256(after)
  const at = new Date().toISOString()
  const directory = statePath('store-compactions')
  let backups: string[] = []
  try { backups = readdirSync(directory).filter(name => name.startsWith('backup-')) } catch { backups = [] }
  let backupPath: string | null = null
  // Always keep the first pre-compaction generation so a downgrade can restore
  // the original journal; later generations only when they fit the size budget.
  if (bytes.length > 0 && (bytes.length <= COMPACT_BACKUP_LIMIT_BYTES || backups.length === 0)) {
    backupPath = statePath('store-compactions', `backup-${beforeSha256.slice(0, 16)}-${at.replace(/[:.]/g, '')}.jsonl`)
    writeBytes(backupPath, bytes)
    pruneCompactionBackups(directory)
  }
  writeBytes(journalPath, after)
  // The cache must mirror exactly the retained checkpoints, never the dropped tail.
  const prepared = new Map<string, OperationSummary>(kept), committed = new Set<string>(kept.map(([operationId]) => operationId))
  journalCache = { path: resolve(journalPath), digest: afterSha256, bytes: after.length, hashState: createHash('sha256').update(after), journal: { prepared, committed, pending: new Map() } }
  try {
    writeText(statePath('store-compactions', `compaction-${afterSha256.slice(0, 16)}-${at.replace(/[:.]/g, '')}.json`), `${JSON.stringify({
      version: 1, at, journalPath, beforeBytes: bytes.length, beforeSha256, afterBytes: after.length, afterSha256,
      kept: kept.length, dropped, backupPath,
    }, null, 2)}\n`)
  } catch {
    // Losing only the maintenance record must not lose the compacted journal.
  }
  problems.delete(resolve(journalPath))
  return journalCache.journal
}

/** Called only by the owner of this physical journal's lock. */
function recoverLocked(journalPath: string): Journal {
  try {
    const journal = readJournal(journalPath, true)
    let recovered = journal
    for (const operation of journal.pending.values()) {
      // Check the entire path set before inspecting any transaction sidecars.
      for (const write of operation.writes) assertWritePath(write.path, journalPath)
      // Validate every file before changing the first file of a transaction.
      for (const write of operation.writes) {
        assertWritePath(write.path, journalPath)
        const current = hashAt(write.path)
        if (current !== write.beforeSha256 && current !== write.afterSha256) fail(write.path, 'recovery', `操作 ${operation.operationId} 恢复冲突：文件已被修改；保留现有字节`)
        checkContent(write, write.content)
        preserveOriginal(write.path, true)
      }
      for (const write of operation.writes) {
        assertWritePath(write.path, journalPath)
        const current = hashAt(write.path)
        if (current !== write.beforeSha256 && current !== write.afterSha256) fail(write.path, 'recovery', `操作 ${operation.operationId} 恢复冲突：文件已被修改；保留现有字节`)
        if (hashAt(write.path) !== write.afterSha256) writeText(write.path, write.content)
        else syncExisting(write.path)
        problems.delete(resolve(write.path))
      }
      recovered = appendCommitted(journalPath, operation)
    }
    return recovered
  } catch (error) {
    if (error instanceof StorageError) throw error
    fail(journalPath, 'recovery', `本地状态恢复未完成：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Restore local snapshots only, refusing other writers and files edited since prepare. */
function recoverAndReadJournal(journalPath: string): Journal {
  // Validated, durable cache hits need no lock mutation. A cold generation and
  // pending operations use the same fence as commits; a live prepare is not a crash.
  const journal = readJournal(journalPath)
  if (journal.pending.size === 0) {
    // Oversized journals are compacted before any further read fence pays for them.
    if ((journalCache?.bytes ?? 0) > journalLimitBytes()) return withJournalLock(physicalPath(journalPath, true), assertLockPath, () => compactJournalLocked(journalPath))
    return journal
  }
  return withJournalLock(physicalPath(journalPath, true), assertLockPath, () => recoverLocked(journalPath))
}

export function recoverOperations(journalPath = defaultJournal()): void {
  recoverAndReadJournal(journalPath)
}

export interface CommitFilesOptions<R = unknown> extends OperationMetadata {
  kind: string
  targetId: string
  writes: FileWrite[]
  result?: R
  journalPath?: string
}

function previousOperation(path: string, operation: { operationId: string; kind: string; targetId: string }, locked = false): OperationSummary | undefined {
  const journal = readJournal(path, locked), previous = journal.prepared.get(operation.operationId)
  // An operation's identity is its business target and kind. Derived paths
  // (for example tomorrow's daily page) must not change the result of a retry.
  if (previous !== undefined && (previous.kind !== operation.kind || previous.targetId !== operation.targetId)) {
    fail(path, 'journal', `operationId ${operation.operationId} 操作标识冲突；不能用于其他目标`)
  }
  if (previous !== undefined && !journal.committed.has(operation.operationId)) throw new StorageBusyError(path, '同一操作尚未提交；不能提前报告成功')
  return previous
}

/** A validated committed summary, never historical write bodies or mutable index state. */
export function readCommittedOperation(operationId: string, journalPath = defaultJournal()): OperationSummary | undefined {
  if (!nonempty(operationId)) return fail(journalPath, 'journal', '操作标识无效')
  const journal = recoverAndReadJournal(journalPath), previous = journal.prepared.get(operationId)
  if (previous === undefined) return undefined
  if (!journal.committed.has(operationId)) throw new StorageBusyError(journalPath, '操作尚未提交；不能提前报告成功')
  return structuredClone(previous)
}

/** Durable prepare → atomic file replacements → commit; repeated ids return the original result. */
export function commitFiles<R = unknown>(options: CommitFilesOptions<R>): R {
  const journalPath = options.journalPath ?? defaultJournal()
  try {
    assertJournalPath(journalPath)
    return withJournalLock(physicalPath(journalPath, true), assertLockPath, () => {
      let initialJournal = recoverLocked(journalPath)
      if (initialJournal.pending.size === 0 && (journalCache?.bytes ?? 0) > journalLimitBytes()) initialJournal = compactJournalLocked(journalPath)
      const operationId = options.operationId ?? randomUUID(), time = options.time ?? new Date().toISOString()
      if (!nonempty(operationId) || !nonempty(options.targetId) || !nonempty(options.kind) || !Number.isFinite(Date.parse(time)) || options.writes.length === 0) {
        return fail(journalPath, 'journal', '操作元数据无效')
      }
      const paths = options.writes.map(write => resolve(write.path))
      if (new Set(paths).size !== paths.length || paths.includes(resolve(journalPath))) return fail(journalPath, 'journal', '操作包含重复路径或覆盖操作日志')
      for (const path of paths) assertWritePath(path, journalPath)
      const beforeHashes: (string | null)[] = []
      for (const write of options.writes) {
        const bytes = bytesAt(write.path)
        beforeHashes.push(bytes === undefined ? null : sha256(bytes))
        checkContent(write, decodeText(write.path, bytes))
        checkContent(write, write.content)
      }
      // A new prepare is freshly checked by appendJournal below. Existing ids
      // still need a fresh lookup after validators, which may reenter or edit files.
      const previous = initialJournal.prepared.has(operationId)
        ? previousOperation(journalPath, { operationId, kind: options.kind, targetId: options.targetId }, true)
        : undefined
      if (previous !== undefined) return structuredClone(previous.result) as R
      for (const [index, write] of options.writes.entries()) {
        if (write.expectedBefore !== undefined && write.expectedBefore !== null && !hash(write.expectedBefore)) return fail(write.path, 'write', 'expectedBefore SHA256 无效')
        if (write.expectedBefore !== undefined && beforeHashes[index] !== write.expectedBefore) return fail(write.path, 'recovery', `操作 ${operationId} 写入冲突：快照读取后文件已被修改`)
      }
      for (const path of paths) preserveOriginal(path)
      const writes: StoredWrite[] = options.writes.map((write, index) => ({
        path: resolve(write.path), content: write.content, format: write.format ?? 'text',
        beforeSha256: beforeHashes[index] as string | null, afterSha256: sha256(Buffer.from(write.content, 'utf8')),
      }))
      if (writes.some(write => !['text', 'json', 'jsonl'].includes(write.format))) return fail(journalPath, 'journal', '操作日志写入格式无效')
      const prepared: PreparedOperation = { version: 1, phase: 'prepared', operationId, time, targetId: options.targetId, kind: options.kind, writes, ...(options.result === undefined ? {} : { result: options.result }) }
      appendJournal(journalPath, prepared)
      for (const write of writes) {
        // A human editor between prepare and replacement must not lose their bytes.
        assertWritePath(write.path, journalPath)
        if (hashAt(write.path) !== write.beforeSha256) return fail(write.path, 'recovery', `操作 ${operationId} 写入冲突：文件已被修改`)
        writeText(write.path, write.content)
        problems.delete(resolve(write.path))
      }
      appendCommitted(journalPath, prepared)
      return structuredClone(options.result) as R
    })
  } catch (error) {
    if (error instanceof StorageError || error instanceof StorageBusyError) throw error
    return fail(journalPath, 'write', `操作提交未完成，可在重启后恢复：${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface StateSpec<T> {
  path: string
  format: 'json' | 'jsonl'
  fallback: T
  validate?: (value: unknown) => boolean
  validateRow?: (value: unknown) => boolean
}

export interface SnapshotSpec<T> extends Omit<StateSpec<T>, 'format'> {
  format: 'json' | 'jsonl' | 'text'
}

/** Parse and hash the same bytes so a derived update can reject later edits. */
export function readSnapshot<T>(spec: SnapshotSpec<T>, options: ReadOptions = {}): { value: T; expectedBefore: string | null } {
  if (options.recover !== false) recoverOperations()
  assertWritePath(spec.path, defaultJournal())
  const bytes = bytesAt(spec.path), text = decodeText(spec.path, bytes)
  const expectedBefore = bytes === undefined ? null : sha256(bytes)
  const value = text === undefined ? structuredClone(spec.fallback)
    : spec.format === 'json' ? parsedJson(spec.path, text)
    : spec.format === 'jsonl' ? parsedLines(spec.path, text, spec.validateRow) : text
  if (spec.validate !== undefined && !spec.validate(value)) return fail(spec.path, 'schema', '记录结构损坏')
  problems.delete(resolve(spec.path))
  return { value: value as T, expectedBefore }
}

/** Read, validate, and commit one existing JSON/JSONL snapshot without changing its format. */
export function commitState<T, R>(
  spec: StateSpec<T>,
  operation: OperationMetadata & { kind: string; targetId: string },
  update: (current: T) => { value: T; result: R },
): R {
  const { value: current, expectedBefore } = readSnapshot(spec)
  const operationId = operation.operationId ?? randomUUID(), time = operation.time ?? new Date().toISOString()
  const previous = previousOperation(defaultJournal(), { ...operation, operationId })
  if (previous !== undefined) return structuredClone(previous.result) as R
  const { value, result } = update(current)
  const content = spec.format === 'json' ? `${JSON.stringify(value, null, 2)}\n`
    : (value as unknown[]).map(row => JSON.stringify(row)).join('\n') + ((value as unknown[]).length === 0 ? '' : '\n')
  return commitFiles({ ...operation, operationId, time, result, writes: [{ path: spec.path, content, format: spec.format, validate: spec.validate, expectedBefore }] })
}
