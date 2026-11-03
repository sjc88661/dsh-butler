import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [moduleRoot, fixture, action, role] = process.argv.slice(2)
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
const data = join(process.env.DSH_BUTLER_HOME, 'snapshot.txt')
const pathTrace = []
if (process.env.DSH_TEST_STORAGE_TRACE === '1') {
  const realpath = fs.realpathSync
  const traced = (kind, path, call) => {
    try {
      const value = call()
      pathTrace.push({ kind, path: String(path), value: kind === 'lstat' ? { dev: String(value.dev), ino: String(value.ino), link: value.isSymbolicLink() } : value })
      if (pathTrace.length > 26) pathTrace.shift()
      return value
    } catch (error) {
      pathTrace.push({ kind, path: String(path), error: error.code })
      if (pathTrace.length > 26) pathTrace.shift()
      throw error
    }
  }
  fs.realpathSync = (path, ...args) => traced('realpath', path, () => realpath(path, ...args))
  fs.realpathSync.native = (path, ...args) => traced('native', path, () => realpath.native(path, ...args))
  const lstat = fs.lstatSync
  fs.lstatSync = (path, ...args) => traced('lstat', path, () => lstat(path, ...args))
}
let paused = false
function barrier() {
  fs.writeFileSync(join(fixture, `${role}.ready`), 'ready')
  const start = Date.now()
  while (!fs.existsSync(join(fixture, `${role}.release`))) {
    if (Date.now() - start > 12000) throw new Error('Controlled local test barrier timed out')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  if (action === 'commit' && role === 'A' && resolve(to) === resolve(`${data}.migration-v1.json`) && !paused) {
    paused = true; barrier()
  }
  if (action === 'crash' && resolve(to) === resolve(data)) process.exit(79)
  const result = rename(from, to)
  if (action === 'recover' && role === 'A' && resolve(to) === resolve(data) && !paused) {
    paused = true; barrier()
  }
  return result
}
syncBuiltinESMExports()
const store = await import(pathToFileURL(join(moduleRoot, 'src/host/store.ts')).href)
try {
  const value = action === 'recover' ? store.recoverOperations() : store.commitFiles({
    operationId: 'shared-id', kind: 'test.snapshot', targetId: 'snapshot', result: 'original-result',
    writes: [{ path: data, content: 'changed\n' }],
  })
  console.log(JSON.stringify({ ok: true, value, status: store.storageStatus() }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error.name, code: error.code, message: error.message, status: store.storageStatus(), ...(pathTrace.length ? { pathTrace } : {}) }))
}
