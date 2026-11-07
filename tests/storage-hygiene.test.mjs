/**
 * P0 storage hygiene: pre-compaction backup retention.
 *
 * These tests exercise the public retention entry point directly (a plain
 * directory, so no journal is involved) plus one real compaction pass to prove
 * the policy is wired into `compactJournalLocked` and that a legacy 100MB-class
 * backup is removed on the next compaction.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); fs.mkdirSync(base, { recursive: true })
const home = fs.mkdtempSync(join(base, 'storage-hygiene-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
// Compaction is configured per test; nothing here may need a real journal.
process.env.DSH_BUTLER_JOURNAL_COMPACT_BYTES = '100000000'
process.env.DSH_BUTLER_JOURNAL_KEEP_COMMITTED = '100'
const vault = await import('../src/host/vault.ts')
const store = await import('../src/host/store.ts')
vault.ensureVault()

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const MB = 1024 * 1024

function directory(name) {
  const path = join(home, name)
  fs.mkdirSync(path, { recursive: true })
  return path
}

/** Create one fake `backup-*.jsonl` and stamp its mtime. */
function backup(parent, name, { daysAgo = 0, bytes = 100 } = {}) {
  const path = join(parent, name)
  fs.writeFileSync(path, 'x'.repeat(bytes))
  const at = new Date(NOW - daysAgo * DAY)
  fs.utimesSync(path, at, at)
  return path
}

function names(parent) {
  return fs.readdirSync(parent).sort()
}

function auditRows(parent) {
  const path = join(parent, 'retention-audit.jsonl')
  if (!fs.existsSync(path)) return []
  return fs.readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

test('the newest backup is chosen by generation time, not by the SHA in its name', () => {
  const dir = directory('name-vs-time')
  // Real names are `backup-<sha16>-<timestamp>`: the hash sorts first, so
  // lexicographic name order would protect the older file and delete the newer.
  const older = backup(dir, 'backup-ffold-2026-10-01T000000000Z.jsonl', { daysAgo: 30, bytes: 100 })
  const newer = backup(dir, 'backup-00new-2026-11-07T000000000Z.jsonl', { daysAgo: 0, bytes: 100 })
  const result = store.retainCompactionBackups(dir, { now: NOW })
  assert.deepEqual(result.deleted, ['backup-ffold-2026-10-01T000000000Z.jsonl'])
  assert.ok(fs.existsSync(newer), 'the actual newest generation must be the protected one')
  assert.equal(fs.existsSync(older), false)
})

test('the newest backup survives even when it is the only one over both limits', () => {
  const dir = directory('keep-newest')
  const old = backup(dir, 'backup-a-2026-10-01T000000000Z.jsonl', { daysAgo: 30, bytes: 1000 })
  const older = backup(dir, 'backup-b-2026-10-02T000000000Z.jsonl', { daysAgo: 20, bytes: 1000 })
  const newest = backup(dir, 'backup-c-2026-11-07T000000000Z.jsonl', { bytes: 1000 })

  const result = store.retainCompactionBackups(dir, { now: NOW, maxBytes: 1 })
  assert.equal(result.applied, true)
  assert.deepEqual(result.deleted, ['backup-a-2026-10-01T000000000Z.jsonl', 'backup-b-2026-10-02T000000000Z.jsonl'])
  assert.deepEqual(result.failed, [])
  assert.ok(fs.existsSync(newest), 'newest backup is the downgrade path and must never be deleted')
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(older), false)
  assert.equal(result.bytesBefore, 3000)
  assert.equal(result.bytesAfter, 1000, 'bytesAfter reports the retained bytes even above maxBytes')
  assert.ok(result.bytesAfter > result.policy.maxBytes, 'the protected newest backup may exceed the budget alone')
  // The plan is audited before the first deletion.
  const audit = auditRows(dir)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].kind, 'compaction-backup-retention')
  assert.deepEqual(audit[0].deleting.map(entry => entry.name), result.deleted)
})

