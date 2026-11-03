import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const temporary = mkdtempSync(join(base, 'workspace-ui-'))
const state = join(temporary, 'state'), vault = join(temporary, 'vault'), legacyCwd = join(temporary, 'legacy-project')
for (const path of [state, vault, legacyCwd]) mkdirSync(path, { recursive: true })
process.env.DSH_BUTLER_HOME = state; process.env.DSH_BUTLER_VAULT = vault
const workspaceModule = await import('../src/host/workspace.ts').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error })
const ledger = await import('../src/host/ledger.ts')
after(() => { assert.ok(realpathSync(temporary).startsWith(realpathSync(base) + sep)); rmSync(temporary, { recursive: true, force: true }) })

let serial = 0
function environment() {
  const folder = join(state, 'case-' + ++serial); mkdirSync(folder)
  const registryFile = join(folder, 'workspace.json')
  const legacy = Buffer.from(JSON.stringify({ id: 'session-butler', cwd: legacyCwd, title: '原管家', retained: 'keep', titlePinned: true }) + '\n')
  writeFileSync(join(state, 'session.json'), legacy)
  const live = new Map(), persisted = new Map(), titles = new Map(), events = new Map(), workspaces = new Map(), calls = []
  persisted.set('session-butler', { id: 'session-butler', cwd: legacyCwd })
  const sessionQuery = {
    async readSession(id) { if (!persisted.has(id)) throw Object.assign(new Error('not found'), { name: 'SessionQueryError', code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); return { session: persisted.get(id), events: events.get(id) ?? [] } },
    async readSurface(id) { calls.push(['surface', id]); return { session: persisted.get(id), events: events.get(id) ?? [], inheritedEventCount: 0, capturedThroughSeq: events.get(id)?.at(-1)?.seq ?? null } },
  }
  const sessions = { get: id => live.get(id), list: () => [...live.values()], async flush(session) { calls.push(['flush', session.header.id]); persisted.set(session.header.id, session.header); return true } }
  const agents = {
    async create(input) { calls.push(['create', input.sessionId]); live.set(input.sessionId, { header: { id: input.sessionId, cwd: input.meta.cwd } }); return { agent: { id: input.sessionId } } },
    async resume(input) { calls.push(['resume', input.resumeSessionId]); live.set(input.resumeSessionId, { header: persisted.get(input.resumeSessionId) }); return { agent: { id: input.resumeSessionId } } },
  }
  const workspaceRegistry = { list: () => [...workspaces.values()], async resolveByPath(cwd) { return workspaces.get(cwd) }, async create(cwd, title) { const item = { id: 'workspace-' + workspaces.size, path: cwd, title, sessionIds: [], async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) } }; workspaces.set(cwd, item); return item } }
  const sessionTitle = { get: session => ({ title: titles.get(session.header.id), source: { kind: 'user' } }), rename(session, title) { calls.push(['rename', session.header.id, title]); titles.set(session.header.id, title); return { title } } }
  const service = value => ({ get: () => value, why: () => '' })
  const services = Object.fromEntries(Object.entries({ sessions, agents, sessionQuery, sessionTitle, workspaceRegistry }).map(([key, value]) => [key, service(value)]))
  const ctx = { get: key => ({ workspaceRegistry })[key], logger: { warn() {} } }
  function manager() { assert.equal(typeof workspaceModule.createButlerWorkspace, 'function', 'The approved independent workspace manager is missing'); return workspaceModule.createButlerWorkspace(ctx, services, { registryFile }) }
  return { manager, registryFile, legacy, live, persisted, events, calls, workspaces, titles }
}

test('independent daily and topic sessions survive reload without rewriting legacy records or cwd', async () => {
  const e = environment(), manager = e.manager()
  const daily = await manager.open()
  assert.equal(daily.id, 'session-butler-home'); assert.equal(daily.ready.canonicalCwd, realpathSync(vault))
  const [one, two] = await Promise.all([manager.create('科研'), manager.create('学习')])
  assert.notEqual(one.id, two.id)
  const loaded = e.manager(), snapshot = loaded.snapshot()
  assert.equal(snapshot.activeSessionId, two.id)
  assert.deepEqual(snapshot.sessions.filter(row => row.kind === 'topic').map(row => row.title), ['科研', '学习'])
  assert.equal((await loaded.open('session-butler')).cwd, legacyCwd)
  assert.ok(readFileSync(join(state, 'session.json')).equals(e.legacy))
  assert.equal(e.workspaces.get(realpathSync(vault)).title, '管家')
  assert.equal(e.persisted.get('session-butler').cwd, legacyCwd)
})

