import test, { after } from 'node:test'
import assert from 'node:assert/strict'
const navigation = await import('../src/client/navigate.ts')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })
const id = 'session-butler-client-readiness'
const ready = () => ({ id, title: '管家', state: 'live', cwd: 'E:/test/workspace', titlePinned: true, at: '2026-10-20T01:00:00Z',
  ready: { id, canonicalCwd: 'E:/test/workspace', workspaceId: 'workspace-client-test', attached: true, flushed: true } })
function environment(overview = { ok: true, session: ready() }) {
  const opened = [], panels = [], reads = []
  globalThis.fetch = async path => { reads.push(path); return { ok: true, json: async () => structuredClone(overview) } }
  const ctx = { get: name => name === 'uiWorkspace' ? { openSession: target => { opened.push(target) } } : undefined,
    layout: { selectPanel: target => { panels.push(target) } } }
  return { ctx, opened, panels, reads }
}

test('a cached/known header ID still awaits the existing overview before opening the exact ready string ID', async () => {
  const e = environment(), result = await navigation.openButlerConversation(e.ctx, id)
  assert.deepEqual(e.reads, ['/dsh-butler/api/overview'], 'Known IDs must not bypass native readiness')
  assert.deepEqual(e.opened, [id]); assert.equal(result.ok, true); assert.equal(result.sessionId, id)
})

for (const [name, change] of [
  ['missing ack', row => { delete row.ready }],
  ['failed native preparation', row => { row.state = 'failed'; row.note = 'workspace attach failed' }],
  ['flush false', row => { row.ready.flushed = false }],
  ['membership false', row => { row.ready.attached = false }],
  ['foreign acknowledgement', row => { row.ready.id = 'foreign-session' }],
  ['missing workspace', row => { row.ready.workspaceId = '' }],
  ['missing canonical cwd', row => { row.ready.canonicalCwd = '' }],
]) test(name + ' cannot open a stale known session or enter the ready ID cache', async () => {
  const session = ready(); change(session)
  const e = environment({ ok: true, session }), result = await navigation.openButlerConversation(e.ctx, id)
  assert.deepEqual(e.opened, []); assert.deepEqual(e.panels, ['butler']); assert.equal(result.ok, false)
  assert.ok(result.reason); assert.equal(navigation.cachedSessionId(), undefined)
})

test('an overview failure cannot use the old cached ID as a fallback conversation', async () => {
  const e = environment()
  globalThis.fetch = async () => { throw new Error('offline') }
  const result = await navigation.openButlerConversation(e.ctx, id)
  assert.equal(result.ok, false); assert.deepEqual(e.opened, []); assert.deepEqual(e.panels, ['butler'])
  assert.equal(navigation.cachedSessionId(), undefined)
})

test('cache learning accepts only a complete native readiness result', async () => {
  assert.equal(typeof navigation.rememberReadySession, 'function')
  assert.equal(navigation.rememberReadySession(ready()), id)
  assert.equal(navigation.cachedSessionId(), id)
  assert.equal(navigation.rememberReadySession({ ...ready(), state: 'failed' }), undefined)
  assert.equal(navigation.cachedSessionId(), undefined)
})

test('a later healthy read retries preparation instead of permanently caching a failure', async () => {
  const e = environment({ ok: true, session: { ...ready(), state: 'failed', note: 'not ready' } })
  assert.equal((await navigation.openButlerConversation(e.ctx, id)).ok, false)
  const restored = environment()
  assert.equal((await navigation.openButlerConversation(restored.ctx, id)).ok, true)
  assert.deepEqual(restored.opened, [id]); assert.equal(restored.reads.length, 1)
})