test('non-newest backups older than seven days are deleted; fresh ones stay', () => {
  const dir = directory('age-window')
  const old = backup(dir, 'backup-old8-2026-10-30T000000000Z.jsonl', { daysAgo: 8, bytes: 300 })
  const fresh = backup(dir, 'backup-fresh6-2026-11-01T000000000Z.jsonl', { daysAgo: 6, bytes: 300 })
  const newest = backup(dir, 'backup-newest-2026-11-07T000000000Z.jsonl', { daysAgo: 0, bytes: 300 })

  const result = store.retainCompactionBackups(dir, { now: NOW, maxBytes: 1e9 })
  assert.equal(result.reason, 'age')
  assert.deepEqual(result.deleted, ['backup-old8-2026-10-30T000000000Z.jsonl'])
  assert.ok(fs.existsSync(fresh), 'a non-newest backup inside the age window is retained')
  assert.ok(fs.existsSync(newest))
  assert.equal(fs.existsSync(old), false)
  assert.equal(result.policy.days, 7)
})

test('total bytes above the cap delete the oldest backups first', () => {
  const dir = directory('total-bytes')
  const files = ['a', 'b', 'c', 'd'].map(letter => backup(dir, `backup-${letter}-2026-11-07T000000000Z.jsonl`, { bytes: 100 }))
  const result = store.retainCompactionBackups(dir, { now: NOW, maxBytes: 250 })
  assert.equal(result.reason, 'total-bytes')
  assert.deepEqual(result.deleted, ['backup-a-2026-11-07T000000000Z.jsonl', 'backup-b-2026-11-07T000000000Z.jsonl'])
  assert.equal(result.bytesAfter, 200)
  assert.equal(fs.existsSync(files[0]), false)
  assert.equal(fs.existsSync(files[1]), false)
  assert.ok(fs.existsSync(files[2]))
  assert.ok(fs.existsSync(files[3]))
  // Age already removed nothing, so every deletion names its real reason.
  assert.deepEqual(auditRows(dir)[0].deleting.map(entry => entry.reason), ['over-max-bytes', 'over-max-bytes'])
})

test('environment variables override the retention policy and invalid values fall back', () => {
  const dir = directory('env-override')
  const old = backup(dir, 'backup-old2-2026-11-05T000000000Z.jsonl', { daysAgo: 2, bytes: 100 })
  const newest = backup(dir, 'backup-newest-2026-11-07T000000000Z.jsonl', { bytes: 100 })
  process.env.DSH_BUTLER_COMPACT_BACKUP_DAYS = '1'
  process.env.DSH_BUTLER_COMPACT_BACKUP_MAX_BYTES = '250'
  try {
    const result = store.retainCompactionBackups(dir, { now: NOW })
    assert.equal(result.policy.days, 1)
    assert.equal(result.policy.maxBytes, 250)
    assert.equal(result.policy.keepNewest, 1)
    assert.deepEqual(result.deleted, ['backup-old2-2026-11-05T000000000Z.jsonl'])
    assert.ok(fs.existsSync(newest))
    assert.equal(fs.existsSync(old), false)
    // Values that cannot be a positive safe integer must not disable retention.
    process.env.DSH_BUTLER_COMPACT_BACKUP_DAYS = '0'
    process.env.DSH_BUTLER_COMPACT_BACKUP_MAX_BYTES = 'not-a-number'
    const fallback = store.retainCompactionBackups(directory('env-invalid'), { now: NOW })
    assert.equal(fallback.policy.days, 7)
    assert.equal(fallback.policy.maxBytes, 64 * MB)
  } finally {
    delete process.env.DSH_BUTLER_COMPACT_BACKUP_DAYS
    delete process.env.DSH_BUTLER_COMPACT_BACKUP_MAX_BYTES
  }
})

