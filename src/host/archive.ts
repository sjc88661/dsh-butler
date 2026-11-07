/**
 * Fixture archive index: the read-only reason list the workbench consults
 * before showing a ledger item.
 *
 * October acceptance runs left test tasks, reminders and receipts in the real
 * ledger. Archiving them must not delete or rewrite ledger bytes - the ledger is
 * append-only evidence - so the archive is a side index under
 * `vault/archive/index.json`; the ledger keeps every row, and a reader may hide
 * (never remove) the ids the index names.
 *
 * Fail-open by design: a missing or damaged index means "nothing is archived"
 * (every `isArchived*` returns false). Hiding a real item behind a display
 * filter would be worse than showing a fixture, so damage never throws into the
 * workbench path.
 *
 * @module @dsh-external/dsh-butler/host/archive
 */
import { statSync } from 'node:fs'
import { readText, vaultPath } from './vault.ts'

/** Schema version of `vault/archive/index.json`. */
export const ARCHIVE_INDEX_VERSION = 1

/** The archive index every `isArchived*` reader consults. */
export const ARCHIVE_INDEX_FILE = (): string => vaultPath('archive', 'index.json')

/** One archived task id. */
export interface ArchivedTaskEntry {
  id: string
  title?: string
  /** Why it was archived, human-readable. */
  reason: string
  /** The fixture token/rule that matched. */
  matchedBy: string
  /** Which archive batch produced this entry. */
  batchId: string
}

/** One archived reminder, identified by its native schedule id or execution key. */
export interface ArchivedReminderEntry {
  scheduleId?: string
  executionKey?: string
  title?: string
  reason: string
  matchedBy: string
  batchId: string
}

/** One archived receipt, identified by its call id or `at|tool` key. */
export interface ArchivedReceiptEntry {
  key: string
  at?: string
  tool?: string
  reason: string
  matchedBy: string
  batchId: string
}

/** One archive batch, as written by `scripts/archive-fixtures.mjs`. */
export interface ArchiveBatch {
  batchId: string
  createdAt?: string
  /** Batch-relative manifest path, when the batch wrote one. */
  manifest?: string
  counts?: Record<string, number>
  tasks: ArchivedTaskEntry[]
  reminders: ArchivedReminderEntry[]
  receipts: ArchivedReceiptEntry[]
}

/** The complete archive index. Batches compound; older entries stay archived. */
export interface ArchiveIndex {
  version: typeof ARCHIVE_INDEX_VERSION
  updatedAt?: string
  batches: ArchiveBatch[]
}

interface CompiledArchive {
  index: ArchiveIndex
  taskIds: Set<string>
  reminderKeys: Set<string>
  receiptKeys: Set<string>
}

let cached: { signature: string; compiled: CompiledArchive } | undefined

const emptyIndex = (): ArchiveIndex => ({ version: ARCHIVE_INDEX_VERSION, batches: [] })

