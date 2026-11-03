import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'note-catalog-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
const { registerButlerApi } = await import('../src/host/api.ts')
ensureVault()
const files = new Map([
  ['notes/original.md', 'Original user note body'],
  ['notes/中文 资料.md', '原来的中文笔记正文'],
  ['notes/original.md.migration-v1.json', '{"version":1,"sha256":"preserved"}'],
  ['notes/original.md.backup-v1', 'Original backup bytes'],
  ['notes/private.json', '{"private":"metadata"}'],
  ['notes/nested/hidden.md', 'Nested document is not a flat note slug'],
  ['notes/double..dot.md', 'Cannot be opened by the existing note slug fence'],
  ['uploads/original.pdf', '%PDF-test original bytes'],
])
for (const [path, text] of files) { mkdirSync(dirname(vaultPath(path)), { recursive: true }); writeFileSync(vaultPath(path), text) }
const routes = new Map()
const dispose = registerButlerApi({ webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } } }, { timeZone: 'Asia/Shanghai' })
async function request(path) {
  const handler = routes.get(path.split('?')[0]); assert.equal(typeof handler, 'function')
  let response
  await handler(Object.assign(new EventEmitter(), { method: 'GET', url: path }), {
    statusCode: 200, setHeader() {}, end(body) { response = { status: this.statusCode, body: JSON.parse(body) } },
  })
  return response
}
const visible = ['notes/original.md', 'notes/中文 资料.md'].sort()

test('note catalog lists only flat readable notes while preserving sidecars, backups and general artifact listings', async () => {
  const before = new Map([...files].map(([path]) => [path, { bytes: readFileSync(vaultPath(path)), mtime: statSync(vaultPath(path)).mtimeMs }]))
  const list = await request('/dsh-butler/api/note')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.notes.map(row => row.path).sort(), visible)
  for (const row of list.body.notes) {
    const slug = row.path.slice('notes/'.length, -3)
    const opened = await request('/dsh-butler/api/note?slug=' + encodeURIComponent(slug))
    assert.equal(opened.status, 200, row.path)
    assert.equal(opened.body.text, files.get(row.path))
  }
  const overview = await request('/dsh-butler/api/overview')
  assert.equal(overview.status, 200)
  for (const path of files.keys()) assert.ok(overview.body.vault.files.some(row => row.path === path), `General listing retains ${path}`)
  for (const [path, old] of before) {
    assert.deepEqual(readFileSync(vaultPath(path)), old.bytes, path)
    assert.equal(statSync(vaultPath(path)).mtimeMs, old.mtime, path)
  }
})

test('newer metadata cannot consume the 200-note display quota and hide older real notes', async () => {
  const old = new Date('2020-01-01T00:00:00.000Z'), recent = new Date('2026-10-17T00:00:00.000Z')
  for (const path of visible) utimesSync(vaultPath(path), old, old)
  const metadata = []
  for (let index = 0; index < 205; index++) {
    const path = vaultPath('notes', `sidecar-${index}.md.migration-v1.json`)
    const bytes = Buffer.from(`{"version":1,"fixture":${index}}`)
    writeFileSync(path, bytes); utimesSync(path, recent, recent); metadata.push({ path, bytes })
  }
  const list = await request('/dsh-butler/api/note')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.notes.map(row => row.path).sort(), visible)
  for (const row of metadata) {
    assert.deepEqual(readFileSync(row.path), row.bytes)
    assert.equal(statSync(row.path).mtimeMs, recent.valueOf())
  }
})

test.after(() => dispose())
