/**
 * P0 usage hygiene: hot-ledger rotation into `usage-archive/`, archive-aware
 * totals, and the backfill daily-page de-noising.
 *
 * The hot ledger is the only file rewritten; archives are append-only. Every
 * assertion checks both the physical files and the ledger projection, because
 * "totals did not change" is the whole point of rotating.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { zstdCompressSync } from 'node:zlib'

const base = resolve('tests/.tmp'); fs.mkdirSync(base, { recursive: true })
const home = fs.mkdtempSync(join(base, 'usage-rotation-'))
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const vault = await import('../src/host/vault.ts')
const ledger = await import('../src/host/ledger.ts')
const rotation = await import('../src/host/usage-rotation.ts')
const backfill = await import('../src/host/backfill.ts')
vault.ensureVault()

const hotPath = () => vault.vaultPath('ledger', 'usage.jsonl')
const archiveDirectory = () => vault.vaultPath('ledger', 'usage-archive')
const at = (minutesAgo = 1) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function row(seq, options = {}) {
  const inputTokens = options.inputTokens ?? 10 + seq
  const outputTokens = options.outputTokens ?? 2
  return {
    sessionId: options.sessionId ?? 'session-alpha',
    eventSeq: options.eventSeq ?? seq,
    turn: 1,
    step: seq,
    at: options.at ?? at(),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(options.cacheReadTokens === undefined ? {} : { cacheReadTokens: options.cacheReadTokens }),
    ...(options.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: options.cacheWriteTokens }),
    usageState: 'reported',
    origin: 'live',
  }
}

/** Replace the hot file and archive with an exact fixture; a rewrite changes the stat signature. */
function resetLedger(rows = []) {
  fs.rmSync(archiveDirectory(), { recursive: true, force: true })
  fs.writeFileSync(hotPath(), rows.length === 0 ? '' : `${rows.map(entry => JSON.stringify(entry)).join('\n')}\n`)
}

function linesOf(path) {
  return fs.readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
}

function archiveLines() {
  if (!fs.existsSync(archiveDirectory())) return []
  return fs.readdirSync(archiveDirectory()).filter(name => /^\d{4}\.jsonl$/.test(name)).sort()
    .flatMap(name => linesOf(join(archiveDirectory(), name)))
}

function waitForCompletion(state, label) {
  return (async () => {
    const deadline = Date.now() + 10_000
    while (state.last === undefined && state.problem === undefined) {
      if (Date.now() > deadline) throw new Error(`${label} did not finish`)
      await delay(2)
    }
    return state
  })()
}

test('a size-triggered pass archives whole lines and leaves a hot file below the hysteresis target', () => {
  const rows = Array.from({ length: 10 }, (_, index) => row(index + 1, { sessionId: `session-${index % 2}` }))
  resetLedger(rows)
  const beforeBytes = fs.statSync(hotPath()).size
  const huge = rotation.rotateUsageLedger({ maxBytes: beforeBytes * 10, now: Date.now() })
  assert.equal(huge.applied, false)
  assert.equal(huge.skipped, 'below-threshold')
  assert.equal(fs.statSync(hotPath()).size, beforeBytes, 'a skipped pass leaves every byte alone')

  const maxBytes = Math.floor(beforeBytes / 2)
  const result = rotation.rotateUsageLedger({ maxBytes, now: Date.now() })
  assert.equal(result.applied, true)
  assert.equal(result.reason, 'size')
  assert.ok(result.movedRows > 0)
  assert.ok(result.hotBytesAfter <= Math.max(1, Math.floor(maxBytes / 2)))
  assert.equal(fs.statSync(hotPath()).size, result.hotBytesAfter)
  assert.ok(result.archives.length > 0)
  for (const archive of result.archives) assert.match(archive.path, /[\\/]usage-archive[\\/]\d{4}\.jsonl$/)

  // Every original record survives exactly once across hot + archive.
  const physical = [...linesOf(hotPath()), ...archiveLines()].sort()
  assert.deepEqual(physical, rows.map(entry => JSON.stringify(entry)).sort())
  // The next immediate pass has nothing to do: rotation is not one append apart.
  const again = rotation.rotateUsageLedger({ maxBytes: Math.floor(beforeBytes / 2), now: Date.now() })
  assert.equal(again.applied, false)
  assert.equal(again.skipped, 'below-threshold')
  assert.deepEqual(rotation.lastUsageRotation(), again)
})

