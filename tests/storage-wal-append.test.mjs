import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'

const parent = resolve('tests/.tmp'); fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(join(parent, 'storage-wal-'))
process.env.DSH_BUTLER_HOME = join(fixture, 'state'); process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts'), store = await import('../src/host/store.ts'), notes = await import('../src/host/notes.ts')
const journal = vault.statePath('store-operations.jsonl'), target = vault.statePath('value.txt')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = () => fs.readFileSync(journal)
const options = id => ({ operationId: id, kind: 'test.wal', targetId: 'value', result: { original: ['stable'] }, writes: [{ path: target, content: 'changed\n' }] })
function removeOwned(path) {
  if (!fs.existsSync(path)) return
  assert.ok(fs.realpathSync(path).startsWith(fs.realpathSync(parent) + sep)); fs.rmSync(path, { recursive: true, force: true })
}
beforeEach(() => { removeOwned(vault.STATE_HOME); removeOwned(vault.VAULT_HOME); vault.ensureVault(); fs.writeFileSync(target, 'original\n') })
after(() => removeOwned(fixture))
function seed({ ending = '\n', bom = false } = {}) {
  const rows = [], content = 'historical snapshot '.repeat(256)
  for (let i = 0; i < 6; i++) {
    const row = { version: 1, phase: 'prepared', operationId: `historical-${i}`, kind: 'historical.snapshot', targetId: 'history', time: '2026-10-17T00:00:00.000Z',
      writes: [{ path: vault.statePath('historical.txt'), content, format: 'text', beforeSha256: null, afterSha256: hash(content) }] }
    const { writes: _, ...end } = row; rows.push(JSON.stringify(row), JSON.stringify({ ...end, phase: 'committed' }))
  }
  fs.writeFileSync(journal, (bom ? '\uFEFF' : '') + rows.join('\r\n') + ending); store.recoverOperations(); return bytes()
}
function requireLookup() { assert.equal(typeof store.readCommittedOperation, 'function', 'Validated operation-summary lookup is missing') }
function withIo(hooks, action) {
  const names = ['openSync', 'closeSync', 'readSync', 'writeSync', 'writeFileSync', 'fsyncSync', 'renameSync'], original = Object.fromEntries(names.map(name => [name, fs[name]])), fds = new Map()
  const metrics = { journalBytesWritten: 0, journalRenames: 0, directWrites: 0, durableJournalFences: 0, journalBytesRead: 0, fullJournalReads: 0 }
  fs.openSync = (path, ...args) => { const fd = original.openSync(path, ...args), name = typeof path === 'string' ? resolve(path) : ''; fds.set(fd, { path: name, direct: name === resolve(journal), journal: name === resolve(journal) || name.startsWith(resolve(journal) + '.tmp-'), data: '' }); return fd }
  fs.closeSync = fd => { try { return original.closeSync(fd) } finally { fds.delete(fd) } }
  fs.readSync = (fd, buffer, offset, length, position) => {
    const count = original.readSync(fd, buffer, offset, length, position), info = fds.get(fd)
    if (info?.direct && position === null) { metrics.journalBytesRead += count; if (count === 0) metrics.fullJournalReads++ }
    return count
  }
  fs.writeFileSync = (fd, value, ...args) => { const info = fds.get(fd); if (info?.journal) { metrics.journalBytesWritten += Buffer.byteLength(value); info.data += Buffer.from(value).toString() }; return original.writeFileSync(fd, value, ...args) }
  fs.writeSync = (fd, buffer, offset, length, position) => {
    const info = fds.get(fd), run = (take = length) => original.writeSync(fd, buffer, offset, take, position)
    const count = hooks.write ? hooks.write({ fd, buffer, offset, length, position, info, run }) : run()
    if (info?.journal && count > 0) { metrics.journalBytesWritten += count; info.data += buffer.subarray(offset, offset + count).toString() }
    if (info?.direct) metrics.directWrites++
    return count
  }
  fs.fsyncSync = fd => { const info = fds.get(fd), run = () => original.fsyncSync(fd); const result = hooks.fsync ? hooks.fsync({ fd, info, run }) : run(); if (info?.direct) metrics.durableJournalFences++; return result }
  fs.renameSync = (from, to) => { if (resolve(to) === resolve(journal)) metrics.journalRenames++; return original.renameSync(from, to) }
  syncBuiltinESMExports()
  try { return action(metrics) } finally { for (const name of names) fs[name] = original[name]; syncBuiltinESMExports() }
}

