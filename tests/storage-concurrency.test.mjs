import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixtureParent = resolve('tests/.tmp')
fs.mkdirSync(fixtureParent, { recursive: true })
const fixture = fs.mkdtempSync(join(fixtureParent, 'storage-concurrency-'))
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
const vault = await import('../src/host/vault.ts')
const store = await import('../src/host/store.ts')
const reloaded = await import('../src/host/store.ts?separate-module-instance')
const { withJournalLock } = await import('../src/host/store-lock.ts')
const journal = vault.statePath('store-operations.jsonl'), data = vault.statePath('snapshot.txt'), lock = `${journal}.lock`
const worker = resolve('tests/helpers/storage-concurrency-worker.mjs')

function removeOwned(path) {
  if (!fs.existsSync(path)) return
  assert.ok(fs.realpathSync(path).startsWith(fs.realpathSync(fixtureParent) + sep))
  fs.rmSync(path, { recursive: true, force: true })
}

/**
 * 清理“链接”要跨平台：Windows junction 用 unlink 会 EPERM/EISDIR，必须 rmdir；
 * POSIX symlink 用 rmdir 会 ENOTDIR，必须 unlink。这里按错误码回退。
 */
function removeLink(path) {
  try {
    fs.unlinkSync(path)
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EISDIR' || error.code === 'EACCES') fs.rmdirSync(path)
    else throw error
  }
}
beforeEach(() => {
  for (const name of fs.readdirSync(fixture)) removeOwned(join(fixture, name))
  vault.ensureVault(); fs.writeFileSync(data, 'original\n')
})
after(() => removeOwned(fixture))
const options = (operationId = 'local') => ({ operationId, kind: 'test.snapshot', targetId: 'snapshot', result: 'original-result', writes: [{ path: data, content: 'changed\n' }] })
const rows = () => fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse)
const lockedFiles = () => fs.readdirSync(vault.STATE_HOME).filter(name => name.includes('.lock'))
function childSync(action, role) {
  const result = spawnSync(process.execPath, [worker, resolve('.'), fixture, action, role], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, action === 'crash' ? 79 : 0, result.stderr || result.error?.message)
  return action === 'crash' ? result : JSON.parse(result.stdout.trim())
}
function child(action, role) {
  const running = spawn(process.execPath, [worker, resolve('.'), fixture, action, role], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  running.stdout.on('data', value => { stdout += value }); running.stderr.on('data', value => { stderr += value })
  const done = new Promise((resolve, reject) => {
    running.once('error', reject)
    running.once('exit', code => {
      try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout.trim())) } catch (error) { reject(error) }
    })
  })
  return { running, done }
}
async function ready(role) {
  const start = Date.now()
  while (!fs.existsSync(join(fixture, `${role}.ready`))) {
    if (Date.now() - start > 14000) throw new Error(`Worker ${role} never reached its barrier`)
    await new Promise(done => setTimeout(done, 5))
  }
}
function busy(result) {
  assert.equal(result.ok, false, 'the competing operation must stop before touching the journal')
  assert.equal(result.code, 'STORAGE_BUSY', JSON.stringify(result))
  assert.equal(result.status.degraded, false, `contention must not report corruption: ${JSON.stringify(result)}`)
}

test('two processes cannot prepare the same id concurrently, and a later explicit retry is idempotent', async () => {
  const first = child('commit', 'A')
  let peer
  try { await ready('A'); peer = childSync('commit', 'B') }
  finally { fs.writeFileSync(join(fixture, 'A.release'), 'release') }
  const firstResult = await first.done
  busy(peer)
  assert.equal(firstResult.ok, true)
  assert.equal(childSync('commit', 'retry').value, 'original-result')
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
  store.recoverOperations()
  assert.equal(fs.readFileSync(data, 'utf8'), 'changed\n')
  assert.deepEqual(lockedFiles(), [])
})

test('two recovery processes cannot append two commit markers for one prepared operation', async () => {
  childSync('crash', 'seed')
  const first = child('recover', 'A')
  let peer
  try { await ready('A'); peer = childSync('recover', 'B') }
  finally { fs.writeFileSync(join(fixture, 'A.release'), 'release') }
  const firstResult = await first.done
  busy(peer)
  assert.equal(firstResult.ok, true)
  assert.equal(childSync('recover', 'retry').ok, true)
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
  assert.deepEqual(lockedFiles(), [])
})