test('an age-triggered pass moves only entries older than the configured window', () => {
  const oldAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
  const rows = [row(1, { at: oldAt }), row(2), row(3)]
  resetLedger(rows)
  const result = rotation.rotateUsageLedger({ maxBytes: 1e9, maxAgeDays: 90, now: Date.now() })
  assert.equal(result.applied, true)
  assert.equal(result.reason, 'age')
  assert.equal(result.movedRows, 1)
  const archived = archiveLines()
  assert.deepEqual(archived, [JSON.stringify(rows[0])])
  assert.match(result.archives[0].path, new RegExp(`[\\\\/]${new Date(oldAt).getUTCFullYear()}\\.jsonl$`))
  assert.deepEqual(linesOf(hotPath()), rows.slice(1).map(entry => JSON.stringify(entry)))
})

test('totals and per-session attribution are identical before and after rotation', () => {
  const sessions = ['session-alpha', 'session-beta', 'session-gamma']
  const rows = Array.from({ length: 30 }, (_, index) => row(index + 1, {
    sessionId: sessions[index % sessions.length],
    inputTokens: 3 + index,
    outputTokens: 1 + (index % 4),
    cacheReadTokens: index * 2,
    cacheWriteTokens: index % 3,
  }))
  resetLedger(rows)
  const before = ledger.usageTotals()
  const beforeSessions = new Map(sessions.map(session => [session, ledger.sessionUsageTotals(session)]))
  assert.equal(before.calls, rows.length)

  const result = rotation.rotateUsageLedger({ maxBytes: 1, now: Date.now() })
  assert.equal(result.applied, true)
  assert.equal(result.movedRows, rows.length)
  assert.equal(fs.statSync(hotPath()).size, 0, 'a size pass may move every row')

  const after = ledger.usageTotals()
  assert.deepEqual(after, before, 'the roll-up is over hot + archive rows, not the hot file alone')
  assert.equal(ledger.usageRecords().length, rows.length)
  for (const session of sessions) assert.deepEqual(ledger.sessionUsageTotals(session), beforeSessions.get(session))
  assert.deepEqual(ledger.usageArchiveDiagnostics(), [])
  assert.equal(archiveLines().length, rows.length)
})

test('an unreadable or damaged archive is reported without taking the hot rows down', () => {
  const rows = [row(1), row(2)]
  resetLedger(rows)
  fs.writeFileSync(archiveDirectory(), 'this is a file, not a directory')
  const totals = ledger.usageTotals()
  assert.equal(totals.calls, 2, 'hot rows stay readable when the archive cannot be read')
  assert.ok(ledger.usageArchiveDiagnostics().length > 0, 'archive damage is explicit, not silently dropped')

  fs.rmSync(archiveDirectory(), { force: true })
  fs.mkdirSync(archiveDirectory(), { recursive: true })
  const archived = row(3, { sessionId: 'session-archived' })
  fs.writeFileSync(join(archiveDirectory(), '2026.jsonl'), `${JSON.stringify(archived)}\n{broken json\n`)
  // Force a projection rebuild: the hot signature is not derived from the archive.
  fs.appendFileSync(hotPath(), '\n')
  const recovered = ledger.usageTotals()
  assert.equal(recovered.calls, 3, 'valid archived rows are merged even when a sibling line is damaged')
  assert.ok(recovered.sessions >= 2)
  assert.ok(ledger.usageRecords().some(entry => entry.sessionId === 'session-archived'))
  assert.ok(ledger.usageArchiveDiagnostics().length > 0)
  assert.equal(fs.readFileSync(hotPath(), 'utf8').includes('session-archived'), false,
    'rotation/reading never rewrites the hot file from the archive')
})

test('an archive write failure is reported and leaves the hot file untouched', () => {
  const rows = [row(1), row(2)]
  resetLedger(rows)
  const hotBefore = fs.readFileSync(hotPath())
  fs.writeFileSync(archiveDirectory(), 'this file blocks the archive directory')
  const result = rotation.rotateUsageLedger({ maxBytes: 1, now: Date.now() })
  assert.equal(result.applied, false)
  assert.equal(result.skipped, 'error')
  assert.match(result.error, /用量归档写入失败/)
  assert.deepEqual(fs.readFileSync(hotPath()), hotBefore, 'a failed pass never rewrites the hot file')
  assert.equal(rotation.lastUsageRotation().skipped, 'error')
  assert.equal(ledger.usageRecords().length, 2, 'the hot rows remain readable after the failed pass')
})

