/**
 * 备份/恢复：快照内容、策略排除、保留数量、SHA256 校验、确认词与 pre-restore。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { createBackup, listBackups, planRestore, restoreBackup } = await import('../src/host/backup.ts')

function seed() {
  const root = mkdtempSync(join('tests/.tmp', 'backup-'))
  const vault = join(root, 'vault'), state = join(root, 'state'), backups = join(state, 'backups')
  mkdirSync(join(vault, 'notes'), { recursive: true })
  mkdirSync(join(vault, 'ledger'), { recursive: true })
  mkdirSync(join(state, 'cache'), { recursive: true })
  mkdirSync(join(state, 'logs'), { recursive: true })
  writeFileSync(join(vault, 'notes', 'a.md'), '# A\n\noriginal note\n')
  writeFileSync(join(vault, 'ledger', 'tasks.jsonl'), `${JSON.stringify({ id: 't1', title: 'one' })}\n`)
  writeFileSync(join(state, 'memos.json'), '[]\n')
  writeFileSync(join(state, 'cache', 'ignored.bin'), 'cache')
  writeFileSync(join(state, 'logs', 'ignored.log'), 'log')
  return { root, vault, state, backups }
}

test('a snapshot copies vault + durable state, records hashes and excludes regenerable dirs', () => {
  const seeded = seed()
  const options = { vaultHome: seeded.vault, stateHome: seeded.state, backupHome: seeded.backups,
    now: () => new Date('2026-11-07T05:00:00.000Z'), maxBackups: 5 }
  const result = createBackup(options)
  assert.equal(result.id, 'butler-backup-20261107T050000')
  assert.equal(result.manifest.counts.vault, 2)
  assert.equal(result.manifest.counts.state, 1)
  assert.equal(result.manifest.files.length, 3)
  assert.ok(result.manifest.bytes > 0)
  assert.ok(result.manifest.excluded.some(label => label.includes('cache')))
  assert.equal(existsSync(join(result.directory, 'state', 'cache', 'ignored.bin')), false)
  assert.equal(existsSync(join(result.directory, 'state', 'logs', 'ignored.log')), false)
  assert.equal(readFileSync(join(result.directory, 'vault', 'notes', 'a.md'), 'utf8'), '# A\n\noriginal note\n')
  const manifest = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.files.find(file => file.path === 'notes/a.md').sha256.length, 64)
  assert.deepEqual(listBackups(seeded.backups).map(entry => entry.id), [result.id])
})

test('snapshot retention keeps only the newest N', () => {
  const seeded = seed()
  const times = ['2026-11-07T05:00:00.000Z', '2026-11-07T06:00:00.000Z', '2026-11-07T07:00:00.000Z']
  for (const time of times) {
    createBackup({ vaultHome: seeded.vault, stateHome: seeded.state, backupHome: seeded.backups,
      now: () => new Date(time), maxBackups: 2 })
  }
  const listed = listBackups(seeded.backups)
  assert.equal(listed.length, 2)
  assert.deepEqual(listed.map(entry => entry.id), ['butler-backup-20261107T070000', 'butler-backup-20261107T060000'])
})

test('restore verifies hashes, writes files back and snapshots the pre-restore state', () => {
  const seeded = seed()
  const options = { vaultHome: seeded.vault, stateHome: seeded.state, backupHome: seeded.backups,
    now: () => new Date('2026-11-07T05:00:00.000Z'), maxBackups: 5 }
  const created = createBackup(options)
  writeFileSync(join(seeded.vault, 'notes', 'a.md'), '# A\n\nedited after backup\n')

  const plan = planRestore(seeded.backups, created.id)
  assert.equal(plan.writes.length, 3)
  const restored = restoreBackup(seeded.backups, created.id, 'RESTORE')
  assert.equal(restored.restored, 3)
  assert.equal(readFileSync(join(seeded.vault, 'notes', 'a.md'), 'utf8'), '# A\n\noriginal note\n')
  assert.ok(existsSync(join(seeded.backups, restored.preRestore, 'manifest.json')))
})

test('a wrong confirmation or a corrupted snapshot refuses without writing', () => {
  const seeded = seed()
  const options = { vaultHome: seeded.vault, stateHome: seeded.state, backupHome: seeded.backups,
    now: () => new Date('2026-11-07T05:00:00.000Z'), maxBackups: 5 }
  const created = createBackup(options)
  assert.throws(() => restoreBackup(seeded.backups, created.id, 'yes'), /RESTORE/)
  assert.throws(() => planRestore(seeded.backups, 'butler-backup-19990101T000000'), /没有这个备份/)

  const file = join(created.directory, 'vault', 'notes', 'a.md')
  writeFileSync(file, '# A\n\ntampered backup\n')
  writeFileSync(join(seeded.vault, 'notes', 'a.md'), '# A\n\ncurrent untouched\n')
  assert.throws(() => restoreBackup(seeded.backups, created.id, 'RESTORE'), /校验失败/)
  assert.equal(readFileSync(join(seeded.vault, 'notes', 'a.md'), 'utf8'), '# A\n\ncurrent untouched\n')
})