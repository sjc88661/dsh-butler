import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'usage-auxiliary-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { installUsageRecorder, priceUsage } = await import('../src/host/usage.ts')
const { addUsage, usageRecords, usageTotals, usageKeys } = await import('../src/host/ledger.ts')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
const { runUsageBackfill } = await import('../src/host/backfill.ts')
const { usageView, usageBreakdownView } = await import('../src/client/workbench-model.ts')
ensureVault()
const at = Date.UTC(2026, 9, 21, 3)
const known = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 3 }
const route = { provider: 'deepseek-account', model: 'deepseek-v4-flash' }
const request = (purpose = 'session-title', extra = {}) => ({ ...route, purpose, sessionId: 'native-session', messages: [], ...extra })
const chunks = (...values) => (async function* () { yield* values })()
const consume = async stream => { const seen = []; for await (const chunk of stream) seen.push(chunk); return seen }
function environment(options = {}) {
  writeFileSync(vaultPath('ledger', 'usage.jsonl'), '')
  const listeners = new Map(), detached = []
  let initiator, context
  const recorder = installUsageRecorder({
    get: () => ({ currentInitiator: () => initiator }),
    on(name, listener) { listeners.set(name, listener); return () => { detached.push(name); listeners.delete(name) } },
  }, { auxiliaryContext: () => context, ...options })
  return { recorder, listeners, detached,
    identity(agent, identity) { initiator = agent; context = identity },
    stream(req, source) { const next = () => source; return listeners.get('llm/stream')?.(req, next) ?? next() },
    send(seq, usage = known) { listeners.get('session/event')({ id: 'native-session' }, { type: 'assistant/message', seq, time: at,
      data: { turn: 1, step: 1, usage, message: { source: route } } }) },
  }
}

test('native title streams record only the final provider snapshot without changing chunks or claiming a task', async () => {
  const e = environment(), a = { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } }, b = { type: 'usage', usage: known }
  e.identity({ id: 'native-session', session: { id: 'native-session' } }, { sessionId: 'native-session', taskId: 'later-task', runId: 'later-run', ownerId: 'owner' })
  const finish = { type: 'finish', reason: { kind: 'stop' } }, expected = [a, b, finish]
  const actual = await consume(e.stream(request(), chunks(...expected)))
  actual.forEach((chunk, index) => assert.equal(chunk, expected[index]))
  const [row] = usageRecords()
  assert.ok(row, 'a native auxiliary request must leave a durable usage row')
  assert.equal(row.callKind, 'auxiliary'); assert.equal(row.purpose, 'session-title')
  assert.equal(row.sessionId, 'native-session'); assert.equal(row.taskId, undefined); assert.equal(row.runId, undefined); assert.equal(row.ownerId, undefined)
  assert.equal(row.totalTokens, 12); assert.equal(row.inputTokens, 10)
  assert.equal(row.outcome, 'completed'); assert.equal(row.cost, undefined, 'account calls must not borrow official prices')
  assert.equal(usageTotals().totalTokens, 12)
  e.recorder.stop(); assert.deepEqual(e.detached.sort(), ['llm/stream', 'session/event'])
})

test('title source markers work without purpose, while unknown purposes and main assistant streams are not double counted', async () => {
  const e = environment()
  await consume(e.stream(request(undefined, { purpose: undefined, messages: [{ role: 'user', source: { kind: 'dsh-session-title-llm' } }] }), chunks({ type: 'usage', usage: known })))
  await consume(e.stream(request('future-main-purpose'), chunks({ type: 'usage', usage: known })))
  await consume(e.stream(request(undefined, { purpose: undefined }), chunks({ type: 'usage', usage: known })))
  e.send(1)
  assert.equal(usageRecords().length, 2)
  assert.equal(usageTotals().assistantCalls, 1); assert.equal(usageTotals().auxiliaryCalls, 1)
  assert.equal(e.recorder.status().uncoveredPurposeStreams, 1)
  e.recorder.stop()
})

test('compaction captures the exact initiator context before iteration and never trusts another session or request task fields', async () => {
  const e = environment(), original = { sessionId: 'native-session', rootSessionId: 'root-session', ownerId: 'owner',
    taskId: 'task-A', runId: 'run-A', originMessageId: 'input-A', turn: 1, step: 1, callId: 'tool-A' }
  e.identity({ id: 'native-session', session: { id: 'native-session' } }, original)
  const stream = e.stream(request('compaction'), chunks({ type: 'usage', usage: known }))
  original.taskId = 'task-B'; original.runId = 'run-B'
  e.identity({ id: 'another-session', session: { id: 'another-session' } }, { sessionId: 'another-session', taskId: 'other', runId: 'other' })
  await consume(stream)
  await consume(e.stream(request('compaction', { taskId: 'forged', ownerId: 'forged' }), chunks({ type: 'usage', usage: known })))
  e.identity(undefined, original)
  await consume(e.stream(request('compaction'), chunks({ type: 'usage', usage: known })))
  const rows = usageRecords()
  assert.equal(rows.length, 3)
  assert.equal(rows[0].taskId, 'task-A'); assert.equal(rows[0].runId, 'run-A'); assert.equal(rows[0].ownerId, 'owner')
  assert.equal(rows[0].turn, undefined); assert.equal(rows[0].step, undefined); assert.notEqual(rows[0].callId, 'tool-A')
  assert.equal(rows[1].sessionId, 'native-session'); assert.equal(rows[1].taskId, undefined); assert.equal(rows[1].ownerId, undefined)
  assert.equal(rows[2].taskId, undefined)
  e.recorder.stop()
})

