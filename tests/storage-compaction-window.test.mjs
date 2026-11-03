import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'storage-window-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_JOURNAL_COMPACT_BYTES = '100000000'
process.env.DSH_BUTLER_JOURNAL_KEEP_COMMITTED = '3'
const vault = await import('../src/host/vault.ts')
const store = await import('../src/host/store.ts')
vault.ensureVault()
const journal = vault.statePath('store-operations.jsonl')

test('the committed retention window keeps only the newest identities', () => {
  const snapshot = vault.statePath('window-target.json')
  writeFileSync(snapshot, 'start\n')
  for (let i = 0; i < 8; i++) {
    store.commitFiles({
      operationId: `window-${i}`, kind: 'test.window', targetId: `window-${i}`, result: { i },
      writes: [{ path: snapshot, content: `window ${i}\n` }],
    })
  }
  process.env.DSH_BUTLER_JOURNAL_COMPACT_BYTES = '1'
  store.recoverOperations()
  const text = readFileSync(journal, 'utf8')
  const checkpoints = text.split('\n').filter(line => line.includes('"phase":"checkpoint"'))
  assert.equal(checkpoints.length, 3, 'only the configured window is retained')
  const ids = checkpoints.map(line => JSON.parse(line).operationId)
  assert.deepEqual(ids, ['window-5', 'window-6', 'window-7'], 'newest identities win')
  assert.equal(store.storageStatus([journal]).degraded, false)
  // A retained id still replays idempotently; a dropped id is simply unknown.
  assert.deepEqual(store.readCommittedOperation('window-7')?.result, { i: 7 })
  assert.equal(store.readCommittedOperation('window-0'), undefined)
})
