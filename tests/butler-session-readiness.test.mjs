import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const temporary = mkdtempSync(join(base, 'butler-session-ready-'))
const stateHome = join(temporary, 'state'), workspacePath = join(temporary, 'workspace'), foreignPath = join(temporary, 'foreign')
for (const path of [stateHome, workspacePath, foreignPath]) mkdirSync(path, { recursive: true })
process.env.DSH_BUTLER_HOME = stateHome
process.env.DSH_BUTLER_VAULT = join(temporary, 'vault')
const { createButlerSession } = await import('../src/host/session.ts')
const id = 'session-butler-readiness-test', title = '管家准备回归'
const recordFile = join(stateHome, 'session.json')
after(() => {
  assert.ok(realpathSync(temporary).startsWith(realpathSync(base) + sep))
  rmSync(temporary, { recursive: true, force: true })
})

function queryError(code) { return Object.assign(new Error(code), { name: 'SessionQueryError', code }) }
function environment(options = {}) {
  const calls = [], live = new Map(), config = { ...options }
  let persisted = options.persisted !== false
  const session = { header: { id: options.liveId ?? id, cwd: options.liveCwd ?? workspacePath } }
  const native = { id: options.nativeId ?? id, cwd: options.nativeCwd ?? workspacePath }
  if (options.live !== false) live.set(id, session)
  const original = Buffer.from(JSON.stringify({ id, title, cwd: workspacePath, state: 'resumed', titlePinned: true,
    at: '2026-10-20T01:00:00.000Z', retainedUnknown: { owner: 'preserve' } }, null, 2) + '\n')
  writeFileSync(recordFile, original)
  const workspace = { id: 'workspace-readiness-test', path: workspacePath, title: '测试工作区', sessionIds: [],
    async attachSession(target) {
      calls.push(['attach', target])
      assert.equal(target, id)
      await config.onAttach?.({ live, session, workspace })
      if (config.attachError) throw config.attachError
      if (!config.noMembership && !workspace.sessionIds.includes(target)) workspace.sessionIds.push(target)
    } }
  const sessions = { get: target => live.get(target), list: () => [...live.values()],
    async flush(value) {
      calls.push(['flush', value])
      assert.equal(value, session, 'The public Session, never an AgentHandle, is flushed')
      await config.onFlush?.({ live, session })
      if (config.flushError) throw config.flushError
      if (config.flushResult === false) return false
      persisted = true
      return true
    } }
  const query = { async readSession(target) {
    calls.push(['read', target]); assert.equal(target, id)
    await config.onRead?.({ live, session })
    if (config.queryError) throw config.queryError
    if (!persisted) throw queryError('SESSION_QUERY_SESSION_NOT_FOUND')
    return { session: { ...native }, inheritedEventCount: 0, events: [] }
  } }
  const agents = { get: target => live.has(target) ? { id: target } : undefined,
    async resume({ resumeSessionId, setup, agentOptions }) {
      calls.push(['resume', resumeSessionId]); assert.equal(resumeSessionId, id)
      if (config.resumeError) throw config.resumeError
      if (!persisted) throw queryError('SESSION_QUERY_SESSION_NOT_FOUND')
      if (setup) { calls.push(['preset', agentOptions]); assert.equal(await setup({ scope: id }), undefined) }
      live.set(id, session)
      return { agent: { id: config.handleId ?? id, session } }
    },
    async create(input) {
      calls.push(['create', input]); assert.equal(input.sessionId, id)
      assert.equal(input.meta.cwd, workspacePath)
      if (input.setup) { assert.equal(input.meta.agentPreset, 'standard'); calls.push(['preset', input.agentOptions]); assert.equal(await input.setup({ scope: id }), undefined) }
      live.set(id, session)
      return { agent: { id: config.handleId ?? id, session } }
    } }
  const registry = { list: () => [workspace],
    async resolveByPath(cwd) { calls.push(['resolve', cwd]); return config.workspaceMissing ? undefined : workspace },
    async create(cwd) { calls.push(['workspace-create', cwd]); return workspace } }
  const titles = { get: () => ({ title, source: { kind: 'user' } }), rename() { calls.push(['rename']) } }
  const slot = (name, value) => ({ get: () => config.missing === name ? undefined : value, why: () => name + ' unavailable' })
  const services = { sessions: slot('sessions', sessions), agents: slot('agents', agents), sessionTitle: slot('sessionTitle', titles),
    sessionQuery: slot('sessionQuery', query), workspaceRegistry: slot('workspaceRegistry', registry), resolved: () => [] }
  const manager = createButlerSession({ logger: { warn() {} }, get: name => name === 'workspaceRegistry' ? registry : undefined }, services,
    { id, title, cwd: options.cwd ?? workspacePath, prepare: options.prepare, verifyLive: options.verifyLive })
  // On the parent revision exercise its real public ensure path, rather than
  // making RED merely an absent-export assertion. GREEN must expose ensureReady.
  const open = () => typeof manager.ensureReady === 'function' ? manager.ensureReady() : manager.ensure()
  return { manager, open, config, calls, workspace, native, session, original }
}

