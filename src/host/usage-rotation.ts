/**
 * Usage-ledger rotation: keep the hot append-only file bounded without losing
 * a single record.
 *
 * The ledger only ever appends: a growing `vault/ledger/usage.jsonl` is honest
 * but it makes every cold read (and every panel poll after restart) pay for all
 * history. Rotation moves the oldest records to `vault/ledger/usage-archive/
 * <year>.jsonl`, where they stay readable JSONL that the ledger's read path
 * merges back in - totals and per-session attribution do not change, only the
 * files they physically live in.
 *
 * Safety rules, in order of importance:
 *  - never lose a byte: archive lines are appended and flushed *before* the hot
 *    file is atomically replaced, so a crash can duplicate a record but not
 *    drop one;
 *  - never guess: a hot file with a line the ledger could not parse is left
 *    exactly as it is (rotation reports why it skipped);
 *  - never fail the caller: errors come back as a skipped result;
 *  - never thrash: the size trigger shrinks the hot file to half the limit, so
 *    it takes a while to cross the threshold again.
 *
 * @module @dsh-external/dsh-butler/host/usage-rotation
 */
import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { readJsonLinesLenient, storageStatus } from './store.ts'
import { vaultPath, writeText } from './vault.ts'

/** The append-only usage log the recorder appends to. */
export const USAGE_LEDGER_FILE = (): string => vaultPath('ledger', 'usage.jsonl')

/** Per-year archives; every read path merges them with the hot file. */
export const USAGE_ARCHIVE_DIR = (): string => vaultPath('ledger', 'usage-archive')

/** Default hot-file limit: 2MB is over a month of calls on this machine. */
export const DEFAULT_ROTATE_MAX_BYTES = 2 * 1024 * 1024

/** Default maximum age of an entry before it is archived, in days. */
export const DEFAULT_ROTATE_MAX_AGE_DAYS = 90

/**
 * The age probe reads the whole head of the hot file, so it is throttled in
 * process. A size trigger is checked on every call and needs no throttle.
 */
const AGE_PROBE_INTERVAL_MS = 60 * 60 * 1000

let lastAgeProbe = 0
let lastRotation: UsageRotationResult | undefined

/** Rows never moved by rotation: anything the byte parser cannot prove is a usable JSONL row. */
interface UsageRawRow {
  /** The original line, kept verbatim so moving it cannot reformat valid bytes. */
  line: string
  /** Parsed instant of `at`, milliseconds. */
  at: number
  /** UTC year of `at`, the archive partition. */
  year: number
}

/** Rotate when the hot file exceeds `DSH_BUTLER_USAGE_ROTATE_BYTES` (default 2MB). */
export function usageRotationMaxBytes(): number {
  const configured = Number(process.env.DSH_BUTLER_USAGE_ROTATE_BYTES)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_ROTATE_MAX_BYTES
}

/** Archive entries older than `DSH_BUTLER_USAGE_ROTATE_DAYS` days (default 90). */
export function usageRotationMaxAgeDays(): number {
  const configured = Number(process.env.DSH_BUTLER_USAGE_ROTATE_DAYS)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_ROTATE_MAX_AGE_DAYS
}

/** Explicit inputs; tests inject the clock and thresholds instead of touching the host. */
export interface UsageRotationOptions {
  path?: string
  archiveDirectory?: string
  /** Already observed hot-file size, so the caller's stat is not repeated. */
  observedBytes?: number
  maxBytes?: number
  maxAgeDays?: number
  now?: number
}

/** One archive file this pass appended to. */
export interface UsageRotationArchiveWrite {
  path: string
  year: number
  rows: number
  bytes: number
}

/** What one rotation pass did, verbatim. A skipped pass leaves every byte alone. */
export interface UsageRotationResult {
  applied: boolean
  reason?: 'age' | 'size' | 'age+size'
  skipped?: 'missing' | 'empty' | 'below-threshold' | 'error'
  error?: string
  hotBytesBefore: number
  hotBytesAfter: number
  movedRows: number
  movedBytes: number
  archives: UsageRotationArchiveWrite[]
}

/** The parts of the archived rows the ledger needs; the row shape is the caller's. */
export interface UsageArchiveRead<T = unknown> {
  rows: T[]
  files: string[]
  /** Explicitly reported damage: archived rows that could not be read are never silently dropped. */
  problems: string[]
}