test('rename changes the exact native title and persists across reload; failed opens retain the active session', async () => {
  const e = environment(), manager = e.manager(), daily = await manager.open(), topic = await manager.create('临时主题')
  await manager.rename(topic.id, '科研进展')
  assert.equal(e.titles.get(topic.id), '科研进展')
  const renameIndex = e.calls.findLastIndex(row => row[0] === 'rename' && row[2] === '科研进展')
  assert.ok(e.calls.findLastIndex(row => row[0] === 'flush' && row[1] === topic.id) > renameIndex, 'Native rename must be flushed before durable UI acknowledgement')
  assert.equal(e.manager().snapshot().sessions.find(row => row.id === topic.id).title, '科研进展')
  e.persisted.set(daily.id, { id: daily.id, cwd: legacyCwd }); e.live.delete(daily.id)
  const failed = await manager.open(daily.id)
  assert.equal(failed.state, 'failed'); assert.equal(manager.snapshot().activeSessionId, topic.id)
  assert.equal(e.calls.filter(row => row[0] === 'create' && row[1] === daily.id).length, 1)
})

test('archive exports visible native surface and is incremental, preserving manual changes in a new generated version', async () => {
  const e = environment(), manager = e.manager(), daily = await manager.open()
  e.events.set(daily.id, [
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '整理本周进展' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: '已保存进展笔记' }] } } },
    { type: 'tool/result', seq: 3, time: 3, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'notes/progress.md' }, { type: 'reasoning', text: 'PRIVATE_TOOL_REASONING' }] }] } } },
    { type: 'system/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: 'PRIVATE_SYSTEM' }] } } },
    { type: 'user/message', seq: 5, time: 5, data: { source: { kind: 'system' }, content: [{ type: 'text', text: 'PRIVATE_INJECTED_USER_CONTEXT' }] } },
    { type: 'user/message', seq: 6, time: 6, data: { content: [{ type: 'text', text: 'PRIVATE_UNPROVEN_USER_CONTEXT' }] } },
  ])
  const first = await manager.archive(daily.id), original = readFileSync(first.path, 'utf8')
  assert.equal(first.conflict, false); assert.match(original, /整理本周进展/); assert.match(original, /notes\/progress.md/)
  assert.match(original, /#2/); assert.doesNotMatch(original, /PRIVATE_REASONING|PRIVATE_TOOL_REASONING|PRIVATE_SYSTEM|PRIVATE_INJECTED_USER_CONTEXT|PRIVATE_UNPROVEN_USER_CONTEXT/)
  assert.deepEqual(await manager.archive(daily.id), first)
  writeFileSync(first.path, 'owner edit\n')
  const conflict = await manager.archive(daily.id)
  assert.equal(conflict.conflict, true); assert.notEqual(conflict.path, first.path)
  assert.equal(readFileSync(first.path, 'utf8'), 'owner edit\n'); assert.equal(readFileSync(conflict.path, 'utf8'), original)
  assert.deepEqual(await manager.archive(daily.id), conflict, 'Repeated polling reuses the same generated conflict snapshot')
  assert.equal(e.calls.filter(row => row[0] === 'resume').length, 0, 'Export must not activate native agents')
})

test('a corrupt new registry fails closed and retains exact bytes', () => {
  const e = environment(), bytes = Buffer.from('{broken-workspace-registry')
  writeFileSync(e.registryFile, bytes)
  assert.throws(() => e.manager().snapshot(), /损坏|无效|JSON/)
  assert.ok(readFileSync(e.registryFile).equals(bytes)); assert.equal(e.calls.length, 0)
})

test('two manager instances serialize updates and never lose independent new topics', async () => {
  const e = environment(), first = e.manager(), second = e.manager()
  await first.open()
  const topics = await Promise.all([first.create('甲'), second.create('乙')])
  const rows = first.snapshot().sessions
  assert.ok(topics.every(topic => rows.some(row => row.id === topic.id)))
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
})

test('registered topic roots and descendants share butler scope without charging unrelated Codex histories', () => {
  assert.equal(typeof ledger.setButlerSessionIds, 'function', 'A singleton session id cannot attribute multiple managed chats')
  ledger.setButlerSessionIds(['session-butler-home', 'session-butler-topic-a'])
  assert.deepEqual(ledger.usageScope({ sessionId: 'session-butler-topic-a' }), { scope: 'butler', scopeKind: 'normal' })
  assert.deepEqual(ledger.usageScope({ sessionId: 'native-child', rootSessionId: 'session-butler-topic-a' }), { scope: 'butler', scopeKind: 'child' })
  assert.deepEqual(ledger.usageScope({ sessionId: 'codex-old' }), { scope: 'other', scopeKind: 'other' })
})
