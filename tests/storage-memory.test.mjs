import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

test('repeated recovery without retention compaction has bounded process memory and preserves every journal byte', () => {
  const parent = resolve('tests/.tmp')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'storage-memory-'))
  try {
    const state = join(fixture, 'state'), vault = join(fixture, 'vault')
    mkdirSync(state); mkdirSync(vault)
    const journal = join(state, 'store-operations.jsonl'), content = 'snapshot '.repeat(10_000)
    const hash = createHash('sha256').update(content).digest('hex')
    for (let index = 0; index < 380; index++) {
      const row = { version: 1, phase: 'prepared', operationId: `memory-${index}`, time: '2026-10-17T00:00:00.000Z',
        targetId: 'snapshot', kind: 'test.memory', writes: [{ path: join(state, 'snapshot.txt'), content, format: 'text', beforeSha256: null, afterSha256: hash }] }
      const { writes: _, ...commit } = row
      appendFileSync(journal, JSON.stringify(row) + '\n' + JSON.stringify({ ...commit, phase: 'committed' }) + '\n')
    }
    const bytes = readFileSync(journal), beforeHash = createHash('sha256').update(bytes).digest('hex')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { recoverOperations, storageStatus } from ${JSON.stringify(pathToFileURL(resolve('src/host/store.ts')).href)};
      const before = process.resourceUsage().maxRSS;
      for (let i = 0; i < 8; i++) recoverOperations();
      console.log(JSON.stringify({ growthBytes: (process.resourceUsage().maxRSS - before) * 1024, health: storageStatus() }));
    `], { encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...process.env, DSH_BUTLER_HOME: state, DSH_BUTLER_VAULT: vault,
        // This regression measures recovery/cache memory, not maintenance.
        // Pin both knobs so inherited host settings cannot compact the fixture.
        DSH_BUTLER_JOURNAL_COMPACT_BYTES: String(bytes.length + 1), DSH_BUTLER_JOURNAL_KEEP_COMMITTED: '5000' } })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    const usage = JSON.parse(result.stdout)
    assert.equal(usage.health.degraded, false)
    assert.ok(usage.growthBytes < bytes.length * 4,
      `committed history must not amplify resident memory beyond 4x journal bytes: ${usage.growthBytes} for ${bytes.length}`)
    assert.equal(createHash('sha256').update(readFileSync(journal)).digest('hex'), beforeHash)
    assert.equal(existsSync(join(state, 'store-compactions')), false, 'memory regression must not exercise retention compaction')
    assert.equal(existsSync(join(state, 'snapshot.txt')), false, 'committed snapshots must not replay')
  } finally {
    assert.ok(realpathSync(fixture).startsWith(realpathSync(parent) + sep))
    rmSync(fixture, { recursive: true, force: true })
  }
})
