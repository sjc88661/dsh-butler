import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'

const base = resolve('tests/.tmp')
fs.mkdirSync(base, { recursive: true })
const home = fs.mkdtempSync(join(base, 'backfill-responsive-'))
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
ensureVault()
const ledgerPath = vaultPath('ledger', 'usage.jsonl')
const originalRead = fs.readFileSync
let ledgerReads = 0
fs.readFileSync = function (path, ...args) {
  if (String(path) === ledgerPath) ledgerReads += 1
  return originalRead.call(this, path, ...args)
}
syncBuiltinESMExports()
const { installUsageBackfill } = await import('../src/host/backfill.ts')
const { addUsage, usageRecords } = await import('../src/host/ledger.ts')

function populate(count = 3000) {
  const at = Date.now() - 1000
  const previous = Array.from({ length: 1200 }, (_, seq) => ({
    at: new Date(at).toISOString(), sessionId: 'older-session', eventSeq: seq,
    turn: 1, step: 1, totalTokens: 1, usageState: 'reported', origin: 'live',
  })).map(row => JSON.stringify(row)).join('\n') + '\n'
  fs.writeFileSync(ledgerPath, previous)
  const dir = join(process.env.DSH_HOME, 'sessions', 'workspace', 'native-session')
  fs.mkdirSync(dir, { recursive: true })
  const frames = Array.from({ length: count }, (_, seq) => zstdCompressSync(Buffer.from(JSON.stringify({
    type: 'assistant/message', seq, time: at + seq,
    data: { turn: 1, step: 1, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, message: {} },
  }) + '\n')))
  fs.writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return { previous, count, at }
}

test('startup backfill keeps heartbeat responsive while processing thousands of native frames', async t => {
  const fixture = populate()
  let state
  const observations = []
  const heartbeat = setInterval(() => {
    observations.push(state?.running ?? false)
  }, 2)
  t.after(() => clearInterval(heartbeat))
  ledgerReads = 0
  const started = performance.now()
  state = installUsageBackfill({ timeZone: 'UTC', afterMs: 0 })
  while (state.last === undefined && state.problem === undefined) await delay(2)
  clearInterval(heartbeat)
  t.diagnostic(JSON.stringify({ ms: Math.round(performance.now() - started), ledgerReads,
    heartbeatsDuringRun: observations.filter(Boolean).length }))
  assert.equal(state.problem, undefined)
  assert.ok(observations.some(Boolean), 'the event loop must run heartbeat callbacks before backfill finishes')
  assert.ok(ledgerReads <= 4, `backfill reread the usage ledger ${ledgerReads} times for ${fixture.count} calls`)
  assert.equal(state.last.added, fixture.count)
  assert.equal(usageRecords().length, 1200 + fixture.count)
  assert.ok(fs.readFileSync(ledgerPath, 'utf8').startsWith(fixture.previous), 'existing ledger bytes must remain intact')
})

test('stopping a pending backfill prevents its scheduled callback from writing anything', async () => {
  const { previous } = populate(20)
  let scheduled
  const state = installUsageBackfill({ timeZone: 'UTC', timer: { setTimeout(callback) { scheduled = callback } } })
  assert.equal(typeof state.stop, 'function', 'the host effect needs a backfill cancellation handle')
  state.stop()
  scheduled()
  await delay(10)
  assert.equal(state.running, false)
  assert.equal(state.last, undefined)
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), previous)
})

test('stopping an active backfill cancels later batches without claiming completion', async () => {
  populate()
  const state = installUsageBackfill({ timeZone: 'UTC', immediate: true })
  assert.equal(typeof state.stop, 'function')
  await new Promise(resolve => setImmediate(resolve))
  state.stop()
  const stopped = fs.readFileSync(ledgerPath, 'utf8')
  await delay(20)
  assert.equal(state.running, false)
  assert.equal(state.last, undefined)
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), stopped)
})

test('a live event can claim its legacy metadata between background slices without giving it to another call', async () => {
  const { previous, at } = populate()
  const legacyAt = new Date(at + 2500).toISOString()
  fs.writeFileSync(ledgerPath, previous + JSON.stringify({ at: legacyAt, sessionId: 'native-session', turn: 1, step: 1,
    totalTokens: 3, taskId: 'historical-task', rootSessionId: 'butler', scope: 'butler', scopeKind: 'child',
    cost: 17, costBasis: 'historical-basis' }) + '\n')
  const state = installUsageBackfill({ timeZone: 'UTC', immediate: true, butlerSession: () => 'butler' })
  assert.equal(state.running, true)
  addUsage({ at: legacyAt, sessionId: 'native-session', eventSeq: 99999, turn: 1, step: 1, usageState: 'unknown', origin: 'live' })
  while (state.last === undefined && state.problem === undefined) await delay(2)
  assert.equal(state.problem, undefined)
  const rows = usageRecords()
  const claimed = rows.find(row => row.eventSeq === 99999)
  const other = rows.find(row => row.eventSeq === 2500 && row.sessionId === 'native-session')
  assert.equal(claimed.taskId, 'historical-task')
  assert.equal(claimed.scopeKind, 'child')
  assert.equal(claimed.cost, 17)
  assert.equal(claimed.costBasis, 'historical-basis')
  assert.equal(other.taskId, undefined, 'the backfill snapshot must not reuse a legacy attribution already claimed by a live event')
  assert.equal(other.cost, undefined)
  assert.equal(rows.filter(row => row.taskId === 'historical-task').length, 1)
})
