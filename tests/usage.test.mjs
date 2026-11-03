import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'usage-reconcile-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { installUsageRecorder } = await import('../src/host/usage.ts')
const { addUsage, usageRecords, usageTotals, setButlerSessionId } = await import('../src/host/ledger.ts')
const { runUsageBackfill } = await import('../src/host/backfill.ts')
const { storageStatus } = await import('../src/host/store.ts')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
ensureVault()
const at = Date.UTC(2026, 9, 15, 3)
const envelope = (seq, usage, source = {}) => ({ type: 'assistant/message', seq, time: at, data: { turn: 1, step: 1, message: { source }, ...(usage ? { usage } : {}) } })
function environment(options = {}) {
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), '')
  let listener
  const recorder = installUsageRecorder({ on(_name, fn) { listener = fn; return () => {} } }, options)
  return { recorder, send(id, e) { listener({ id }, e) } }
}

test('a missing provider usage is a durable unknown call, including after reload', () => {
  const e = environment()
  e.send('unknown-session', envelope(10))
  assert.equal(usageRecords().length, 1)
  assert.equal(usageRecords()[0].usageState, 'unknown')
  assert.equal(usageTotals().calls, 1)
  assert.equal(usageTotals().withoutUsage, 1)
  e.recorder.stop()
  assert.equal(usageRecords()[0].eventSeq, 10)
})

test('live event replay is idempotent while distinct native sequences at one position remain distinct', () => {
  const e = environment(), usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  const one = envelope(20, usage)
  e.send('replay-session', one); e.send('replay-session', one)
  e.send('replay-session', envelope(21, usage))
  assert.equal(usageRecords().length, 2)
  assert.equal(usageTotals().totalTokens, 24)
  e.recorder.stop()
})

test('late reported usage reconciles the same unknown event instead of charging an extra call', () => {
  const e = environment()
  e.send('late-session', envelope(30))
  e.send('late-session', envelope(30, { inputTokens: 4, outputTokens: 1, totalTokens: 5 }))
  e.send('late-session', envelope(30))
  assert.equal(usageRecords().length, 1)
  assert.equal(usageTotals().calls, 1)
  assert.equal(usageTotals().withoutUsage, 0)
  assert.equal(usageTotals().totalTokens, 5)
  e.recorder.stop()
})

test('reminders and children are included in butler usage with separate scope kinds', () => {
  setButlerSessionId('session-butler')
  const e = environment({ butlerSession: () => 'session-butler', context: id => ({ sessionId: id, rootSessionId: 'session-butler', runId: 'r', taskId: 't' }) })
  e.send('session-butler-reminder-verified', envelope(40, { inputTokens: 3, outputTokens: 1 }))
  e.send('child-owned', envelope(41, { inputTokens: 2, outputTokens: 1 }))
  const rows = usageRecords()
  assert.equal(rows[0].scope, 'butler'); assert.equal(rows[0].scopeKind, 'reminder')
  assert.equal(rows[1].scope, 'butler'); assert.equal(rows[1].scopeKind, 'child')
  assert.equal(usageTotals().butlerCalls, 2)
  e.recorder.stop()
})

test('a global last-route echo cannot assign another session a provider or a price', () => {
  const e = environment({ route: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) })
  e.send('route-A', envelope(50, { inputTokens: 3, outputTokens: 1 }))
  e.send('route-B', envelope(51, { inputTokens: 2, outputTokens: 1 }, { provider: 'provider-B', model: 'model-B' }))
  assert.equal(usageRecords()[0].provider, undefined)
  assert.equal(usageRecords()[0].cost, undefined)
  assert.equal(usageRecords()[1].provider, 'provider-B')
  assert.equal(usageRecords()[0].at, new Date(at).toISOString())
  e.recorder.stop()
})

test('backfill completes an unknown live event using the same native sequence', () => {
  const e = environment()
  e.send('backfill-session', envelope(60))
  const logHome = join(home, 'logs-known'), dir = join(logHome, 'sessions', 'workspace', 'backfill-session')
  mkdirSync(dir, { recursive: true })
  const rows = [{ type: 'session', data: { id: 'backfill-session' } }, envelope(60, { inputTokens: 7, outputTokens: 2, totalTokens: 9 })]
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n')))
  runUsageBackfill({ home: logHome, now: at + 1000 })
  assert.equal(usageRecords().length, 1)
  assert.equal(usageTotals().withoutUsage, 0)
  assert.equal(usageTotals().totalTokens, 9)
  const again = runUsageBackfill({ home: logHome, now: at + 1000 })
  assert.equal(again.added, 0)
  e.recorder.stop()
})

test('backfill upgrades a legacy position identity without counting the same call twice', () => {
  const e = environment()
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), JSON.stringify({ sessionId: 'legacy-session', turn: 1, step: 1, at: new Date(at).toISOString(), inputTokens: 7, outputTokens: 2, totalTokens: 9 }) + '\n')
  const logHome = join(home, 'logs-legacy'), dir = join(logHome, 'sessions', 'workspace', 'legacy-session')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from([
    { type: 'session', data: { id: 'legacy-session' } }, envelope(70, { inputTokens: 7, outputTokens: 2, totalTokens: 9 }),
  ].map(r => JSON.stringify(r)).join('\n') + '\n')))
  runUsageBackfill({ home: logHome, now: at + 1000 })
  assert.equal(usageRecords().length, 1)
  assert.equal(usageRecords()[0].eventSeq, 70)
  assert.equal(usageTotals().totalTokens, 9)
  e.recorder.stop()
})