function indexSignature(path: string): string {
  try {
    const stat = statSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`
  }
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** Keep only entries with an identity; a damaged entry must not hide anything. */
function normalizeBatch(value: unknown): ArchiveBatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!nonempty(record['batchId'])) return undefined
  const batchId = record['batchId']
  const entries = <T>(input: unknown, read: (row: Record<string, unknown>) => T | undefined): T[] =>
    Array.isArray(input) ? input.map(row => typeof row === 'object' && row !== null && !Array.isArray(row)
      ? read(row as Record<string, unknown>) : undefined).filter((row): row is T => row !== undefined) : []
  const reasonOf = (row: Record<string, unknown>): { reason: string; matchedBy: string } => ({
    reason: nonempty(row['reason']) ? row['reason'] : '未注明原因',
    matchedBy: nonempty(row['matchedBy']) ? row['matchedBy'] : 'unknown',
  })
  const batch: ArchiveBatch = {
    batchId,
    ...(nonempty(record['createdAt']) ? { createdAt: record['createdAt'] } : {}),
    ...(nonempty(record['manifest']) ? { manifest: record['manifest'] } : {}),
    ...(typeof record['counts'] === 'object' && record['counts'] !== null && !Array.isArray(record['counts'])
      ? { counts: Object.fromEntries(Object.entries(record['counts'] as Record<string, unknown>)
        .filter(([, count]) => typeof count === 'number' && Number.isFinite(count)) as Array<[string, number]>) }
      : {}),
    tasks: entries(record['tasks'], row => nonempty(row['id']) ? {
      id: row['id'], ...(nonempty(row['title']) ? { title: row['title'] } : {}), ...reasonOf(row), batchId,
    } : undefined),
    reminders: entries(record['reminders'], row => {
      const scheduleId = nonempty(row['scheduleId']) ? row['scheduleId'] : undefined
      const executionKey = nonempty(row['executionKey']) ? row['executionKey'] : undefined
      if (scheduleId === undefined && executionKey === undefined) return undefined
      return {
        ...(scheduleId === undefined ? {} : { scheduleId }),
        ...(executionKey === undefined ? {} : { executionKey }),
        ...(nonempty(row['title']) ? { title: row['title'] } : {}), ...reasonOf(row), batchId,
      }
    }),
    receipts: entries(record['receipts'], row => nonempty(row['key']) ? {
      key: row['key'],
      ...(nonempty(row['at']) ? { at: row['at'] } : {}),
      ...(nonempty(row['tool']) ? { tool: row['tool'] } : {}),
      ...reasonOf(row), batchId,
    } : undefined),
  }
  return batch
}

function normalizeIndex(value: unknown): ArchiveIndex | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['version'] !== ARCHIVE_INDEX_VERSION || !Array.isArray(record['batches'])) return undefined
  return {
    version: ARCHIVE_INDEX_VERSION,
    ...(nonempty(record['updatedAt']) ? { updatedAt: record['updatedAt'] } : {}),
    batches: record['batches'].map(normalizeBatch).filter((batch): batch is ArchiveBatch => batch !== undefined),
  }
}

function compile(index: ArchiveIndex): CompiledArchive {
  const taskIds = new Set<string>(), reminderKeys = new Set<string>(), receiptKeys = new Set<string>()
  for (const batch of index.batches) {
    for (const entry of batch.tasks) taskIds.add(entry.id)
    for (const entry of batch.reminders) {
      if (entry.scheduleId !== undefined) reminderKeys.add(entry.scheduleId)
      if (entry.executionKey !== undefined) reminderKeys.add(entry.executionKey)
    }
    for (const entry of batch.receipts) receiptKeys.add(entry.key)
  }
  return { index, taskIds, reminderKeys, receiptKeys }
}

/** Read the archive index, cached by file identity; a missing/damaged file is empty. */
function compiledArchive(): CompiledArchive {
  const path = ARCHIVE_INDEX_FILE()
  const signature = indexSignature(path)
  if (cached?.signature === signature) return cached.compiled
  let index = emptyIndex()
  try {
    const text = readText(path)
    if (text !== undefined) index = normalizeIndex(JSON.parse(text) as unknown) ?? emptyIndex()
  } catch {
    // Fail open: a damaged archive index must not break the workbench path.
    index = emptyIndex()
  }
  const compiled = compile(index)
  cached = { signature, compiled }
  return compiled
}

/**
 * The complete parsed archive index.
 * @returns every batch; empty when nothing has been archived yet.
 */
export function readArchiveIndex(): ArchiveIndex {
  return structuredClone(compiledArchive().index)
}

/** @returns every archived task entry, flattened across batches. */
export function archivedTasks(): ArchivedTaskEntry[] {
  return compiledArchive().index.batches.flatMap(batch => batch.tasks.map(entry => ({ ...entry })))
}

/** @returns every archived reminder entry, flattened across batches. */
export function archivedReminders(): ArchivedReminderEntry[] {
  return compiledArchive().index.batches.flatMap(batch => batch.reminders.map(entry => ({ ...entry })))
}

/** @returns every archived receipt entry, flattened across batches. */
export function archivedReceipts(): ArchivedReceiptEntry[] {
  return compiledArchive().index.batches.flatMap(batch => batch.receipts.map(entry => ({ ...entry })))
}

/** @returns a copy of the archived task-id set, for bulk filtering. */
export function archivedTaskIds(): Set<string> {
  return new Set(compiledArchive().taskIds)
}

/** @returns a copy of the archived reminder-key set (schedule ids and execution keys). */
export function archivedReminderKeys(): Set<string> {
  return new Set(compiledArchive().reminderKeys)
}

/** @returns a copy of the archived receipt-key set. */
export function archivedReceiptKeys(): Set<string> {
  return new Set(compiledArchive().receiptKeys)
}

/**
 * Whether a task id was archived as an acceptance fixture.
 * @param id - task id.
 * @returns false when the archive index is missing or does not name the id.
 */
export function isArchivedTask(id: string): boolean {
  return nonempty(id) && compiledArchive().taskIds.has(id)
}

/**
 * Whether a reminder was archived as an acceptance fixture.
 * @param scheduleId - native schedule id or reminder execution key.
 * @returns false when the archive index is missing or does not name the reminder.
 */
export function isArchivedReminder(scheduleId: string): boolean {
  return nonempty(scheduleId) && compiledArchive().reminderKeys.has(scheduleId)
}

/**
 * Whether a receipt was archived as an acceptance fixture.
 * @param key - receipt call id, or the fallback `at|tool` key.
 * @returns false when the archive index is missing or does not name the receipt.
 */
export function isArchivedReceipt(key: string): boolean {
  return nonempty(key) && compiledArchive().receiptKeys.has(key)
}

/** Drop the in-process cache; used when tests rewrite the index between cases. */
export function clearArchiveIndexCache(): void {
  cached = undefined
}
