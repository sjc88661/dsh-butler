import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const temporary = mkdtempSync(join((mkdirSync(resolve('tests/.tmp'), { recursive: true }), resolve('tests/.tmp')), 'conversation-sources-'))
process.env.DSH_BUTLER_HOME = join(temporary, 'state')
process.env.DSH_BUTLER_VAULT = join(temporary, 'vault')
const implementation = await import('../src/host/conversation-sources.ts')
const make = options => {
  assert.equal(typeof implementation.createConversationSources, 'function', 'conversation source manager must be implemented')
  const root = mkdtempSync(join(temporary, 'case-'))
  return implementation.createConversationSources({ stateFile: join(root, 'sources-state.json'), indexFile: join(root, 'sources-index.json'), ...options })
}
const at = Date.UTC(2026, 9, 21, 3)
const user = (seq, text) => ({ seq, type: 'user/message', time: at + seq, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = (seq, text) => ({ seq, type: 'assistant/message', time: at + seq, data: { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'text', text }] } } })
function native() {
  const calls = []
  const rows = [{ header: { id: 'main', cwd: 'E:/project', createdAt: at }, live: true, persisted: true }, { header: { id: 'child', cwd: 'E:/project', createdAt: at + 1, parentSession: 'main', isSeeded: true }, live: false, persisted: true }, { header: { id: 'other', cwd: 'E:/private', createdAt: at + 2 }, live: false, persisted: true }]
  return { calls, rows,
    async listSessions() { calls.push('list'); return structuredClone(rows) },
    async readTitleSnapshots(ids) { calls.push('titles'); return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: rows.find(r => r.header.id === id).header, title: { title: `Title ${id}`, time: at + 10 } } })) },
    async readSurface(id) { calls.push(`read:${id}`); return { session: { ...rows.find(r => r.header.id === id).header, inheritedEventCount: id === 'child' ? 2 : 0 }, events: id === 'child' ? [user(0, 'inherited'), assistant(1, 'inherited answer'), user(2, 'own question'), assistant(3, 'own answer')] : [user(0, 'project progress'), assistant(1, 'finished change')], capturedThroughSeq: 3 } },
  }
}

test('metadata indexing is idempotent, groups child sources, and performs no transcript reads', async () => {
  const query = native(), manager = make({ query: () => query })
  const first = await manager.list(), second = await manager.list()
  assert.equal(first.items.length, 3); assert.equal(second.items.length, 3)
  assert.equal(first.items.find(row => row.sessionId === 'child').parentId, 'main')
  assert.ok(first.items.every(row => row.title.startsWith('Title ')))
  assert.equal(query.calls.some(call => call.startsWith('read:')), false)
  assert.equal(query.calls.filter(call => call === 'titles').length, 1, 'unchanged polling must not replay cold logs for titles')
  assert.equal(manager.settings().codexEnabled, false)
  manager.dispose()
})

test('exclusions gate list, selection, reads and settings survive reloading', async () => {
  const query = native(), root = mkdtempSync(join(temporary, 'persistence-'))
  const options = { query: () => query, stateFile: join(root, 'state.json'), indexFile: join(root, 'index.json') }
  const manager = make(options); await manager.list()
  await manager.select('session-butler-home', [{ provider: 'dsh', sessionId: 'main' }])
  manager.configure({ excludedWorkspaces: ['dsh:E:/project'] })
  assert.equal((await manager.list()).items.some(row => row.sessionId === 'main'), false)
  assert.deepEqual(manager.selected('session-butler-home'), [])
  await assert.rejects(manager.read({ provider: 'dsh', sessionId: 'main' }), /排除|拒绝|无权/)
  assert.equal(query.calls.includes('read:main'), false)
  const reloaded = make(options)
  assert.deepEqual(reloaded.settings().excludedWorkspaces, ['dsh:E:/project'])
  assert.deepEqual(reloaded.selected('session-butler-home'), [])
  manager.dispose(); reloaded.dispose()
})

test('only own visible messages are read, stable identities preserved, output bounded', async () => {
  const query = native(), manager = make({ query: () => query }); await manager.list()
  const read = await manager.read({ provider: 'dsh', sessionId: 'child' }, { limit: 1, maxChars: 30 })
  assert.deepEqual(read.messages.map(row => row.text), ['own question'])
  assert.match(read.messages[0].id, /2$/)
  assert.equal(read.truncated, true); assert.equal(typeof read.nextOffset, 'number')
  const next = await manager.read({ provider: 'dsh', sessionId: 'child' }, { offset: read.nextOffset })
  assert.deepEqual(next.messages.map(row => row.text), ['own answer'])
  assert.doesNotMatch(JSON.stringify(next), /private thought/)
  manager.dispose()
})

test('an exclusion made during an asynchronous read prevents the result from escaping', async () => {
  const query = native(); let release
  const baseRead = query.readSurface.bind(query)
  query.readSurface = async id => { await new Promise(resolve => { release = resolve }); return baseRead(id) }
  const manager = make({ query: () => query }); await manager.list()
  const pending = manager.read({ provider: 'dsh', sessionId: 'main' })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  manager.configure({ excludedConversations: ['dsh:main'] }); release()
  await assert.rejects(pending, /排除|拒绝|无权/)
  manager.dispose()
})

