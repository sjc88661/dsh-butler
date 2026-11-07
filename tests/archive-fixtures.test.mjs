/**
 * P0 fixture hygiene: `scripts/archive-fixtures.mjs` is a read-only dry-run by
 * default, `--apply` only adds a snapshot/index and never touches the ledgers,
 * and `src/host/archive.ts` answers the `isArchived*` predicates from that index.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); fs.mkdirSync(base, { recursive: true })
const home = fs.mkdtempSync(join(base, 'archive-fixtures-'))
const vaultHome = join(home, 'vault')
const stateHome = join(home, 'state')
process.env.DSH_BUTLER_VAULT = vaultHome
process.env.DSH_BUTLER_HOME = stateHome
fs.mkdirSync(join(vaultHome, 'ledger'), { recursive: true })
fs.mkdirSync(stateHome, { recursive: true })

const SCRIPT = resolve('scripts/archive-fixtures.mjs')
const BATCH = '2026-10-fixtures'
const tasksFile = join(vaultHome, 'ledger', 'tasks.jsonl')
const receiptsFile = join(vaultHome, 'ledger', 'receipts.jsonl')
const manifestFile = join(vaultHome, 'archive', BATCH, 'manifest.json')
const indexFile = join(vaultHome, 'archive', 'index.json')
const { clearArchiveIndexCache, readArchiveIndex, archivedTaskIds, isArchivedTask,
  isArchivedReminder, isArchivedReceipt } = await import('../src/host/archive.ts')

const STAMP = '2026-10-15T00:00:00.000Z'
const tasks = [
  { id: 'task-linked-1', title: 'DSH007 验收 fixture', status: 'done', createdAt: STAMP, updatedAt: STAMP },
  { id: 'task-weak-1', title: '验收：10 月投递报告', status: 'done', createdAt: STAMP, updatedAt: STAMP },
  { id: 'task-real-1', title: '整理真实发票', status: 'pending', createdAt: STAMP, updatedAt: STAMP },
]
const receipts = [
  { callId: 'call-linked-1', taskId: 'task-linked-1', at: '2026-10-21T00:00:00.000Z', tool: 'butler_task', ok: true, summary: '回执' },
  { at: '2026-10-22T00:00:00.000Z', tool: 'butler_note', taskId: 'task-linked-1', ok: true },
  { callId: 'call-real-1', taskId: 'task-real-1', at: '2026-10-23T00:00:00.000Z', tool: 'butler_note', ok: true, summary: '真实笔记' },
  { callId: 'call-session-1', sessionId: 'session-butler007-demo', at: '2026-10-24T00:00:00.000Z', tool: 'butler_task', ok: true, summary: '投递回执' },
]
const operations = {
  version: 1,
  operations: {
    'exec-fixture-1': { action: 'create', scheduleId: 'sched-fixture-1', request: { title: 'DSH008 验收提醒' }, sourceSessionId: 'session-normal', identity: { sessionId: 'session-normal' } },
    'exec-real': { action: 'create', scheduleId: 'sched-real', request: { title: '喝水提醒' }, identity: { sessionId: 'session-real' } },
  },
}
const sessions = {
  version: 1,
  bindings: {
    'session-butler007-x': { id: 'binding-1', title: 'DSH_LIVE 投递', sourceSessionId: 'session-butler007-x' },
    'session-real': { id: 'binding-real', title: '真实会话', sourceSessionId: 'session-real' },
  },
}
fs.writeFileSync(tasksFile, `${tasks.map(task => JSON.stringify(task)).join('\n')}\n`)
fs.writeFileSync(receiptsFile, `${receipts.map(receipt => JSON.stringify(receipt)).join('\n')}\n`)
fs.writeFileSync(join(stateHome, 'reminder-operations.json'), `${JSON.stringify(operations, null, 2)}\n`)
fs.writeFileSync(join(stateHome, 'reminder-sessions.json'), `${JSON.stringify(sessions, null, 2)}\n`)

const digest = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex')

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, DSH_BUTLER_VAULT: vaultHome, DSH_BUTLER_HOME: stateHome },
  })
}

function parseReport(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function sourceLines(path) {
  return fs.readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
}

const ledgerBefore = { tasks: digest(tasksFile), receipts: digest(receiptsFile) }
const ledgerBytesBefore = { tasks: fs.readFileSync(tasksFile), receipts: fs.readFileSync(receiptsFile) }

function assertLedgersUntouched() {
  assert.equal(digest(tasksFile), ledgerBefore.tasks, 'tasks.jsonl is append-only evidence and must not change')
  assert.equal(digest(receiptsFile), ledgerBefore.receipts, 'receipts.jsonl is append-only evidence and must not change')
  assert.deepEqual(fs.readFileSync(tasksFile), ledgerBytesBefore.tasks)
  assert.deepEqual(fs.readFileSync(receiptsFile), ledgerBytesBefore.receipts)
  assert.equal(sourceLines(tasksFile).length, tasks.length)
  assert.equal(sourceLines(receiptsFile).length, receipts.length)
}

test('the default dry run reads the fixtures and writes nothing', () => {
  const vaultTopBefore = fs.readdirSync(vaultHome).sort()
  const result = runScript(['--dry-run', '--vault', vaultHome, '--state', stateHome])
  const report = parseReport(result)
  assert.equal(report.mode, 'dry-run')
  assert.equal(report.batch, BATCH)
  assert.equal(report.homes.vault, vaultHome)
  assert.deepEqual(report.written, [])
  assert.deepEqual(report.counts, { tasks: 2, reminders: 1, reminderOperations: 1, reminderSessions: 1, receipts: 3 })
  assert.deepEqual(report.tasks.map(entry => entry.id), ['task-linked-1', 'task-weak-1'])
  assert.ok(report.sources.every(source => source.exists === true))
  assert.equal(fs.existsSync(join(vaultHome, 'archive')), false, 'a dry run must not create the archive')
  assert.deepEqual(fs.readdirSync(vaultHome).sort(), vaultTopBefore)
  assertLedgersUntouched()
})

test('--apply writes the batch snapshot and index without deleting or rewriting ledger rows', () => {
  const result = runScript(['--apply', '--vault', vaultHome, '--state', stateHome])
  const report = parseReport(result)
  assert.equal(report.mode, 'apply')
  assert.ok(report.written.includes(manifestFile), `written must name the manifest: ${report.written.join(', ')}`)
  assert.ok(report.written.includes(indexFile))
  assert.ok(fs.existsSync(manifestFile))
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.batchId, BATCH)
  assert.deepEqual(manifest.counts, report.counts)
  assert.match(manifest.reason, /未删除、未改写/)
  assert.deepEqual(manifest.tasks.map(entry => entry.id), ['task-linked-1', 'task-weak-1'])
  assert.equal(JSON.stringify(manifest).includes('task-real-1'), false, 'unmatched ids never enter the snapshot')

  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  assert.equal(index.version, 1)
  assert.equal(index.batches.length, 1)
  const batch = index.batches[0]
  assert.equal(batch.batchId, BATCH)
  assert.equal(batch.manifest, `${BATCH}/manifest.json`)
  assert.deepEqual(batch.tasks.map(entry => entry.id), ['task-linked-1', 'task-weak-1'])
  assert.deepEqual(batch.reminders.map(entry => entry.scheduleId), ['sched-fixture-1'])
  assert.deepEqual(batch.receipts.map(entry => entry.key).sort(),
    ['2026-10-22T00:00:00.000Z|butler_note', 'call-linked-1', 'call-session-1'])

  // The batch copies the matched raw lines verbatim.
  const expectedTasks = sourceLines(tasksFile).filter(line => ['task-linked-1', 'task-weak-1'].includes(JSON.parse(line).id))
    .sort((left, right) => JSON.parse(left).id.localeCompare(JSON.parse(right).id))
  assert.deepEqual(sourceLines(join(vaultHome, 'archive', BATCH, 'tasks.jsonl')), expectedTasks)
  const expectedReceiptLines = sourceLines(receiptsFile)
    .filter(line => {
      const entry = JSON.parse(line)
      return entry.callId !== 'call-real-1'
    })
  assert.equal(sourceLines(join(vaultHome, 'archive', BATCH, 'receipts.jsonl')).length, expectedReceiptLines.length)
  assertLedgersUntouched()
})

test('a repeated --apply replaces its own batch instead of duplicating it', () => {
  const result = runScript(['--apply', '--vault', vaultHome, '--state', stateHome])
  parseReport(result)
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  assert.equal(index.batches.length, 1, 're-running the same batch must be idempotent')
  assert.equal(index.batches[0].batchId, BATCH)
  assert.deepEqual(index.batches[0].counts, { tasks: 2, reminders: 1, reminderOperations: 1, reminderSessions: 1, receipts: 3 })
  assertLedgersUntouched()
})

test('another batch compounds: earlier batches stay archived', () => {
  const result = runScript(['--apply', '--vault', vaultHome, '--state', stateHome, '--batch', '2026-11-extra'])
  assert.equal(parseReport(result).batch, '2026-11-extra')
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  assert.equal(index.batches.length, 2)
  assert.deepEqual(index.batches.map(batch => batch.batchId).sort(), ['2026-10-fixtures', '2026-11-extra'])
  assert.ok(fs.existsSync(join(vaultHome, 'archive', '2026-11-extra', 'manifest.json')))
  assertLedgersUntouched()
})

test('archive.ts predicates answer from the index and keep their cache in sync', () => {
  clearArchiveIndexCache()
  assert.equal(readArchiveIndex().batches.length, 2)
  assert.equal(isArchivedTask('task-linked-1'), true)
  assert.equal(isArchivedTask('task-weak-1'), true)
  assert.equal(isArchivedTask('task-real-1'), false)
  assert.equal(isArchivedTask(''), false)
  assert.equal(isArchivedTask('missing-task'), false)
  assert.equal(isArchivedReminder('sched-fixture-1'), true)
  assert.equal(isArchivedReminder('exec-fixture-1'), true)
  assert.equal(isArchivedReminder('sched-real'), false)
  assert.equal(isArchivedReceipt('call-linked-1'), true)
  assert.equal(isArchivedReceipt('call-session-1'), true)
  assert.equal(isArchivedReceipt('2026-10-22T00:00:00.000Z|butler_note'), true)
  assert.equal(isArchivedReceipt('call-real-1'), false)
  const ids = archivedTaskIds()
  assert.deepEqual([...ids].sort(), ['task-linked-1', 'task-weak-1'])
  ids.add('task-real-1')
  assert.equal(isArchivedTask('task-real-1'), false, 'the predicate set is a copy, callers cannot mutate it')
})

test('a damaged, missing, or future-version index fails open to "nothing archived"', () => {
  clearArchiveIndexCache()
  fs.writeFileSync(indexFile, '{not json')
  assert.equal(readArchiveIndex().batches.length, 0)
  assert.equal(isArchivedTask('task-linked-1'), false)
  assert.equal(isArchivedReminder('sched-fixture-1'), false)
  assert.equal(isArchivedReceipt('call-linked-1'), false)

  fs.rmSync(indexFile, { force: true })
  clearArchiveIndexCache()
  assert.equal(isArchivedTask('task-linked-1'), false, 'a missing index must not hide anything')

  fs.writeFileSync(indexFile, `${JSON.stringify({
    version: 2,
    batches: [{ batchId: 'future', tasks: [{ id: 'task-linked-1', reason: 'r', matchedBy: 'm' }] }],
  })}\n`)
  clearArchiveIndexCache()
  assert.equal(isArchivedTask('task-linked-1'), false, 'an unknown schema is empty, never guessed')
  assert.equal(readArchiveIndex().batches.length, 0)
})

test('conflicting or unknown flags fail before any write', () => {
  const conflict = runScript(['--apply', '--dry-run', '--vault', vaultHome, '--state', stateHome])
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stderr, /--apply 与 --dry-run 只能选一个/)

  const unknown = runScript(['--nope'])
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /未知参数/)
  assertLedgersUntouched()
})