test('a second pass is a no-op and reports the retained bytes honestly', () => {
  const dir = directory('idempotent')
  backup(dir, 'backup-old-2026-10-01T000000000Z.jsonl', { daysAgo: 30, bytes: 700 })
  const newest = backup(dir, 'backup-new-2026-11-07T000000000Z.jsonl', { bytes: 300 })
  const first = store.retainCompactionBackups(dir, { now: NOW })
  assert.equal(first.applied, true)
  const second = store.retainCompactionBackups(dir, { now: NOW })
  assert.equal(second.applied, false)
  assert.deepEqual(second.deleted, [])
  assert.deepEqual(second.failed, [])
  assert.equal(second.bytesBefore, 300)
  assert.equal(second.bytesAfter, 300)
  assert.equal(fs.statSync(newest).size, 300)
  // The audit is not spammed for a pass that planned nothing.
  assert.equal(auditRows(dir).length, 1)
})

test('a failed delete is reported, never blocks the others, and compaction stays safe', () => {
  const dir = directory('delete-failure')
  const locked = backup(dir, 'backup-locked-2026-10-01T000000000Z.jsonl', { daysAgo: 30, bytes: 100 })
  const other = backup(dir, 'backup-other-2026-10-02T000000000Z.jsonl', { daysAgo: 30, bytes: 100 })
  const newest = backup(dir, 'backup-newest-2026-11-07T000000000Z.jsonl', { bytes: 100 })
  const originalUnlink = fs.unlinkSync
  fs.unlinkSync = function patchedUnlink(path, ...args) {
    if (resolve(String(path)) === resolve(locked)) {
      const error = new Error('simulated sharing violation')
      error.code = 'EPERM'
      throw error
    }
    return originalUnlink.call(this, path, ...args)
  }
  syncBuiltinESMExports()
  try {
    const result = store.retainCompactionBackups(dir, { now: NOW })
    assert.equal(result.applied, true, 'the pass still deletes everything it can')
    assert.deepEqual(result.deleted, ['backup-other-2026-10-02T000000000Z.jsonl'])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].name, 'backup-locked-2026-10-01T000000000Z.jsonl')
    assert.match(result.failed[0].error, /sharing violation/)
    assert.ok(fs.existsSync(locked), 'a failed delete keeps the original bytes')
    assert.equal(fs.existsSync(other), false)
    assert.ok(fs.existsSync(newest))
  } finally {
    fs.unlinkSync = originalUnlink
    syncBuiltinESMExports()
  }
  const audit = auditRows(dir)
  assert.equal(audit.at(-1).kind, 'compaction-backup-retention-failure')
  assert.equal(audit.at(-1).failed[0].name, 'backup-locked-2026-10-01T000000000Z.jsonl')
})

test('an audit write failure does not stop the agreed deletions', () => {
  const dir = directory('audit-failure')
  // A directory where the audit file should be makes every append fail.
  fs.mkdirSync(join(dir, 'retention-audit.jsonl'))
  const old = backup(dir, 'backup-old-2026-10-01T000000000Z.jsonl', { daysAgo: 30, bytes: 100 })
  const newest = backup(dir, 'backup-new-2026-11-07T000000000Z.jsonl', { bytes: 100 })
  const result = store.retainCompactionBackups(dir, { now: NOW })
  assert.equal(result.auditPath, undefined)
  assert.equal(result.applied, true)
  assert.deepEqual(result.deleted, ['backup-old-2026-10-01T000000000Z.jsonl'])
  assert.equal(fs.existsSync(old), false)
  assert.ok(fs.existsSync(newest))
})

