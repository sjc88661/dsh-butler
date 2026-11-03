import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'

const parent = resolve('tests/.tmp'); fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(join(parent, 'store-new-operation-'))
process.env.DSH_BUTLER_HOME = join(fixture, 'state'); process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts'), store = await import('../src/host/store.ts')
const peer = await import('../src/host/store.ts?new-operation-peer')
const journal = vault.statePath('store-operations.jsonl'), target = vault.statePath('value.txt')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = () => fs.readFileSync(journal)
const options = id => ({ operationId: id, kind: 'test.new-operation', targetId: 'value', result: { original: ['stable'] },
  writes: [{ path: target, content: 'changed\n' }] })
function removeOwned(path) {
  if (!fs.existsSync(path)) return
  assert.ok(fs.realpathSync(path).startsWith(fs.realpathSync(parent) + sep))
  fs.rmSync(path, { recursive: true, force: true })
}
beforeEach(() => {
  removeOwned(vault.STATE_HOME); removeOwned(vault.VAULT_HOME)
  vault.ensureVault(); fs.writeFileSync(target, 'original\n')
})
after(() => removeOwned(fixture))

function seed() {
  const rows = [], content = 'historical snapshot '.repeat(1024)
  for (let i = 0; i < 4; i++) {
    const row = { version: 1, phase: 'prepared', operationId: `historical-${i}`, kind: 'test.history', targetId: 'history', time: '2026-10-20T00:00:00.000Z',
      writes: [{ path: vault.statePath('historical.txt'), content, format: 'text', beforeSha256: null, afterSha256: hash(content) }] }
    const { writes: _, ...summary } = row
    rows.push(JSON.stringify(row), JSON.stringify({ ...summary, phase: 'committed' }))
  }
  fs.writeFileSync(journal, rows.join('\n') + '\n'); store.recoverOperations()
  return bytes()
}

/** Count real sequential journal bytes, preserving every underlying read/write/fsync. */
function withJournalIo(action, { failPrepareSync = false } = {}) {
  const names = ['openSync', 'closeSync', 'readSync', 'fsyncSync'], original = Object.fromEntries(names.map(name => [name, fs[name]]))
  const fds = new Map(), metrics = { scans: [], journalSyncs: 0 }; let failed = false
  fs.openSync = (path, ...args) => {
    const fd = original.openSync(path, ...args)
    fds.set(fd, { journal: typeof path === 'string' && resolve(path) === resolve(journal), read: 0 })
    return fd
  }
  fs.closeSync = fd => { try { return original.closeSync(fd) } finally { fds.delete(fd) } }
  fs.readSync = (fd, buffer, offset, length, position) => {
    const count = original.readSync(fd, buffer, offset, length, position), info = fds.get(fd)
    if (info?.journal && position === null) { info.read += count; if (count === 0) metrics.scans.push(info.read) }
    return count
  }
  fs.fsyncSync = fd => {
    if (fds.get(fd)?.journal) {
      if (failPrepareSync && !failed) { failed = true; throw Error('new-operation prepare fsync failed') }
      const value = original.fsyncSync(fd); metrics.journalSyncs++; return value
    }
    return original.fsyncSync(fd)
  }
  syncBuiltinESMExports()
  try { return { value: action(), metrics } }
  finally { for (const name of names) fs[name] = original[name]; syncBuiltinESMExports() }
}

test('a warm new commit scans each required generation and omits one redundant pre-prepare full scan', t => {
  const before = seed(); let validated = 0
  const { value, metrics } = withJournalIo(() => store.commitFiles({ ...options('new-id'), writes: [{ path: target, content: 'changed\n', validate: () => { validated++; return true } }] }))
  assert.deepEqual(value, { original: ['stable'] }); assert.equal(validated, 2)
  const current = bytes(), appended = current.subarray(before.length).toString('utf8').split('\n').filter(Boolean)
  const preparedBytes = Buffer.byteLength(appended[0] + '\n'), middleBytes = before.length + preparedBytes
  t.diagnostic(JSON.stringify({ beforeBytes: before.length, preparedBytes, finalBytes: current.length, ...metrics }))
  assert.equal(metrics.scans.length, 5, 'A new id needs one entry scan and the unchanged four full append fences')
  assert.deepEqual(metrics.scans, [before.length, before.length, middleBytes, middleBytes, current.length])
  assert.equal(metrics.scans.reduce((sum, size) => sum + size, 0), 2 * before.length + 2 * middleBytes + current.length)
  assert.equal(metrics.journalSyncs, 2, 'Prepared and committed rows both remain durably fenced')
  assert.ok(current.subarray(0, before.length).equals(before), 'Every historical byte must stay an exact prefix')
  assert.deepEqual(appended.map(line => JSON.parse(line).phase), ['prepared', 'committed'])
})