test('separately imported modules share the journal fence before invoking a nested commit', () => {
  let peer
  store.commitFiles({ ...options('outer'), writes: [{ path: data, content: 'changed\n', validate: () => {
    try { reloaded.commitFiles(options('nested')); peer = { ok: true } }
    catch (error) { peer = { ok: false, code: error.code, status: reloaded.storageStatus() } }
    return true
  } }] })
  busy(peer)
  assert.deepEqual(rows().map(row => row.operationId), ['outer', 'outer'])
  assert.deepEqual(lockedFiles(), [])
})

test('a read in another module cannot recover the active writer between prepare and replacement', () => {
  const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, journalFds = new Set()
  let attempted = false, peer
  fs.openSync = (path, ...args) => {
    const fd = open(path, ...args)
    if (resolve(path) === resolve(journal) && args[0] === 'a+') journalFds.add(fd)
    return fd
  }
  fs.closeSync = fd => { try { return close(fd) } finally { journalFds.delete(fd) } }
  fs.fsyncSync = fd => {
    const value = sync(fd)
    if (journalFds.has(fd) && !attempted) {
      attempted = true
      try { reloaded.readState(vault.statePath('unrelated.json'), []); peer = { ok: true } }
      catch (error) { peer = { ok: false, code: error.code, status: reloaded.storageStatus() } }
    }
    return value
  }
  syncBuiltinESMExports()
  try { store.commitFiles(options('active-writer')) }
  finally { fs.openSync = open; fs.closeSync = close; fs.fsyncSync = sync; syncBuiltinESMExports() }
  busy(peer)
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
  assert.equal(store.storageStatus().degraded, false)
})

test('a crashed owner is reclaimed and its prepared local write is recovered exactly once', () => {
  childSync('crash', 'seed')
  assert.equal(fs.existsSync(lock), true, 'an interrupted writer must leave its owner identity')
  store.recoverOperations(); store.recoverOperations()
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
  assert.equal(fs.readFileSync(data, 'utf8'), 'changed\n')
  assert.deepEqual(lockedFiles(), [])
})

test('a live owner is never evicted because of age, and its bytes remain untouched', () => {
  const token = '11111111-1111-4111-8111-111111111111'
  fs.mkdirSync(lock)
  const owner = join(lock, `owner-${token}.json`)
  const content = JSON.stringify({ version: 1, pid: process.pid, token, time: '2000-01-01T00:00:00.000Z' })
  fs.writeFileSync(owner, content)
  fs.utimesSync(lock, new Date(0), new Date(0))
  assert.throws(() => store.commitFiles(options()), error => error.code === 'STORAGE_BUSY')
  assert.equal(fs.readFileSync(owner, 'utf8'), content)
  assert.equal(fs.readFileSync(data, 'utf8'), 'original\n')
  assert.equal(fs.existsSync(journal), false)
  assert.equal(store.storageStatus().degraded, false)
})

test('unreadable or unidentified lock ownership fails closed without deleting evidence', () => {
  fs.mkdirSync(lock)
  const unknown = join(lock, 'unknown-owner.txt')
  fs.writeFileSync(unknown, 'keep this lock evidence')
  assert.throws(() => store.commitFiles(options()), error => error.code === 'STORAGE_BUSY')
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'keep this lock evidence')
  assert.equal(fs.existsSync(journal), false)
  assert.equal(store.storageStatus().degraded, false)
  assert.deepEqual(lockedFiles(), ['store-operations.jsonl.lock'])
})

test('a failed callback releases only its own lock and a following commit can proceed', () => {
  assert.throws(() => store.commitFiles({ ...options(), writes: [{ path: data, content: 'changed\n', validate: () => { throw new Error('validation stopped') } }] }), /validation stopped/)
  assert.deepEqual(lockedFiles(), [])
  assert.equal(store.commitFiles(options('after-failure')), 'original-result')
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
})

test('simultaneous stale-owner reclaimers recover one operation without deleting a new owner', async () => {
  childSync('crash', 'seed')
  const peers = await Promise.all(Array.from({ length: 6 }, (_, index) => child('recover', `peer-${index}`).done))
  assert.ok(peers.some(peer => peer.ok))
  for (const peer of peers) if (!peer.ok) busy(peer)
  store.recoverOperations()
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
  assert.equal(fs.readFileSync(data, 'utf8'), 'changed\n')
  assert.deepEqual(lockedFiles(), [])
})