test('failures, protocol errors, cancellation and missing usage retain their real outcomes and propagate the original failure', async () => {
  const e = environment(), failure = new Error('original failure'), signal = new AbortController()
  const broken = (async function* () { yield { type: 'usage', usage: known }; throw failure })()
  await assert.rejects(consume(e.stream(request('compaction'), broken)), error => error === failure)
  const protocolError = { type: 'finish', reason: { kind: 'error', failure: { code: 'quota' } } }
  assert.equal((await consume(e.stream(request(), chunks(protocolError))))[0], protocolError)
  const cancelled = e.stream(request('compaction', { signal: signal.signal }), chunks({ type: 'text-delta', text: 'partial' }, { type: 'usage', usage: known }))
  for await (const _chunk of cancelled) break
  signal.abort()
  await consume(e.stream(request(), chunks({ type: 'finish', reason: { kind: 'aborted' } })))
  await consume(e.stream(request(), chunks({ type: 'finish', reason: { kind: 'stop' } })))
  const rows = usageRecords()
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map(row => row.outcome), ['failed', 'failed', 'cancelled', 'cancelled', 'completed'])
  assert.deepEqual(rows.map(row => row.usageState), ['reported', 'unknown', 'unknown', 'unknown', 'unknown'])
  assert.equal(usageTotals().withoutUsage, 4); assert.equal(usageTotals().totalTokens, 12)
  e.recorder.stop()
})

test('each stream retry has independent identity and auxiliary append replay never collides with assistant backfill', async () => {
  const e = environment()
  for (let i = 0; i < 2; i++) await consume(e.stream(request(), chunks({ type: 'usage', usage: known })))
  const [row] = usageRecords()
  assert.ok(row, 'stream attempts must be recorded before identity replay is checked')
  addUsage(row); addUsage(row)
  assert.equal(usageRecords().length, 2); assert.equal(usageKeys().size, 2)
  addUsage({ ...row, turn: 1, step: 1, at: new Date(at).toISOString() })
  const logHome = join(home, 'logs'), dir = join(logHome, 'sessions', 'workspace', 'native-session'); mkdirSync(dir, { recursive: true })
  const event = { type: 'assistant/message', seq: 77, time: at, data: { turn: 1, step: 1, usage: { totalTokens: 7 }, message: {} } }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')))
  runUsageBackfill({ home: logHome, now: at + 1000 })
  assert.equal(usageRecords().length, 3)
  assert.equal(usageTotals().auxiliaryCalls, 2); assert.equal(usageTotals().assistantCalls, 1)
  assert.equal(usageRecords().find(item => item.eventSeq === 77).callKind, undefined)
  assert.equal(usageRecords().find(item => item.callId === row.callId).purpose, 'session-title')
  e.recorder.stop()
})

test('abort signals without a terminal chunk and synchronous middleware failures preserve cancellation and error semantics', async () => {
  const e = environment(), controller = new AbortController(), failure = new Error('synchronous middleware failure')
  const source = (async function* () { yield { type: 'usage', usage: known }; controller.abort() })()
  await consume(e.stream(request('compaction', { signal: controller.signal }), source))
  assert.throws(() => e.listeners.get('llm/stream')(request(), () => { throw failure }), error => error === failure)
  assert.throws(() => e.listeners.get('llm/stream')(request('compaction', { signal: controller.signal }), () => { throw failure }), error => error === failure)
  assert.deepEqual(usageRecords().map(row => row.outcome), ['cancelled', 'failed', 'cancelled'])
  assert.equal(usageRecords()[0].usageState, 'reported')
  e.recorder.stop()
})

test('observer failures cannot mask a provider error and unknown purposes return the identical stream', async () => {
  const e = environment({ butlerSession() { throw new Error('recorder storage scope unavailable') } }), failure = new Error('original provider failure')
  const broken = (async function* () { throw failure })()
  await assert.rejects(consume(e.stream(request(), broken)), error => error === failure)
  assert.equal(e.recorder.status().failed, 1)
  assert.match(e.recorder.status().auxiliaryProblem, /recorder storage scope unavailable/)
  const source = chunks({ type: 'usage', usage: known })
  assert.equal(e.stream(request('unverified-purpose'), source), source)
  assert.equal(usageRecords().length, 0)
  e.recorder.stop()
})

