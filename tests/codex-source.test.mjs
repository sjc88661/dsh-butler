import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

const implementation = await import('../src/host/codex-source.ts')
const make = options => {
  assert.equal(typeof implementation.createCodexSource, 'function', 'readonly Codex adapter must be implemented')
  return implementation.createCodexSource(options)
}

test('Codex adapter only lists and reads through readonly calls and pages user-visible items', async () => {
  const calls = []
  const source = make({ request: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/list') return { data: [{ id: 'codex-1', name: 'Code review', cwd: 'E:/code', updatedAt: 1792551600 }], nextCursor: null }
    if (method === 'thread/read') return { thread: { id: 'codex-1', name: 'Code review', cwd: 'E:/code', updatedAt: 1792551600 } }
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Review work' }] }, { id: 'r1', type: 'reasoning', summary: ['private thoughts'] }, { id: 'a1', type: 'agentMessage', text: 'Review complete' }] }], nextCursor: null }
    throw Error(`Unexpected ${method}`)
  } })
  assert.equal((await source.list())[0].title, 'Code review')
  const result = await source.read({ provider: 'codex', sessionId: 'codex-1' })
  assert.deepEqual(result.messages.map(row => row.text), ['Review work', 'Review complete'])
  assert.deepEqual(result.messages.map(row => row.id), ['turn-1:u1', 'turn-1:a1'])
  assert.doesNotMatch(JSON.stringify(result), /private thoughts/)
  assert.equal(calls.some(row => /start|resume|fork|name\/set|goal\/set/.test(row.method)), false)
  assert.equal(calls[0].params.useStateDbOnly, true)
  assert.ok(calls[0].params.sourceKinds.includes('appServer'))
  assert.ok(calls[0].params.sourceKinds.includes('subAgent'))
  assert.ok(calls.filter(row => row.method === 'thread/turns/list').every(row => row.params.itemsView === 'summary'))
  source.dispose()
})

test('Codex truncated inventory and archived metadata stay explicit without changing original threads', async () => {
  const source = make({ maxPages: 1, request: async (method, params) => {
    assert.equal(method, 'thread/list')
    return { data: [{ id: params.archived ? 'old' : 'active', name: 'Stored', updatedAt: 1 }], nextCursor: 'more' }
  } })
  assert.equal((await source.list()).length, 2)
  assert.equal(source.truncated, true)
  source.dispose()
})

test('Codex adapter bounds pagination and reports an unsupported read API rather than resuming', async () => {
  const calls = []
  const source = make({ maxPages: 2, request: async (method, params) => {
    calls.push(method)
    if (method === 'thread/list') return { data: [{ id: `id-${params.cursor ?? 'first'}`, name: 'Stored', updatedAt: 1 }], nextCursor: String(calls.length) }
    if (method === 'thread/read') return { thread: { id: 'first', updatedAt: 1 } }
    throw Error('unsupported method')
  } })
  assert.ok((await source.list()).length <= 4)
  await assert.rejects(source.read({ provider: 'codex', sessionId: 'first' }), /unsupported/)
  assert.equal(calls.includes('thread/resume'), false)
  source.dispose()
})

test('a startup failure preserves the exit status instead of masquerading as an empty inventory', async () => {
  const source = make({ executable: process.execPath, timeoutMs: 2000 })
  await assert.rejects(source.list(), /退出.*(?:码|code).*1/)
  source.dispose()
})

