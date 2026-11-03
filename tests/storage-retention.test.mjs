import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'storage-retention-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
// Compaction is configured per call so the fixture can grow before the threshold.
process.env.DSH_BUTLER_JOURNAL_COMPACT_BYTES = '100000000'
process.env.DSH_BUTLER_JOURNAL_KEEP_COMMITTED = '100'
const vault = await import('../src/host/vault.ts')
const store = await import('../src/host/store.ts')
vault.ensureVault()
const journal = vault.statePath('store-operations.jsonl')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('an oversized journal compacts committed history into idempotent checkpoints', () => {
  const snapshot = vault.statePath('compaction-target.json')
  writeFileSync(snapshot, 'start\n')
  for (let i = 0; i < 12; i++) {
    store.commitFiles({
      operationId: `compact-${i}`, kind: 'test.compaction', targetId: `target-${i}`, result: { index: i },
      writes: [{ path: snapshot, content: `content ${i}\n`.repeat(200) }],
    })
  }
  const before = readFileSync(journal)
  assert.ok(before.length > 4096, `fixture must exceed the shared limit, got ${before.length}`)
  // Lower the limit now: the next read compacts before paying another full hash.
  process.env.DSH_BUTLER_JOURNAL_COMPACT_BYTES = '4096'
  store.recoverOperations()
  const after = readFileSync(journal)
  assert.ok(after.length < before.length, 'compaction must shrink the journal')
  assert.match(after.toString('utf8'), /"phase":"checkpoint"/)
  assert.doesNotMatch(after.toString('utf8'), /"writes"/)
  assert.equal(store.storageStatus([journal]).degraded, false)
  // Idempotent replay survives compaction: the result is kept, writes are not re-applied.
  const repeated = store.commitFiles({
    operationId: 'compact-3', kind: 'test.compaction', targetId: 'target-3', result: null,
    writes: [{ path: snapshot, content: 'must not be written\n' }],
  })
  assert.deepEqual(repeated, { index: 3 })
  assert.equal(readFileSync(snapshot, 'utf8'), `content 11\n`.repeat(200))
  assert.deepEqual(store.readCommittedOperation('compact-3')?.result, { index: 3 })
  // Maintenance audit and a bounded pre-compaction backup are recorded.
  const directory = vault.statePath('store-compactions')
  const entries = readdirSync(directory)
  const compaction = entries.find(name => name.startsWith('compaction-') && name.endsWith('.json'))
  const backup = entries.find(name => name.startsWith('backup-') && name.endsWith('.jsonl'))
  assert.ok(compaction, 'compaction metadata must be recorded')
  assert.ok(backup, 'pre-compaction backup must exist below the size limit')
  const audit = JSON.parse(readFileSync(join(directory, compaction), 'utf8'))
  assert.equal(audit.beforeSha256, digest(before))
  assert.equal(audit.afterSha256, digest(after))
  assert.equal(audit.beforeBytes, before.length)
  assert.equal(audit.afterBytes, after.length)
  assert.equal(audit.backupPath !== null, true)
  assert.deepEqual(readFileSync(audit.backupPath), before, 'pre-compaction backup must preserve every original journal byte')
})

test('an unterminated torn tail is preserved as evidence then trimmed so writes continue', () => {
  const snapshot = vault.statePath('torn-target.json')
  writeFileSync(snapshot, 'torn-start\n')
  store.commitFiles({
    operationId: 'torn-committed', kind: 'test.torn', targetId: 'torn', result: { ok: true },
    writes: [{ path: snapshot, content: 'torn-content\n' }],
  })
  const valid = readFileSync(journal)
  const torn = Buffer.concat([valid, Buffer.from('{"version":1,"phase":"prepared","operationId":"torn-')])
  writeFileSync(journal, torn)
  store.recoverOperations()
  assert.deepEqual(readFileSync(journal), valid)
  const failurePath = join(vault.statePath('store-failures'), `${digest(torn)}.jsonl`)
  assert.ok(existsSync(failurePath), 'the exact torn bytes must be preserved')
  assert.deepEqual(readFileSync(failurePath), torn)
  const repairs = readdirSync(vault.statePath('store-repairs'))
  assert.equal(repairs.length, 1)
  const repair = JSON.parse(readFileSync(join(vault.statePath('store-repairs'), repairs[0]), 'utf8'))
  assert.equal(repair.journalSha256, digest(torn))
  assert.equal(repair.truncatedBytes, torn.length - valid.length)
  assert.equal(repair.keptBytes, valid.length)
  assert.equal(store.storageStatus([journal]).degraded, false)
  // The same generation accepts the next durable write.
  const next = store.commitFiles({
    operationId: 'torn-after', kind: 'test.torn', targetId: 'torn', result: { after: true },
    writes: [{ path: snapshot, content: 'after\n' }],
  })
  assert.deepEqual(next, { after: true })
  assert.equal(readFileSync(snapshot, 'utf8'), 'after\n')
})

test('a terminated malformed line still fails closed and keeps every byte', () => {
  const before = readFileSync(journal)
  const damaged = Buffer.concat([before, Buffer.from('{torn\n')])
  writeFileSync(journal, damaged)
  assert.throws(() => store.recoverOperations(), error => error instanceof store.StorageError)
  assert.deepEqual(readFileSync(journal), damaged)
})

test('a torn first record fails closed instead of truncating the journal to empty', () => {
  writeFileSync(journal, '{"version":1,"phase":"prepared","operationId":"first')
  assert.throws(() => store.recoverOperations(), error => error instanceof store.StorageError)
  assert.deepEqual(readFileSync(journal), Buffer.from('{"version":1,"phase":"prepared","operationId":"first'))
})