const rowBytes = (row: UsageRawRow): number => Buffer.byteLength(row.line, 'utf8') + 1

/**
 * Parse the hot file into raw lines. Blank lines are ignored like the readers
 * do; any other unparseable line is reported so rotation can refuse to touch it.
 */
function readUsageRows(path: string): { rows: UsageRawRow[]; invalidLines: number[] } {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
  const rows: UsageRawRow[] = []
  const invalidLines: number[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    let value: unknown
    try { value = JSON.parse(line) as unknown } catch {
      invalidLines.push(index + 1)
      continue
    }
    const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    const at = record !== undefined && typeof record['at'] === 'string' ? Date.parse(record['at']) : Number.NaN
    if (!Number.isFinite(at)) {
      invalidLines.push(index + 1)
      continue
    }
    rows.push({ line, at, year: new Date(at).getUTCFullYear() })
  }
  return { rows, invalidLines }
}

/** Append raw lines to one archive file, inserting a separator for an externally edited tail. */
function appendArchiveFile(path: string, rows: readonly UsageRawRow[]): void {
  mkdirSync(dirname(path), { recursive: true })
  let prefix = ''
  try {
    const size = statSync(path).size
    if (size > 0) {
      const fd = openSync(path, 'r')
      try {
        const last = Buffer.alloc(1)
        if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) prefix = '\n'
      } finally { closeSync(fd) }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  appendFileSync(path, `${prefix}${rows.map(row => row.line).join('\n')}\n`, { encoding: 'utf8', flush: true })
}

/** One full rotation pass; never throws, and returns what it refused to do. */
function rotateUsageLedgerOnce(options: UsageRotationOptions): UsageRotationResult {
  const path = options.path ?? USAGE_LEDGER_FILE()
  const archiveDirectory = options.archiveDirectory ?? USAGE_ARCHIVE_DIR()
  const now = options.now ?? Date.now()
  const maxBytes = options.maxBytes ?? usageRotationMaxBytes()
  const maxAgeDays = options.maxAgeDays ?? usageRotationMaxAgeDays()
  const result: UsageRotationResult = {
    applied: false, hotBytesBefore: 0, hotBytesAfter: 0, movedRows: 0, movedBytes: 0, archives: [],
  }
  let hotBytes = options.observedBytes
  if (hotBytes === undefined) {
    try { hotBytes = statSync(path).size } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...result, skipped: 'missing' }
      return { ...result, skipped: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }
  result.hotBytesBefore = hotBytes
  if (hotBytes === 0) return { ...result, skipped: 'empty' }
  const sizeTrigger = hotBytes > maxBytes
  let parsed: { rows: UsageRawRow[]; invalidLines: number[] }
  try { parsed = readUsageRows(path) } catch (error) {
    return { ...result, skipped: 'error', error: error instanceof Error ? error.message : String(error) }
  }
  if (parsed.invalidLines.length > 0) {
    return {
      ...result, skipped: 'error',
      error: `usage.jsonl 第 ${parsed.invalidLines.slice(0, 5).join(',')} 行无法解析；为不丢行，本次不轮转`,
    }
  }
  const rows = parsed.rows
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  const aged = rows.filter(row => row.at < cutoff)
  const ageTrigger = aged.length > 0
  if (!sizeTrigger && !ageTrigger) return { ...result, skipped: 'below-threshold' }
  const moving = new Set<UsageRawRow>(aged)
  let keptBytes = rows.reduce((total, row) => total + rowBytes(row), 0) - aged.reduce((total, row) => total + rowBytes(row), 0)
  // Hysteresis: a size-triggered pass goes to half the limit, so the next passes
  // are not one append apart. An age-triggered pass only moves what actually aged.
  const keptMaxBytes = Math.max(1, Math.floor(maxBytes / 2))
  if (sizeTrigger) {
    for (const row of rows) {
      if (keptBytes <= keptMaxBytes) break
      if (moving.has(row)) continue
      moving.add(row)
      keptBytes -= rowBytes(row)
    }
  }
  if (moving.size === 0) return { ...result, skipped: 'below-threshold' }
  const groups = new Map<number, UsageRawRow[]>()
  for (const row of rows) {
    if (!moving.has(row)) continue
    const group = groups.get(row.year)
    if (group === undefined) groups.set(row.year, [row])
    else group.push(row)
  }
  // Archive first, hot file second: an interrupted pass may duplicate rows on
  // the next read, but it can never drop them. A write failure is reported as a
  // skipped pass (this function never throws, and the hot file stays untouched).
  try {
    for (const [year, group] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
      const archivePath = join(archiveDirectory, `${year}.jsonl`)
      appendArchiveFile(archivePath, group)
      result.archives.push({
        path: archivePath, year, rows: group.length,
        bytes: group.reduce((total, row) => total + rowBytes(row), 0),
      })
    }
  } catch (error) {
    return { ...result, skipped: 'error', error: `用量归档写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const keptLines = rows.filter(row => !moving.has(row)).map(row => row.line)
  const hotContent = keptLines.length === 0 ? '' : `${keptLines.join('\n')}\n`
  try {
    writeText(path, hotContent)
  } catch (error) {
    return { ...result, skipped: 'error', error: `用量热文件重写失败：${error instanceof Error ? error.message : String(error)}` }
  }
  result.applied = true
  result.reason = sizeTrigger && ageTrigger ? 'age+size' : sizeTrigger ? 'size' : 'age'
  result.hotBytesAfter = Buffer.byteLength(hotContent, 'utf8')
  result.movedRows = moving.size
  result.movedBytes = [...moving].reduce((total, row) => total + rowBytes(row), 0)
  return result
}

/**
 * Rotate the usage ledger now.
 *
 * @param options - paths, thresholds and clock; defaults to the configured host files.
 * @returns what moved, or why nothing did. Failure leaves the hot file untouched.
 */
export function rotateUsageLedger(options: UsageRotationOptions = {}): UsageRotationResult {
  const result = rotateUsageLedgerOnce(options)
  lastRotation = result
  return result
}

/**
 * Cheap per-call check used by the ledger read path: the size gate runs every
 * time, the age gate at most once an hour per process.
 *
 * @param options - optional observed size and clock.
 * @returns the rotation result when a pass ran, otherwise undefined.
 */
export function maybeRotateUsageLedger(options: { path?: string; observedBytes?: number; now?: number } = {}): UsageRotationResult | undefined {
  try {
    const now = options.now ?? Date.now()
    let hotBytes = options.observedBytes
    if (hotBytes === undefined) {
      try { hotBytes = statSync(options.path ?? USAGE_LEDGER_FILE()).size } catch { return undefined }
    }
    const sizeDue = hotBytes > usageRotationMaxBytes()
    const ageDue = !sizeDue && now - lastAgeProbe >= AGE_PROBE_INTERVAL_MS
    if (!sizeDue && !ageDue) return undefined
    lastAgeProbe = now
    return rotateUsageLedger({ ...options, observedBytes: hotBytes, now })
  } catch {
    // Maintenance must never fail the usage read that triggered it.
    return undefined
  }
}

/** The latest rotation attempt, for diagnostics and tests. */
export function lastUsageRotation(): UsageRotationResult | undefined {
  if (lastRotation === undefined) return undefined
  return { ...lastRotation, archives: lastRotation.archives.map(archive => ({ ...archive })) }
}

/**
 * Read every archived usage row, oldest archive file first.
 *
 * Read failures and per-file damage are reported in `problems`; they never
 * throw away the hot rows the caller can still read.
 *
 * @param validate - the same row validator the hot file is read with.
 * @returns archived rows plus explicit damage.
 */
export function readUsageArchive<T = unknown>(validate?: (row: unknown) => boolean): UsageArchiveRead<T> {
  const directory = USAGE_ARCHIVE_DIR()
  const result: UsageArchiveRead<T> = { rows: [], files: [], problems: [] }
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    result.problems.push(`用量归档目录读取失败 ${directory}：${error instanceof Error ? error.message : String(error)}`)
    return result
  }
  for (const name of names.filter(entry => /^\d{4}\.jsonl$/.test(entry)).sort()) {
    const path = join(directory, name)
    try {
      result.rows.push(...readJsonLinesLenient<T>(path, validate))
      result.files.push(path)
      for (const issue of storageStatus([path]).diagnostics) result.problems.push(`${path}: ${issue.message}`)
    } catch (error) {
      result.problems.push(`用量归档读取失败 ${path}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