test('compaction without run proof and obsolete task callbacks cannot charge a recent business task', async () => {
  const e = environment({ taskId: () => 'recent-task' })
  e.identity({ id: 'native-session', session: { id: 'native-session' } }, { sessionId: 'native-session', taskId: 'stale-task', ownerId: 'stale-owner' })
  await consume(e.stream(request('compaction'), chunks({ type: 'usage', usage: known })))
  e.send(2)
  assert.equal(usageRecords()[0].taskId, undefined); assert.equal(usageRecords()[0].ownerId, undefined)
  assert.equal(usageRecords()[1].taskId, undefined)
  e.recorder.stop()
})

test('totals and workbench distinguish helper purposes, unknown usage and partial price coverage while preserving legacy costs', async () => {
  const e = environment()
  addUsage({ at: new Date(at).toISOString(), sessionId: 'legacy', totalTokens: 8, cost: 0.5, costBasis: 'historical' })
  await consume(e.stream(request('session-title', { provider: 'deepseek-official' }), chunks({ type: 'usage', usage: known })))
  await consume(e.stream(request('compaction'), chunks({ type: 'usage', usage: known })))
  await consume(e.stream(request(), chunks()))
  const totals = usageTotals()
  assert.equal(totals.calls, 4); assert.equal(totals.assistantCalls, 1); assert.equal(totals.auxiliaryCalls, 3)
  assert.equal(totals.pricedCalls, 2); assert.equal(totals.unpricedCalls, 1); assert.equal(totals.withoutUsage, 1)
  assert.equal(totals.byPurpose['session-title'].calls, 2); assert.equal(totals.byPurpose['session-title'].withoutUsage, 1)
  assert.equal(totals.byPurpose.compaction.unpricedCalls, 1); assert.equal(totals.byPurpose.assistant.cost, 0.5)
  assert.match(usageView(totals).costText, /部分.*2\/4.*未知/)
  const breakdown = usageBreakdownView(totals).join('；')
  assert.match(breakdown, /助手回复.*1/); assert.match(breakdown, /会话命名.*2/); assert.match(breakdown, /上下文压缩.*1/)
  assert.match(breakdown, /缺用量.*1/); assert.match(breakdown, /未计价.*1/)
  const panel = readFileSync(resolve('src/client/panel.ts'), 'utf8')
  assert.ok(!panel.includes('此账本不含会话命名'))
  e.recorder.stop()
})

test('partial input, partial output and total-only usage keep real tokens unpriced without repricing stored historical costs', async () => {
  const e = environment(), official = { provider: 'deepseek-official', model: route.model }
  const partials = [{ inputTokens: 9 }, { outputTokens: 4 }, { totalTokens: 13 }]
  for (const [index, tokens] of partials.entries()) {
    assert.deepEqual(priceUsage({ ...official, ...tokens, usageState: 'reported' }, at), {}, 'an omitted input/output count cannot mean zero')
    await consume(e.stream(request('session-title', official), chunks({ type: 'usage', usage: tokens })))
    // Historical rows without a stored amount use the same completeness rule
    // when the workbench considers deriving an estimate on read.
    addUsage({ at: new Date(at).toISOString(), sessionId: `partial-legacy-${index}`, ...official, ...tokens })
  }
  const partialRows = usageRecords()
  assert.equal(partialRows.length, 6)
  assert.ok(partialRows.every(row => row.cost === undefined && row.costBasis === undefined))
  assert.ok(partialRows.filter(row => row.callKind === 'auxiliary').every(row => row.usageState === 'reported'))
  assert.equal(usageTotals().pricedCalls, 0); assert.equal(usageTotals().derivedCalls, 0)
  assert.equal(usageTotals().unpricedCalls, 6); assert.equal(usageTotals().withoutUsage, 0)
  for (const invalid of [{ inputTokens: -1, outputTokens: 2 }, { inputTokens: 1, outputTokens: NaN }, { inputTokens: Infinity, outputTokens: 2 }]) {
    assert.deepEqual(priceUsage({ ...official, ...invalid }, at), {})
  }
  addUsage({ at: new Date(at).toISOString(), sessionId: 'stored-partial', eventSeq: 700, ...official, inputTokens: 9,
    cost: 0.5, costBasis: 'historical-partial-policy' })
  addUsage({ at: new Date(at).toISOString(), sessionId: 'stored-partial', eventSeq: 700, ...official, inputTokens: 9,
    origin: 'backfill', cost: 999, costBasis: 'new-policy-must-not-overwrite-history' })
  assert.equal(usageRecords().find(row => row.eventSeq === 700).cost, 0.5)
  assert.equal(usageRecords().find(row => row.eventSeq === 700).costBasis, 'historical-partial-policy')
  assert.equal(usageTotals().cost, 0.5); assert.equal(usageTotals().pricedCalls, 1); assert.equal(usageTotals().derivedCalls, 0)
  assert.ok(priceUsage({ ...official, inputTokens: 0, outputTokens: 2 }, at).cost > 0, 'actually reported zero input remains valid')
  e.recorder.stop()
})