test('unknown or missing models keep their tokens unpriced, while stored historical costs remain intact', () => {
  const e = environment()
  e.send('unknown-model', envelope(80, { inputTokens: 20, outputTokens: 5 }, { provider: 'deepseek-official', model: 'future-unlisted-model' }))
  e.send('missing-model', envelope(81, { inputTokens: 20, outputTokens: 5 }, { provider: 'deepseek-official' }))
  assert.equal(usageRecords()[0].cost, undefined)
  assert.equal(usageTotals().pricedCalls, 0)
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), JSON.stringify({ sessionId: 'historical', at: new Date(at).toISOString(), inputTokens: 20, provider: 'deepseek-official', cost: 0.123, costBasis: 'historical-policy' }) + '\n')
  assert.equal(usageTotals().cost, 0.123)
  assert.equal(usageTotals().derivedCalls, 0)
  e.recorder.stop()
})

test('legacy calls at one position but different instants remain separate outside the log window', () => {
  environment()
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), [10, 20].map((tokens, index) => JSON.stringify({ sessionId: 'legacy-repeated', turn: 1, step: 1,
    at: new Date(at + index * 1000).toISOString(), totalTokens: tokens })).join('\n') + '\n')
  assert.equal(usageRecords().length, 2)
  assert.equal(usageTotals().totalTokens, 30)
})

test('native sequence migration preserves historical task scope and cost and reports new calls separately', () => {
  environment()
  setButlerSessionId('historical-butler')
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), JSON.stringify({ sessionId: 'historical-child', rootSessionId: 'historical-butler', taskId: 'business-history', turn: 1, step: 1,
    at: new Date(at).toISOString(), scope: 'butler', scopeKind: 'child', inputTokens: 7, outputTokens: 2, totalTokens: 9,
    cost: 99, costBasis: 'original-estimate' }) + '\n')
  const logHome = join(home, 'logs-metadata'), dir = join(logHome, 'sessions', 'workspace', 'historical-child')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from([
    envelope(90, { inputTokens: 7, outputTokens: 2, totalTokens: 9 }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
    { ...envelope(91, { totalTokens: 11 }), time: at + 1 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')))
  const result = runUsageBackfill({ home: logHome, now: at + 1000, butlerSession: () => 'historical-butler' })
  const original = usageRecords().find(row => row.eventSeq === 90)
  assert.equal(original.scope, 'butler')
  assert.equal(original.scopeKind, 'child')
  assert.equal(original.taskId, 'business-history')
  assert.equal(original.cost, 99)
  assert.equal(original.costBasis, 'original-estimate')
  assert.equal(result.reconciled, 1)
  assert.equal(result.added, 1)
  assert.equal(usageRecords().length, 2)
})

test('legacy migration matches exact instants when multiple calls reused the same model position', () => {
  environment()
  const legacy = [10, 20].map((tokens, index) => ({ sessionId: 'reuse-position', turn: 1, step: 1, at: new Date(at + index * 1000).toISOString(), totalTokens: tokens, taskId: `task-${index}` }))
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), legacy.map(row => JSON.stringify(row)).join('\n') + '\n')
  const logHome = join(home, 'logs-exact'), dir = join(logHome, 'sessions', 'workspace', 'reuse-position')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from([10, 20].map((tokens, index) => JSON.stringify({ ...envelope(100 + index, { totalTokens: tokens }), time: at + index * 1000 })).join('\n') + '\n')))
  const result = runUsageBackfill({ home: logHome, now: at + 2000 })
  assert.equal(usageRecords().length, 2)
  assert.equal(usageTotals().totalTokens, 30)
  assert.equal(usageRecords().find(row => row.eventSeq === 101).taskId, 'task-1')
  assert.equal(result.reconciled, 2)
  assert.equal(result.added, 0)
})

test('one legacy call must not attach its task to an earlier native call at the same position', () => {
  environment()
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), JSON.stringify({ sessionId: 'partial-legacy', turn: 1, step: 1, at: new Date(at + 1000).toISOString(), totalTokens: 20, taskId: 'actual-second-task' }) + '\n')
  const logHome = join(home, 'logs-partial'), dir = join(logHome, 'sessions', 'workspace', 'partial-legacy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from([10, 20].map((tokens, index) => JSON.stringify({ ...envelope(110 + index, { totalTokens: tokens }), time: at + index * 1000 })).join('\n') + '\n')))
  runUsageBackfill({ home: logHome, now: at + 2000 })
  assert.equal(usageRecords().find(row => row.eventSeq === 110).taskId, undefined)
  assert.equal(usageRecords().find(row => row.eventSeq === 111).taskId, 'actual-second-task')
  assert.equal(usageTotals('actual-second-task').totalTokens, 20)
})

test('usage appends preserve the existing file and keep damaged-line diagnostics visible', () => {
  environment()
  const path = vaultPath('ledger', 'usage.jsonl')
  const original = '{broken\n' + JSON.stringify({ at: new Date(at).toISOString(), sessionId: 'existing', eventSeq: 1, totalTokens: 3 })
  writeFileSync(path, original)
  const before = statSync(path)
  assert.equal(usageRecords().length, 1)
  addUsage({ at: new Date(at).toISOString(), sessionId: 'appended', eventSeq: 2, totalTokens: 4 })
  assert.equal(statSync(path).ino, before.ino, 'a usage append must not replace the existing ledger file')
  assert.ok(readFileSync(path, 'utf8').startsWith(original + '\n'))
  assert.equal(usageRecords().length, 2)
  assert.ok(storageStatus([path]).diagnostics.some(issue => issue.line === 1 && issue.blocking === false))
})