test('non-backup files and directories in the same directory are never touched', () => {
  const dir = directory('non-backup')
  const compaction = join(dir, 'compaction-abcdef.json')
  const readme = join(dir, 'README.md')
  const audit = join(dir, 'retention-audit.jsonl')
  const nested = join(dir, 'backup-subdirectory')
  fs.writeFileSync(compaction, '{"kept":true}\n')
  fs.writeFileSync(readme, 'owner notes\n')
  fs.writeFileSync(audit, 'pre-existing audit line\n')
  fs.mkdirSync(nested)
  fs.writeFileSync(join(nested, 'inside.txt'), 'keep\n')
  // A non-backup name that merely contains the word must stay too.
  fs.writeFileSync(join(dir, 'notes-about-backup.txt'), 'keep\n')
  const old = backup(dir, 'backup-old-2026-10-01T000000000Z.jsonl', { daysAgo: 30, bytes: 100 })
  const newest = backup(dir, 'backup-new-2026-11-07T000000000Z.jsonl', { bytes: 100 })

  const result = store.retainCompactionBackups(dir, { now: NOW })
  assert.deepEqual(result.deleted, ['backup-old-2026-10-01T000000000Z.jsonl'])
  assert.equal(fs.existsSync(old), false)
  assert.ok(fs.existsSync(newest), 'the newest backup stays protected')
  for (const path of [compaction, readme, join(nested, 'inside.txt'), join(dir, 'notes-about-backup.txt')]) {
    assert.ok(fs.existsSync(path), `${path} must survive retention`)
  }
  assert.equal(fs.readFileSync(compaction, 'utf8'), '{"kept":true}\n')
  assert.equal(fs.readFileSync(readme, 'utf8'), 'owner notes\n')
  // The audit file is appended to, never truncated.
  assert.ok(fs.readFileSync(audit, 'utf8').startsWith('pre-existing audit line\n'))
  assert.equal(fs.readdirSync(nested).length, 1)
})

test('a real journal compaction runs retention and drops an oversized legacy backup', () => {
  const snapshot = vault.statePath('hygiene-target.json')
  fs.writeFileSync(snapshot, 'start\n')
  for (let index = 0; index < 12; index += 1) {
    store.commitFiles({
      operationId: `hygiene-${index}`,
      kind: 'test.hygiene',
      targetId: `target-${index}`,
      result: { index },
      writes: [{ path: snapshot, content: `content ${index}\n`.repeat(200) }],
    })
  }
  const journal = vault.statePath('store-operations.jsonl')
  const before = fs.readFileSync(journal)
  assert.ok(before.length > 4096, `fixture must exceed the shared limit, got ${before.length}`)

  const directory = vault.statePath('store-compactions')
  fs.mkdirSync(directory, { recursive: true })
  // `-` sorts before every hex sha prefix, so this file is the oldest generation.
  const legacy = join(directory, 'backup--legacy-2026-10-01T000000000Z.jsonl')
  fs.writeFileSync(legacy, 'legacy backup\n')
  const legacyAt = new Date(Date.now() - 30 * DAY)
  fs.utimesSync(legacy, legacyAt, legacyAt)

  process.env.DSH_BUTLER_JOURNAL_COMPACT_BYTES = '4096'
  store.recoverOperations()
  const after = fs.readFileSync(journal)
  assert.ok(after.length < before.length, 'compaction must shrink the journal')
  assert.match(after.toString('utf8'), /"phase":"checkpoint"/)
  assert.equal(store.storageStatus([journal]).degraded, false)
  assert.equal(fs.existsSync(legacy), false, 'the old legacy backup is released during compaction')

  const backups = fs.readdirSync(directory).filter(name => name.startsWith('backup-'))
  assert.equal(backups.length, 1, 'the new backup is the only retained generation')
  const fresh = join(directory, backups[0])
  assert.notEqual(fresh, legacy)
  assert.equal(fs.statSync(fresh).size, before.length, 'the pre-compaction bytes are preserved')
  const metadata = fs.readdirSync(directory).find(name => name.startsWith('compaction-') && name.endsWith('.json'))
  assert.ok(metadata, 'compaction metadata must be recorded')
  const audit = JSON.parse(fs.readFileSync(join(directory, metadata), 'utf8'))
  assert.equal(audit.backupPath, fresh)
  assert.ok(fs.existsSync(audit.backupPath))
  const retentionLog = auditRows(directory)
  assert.ok(retentionLog.some(row => row.kind === 'compaction-backup-retention'
    && row.deleting.some(entry => entry.name === 'backup--legacy-2026-10-01T000000000Z.jsonl')))
})
