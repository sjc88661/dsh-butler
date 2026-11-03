import test from 'node:test'
import assert from 'node:assert/strict'
let runtime
try { runtime = await import('../src/host/dialogue-control.ts') } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }

function fixture(overrides = {}) {
  const calls = [], caller = { sessionId: 'session-butler-home', originMessageId: 'human-1' }
  const controller = {
    async list() { calls.push(['list']); return { items: [{ sessionId: 'zotero-reading', running: true, agentAvailable: true, projections: { huge: 'x'.repeat(100000) } }] } },
    async prompt(request) { calls.push(['prompt', request]); return { accepted: true } },
    async cancel(request) { calls.push(['cancel', request]); return { accepted: true } },
  }
  const access = { caller: () => caller, sources: () => ({ describe: async ref => ({ provider: 'dsh', sessionId: ref.sessionId, title: 'Reading', available: true }) }), controller: () => controller, timeZone: 'Asia/Shanghai', ...overrides }
  return { calls, caller, controller, access, tool: () => { assert.ok(runtime, 'dialogue-control module must exist'); return runtime.dialogueControlDefinition(access) } }
}

test('status stays read only and bounds native metadata output', async () => {
  const f = fixture(), tool = f.tool()
  const result = await tool.execute({ action: 'status', sessionId: 'zotero-reading' }, {})
  assert.equal(result.running, true)
  assert.deepEqual(f.calls.map(row => row[0]), ['list'])
  assert.ok(JSON.stringify(result).length < 2000)
  assert.match(tool.description, /明确/)
  assert.match(tool.description, /来源正文/)
})

test('status projections fallback exposes only counts and does not activate the target', async () => {
  const f = fixture(); delete f.controller.list
  f.controller.projections = async () => ({ kind: 'sequenced', asOfSeq: 17, values: { inbox: { 'next-turn': [{ secret: 'do not copy' }], 'next-step': [] }, modelSelection: { giant: 'x'.repeat(10000) } } })
  const result = await f.tool().execute({ action: 'status', sessionId: 'zotero-reading' }, {})
  assert.equal(result.pendingInputs, 1); assert.equal(result.asOfSeq, 17)
  assert.ok(!JSON.stringify(result).includes('do not copy'))
})

test('concurrent duplicate dispatch queues only one native prompt and keeps its envelope native', async () => {
  const f = fixture(), tool = f.tool(), args = { action: 'dispatch', sessionId: 'zotero-reading', prompt: 'Read the paper and report its DOI.' }
  const result = await Promise.all([tool.execute(args, {}), tool.execute(args, {}), tool.execute(args, {})])
  assert.ok(result.every(row => row.accepted === true && row.completed === undefined))
  const prompts = f.calls.filter(row => row[0] === 'prompt'); assert.equal(prompts.length, 1)
  assert.deepEqual(Object.keys(prompts[0][1]).sort(), ['clientTimeZone', 'content', 'mode', 'requestId', 'sessionId'])
  assert.equal(prompts[0][1].mode, 'queue'); assert.equal(prompts[0][1].content[0].text, args.prompt)
  const restarted = runtime.dialogueControlDefinition(f.access)
  const duplicated = await restarted.execute(args, {})
  assert.equal(duplicated.requestId, prompts[0][1].requestId)
  assert.equal(f.calls.filter(row => row[0] === 'prompt').length, 1, 'Recreating the adapter must retain process-local success deduplication')
  f.caller.originMessageId = 'human-2'; await tool.execute(args, {})
  assert.notEqual(f.calls.filter(row => row[0] === 'prompt').at(-1)[1].requestId, prompts[0][1].requestId)
})

test('distinct dispatches for the same target remain serial', async () => {
  const f = fixture(); let active = 0, max = 0
  f.controller.prompt = async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 8)); active--; return { accepted: true } }
  const tool = f.tool()
  await Promise.all(['first', 'second'].map(prompt => tool.execute({ action: 'dispatch', sessionId: 'zotero-reading', prompt }, {})))
  assert.equal(max, 1)
})

test('native rejection and failures are transparent and never automatically retried', async () => {
  for (const fail of [async () => ({ accepted: false }), async () => { throw new Error('native unavailable') }]) {
    const f = fixture(); let attempts = 0
    f.controller.prompt = async () => { attempts++; return fail() }
    await assert.rejects(f.tool().execute({ action: 'dispatch', sessionId: 'zotero-reading', prompt: 'Read this paper.' }, {}), /未接受|native unavailable/)
    assert.equal(attempts, 1)
  }
})

