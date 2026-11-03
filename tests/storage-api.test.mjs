import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'storage-api-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
const { storageStatus } = await import('../src/host/store.ts')
const { registerButlerApi } = await import('../src/host/api.ts')
ensureVault()

test('the overview exposes corrupt ledger state without inventing an empty task list', async () => {
  writeFileSync(vaultPath('ledger', 'tasks.jsonl'), '{bad task row}\n')
  const routes = new Map()
  registerButlerApi({ webServer: { register(route) { routes.set(route.path, route); return () => {} } } }, {
    timeZone: 'Asia/Shanghai', runtimeControls: () => ({ storage: storageStatus() }),
  })
  let body
  const response = { statusCode: 0, setHeader() {}, end(text) { body = JSON.parse(text) } }
  await routes.get('/dsh-butler/api/overview').handler({ method: 'GET' }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(body.ledger, undefined)
  assert.match(body.ledgerError, /tasks\.jsonl/)
  assert.equal(body.runtimeControls.storage.degraded, true)
})