test('one transaction writes only its appended journal bytes and never replaces the historical journal', t => {
  const before = seed()
  withIo({}, metrics => {
    assert.deepEqual(store.commitFiles(options('small-write')), { original: ['stable'] })
    const current = bytes(); assert.ok(current.subarray(0, before.length).equals(before))
    t.diagnostic(JSON.stringify({ historicalBytes: before.length, addedBytes: current.length - before.length, ...metrics }))
    assert.equal(metrics.journalBytesWritten, current.length - before.length, 'Historical journal bytes must not be rewritten for prepare/commit')
    assert.equal(metrics.journalRenames, 0)
    assert.ok(metrics.durableJournalFences >= 2)
  })
})

test('owned durable appends maintain the summary index without decoding historical write snapshots again', () => {
  seed(); const parse = JSON.parse; let historical = 0
  JSON.parse = (text, ...rest) => { if (typeof text === 'string' && text.includes('"operationId":"historical-')) historical++; return parse(text, ...rest) }
  try { store.commitFiles(options('indexed-append')); store.recoverOperations(); assert.equal(historical, 0, 'Known append must not rematerialize historical snapshots') }
  finally { JSON.parse = parse }
})

test('a fresh note operation and its exact replay avoid the generic whole-history row reader', () => {
  seed(); const parse = JSON.parse; let historical = 0
  JSON.parse = (text, ...rest) => { if (typeof text === 'string' && text.includes('"operationId":"historical-')) historical++; return parse(text, ...rest) }
  try {
    const input = { slug: 'indexed-note', markdown: 'Original body', operationId: 'indexed-note-call' }, first = notes.writeNote(input, 'write')
    assert.equal(first.ok, true); assert.deepEqual(notes.writeNote(input, 'write'), first)
    assert.throws(() => notes.writeNote({ ...input, markdown: 'changed replay payload' }, 'write'), /payload|operation|请求/i)
    assert.equal(historical, 0, 'Note replay must use the validated summary index, not full historical rows')
  } finally { JSON.parse = parse }
})

test('summary results are independent clones and preserve same-size/restored-mtime tamper detection', () => {
  requireLookup(); store.commitFiles(options('cloned-summary'))
  const first = store.readCommittedOperation('cloned-summary'); assert.ok(first); assert.equal('writes' in first, false)
  first.result.original[0] = 'poison'; assert.deepEqual(store.readCommittedOperation('cloned-summary').result, { original: ['stable'] })
  const saved = fs.statSync(journal), original = bytes(), changed = Buffer.from(original.toString().replace('changed\\n', 'tampered!'))
  assert.equal(changed.length, original.length); fs.writeFileSync(journal, changed); fs.utimesSync(journal, saved.atime, saved.mtime)
  assert.throws(() => store.readCommittedOperation('cloned-summary'), /SHA|损坏|内容/i)
})

test('each warm committed lookup verifies the full journal once, including a missing operation', () => {
  seed(); store.commitFiles(options('lookup-once'))
  const journalBytes = fs.statSync(journal).size
  for (const id of ['lookup-once', 'not-committed']) withIo({}, metrics => {
    const result = store.readCommittedOperation(id)
    assert.equal(result?.operationId, id === 'lookup-once' ? id : undefined)
    assert.equal(metrics.journalBytesRead, journalBytes, 'A lookup must validate every byte without a redundant second scan')
    assert.equal(metrics.fullJournalReads, 1)
    assert.equal(metrics.journalBytesWritten, 0)
    assert.equal(metrics.durableJournalFences, 0, 'A validated warm read must not acquire a new durable write fence')
  })
})