test('an existing id still revalidates the full journal after validators and returns an independent original result', () => {
  seed(); store.commitFiles(options('replay')); const before = bytes(); let validated = 0
  const { value, metrics } = withJournalIo(() => store.commitFiles({ ...options('replay'), result: null,
    writes: [{ path: target, content: 'discarded\n', validate: () => { validated++; return true } }] }))
  assert.equal(validated, 2); assert.deepEqual(value, { original: ['stable'] })
  assert.deepEqual(metrics.scans, [before.length, before.length]); assert.equal(metrics.journalSyncs, 0)
  value.original[0] = 'changed locally'
  assert.deepEqual(store.readCommittedOperation('replay').result, { original: ['stable'] })
  assert.deepEqual(bytes(), before); assert.equal(fs.readFileSync(target, 'utf8'), 'changed\n')
})

for (const field of ['kind', 'targetId']) test(`an existing id cannot return another ${field} result`, () => {
  seed(); store.commitFiles(options('identity')); const before = bytes()
  assert.throws(() => store.commitFiles({ ...options('identity'), [field]: 'another-owner' }), /operationId.*冲突/)
  assert.deepEqual(bytes(), before); assert.equal(fs.readFileSync(target, 'utf8'), 'changed\n')
})

for (const replay of [false, true]) test(`validator same-size/restored-mtime journal damage cannot produce a ${replay ? 'replayed' : 'new'} success`, () => {
  seed(); if (replay) store.commitFiles(options('tamper'))
  const before = bytes(), stamp = fs.statSync(journal), altered = Buffer.from(before)
  altered[0] = 91 // '[' makes the first physical row invalid without changing its size.
  let changed = false
  const businessBefore = fs.readFileSync(target)
  assert.throws(() => store.commitFiles({ ...options('tamper'), writes: [{ path: target, content: 'must not replace\n', validate: () => {
    if (!changed) { changed = true; fs.writeFileSync(journal, altered); fs.utimesSync(journal, stamp.atime, stamp.mtime) }
    return true
  } }] }), error => error.name === 'StorageError')
  assert.equal(changed, true); assert.deepEqual(bytes(), altered)
  assert.deepEqual(fs.readFileSync(target), businessBefore)
  assert.equal(fs.existsSync(journal + '.lock'), false)
})

test('a validator cannot inject another owner for the initially absent operation id', () => {
  seed(); let injected
  const operation = { version: 1, phase: 'prepared', operationId: 'injected-id', kind: 'foreign-kind', targetId: 'foreign-target', time: '2026-10-20T00:00:00.000Z',
    writes: [{ path: target, content: 'foreign\n', format: 'text', beforeSha256: hash('original\n'), afterSha256: hash('foreign\n') }], result: 'foreign-result' }
  const { writes: _, result: __, ...summary } = operation
  let changed = false
  assert.throws(() => store.commitFiles({ ...options('injected-id'), writes: [{ path: target, content: 'outer\n', validate: () => {
    if (!changed) {
      changed = true; fs.appendFileSync(journal, JSON.stringify(operation) + '\n' + JSON.stringify({ ...summary, phase: 'committed' }) + '\n'); injected = bytes()
    }
    return true
  } }] }), error => error.name === 'StorageError')
  assert.equal(changed, true); assert.deepEqual(bytes(), injected)
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n')
})

test('the new-id path retains the shared physical lock against validator peer reentry', () => {
  seed(); let attempted = false, busy
  const result = store.commitFiles({ ...options('outer'), writes: [{ path: target, content: 'changed\n', validate: () => {
    if (!attempted) {
      attempted = true
      try { peer.commitFiles(options('nested')); assert.fail('Peer commit must remain fenced') }
      catch (error) { busy = error }
    }
    return true
  } }] })
  assert.equal(busy?.code, 'STORAGE_BUSY'); assert.equal(peer.storageStatus().degraded, false)
  assert.deepEqual(result, { original: ['stable'] })
  const ids = bytes().toString().split('\n').filter(Boolean).map(line => JSON.parse(line).operationId)
  assert.equal(ids.includes('nested'), false); assert.equal(ids.filter(id => id === 'outer').length, 2)
  assert.equal(fs.existsSync(journal + '.lock'), false)
})

test('an id recovered from a failed prepare is replayed only after durable local recovery', () => {
  seed(); const before = bytes()
  assert.throws(() => withJournalIo(() => store.commitFiles(options('recover-id')), { failPrepareSync: true }), /prepare fsync failed/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n')
  assert.ok(bytes().subarray(0, before.length).equals(before))
  assert.deepEqual(store.commitFiles({ ...options('recover-id'), result: 'must not replace original result' }), { original: ['stable'] })
  const added = bytes().subarray(before.length).toString().split('\n').filter(Boolean).map(JSON.parse)
  assert.deepEqual(added.map(row => row.phase), ['prepared', 'committed'])
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed\n')
})