test('a live blank session in an initialized workspace receives durable membership before UI readiness', async () => {
  const e = environment(), result = await e.open()
  assert.ok(e.workspace.sessionIds.includes(id), 'Resident/title/cwd alone do not attach a session to the initialized workspace')
  assert.deepEqual(result.ready, { id, canonicalCwd: realpathSync(workspacePath), workspaceId: e.workspace.id, attached: true, flushed: true })
  assert.equal(typeof e.manager.ensureReady, 'function')
  assert.deepEqual(e.calls.map(row => row[0]), ['flush', 'read', 'resolve', 'attach'])
  assert.equal(result.id, id); assert.equal(result.titlePinned, true)
})

test('resumed and newly created sessions use the same flush, query and attachment checkpoint', async () => {
  for (const persisted of [true, false]) {
    const e = environment({ live: false, persisted }), result = await e.open()
    assert.equal(result.ready?.id, id)
    const names = e.calls.map(row => row[0])
    assert.equal(names.includes('resume'), persisted)
    assert.equal(names.includes('create'), !persisted)
    assert.ok(names.indexOf('read') < names.indexOf(persisted ? 'resume' : 'create'), 'Only official typed absence may authorize creation')
    assert.ok(names.indexOf('flush') < names.lastIndexOf('read'))
    assert.ok(names.lastIndexOf('read') < names.indexOf('attach'))
  }
})

test('dedicated create and resume mount the native preset before becoming ready', async () => {
  for (const persisted of [true, false]) {
    const mounted = []
    const e = environment({ live: false, persisted, prepare: target => { assert.deepEqual(target, { id, existing: persisted }); return { presetId: 'standard', agentOptions: { provider: 'native-test', model: 'bounded-test' },
      setup: async context => { mounted.push(context.scope) } } } })
    const result = await e.open()
    assert.equal(result.ready?.id, id)
    assert.deepEqual(mounted, [id])
    assert.deepEqual(e.calls.find(row => row[0] === 'preset')[1], { provider: 'native-test', model: 'bounded-test' })
    assert.ok(e.calls.findIndex(row => row[0] === 'preset') < e.calls.findIndex(row => row[0] === 'flush'))
  }
})

test('missing native setup stops before create or resume and retains the saved identity', async () => {
  const e = environment({ live: false, prepare: () => { throw new Error('native preset unavailable') } })
  assert.equal((await e.open()).state, 'failed')
  assert.equal(e.calls.some(row => ['create', 'resume'].includes(row[0])), false)
  assert.ok(readFileSync(recordFile).equals(e.original))
})

test('a resident session without its native preset cannot advertise readiness', async () => {
  const e = environment({ verifyLive: () => { throw new Error('native preset not composed') } })
  assert.equal((await e.open()).state, 'failed')
  assert.equal(e.calls.some(row => ['create', 'resume', 'flush', 'attach'].includes(row[0])), false)
  assert.ok(readFileSync(recordFile).equals(e.original))
})

test('an existing workspace is reused, and an absent one is resolved through the public create method', async () => {
  for (const workspaceMissing of [false, true]) {
    const e = environment({ workspaceMissing }), result = await e.open()
    assert.equal(result.ready?.workspaceId, e.workspace.id)
    assert.equal(e.calls.filter(row => row[0] === 'workspace-create').length, Number(workspaceMissing))
  }
})

for (const [name, options] of [
  ['flush false', { flushResult: false }],
  ['flush failure', { flushError: new Error('flush failed') }],
  ['query corruption', { queryError: queryError('SESSION_QUERY_CORRUPT_SESSION') }],
  ['query source conflict', { queryError: queryError('SESSION_QUERY_SOURCE_CONFLICT') }],
  ['foreign native id', { nativeId: 'foreign-session' }],
  ['foreign native cwd', { nativeCwd: foreignPath }],
  ['foreign live id', { liveId: 'foreign-session' }],
  ['foreign live cwd', { liveCwd: foreignPath }],
  ['attachment failure', { attachError: new Error('attach failed') }],
  ['missing membership acknowledgement', { noMembership: true }],
]) test(name + ' fails closed without a ready acknowledgement or new agent', async () => {
  const e = environment(options), result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.ok(result.note)
  assert.equal(e.calls.some(row => ['create', 'resume'].includes(row[0])), false)
})