test('lock publication I/O failure leaves business bytes and no lock candidates behind', () => {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (resolve(to) === resolve(lock)) { const error = new Error('lock publication refused'); error.code = 'EACCES'; throw error }
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try { assert.throws(() => store.commitFiles(options()), /lock publication refused/) }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.equal(fs.readFileSync(data, 'utf8'), 'original\n')
  assert.equal(fs.existsSync(journal), false)
  assert.deepEqual(lockedFiles(), [])
})

test('business writes cannot use journal lock directories as state targets', () => {
  assert.throws(() => store.commitFiles({ ...options(), writes: [{ path: join(lock, 'payload.txt'), content: 'invalid lock content' }] }), /日志|锁|journal|lock/i)
  assert.equal(fs.existsSync(journal), false)
  assert.deepEqual(lockedFiles(), [])
})

test('two path aliases of one physical journal use the same lock', () => {
  const alias = vault.statePath('alias')
  fs.symlinkSync(vault.STATE_HOME, alias, 'junction')
  let peer
  store.commitFiles({ ...options('alias-owner'), writes: [{ path: data, content: 'changed\n', validate: () => {
    try { reloaded.commitFiles({ ...options('alias-peer'), journalPath: join(alias, 'store-operations.jsonl') }); peer = { ok: true } }
    catch (error) { peer = { ok: false, code: error.code, status: reloaded.storageStatus() } }
    return true
  } }] })
  busy(peer)
  assert.deepEqual(rows().map(row => row.operationId), ['alias-owner', 'alias-owner'])
  removeLink(alias)
  assert.deepEqual(lockedFiles(), [])
})

test('an ordinary lock directory removed during path resolution does not create a degraded diagnostic', () => {
  fs.mkdirSync(lock)
  const realpath = fs.realpathSync
  let removed = false
  fs.realpathSync = path => {
    if (resolve(path) === resolve(lock) && !removed) { removed = true; fs.rmdirSync(lock) }
    return realpath(path)
  }
  syncBuiltinESMExports()
  try { assert.equal(store.commitFiles(options()), 'original-result') }
  finally { fs.realpathSync = realpath; syncBuiltinESMExports() }
  assert.equal(removed, true)
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
  assert.equal(store.storageStatus([journal, data, lock]).degraded, false)
})

for (const resolution of ['deleted-handle-path', 'missing-after-replacement', 'deleted-without-replacement', 'permission-after-replacement', 'bad-handle-after-removal', 'large-file-identity']) {
  test(`a lock changed during native path resolution stops as contention: ${resolution}`, () => {
    fs.mkdirSync(lock)
    const retired = vault.statePath('retired-lock'), owner = join(lock, 'owner-peer.json')
    const marker = 'a newer writer owns this directory'
    const replacement = !['deleted-without-replacement', 'bad-handle-after-removal'].includes(resolution)
    const realpath = fs.realpathSync, lstat = fs.lstatSync
    let raced = false
    if (resolution === 'large-file-identity') fs.lstatSync = (path, settings) => {
      const value = lstat(path, settings)
      if (resolve(path) === resolve(lock)) {
        const identity = 9007199254740992n + (raced ? 1n : 0n)
        value.ino = settings?.bigint ? identity : Number(identity)
      }
      return value
    }
    fs.realpathSync = path => {
      if (resolve(path) === resolve(lock) && !raced) {
        raced = true
        fs.renameSync(lock, retired)
        if (replacement) {
          fs.mkdirSync(lock)
          fs.writeFileSync(owner, marker)
        }
        const failureCode = { 'missing-after-replacement': 'ENOENT', 'permission-after-replacement': 'EPERM', 'bad-handle-after-removal': 'EBADF' }[resolution]
        if (failureCode) {
          const error = new Error('the observed directory was removed before realpath completed')
          error.code = failureCode
          throw error
        }
        // NTFS can return this deleted-handle namespace successfully instead
        // of ENOENT when another reclaimer removes the observed directory.
        return resolve(fixture, '..', '..', '$Extend', '$Deleted', 'retired-lock')
      }
      return realpath(path)
    }
    syncBuiltinESMExports()
    try { assert.throws(() => store.commitFiles(options()), error => error.code === 'STORAGE_BUSY') }
    finally { fs.realpathSync = realpath; fs.lstatSync = lstat; syncBuiltinESMExports() }
    assert.equal(raced, true)
    assert.equal(fs.existsSync(journal), false)
    assert.equal(fs.readFileSync(data, 'utf8'), 'original\n')
    if (replacement) assert.equal(fs.readFileSync(owner, 'utf8'), marker)
    else assert.equal(fs.existsSync(lock), false)
    assert.equal(store.storageStatus([journal, data, lock]).degraded, false)
    assert.ok(!lockedFiles().some(name => name.endsWith('.tmp')), 'no lock candidate may be left behind')
  })
}