test('the ledger read path itself triggers rotation through the size threshold env', () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1))
  resetLedger(rows)
  process.env.DSH_BUTLER_USAGE_ROTATE_BYTES = '100000000'
  try {
    const before = ledger.usageTotals()
    const beforeBytes = fs.statSync(hotPath()).size
    process.env.DSH_BUTLER_USAGE_ROTATE_BYTES = '200'
    const after = ledger.usageTotals()
    assert.deepEqual(after, before, 'the env-triggered rotation preserves the roll-up')
    const last = rotation.lastUsageRotation()
    assert.equal(last?.applied, true)
    assert.ok(fs.statSync(hotPath()).size < beforeBytes, 'the hot file was actually shrunk')
    assert.ok(fs.existsSync(archiveDirectory()))
    assert.ok(archiveLines().length > 0)
  } finally {
    delete process.env.DSH_BUTLER_USAGE_ROTATE_BYTES
  }
})

test('backfill writes state/logs instead of the daily page, and a second run is idempotent', async () => {
  resetLedger()
  fs.rmSync(vault.vaultPath('ledger', 'receipts.jsonl'), { force: true })
  const dailyDirectory = vault.vaultPath('daily')
  fs.mkdirSync(dailyDirectory, { recursive: true })
  const dailySeed = join(dailyDirectory, '2099-01-01.md')
  const seedContent = '# 2099-01-01\n\n- [任务] 保留这一行\n'
  fs.writeFileSync(dailySeed, seedContent)

  const sessionDirectory = join(process.env.DSH_HOME, 'sessions', 'workspace', 'session-fixture')
  fs.mkdirSync(sessionDirectory, { recursive: true })
  const loggedAt = Date.now() - 60_000
  const frames = [
    { type: 'session', seq: 0, time: loggedAt, data: { id: 'session-fixture' } },
    { type: 'assistant/message', seq: 101, time: loggedAt, data: { turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 }, message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/message', seq: 102, time: loggedAt + 1, data: { turn: 1, step: 2, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
  ]
  fs.writeFileSync(join(sessionDirectory, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)))

  const first = backfill.installUsageBackfill({ timeZone: 'Asia/Shanghai', immediate: true })
  await waitForCompletion(first, 'first backfill')
  assert.equal(first.problem, undefined)
  assert.equal(first.last.added, 2)
  assert.equal(first.last.files, 1)
  assert.equal(ledger.usageTotals().calls, 2)
  assert.equal(ledger.usageTotals().backfilledCalls, 2)

  // The owner-facing daily page is untouched: no run line, no new file.
  assert.deepEqual(fs.readdirSync(dailyDirectory), ['2099-01-01.md'])
  assert.equal(fs.readFileSync(dailySeed, 'utf8'), seedContent)
  for (const name of fs.readdirSync(dailyDirectory)) {
    assert.equal(fs.readFileSync(join(dailyDirectory, name), 'utf8').includes('[用量回填]'), false)
  }

  // The machine-readable log is the new home and is readable JSONL.
  const logPath = backfill.usageBackfillLogPath()
  assert.equal(logPath, vault.statePath('logs', 'usage-backfill.log'))
  assert.ok(fs.existsSync(logPath), 'a run that changed the ledger must leave a trace')
  const entries = linesOf(logPath).map(line => JSON.parse(line))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, 1)
  assert.equal(entries[0].added, 2)
  assert.match(entries[0].summary, /新增 2 次调用/)
  assert.ok(Array.isArray(entries[0].problems))
  assert.ok(ledger.receipts(10).some(receipt => receipt.tool === 'usage-backfill'))

  const second = backfill.installUsageBackfill({ timeZone: 'Asia/Shanghai', immediate: true })
  await waitForCompletion(second, 'second backfill')
  assert.equal(second.problem, undefined)
  assert.equal(second.last.added, 0)
  assert.equal(ledger.usageTotals().calls, 2, 'a repeated backfill must not duplicate records')
  assert.equal(ledger.usageTotals().backfilledCalls, 2)
  assert.equal(linesOf(logPath).length, 1, 'a no-change run does not append another log line')
  assert.equal(fs.readFileSync(dailySeed, 'utf8'), seedContent)
  assert.equal(ledger.receipts(10).filter(receipt => receipt.tool === 'usage-backfill').length, 1)
})
