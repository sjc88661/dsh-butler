import test from 'node:test'
import assert from 'node:assert/strict'
let runtime
try { runtime = await import('../src/host/legacy-tool-series.ts') } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }

function fixture({ baseline = [], current = [{ name: 'read' }], header = { config: { provider: 'native', model: 'original', maxTokens: 8192 }, adapterDefaults: { maxTokens: true } }, affected = () => true } = {}) {
  assert.ok(runtime, 'legacy migration module must exist')
  let listener, removed = false, history = { tools: baseline, updates: [] }
  const appended = [], calls = [], session = {
    requestHeader() { calls.push('header'); return header },
    toolHistory() { calls.push('history'); return history },
    append(type, data) { calls.push('append'); appended.push({ type, data }); header = data.header; history = { tools: header.tools, updates: [] } },
  }
  const agent = { id: 'zotero-reading', session }
  const repair = runtime.installLegacyToolSeriesRepair({ on(name, handler, options) { assert.equal(name, 'system-prompt/assemble'); assert.equal(options.global, true); listener = handler; return () => { removed = true } } }, { affected })
  const assembly = { tools: current, sections: [{ name: 'original' }], contexts: [] }
  return { agent, session, repair, assembly, appended, calls, removed: () => removed,
    invoke: async (next = async () => assembly) => listener(undefined, { agent }, next) }
}

test('affected empty baseline rebases once and preserves the assembly and native envelope', async () => {
  const f = fixture(), result = await f.invoke()
  assert.strictEqual(result, f.assembly)
  assert.equal(f.appended.length, 1)
  assert.equal(f.appended[0].type, 'request/header'); assert.equal(f.appended[0].data.reason, 'series')
  assert.strictEqual(f.appended[0].data.header.tools, f.assembly.tools)
  assert.deepEqual(f.appended[0].data.header.config, { provider: 'native', model: 'original', maxTokens: 8192 })
  assert.deepEqual(f.appended[0].data.header.adapterDefaults, { maxTokens: true })
  await f.invoke(); assert.equal(f.appended.length, 1)
  assert.equal(f.repair.status().count, 1); assert.equal(f.repair.status().lastSessionId, f.agent.id)
  f.repair.stop(); assert.equal(f.removed(), true)
})

test('disjoint PTC directory rebases but a current immediate baseline stays untouched', async () => {
  const ptc = fixture({ baseline: [{ name: 'read' }], current: [{ name: 'run_code' }] })
  await ptc.invoke(); assert.equal(ptc.appended.length, 1)
  const active = fixture({ baseline: [{ name: 'read' }], current: [{ name: 'read' }, { name: 'write' }] })
  await active.invoke(); assert.equal(active.appended.length, 0)
})

test('unaffected and newly created sessions do not read history or append', async () => {
  const outside = fixture({ affected: () => false })
  await outside.invoke(); assert.deepEqual(outside.calls, [])
  const fresh = fixture({ header: undefined })
  fresh.session.requestHeader = () => { fresh.calls.push('header'); return undefined }
  await fresh.invoke(); assert.deepEqual(fresh.calls, ['header'])
  const empty = fixture({ current: [] })
  await empty.invoke(); assert.deepEqual(empty.calls, [])
})

test('scope is rechecked after asynchronous assembly before touching the session', async () => {
  let allowed = true
  const f = fixture({ affected: () => allowed })
  await f.invoke(async () => { allowed = false; return f.assembly })
  assert.deepEqual(f.calls, [])
})

test('all explicitly deferred current tools remain unchanged and report unsupported', async () => {
  const f = fixture({ current: [{ name: 'dynamic', deferLoading: true }] })
  assert.strictEqual(await f.invoke(), f.assembly)
  assert.deepEqual(f.calls, [])
  assert.equal(f.assembly.tools[0].deferLoading, true)
  assert.equal(f.repair.status().count, 0)
  assert.equal(f.repair.status().unsupported.sessionId, f.agent.id)
  assert.match(f.repair.status().unsupported.reason, /deferred/)
})

test('append failure blocks the assembly and keeps repair count unchanged', async () => {
  const f = fixture()
  f.session.append = () => { throw new Error('native append failed') }
  await assert.rejects(f.invoke(), /native append failed/)
  assert.equal(f.repair.status().count, 0)
  const missing = fixture(); delete missing.session.append
  await assert.rejects(missing.invoke(), /声明基线|append/)
})