test('a small read of a long tool-heavy conversation stops after bounded display summaries', async () => {
  const calls = []
  const source = make({ request: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/read') return { thread: { id: 'long-thread', updatedAt: 1792551600 } }
    if (method === 'thread/turns/list') {
      assert.equal(params.itemsView, 'summary', 'full turn hydration would include megabytes of private reasoning and tool output')
      assert.ok(params.limit <= 4, 'a bounded read must use small turn pages')
      assert.equal(params.cursor, undefined, 'limit four is satisfied on the first small page')
      return { data: [{ id: 'turn-1', itemsView: 'summary', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'first request' }] }, { id: 'answer-1', type: 'agentMessage', text: 'first result' }] }, { id: 'turn-2', itemsView: 'summary', items: [{ id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'second request' }] }, { id: 'answer-2', type: 'agentMessage', text: 'second result' }] }], nextCursor: 'remaining-thousands-of-turns' }
    }
    throw Error(`Unnecessary request ${method}`)
  } })
  const read = await source.read({ provider: 'codex', sessionId: 'long-thread' }, { limit: 4, maxChars: 200 })
  assert.equal(read.messages.length, 4); assert.equal(read.truncated, true); assert.equal(read.nextOffset, 4)
  assert.equal(calls.length, 2)
  source.dispose()
})

test('exact citations use a bounded item page in the original turn when absent from its display summary', async () => {
  const calls = []
  const source = make({ request: async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/read') return { thread: { id: 'cite-thread', updatedAt: 1792551600 } }
    if (method === 'thread/turns/list') return { data: [{ id: 'original-turn', itemsView: 'summary', items: [{ id: 'first', type: 'userMessage', content: [{ type: 'text', text: 'request' }] }, { id: 'last', type: 'agentMessage', text: 'terminal response' }] }], nextCursor: null }
    if (method === 'thread/items/list') {
      assert.equal(params.turnId, 'original-turn'); assert.ok(params.limit <= 4)
      if (!params.cursor) return { data: [{ turnId: 'original-turn', item: { id: 'before', type: 'reasoning', summary: ['not visible'] } }], nextCursor: 'wanted-page' }
      assert.equal(params.cursor, 'wanted-page')
      return { data: [{ turnId: 'original-turn', item: { id: 'middle', type: 'agentMessage', text: 'Exact middle evidence' } }], nextCursor: 'unnecessary-large-tool-output' }
    }
    throw Error(`Unexpected ${method}`)
  } })
  const read = await source.read({ provider: 'codex', sessionId: 'cite-thread', eventId: 'original-turn:middle' }, { limit: 1, maxChars: 200 })
  assert.deepEqual(read.messages.map(row => [row.id, row.text]), [['original-turn:middle', 'Exact middle evidence']])
  assert.equal(calls.filter(row => row.method === 'thread/items/list').length, 2)
  assert.doesNotMatch(JSON.stringify(read), /not visible/)
  source.dispose()
})

test('bounded metadata polling can exceed 64 MiB across a healthy connection without a lifetime byte failure', async () => {
  let killed = false
  const payload = 'x'.repeat(4 * 1024 * 1024)
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString())
    if (request.id !== undefined) setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : { data: [], nextCursor: null, ignored: payload } }) + '\n'))
    callback()
  } })
  child.kill = () => { killed = true; child.killed = true; setImmediate(() => child.emit('exit', 0)); return true }
  const source = make({ spawnProcess: () => child, timeoutMs: 2000 })
  for (let index = 0; index < 9; index++) assert.deepEqual(await source.list(), [])
  assert.equal(killed, false)
  source.dispose()
})

test('a capped summary scan omits an unreachable offset and an exact summary citation stays exact', async () => {
  const source = make({ maxPages: 1, request: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'capped', updatedAt: 1792551600 } }
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', itemsView: 'summary', items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] }, { id: 'a1', type: 'agentMessage', text: 'answer' }] }], nextCursor: 'beyond-page-budget' }
    throw Error(`Summary citation must not hydrate tool outputs: ${method}`)
  } })
  const page = await source.read({ provider: 'codex', sessionId: 'capped' }, { limit: 20 })
  assert.equal(page.truncated, true); assert.equal(page.nextOffset, undefined)
  const exact = await source.read({ provider: 'codex', sessionId: 'capped', eventId: 'turn-1:a1' })
  assert.deepEqual(exact.messages.map(row => [row.id, row.text]), [['turn-1:a1', 'answer']])
  assert.equal(exact.truncated, false); assert.equal(exact.nextOffset, undefined)
  assert.equal(page.version, exact.version, 'a source revision must not depend on preview pagination')
  source.dispose()
})