test('missing caller, excluded and self targets fail closed before native admission', async () => {
  const cases = [
    fixture({ caller: () => undefined }),
    fixture({ sources: () => ({ describe: async () => { throw new Error('来源已被排除') } }) }),
    fixture({ caller: () => ({ sessionId: 'zotero-reading', originMessageId: 'human' }) }),
    fixture({ caller: () => ({ sessionId: 'session-butler-home', originMessageId: '' }) }),
  ]
  for (const f of cases) {
    await assert.rejects(f.tool().execute({ action: 'dispatch', sessionId: 'zotero-reading', prompt: 'Work.' }, {}))
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  await assert.rejects(f.tool().execute({ action: 'dispatch', provider: 'codex', sessionId: 'zotero-reading', prompt: 'Work.' }, {}), /Codex|DSH|只读/)
  assert.equal(f.calls.length, 0)
})

test('ordinary fork lineage still permits status and native dispatch', async () => {
  const f = fixture({ sources: () => ({ describe: async () => ({ provider: 'dsh', sessionId: 'zotero-reading', title: 'ordinary fork', available: true, parentId: 'original-paper-session' }) }) })
  const tool = f.tool()
  assert.equal((await tool.execute({ action: 'status', sessionId: 'zotero-reading' }, {})).running, true)
  assert.equal((await tool.execute({ action: 'dispatch', sessionId: 'zotero-reading', prompt: 'Ordinary fork task.' }, {})).accepted, true)
  assert.equal(f.calls.filter(row => row[0] === 'prompt').length, 1)
})

test('native owned-child errors remain authoritative for dispatch and cancel', async () => {
  const f = fixture({ sources: () => ({ describe: async () => ({ provider: 'dsh', sessionId: 'zotero-reading', title: 'child', available: true, parentId: 'parent' }) }) })
  let attempts = 0
  f.controller.prompt = f.controller.cancel = async () => { attempts++; throw new Error('session is owned by subagent routing') }
  const tool = f.tool()
  for (const action of ['dispatch', 'cancel']) await assert.rejects(tool.execute({ action, sessionId: 'zotero-reading', prompt: 'Child-owned task.' }, {}), /owned by subagent routing/)
  assert.equal(attempts, 2)
})

test('status rejects native subagent origin rather than ordinary parent lineage', async () => {
  const f = fixture()
  f.controller.list = async () => ({ items: [{ sessionId: 'zotero-reading', parentSessionId: 'parent', origin: 'subagent', running: true }] })
  await assert.rejects(f.tool().execute({ action: 'status', sessionId: 'zotero-reading' }, {}), /子会话/)
})

test('projection-only status distinguishes inherited subagent descriptors from own descriptors', async () => {
  const f = fixture(); delete f.controller.list
  let inheritedEventCount = 10
  f.controller.projections = async () => ({ kind: 'sequenced', asOfSeq: 20, values: { subagent: { mode: 'continuable', label: 'ancestor', seq: 4 } } })
  f.controller.inspect = async () => ({ meta: { id: 'zotero-reading', parentSession: 'ancestor' }, inheritedEventCount })
  const tool = f.tool()
  assert.equal((await tool.execute({ action: 'status', sessionId: 'zotero-reading' }, {})).asOfSeq, 20)
  inheritedEventCount = 0
  await assert.rejects(tool.execute({ action: 'status', sessionId: 'zotero-reading' }, {}), /子会话/)
})

test('prompt limits reject empty, overlong and excessive UTF8 input before sending', async () => {
  for (const prompt of ['', ' ', 'x'.repeat(6001), '😀'.repeat(3001)]) {
    const f = fixture()
    await assert.rejects(f.tool().execute({ action: 'dispatch', sessionId: 'zotero-reading', prompt }, {}), /正文|prompt|6000|18000/)
    assert.equal(f.calls.length, 0)
  }
})

test('cancel reports only current turn cancellation and pending inbox retention', async () => {
  const f = fixture(), result = await f.tool().execute({ action: 'cancel', sessionId: 'zotero-reading' }, {})
  assert.equal(result.accepted, true); assert.equal(result.pendingInbox, 'preserved')
  assert.match(result.notice, /当前.*turn|当前轮/)
  assert.deepEqual(f.calls, [['cancel', { sessionId: 'zotero-reading' }]])
  f.controller.cancel = async () => { throw new Error('subagent ownership') }
  await assert.rejects(f.tool().execute({ action: 'cancel', sessionId: 'zotero-reading' }, {}), /subagent ownership/)
})