for (const capability of ['sessions', 'sessionQuery', 'workspaceRegistry']) test('missing ' + capability + ' cannot mint UI readiness', async () => {
  const e = environment({ missing: capability }), result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.equal(e.calls.some(row => ['create', 'resume', 'attach'].includes(row[0])), false)
})

test('a resume/setup or persistence failure never falls through to create over the old ID', async () => {
  for (const options of [
    { resumeError: new Error('resume setup failed') },
    { queryError: queryError('SESSION_QUERY_PERSISTENCE_FAILED') },
    { queryError: Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
  ]) {
    const e = environment({ live: false, ...options }), result = await e.open()
    assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
    assert.equal(e.calls.some(row => row[0] === 'create'), false)
  }
})

test('a resumed handle with a different id cannot attach or advertise the original ID', async () => {
  const e = environment({ live: false, handleId: 'foreign-handle' }), result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.equal(e.calls.some(row => row[0] === 'attach'), false)
})

test('ready observations retain the original session record bytes, including unknown owner fields', async () => {
  const e = environment()
  await e.open(); await e.open()
  assert.ok(readFileSync(recordFile).equals(e.original), 'A GET/readiness observation must not replace resumed metadata with live/time churn')
})

test('concurrent readiness calls share work and a failed attachment can be retried', async () => {
  const e = environment({ attachError: new Error('temporary attach failure') })
  const first = await Promise.all([e.open(), e.open()])
  assert.ok(first.every(row => row.state === 'failed' && row.ready === undefined))
  assert.equal(e.calls.filter(row => row[0] === 'attach').length, 1)
  e.config.attachError = undefined
  const next = await e.open()
  assert.equal(next.ready?.attached, true)
  assert.equal(e.calls.filter(row => row[0] === 'attach').length, 2)
})

test('a corrupt session record remains intact and cannot create a replacement identity', async () => {
  const e = environment({ live: false, persisted: false }), bytes = Buffer.from('{broken-owner-record')
  writeFileSync(recordFile, bytes)
  const result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.equal(e.calls.some(row => ['create', 'resume'].includes(row[0])), false)
  assert.ok(existsSync(recordFile)); assert.ok(readFileSync(recordFile).equals(bytes))
})

test('an invalid working directory is rejected before native creation even after typed absence', async () => {
  const e = environment({ live: false, persisted: false, cwd: join(temporary, 'missing-directory') }), result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.equal(e.calls.some(row => ['create', 'resume', 'rename', 'attach'].includes(row[0])), false)
  assert.ok(readFileSync(recordFile).equals(e.original))
})

test('a peer identity update during native lookup prevents stale resume or creation', async () => {
  for (const persisted of [true, false]) {
    const peer = Buffer.from(JSON.stringify({ id: 'peer-owned-session', title: 'peer title', cwd: foreignPath, untouched: true }) + '\n')
    const e = environment({ live: false, persisted, onRead: () => writeFileSync(recordFile, peer) }), result = await e.open()
    assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
    assert.equal(e.calls.some(row => ['create', 'resume', 'attach'].includes(row[0])), false)
    assert.ok(readFileSync(recordFile).equals(peer), 'Peer metadata must not be replaced after an await')
  }
})

test('a peer record update while attaching is preserved and cannot produce a stale acknowledgement', async () => {
  const peer = Buffer.from('{"id":"peer-owned-session","owner":"retain-exact-bytes"}\n')
  const e = environment({ onAttach: () => writeFileSync(recordFile, peer) }), result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.ok(readFileSync(recordFile).equals(peer))
})

test('replacement of the resident Session during attachment invalidates the ready acknowledgement', async () => {
  const e = environment({ onAttach: ({ live, session }) => live.set(id, { header: { ...session.header } }) }), result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.ok(readFileSync(recordFile).equals(e.original))
})

test('only the official typed not-found error permits creation', async () => {
  const e = environment({ live: false, queryError: Object.assign(new Error('Not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }) })
  const result = await e.open()
  assert.equal(result.state, 'failed'); assert.equal(result.ready, undefined)
  assert.equal(e.calls.some(row => ['create', 'resume', 'attach'].includes(row[0])), false)
})