test('Codex is opt-in, provider failures are explicit, and imported history has no usage writes', async () => {
  const query = native(); let codexCalls = 0
  const codex = { async list() { codexCalls++; return [{ key: 'codex:code', provider: 'codex', sessionId: 'code', title: 'Codex task', project: 'E:/code', updatedAt: new Date(at).toISOString(), available: true }] }, async read() { return { conversation: (await this.list())[0], messages: [{ id: 'turn:item', role: 'assistant', text: 'read-only result' }], version: 'v1', truncated: false } }, dispose() {} }
  const manager = make({ query: () => query, codex }); await manager.list(); assert.equal(codexCalls, 0)
  manager.configure({ codexEnabled: true }); assert.equal((await manager.list()).items.some(row => row.provider === 'codex'), true)
  assert.equal((await manager.read({ provider: 'codex', sessionId: 'code' })).messages[0].text, 'read-only result')
  codex.list = async () => { throw Error('unsupported readonly protocol') }
  const failed = await manager.list(); assert.match(failed.status.find(row => row.provider === 'codex').error, /unsupported/)
  manager.dispose()
})

test('corrupt settings and malformed identities preserve bytes and refuse writes', async () => {
  const root = mkdtempSync(join(temporary, 'corrupt-')), stateFile = join(root, 'state.json')
  writeFileSync(stateFile, '{broken')
  assert.throws(() => make({ query: () => native(), stateFile }), /损坏|格式|JSON/)
  assert.equal(readFileSync(stateFile, 'utf8'), '{broken')
  const manager = make({ query: () => native() })
  assert.throws(() => manager.configure({ excludedConversations: ['../../secret'] }), /无效|格式/)
  await assert.rejects(manager.read({ provider: 'dsh', sessionId: '../../auth.json' }), /无效|格式/)
  manager.dispose()
})

test('injected system context is not exposed and excluded metadata is removed from the readable index', async () => {
  const query = native(), root = mkdtempSync(join(temporary, 'private-index-')), indexFile = join(root, 'index.json')
  query.readSurface = async () => ({ session: { id: 'main', cwd: 'E:/project', inheritedEventCount: 0 }, events: [user(0, 'visible'), { ...user(1, 'private injected system context'), data: { role: 'user', source: { kind: 'system' }, content: [{ type: 'text', text: 'private injected system context' }] } }, assistant(2, 'answer')] })
  const manager = make({ query: () => query, indexFile }); await manager.list()
  assert.deepEqual((await manager.read({ provider: 'dsh', sessionId: 'main' })).messages.map(row => row.text), ['visible', 'answer'])
  manager.configure({ excludedWorkspaces: ['dsh:E:/project'] })
  assert.equal(JSON.parse(readFileSync(indexFile, 'utf8')).items.some(row => row.project === 'E:/project'), false)
  manager.dispose()
})

test('native event freshness survives a metadata refresh and explicit search can find Codex body text', async () => {
  const query = native()
  const codex = { async list() { return [{ key: 'codex:code', provider: 'codex', sessionId: 'code', title: 'An unrelated title', project: 'E:/code', updatedAt: new Date(at).toISOString(), available: true }] }, async read(ref) { return { conversation: (await this.list())[0], messages: [{ id: 'turn:item', role: 'assistant', text: 'unique result fragment' }], version: 'v1', truncated: false } }, dispose() {} }
  const manager = make({ query: () => query, codex }); await manager.list()
  manager.noteChanged('main', at + 90000)
  assert.equal((await manager.list()).items.find(row => row.sessionId === 'main').updatedAt, new Date(at + 90000).toISOString())
  manager.configure({ codexEnabled: true })
  const found = await manager.search({ provider: 'codex', q: 'unique result' })
  assert.deepEqual(found.items.map(row => row.sessionId), ['code'])
  manager.dispose()
})

test('tool results retain visible nested text and a seeded source without an inherited boundary fails closed', async () => {
  const query = native(), manager = make({ query: () => query }); await manager.list()
  query.readSurface = async () => ({ session: { id: 'main', cwd: 'E:/project', inheritedEventCount: 0 }, events: [{ seq: 1, type: 'tool/result', time: at, data: { message: { role: 'tool', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'saved result' }, { type: 'reasoning', text: 'private' }] }] } } }] })
  assert.deepEqual((await manager.read({ provider: 'dsh', sessionId: 'main' })).messages.map(row => [row.role, row.text]), [['tool', 'saved result']])
  query.readSurface = async () => ({ session: { id: 'child', cwd: 'E:/project', isSeeded: true }, events: [user(0, 'inherited secret')] })
  await assert.rejects(manager.read({ provider: 'dsh', sessionId: 'child' }), /继承|边界/)
  manager.dispose()
})

test('describe resolves an authorized source beyond the first UI page without reading its transcript', async () => {
  const query = native()
  query.rows.splice(0, query.rows.length, ...Array.from({ length: 251 }, (_, index) => ({ header: { id: `row-${index}`, cwd: 'E:/project', createdAt: at + index }, live: false, persisted: true })))
  const manager = make({ query: () => query }), page = await manager.list({ limit: 200 })
  const absent = query.rows.find(row => !page.items.some(item => item.sessionId === row.header.id)).header.id
  assert.equal((await manager.describe({ provider: 'dsh', sessionId: absent })).sessionId, absent)
  assert.equal(query.calls.some(call => call.startsWith('read:')), false)
  manager.configure({ excludedConversations: [`dsh:${absent}`] })
  await assert.rejects(manager.describe({ provider: 'dsh', sessionId: absent }), /排除|拒绝|无权/)
  manager.dispose()
})

test('only a native title change re-reads a known title while chat events update freshness cheaply', async () => {
  const query = native(), batches = [], original = query.readTitleSnapshots.bind(query)
  query.readTitleSnapshots = async ids => { batches.push([...ids]); return original(ids) }
  const manager = make({ query: () => query }); await manager.list()
  manager.noteChanged('main', at + 10000, 'user/message'); await manager.list()
  assert.equal(batches.length, 1)
  manager.noteChanged('main', at + 20000, 'session/title'); await manager.list()
  assert.deepEqual(batches[1], ['main'])
  manager.dispose()
})