test('short writes are completed, with successful prepare and commit fsync before success', () => {
  const before = seed(); let shortened = false
  withIo({ write: ({ info, length, run }) => { if (info?.direct && !shortened) { shortened = true; return run(Math.min(17, length)) }; return run() } }, metrics => {
    store.commitFiles(options('short-writes')); assert.equal(shortened, true); assert.ok(metrics.directWrites >= 3)
    assert.ok(bytes().subarray(0, before.length).equals(before)); assert.ok(metrics.durableJournalFences >= 2)
  })
})

test('zero progress fails closed before business replacement and leaves every old journal byte', () => {
  const before = seed(); let trapped = false
  withIo({ write: ({ info, run }) => { if (info?.direct) { trapped = true; return 0 }; return run() } }, () => {
    assert.throws(() => store.commitFiles(options('zero-progress')), /write|写入|progress/i)
  })
  assert.equal(trapped, true); assert.deepEqual(bytes(), before); assert.equal(fs.readFileSync(target, 'utf8'), 'original\n')
})

test('a partial append error preserves its uncertain suffix as evidence and self-heals only the torn tail', () => {
  const before = seed(); let writes = 0
  withIo({ write: ({ info, length, run }) => { if (info?.direct) { if (writes++ === 0) return run(Math.min(19, length)); throw Error('injected partial append') }; return run() } }, () => {
    assert.throws(() => store.commitFiles(options('partial-error')), /partial append/)
  })
  const damaged = bytes(); assert.ok(damaged.length > before.length); assert.ok(damaged.subarray(0, before.length).equals(before))
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n')
  // 0.0.22 起：末尾半行是 torn-tail，恢复时先把完整被拒字节存为证据，再只截断该尾部并继续；
  // 历史完整字节一个不动，repair 审计落盘，自愈后不再 degraded（中间行损坏仍 fail-closed）。
  assert.doesNotThrow(() => store.recoverOperations())
  assert.deepEqual(bytes(), before)
  assert.equal(store.storageStatus([journal]).degraded, false)
  const failures = fs.readdirSync(vault.statePath('store-failures'))
  const evidence = failures.find(name => name.endsWith('.jsonl'))
  assert.ok(evidence, 'torn tail must be preserved as store-failures evidence')
  assert.deepEqual(fs.readFileSync(vault.statePath('store-failures', evidence)), damaged)
  const repairs = fs.readdirSync(vault.statePath('store-repairs'))
  assert.equal(repairs.length, 1)
  const repair = JSON.parse(fs.readFileSync(vault.statePath('store-repairs', repairs[0]), 'utf8'))
  assert.equal(repair.keptBytes, before.length)
  assert.equal(repair.truncatedBytes, damaged.length - before.length)
})

test('prepare fsync failure cannot modify business files or return a replay without a successful locked fence', () => {
  requireLookup(); const before = seed(); let trapped = false
  withIo({ fsync: ({ info, run }) => { if (info?.direct) { trapped = true; throw Error('injected journal fsync failure') }; return run() } }, () => {
    assert.throws(() => store.commitFiles(options('prepare-fsync')), /fsync failure/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'original\n')
    assert.throws(() => store.readCommittedOperation('prepare-fsync'), /fsync|durab|恢复|持久/i)
  })
  assert.equal(trapped, true); assert.ok(bytes().subarray(0, before.length).equals(before))
  withIo({}, metrics => { assert.equal(store.readCommittedOperation('prepare-fsync').operationId, 'prepare-fsync'); assert.ok(metrics.durableJournalFences > 0) })
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed\n')
})