test('an uncommitted id never returns a success result before the local write has completed', () => {
  fs.writeFileSync(data, '[]\n')
  let entered = false
  assert.throws(() => store.commitState({ path: data, format: 'json', fallback: [], validate: () => {
    if (!entered) { entered = true; childSync('crash', 'seed') }
    return true
  } }, { operationId: 'shared-id', kind: 'test.snapshot', targetId: 'snapshot' }, () => {
    assert.fail('an unresolved operation must not derive or report a second result')
  }), error => error.code === 'STORAGE_BUSY')
  assert.equal(fs.readFileSync(data, 'utf8'), '[]\n')
  store.recoverOperations()
  assert.equal(fs.readFileSync(data, 'utf8'), 'changed\n')
  assert.deepEqual(rows().map(row => row.phase), ['prepared', 'committed'])
})

test('an owner releasing its directory during a failed rename is contention, not a raw EPERM or degraded', () => {
  fs.mkdirSync(lock)
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (resolve(to) === resolve(lock)) {
      fs.rmdirSync(lock)
      const error = new Error('peer released after competing rename'); error.code = 'EPERM'; throw error
    }
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try { assert.throws(() => store.commitFiles(options()), error => error.code === 'STORAGE_BUSY') }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.equal(fs.readFileSync(data, 'utf8'), 'original\n')
  assert.equal(fs.existsSync(journal), false)
  assert.deepEqual(lockedFiles(), [])
  assert.equal(store.storageStatus([journal, data, lock]).degraded, false)
})

for (const code of ['STORAGE_BUSY', 'EACCES']) {
  test(`a publication guard failure cannot reclaim a replacement owner: ${code}`, () => {
    childSync('crash', 'seed')
    const original = JSON.parse(fs.readFileSync(join(lock, fs.readdirSync(lock)[0]), 'utf8'))
    const replacement = { ...original, token: '22222222-2222-4222-8222-222222222222' }
    const owner = join(lock, `owner-${replacement.token}.json`), marker = JSON.stringify(replacement)
    const before = fs.readFileSync(journal), retired = vault.statePath('retired-lock')
    const rejected = code === 'STORAGE_BUSY' ? new store.StorageBusyError(journal, 'observed replacement before publication')
      : Object.assign(new Error('publication path cannot be inspected'), { code })
    let inspections = 0, ran = false
    assert.throws(() => withJournalLock(journal, path => {
      if (resolve(path) === resolve(lock) && ++inspections === 2) {
        fs.renameSync(lock, retired)
        fs.mkdirSync(lock)
        fs.writeFileSync(owner, marker)
        throw rejected
      }
    }, () => { ran = true }), error => error === rejected)
    assert.equal(ran, false)
    assert.equal(fs.readFileSync(owner, 'utf8'), marker)
    assert.deepEqual(fs.readFileSync(journal), before)
    assert.equal(fs.readFileSync(data, 'utf8'), 'original\n')
    assert.ok(!lockedFiles().some(name => name.endsWith('.tmp')))
  })
}

test('path reinspection reports its actual access error instead of an earlier missing-path error', () => {
  fs.mkdirSync(lock)
  const realpath = fs.realpathSync, lstat = fs.lstatSync
  let recheck = false
  fs.realpathSync = path => {
    if (resolve(path) === resolve(lock)) {
      recheck = true
      throw Object.assign(new Error('initial native lookup was missing'), { code: 'ENOENT' })
    }
    return realpath(path)
  }
  fs.lstatSync = (...args) => {
    if (resolve(args[0]) === resolve(lock) && recheck) throw Object.assign(new Error('second lookup access was denied'), { code: 'EACCES' })
    return lstat(...args)
  }
  syncBuiltinESMExports()
  try { assert.throws(() => store.commitFiles(options()), /second lookup access was denied/) }
  finally { fs.realpathSync = realpath; fs.lstatSync = lstat; syncBuiltinESMExports() }
  assert.equal(fs.existsSync(journal), false)
  assert.equal(fs.readFileSync(data, 'utf8'), 'original\n')
})