test('a visible committed row after fsync failure is not success in this or a fresh module until a durable fence succeeds', async () => {
  requireLookup(); seed(); let reject = false, trapped = false
  const hooks = { fsync: ({ info, run }) => { if (info?.direct && (reject || info.data.includes('"phase":"committed"'))) { reject = true; trapped = true; throw Error('injected committed fsync failure') }; return run() } }
  const original = fs.fsyncSync
  withIo(hooks, () => {
    assert.throws(() => store.commitFiles(options('commit-fsync')), /fsync failure/)
    assert.equal(trapped, true); assert.match(bytes().toString(), /"phase":"committed"[^\n]*"operationId":"commit-fsync"/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'changed\n')
    assert.throws(() => store.readCommittedOperation('commit-fsync'), /fsync|durab|恢复|持久/i)
  })
  const fresh = await import('../src/host/store.ts?wal-fresh-durability')
  withIo({ fsync: ({ info, run }) => { if (info?.direct) throw Error('still no durability fence'); return run() } }, () => {
    assert.throws(() => fresh.readCommittedOperation('commit-fsync'), /durability fence/)
  })
  withIo({}, metrics => { assert.deepEqual(fresh.readCommittedOperation('commit-fsync').result, { original: ['stable'] }); assert.ok(metrics.durableJournalFences > 0) })
  assert.equal(fs.fsyncSync, original)
})

test('valid BOM/CRLF and a committed terminal JSON record without newline retain their exact prefix', () => {
  const before = seed({ ending: '', bom: true }); store.commitFiles(options('delimited-append'))
  const current = bytes(); assert.ok(current.subarray(0, before.length).equals(before)); assert.equal(current[before.length], 10)
  assert.equal(store.storageStatus([journal]).degraded, false)
})

test('the summary lookup recovers a complete pending operation before exposing its result', () => {
  requireLookup()
  store.commitFiles({ ...options('create-real-backup-fences'), writes: [{ path: target, content: 'original\n' }] })
  const row = { version: 1, phase: 'prepared', operationId: 'pending-summary', kind: 'test.wal', targetId: 'value', time: '2026-10-17T00:00:00.000Z', result: { retained: true },
    writes: [{ path: target, content: 'recovered\n', format: 'text', beforeSha256: hash('original\n'), afterSha256: hash('recovered\n') }] }
  fs.writeFileSync(journal, JSON.stringify(row) + '\n')
  assert.deepEqual(store.readCommittedOperation(row.operationId).result, row.result)
  assert.equal(fs.readFileSync(target, 'utf8'), 'recovered\n'); assert.equal(bytes().toString().trim().split('\n').length, 2)
})

test('one lookup returns the last durable view after recovering multiple pending operations', () => {
  const second = vault.statePath('second.txt')
  fs.writeFileSync(second, 'original\n')
  store.commitFiles({ ...options('multiple-backups'), writes: [target, second].map(path => ({ path, content: 'original\n' })) })
  const rows = [target, second].map((path, index) => ({ version: 1, phase: 'prepared', operationId: `pending-${index}`, kind: 'test.wal', targetId: `value-${index}`,
    time: '2026-10-17T00:00:00.000Z', result: { index }, writes: [{ path, content: `recovered-${index}\n`, format: 'text', beforeSha256: hash('original\n'), afterSha256: hash(`recovered-${index}\n`) }] }))
  fs.writeFileSync(journal, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  assert.deepEqual(store.readCommittedOperation('pending-1').result, { index: 1 })
  assert.deepEqual(store.readCommittedOperation('pending-0').result, { index: 0 })
  assert.equal(fs.readFileSync(target, 'utf8'), 'recovered-0\n')
  assert.equal(fs.readFileSync(second, 'utf8'), 'recovered-1\n')
  assert.deepEqual(bytes().toString().trim().split('\n').map(JSON.parse).filter(row => row.phase === 'committed').map(row => row.operationId), ['pending-0', 'pending-1'])
  assert.equal(store.recoverOperations(), undefined, 'Public recovery remains a void operation')
})
