import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'

const parent = resolve('tests/.tmp'); fs.mkdirSync(parent, { recursive: true })
const fixture = fs.mkdtempSync(join(parent, 'action-approval-noop-'))
process.env.DSH_BUTLER_HOME = join(fixture, 'state'); process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts')
const store = await import('../src/host/store.ts')
const peerStore = await import('../src/host/store.ts?action-noop-peer')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { ActionApprovalService, actionArgumentsDigest } = await import('../src/host/action-approval.ts')
const actionFile = vault.statePath('action-approvals.json'), journal = vault.statePath('store-operations.jsonl')
const read = path => fs.readFileSync(path), json = path => JSON.parse(read(path))
const event = (seq, type, data = {}) => ({ seq, type, data })
const empty = () => ({ version: 1, proposals: [], audits: {} })

function removeOwned(path) {
  if (!fs.existsSync(path)) return
  const absolute = resolve(path), actual = fs.realpathSync(path)
  assert.ok(absolute === fixture || absolute.startsWith(fixture + sep))
  assert.ok(actual.startsWith(fs.realpathSync(parent) + sep))
  fs.rmSync(absolute, { recursive: true, force: true })
}
beforeEach(() => {
  removeOwned(vault.STATE_HOME); removeOwned(vault.VAULT_HOME); vault.ensureVault()
  store.commitFiles({ kind: 'test.history', targetId: 'history', operationId: 'noop-history',
    writes: [{ path: vault.statePath('history.txt'), content: 'Historical local snapshot.\n'.repeat(512) }] })
})
after(() => removeOwned(fixture))

/** Count real sequential journal bytes and fsyncs without changing the underlying I/O. */
function measure(action) {
  const names = ['openSync', 'closeSync', 'readSync', 'fsyncSync']
  const original = Object.fromEntries(names.map(name => [name, fs[name]])), fds = new Map()
  const metrics = { scans: [], journalSyncs: 0 }
  fs.openSync = (path, ...args) => {
    const fd = original.openSync(path, ...args)
    fds.set(fd, { journal: typeof path === 'string' && resolve(path) === resolve(journal), bytes: 0 })
    return fd
  }
  fs.closeSync = fd => { try { return original.closeSync(fd) } finally { fds.delete(fd) } }
  fs.readSync = (fd, buffer, offset, length, position) => {
    const size = original.readSync(fd, buffer, offset, length, position), current = fds.get(fd)
    if (current?.journal && position === null) { current.bytes += size; if (size === 0) metrics.scans.push(current.bytes) }
    return size
  }
  fs.fsyncSync = fd => { const value = original.fsyncSync(fd); if (fds.get(fd)?.journal) metrics.journalSyncs++; return value }
  syncBuiltinESMExports()
  try { return { value: action(), metrics } }
  finally { for (const name of names) fs[name] = original[name]; syncBuiltinESMExports() }
}
const addedPrepares = before => read(journal).subarray(before.length).toString('utf8').split('\n').filter(Boolean)
  .map(line => JSON.parse(line)).filter(row => row.phase === 'prepared')

function setup({ query = true, contextsOptions = {} } = {}) {
  const agent = { id: 'owner', session: { id: 'owner', inheritedEventCount: 0 } }
  const contexts = new ExecutionContexts({ file: vault.statePath('contexts.json'), runFor: () => 'run-owner', ...contextsOptions })
  contexts.bindUser(agent, { id: 'origin', source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the exact external action for my approval.' }] })
  contexts.activate('business', contexts.forAgent(agent)); contexts.captureRequest(agent, 1, 1)
  const exec = { agent, name: 'send_email', callId: 'call-owner', arguments: { recipient: 'owner@example.invalid', text: 'Reviewed content' } }
  const identity = { ...contexts.capture(exec)[1].identity }, events = [event(0, 'turn/start', { turn: 1 })]
  const config = { contexts, now: () => Date.parse('2026-10-20T00:00:00.000Z'),
    ...(query ? { sessionQuery: { async readSession(id) {
      assert.equal(id, agent.id); return { inheritedEventCount: 0, events: structuredClone(events) }
    } } } : {}) }
  const service = new ActionApprovalService(config)
  const target = { toolName: exec.name, argsDigest: actionArgumentsDigest(exec.arguments), taskId: identity.taskId, callId: exec.callId }
  const observe = row => service.observeSessionEvent(agent.session, row)
  const propose = () => service.propose(target, identity)
  return { agent, contexts, config, service, exec, identity, target, events, observe, propose }
}

for (const hasUnrelatedFile of [false, true]) test(`query-backed unbound turns retain one fresh validation per event without creating audit commits (${hasUnrelatedFile ? 'unrelated state' : 'absent file'})`, t => {
  const file = { ...empty(), futureRoot: { keep: ['exact'] }, audits: { other: { inheritedEventCount: 0, cursor: 1,
    events: [event(0, 'turn/start', { turn: 7 })], futureAudit: { keep: true } } } }
  if (hasUnrelatedFile) fs.writeFileSync(actionFile, JSON.stringify(file) + '\n')
  const service = new ActionApprovalService({ contexts: new ExecutionContexts(), sessionQuery: { async readSession() { throw Error('No query is needed to observe an unrelated turn') } } })
  const before = read(journal), approvalBefore = fs.existsSync(actionFile) ? read(actionFile) : undefined
  const { metrics } = measure(() => {
    service.observeSessionEvent({ id: 'unbound', inheritedEventCount: 0 }, event(0, 'turn/start', { turn: 1 }))
    service.observeSessionEvent({ id: 'unbound', inheritedEventCount: 0 }, event(1, 'turn/end'))
  })
  const prepares = addedPrepares(before)
  t.diagnostic(JSON.stringify({ sample: 'unbound-start-and-end', beforeBytes: before.length, commits: prepares.length,
    fullScans: metrics.scans.length, fullScanBytes: metrics.scans.reduce((sum, n) => sum + n, 0), ...metrics }))
  assert.equal(prepares.length, 0, 'Unbound query-backed turns must not publish unused action.native-event transactions')
  assert.deepEqual(read(journal), before); assert.deepEqual(metrics.scans, [before.length, before.length]); assert.equal(metrics.journalSyncs, 0)
  if (approvalBefore) assert.deepEqual(read(actionFile), approvalBefore)
  else assert.equal(fs.existsSync(actionFile), false)
})

test('before_model_call is explicitly outside the native approval audit and does not create a transaction', () => {
  const service = new ActionApprovalService({ contexts: new ExecutionContexts(), sessionQuery: { async readSession() { throw Error('unused') } } })
  const before = read(journal), { metrics } = measure(() => service.observeSessionEvent({ id: 'unbound', inheritedEventCount: 0 }, event(0, 'before_model_call', { turn: 1 })))
  assert.deepEqual(read(journal), before); assert.equal(fs.existsSync(actionFile), false)
  assert.deepEqual(metrics.scans, []); assert.equal(metrics.journalSyncs, 0)
})

for (const reload of [false, true]) test(`a later same-turn proposal recovers the complete native boundary and consumes one exact grant (${reload ? 'reloaded' : 'same'} service)`, async () => {
  const h = setup(), preserved = { ...empty(), futureRoot: { keep: true }, audits: { other: { inheritedEventCount: 0, cursor: 0, events: [], futureAudit: [1, 2] } } }
  fs.writeFileSync(actionFile, JSON.stringify(preserved) + '\n'); h.observe(h.events[0])
  const service = reload ? new ActionApprovalService(h.config) : h.service
  const proposal = await service.propose(h.target, h.identity)
  assert.equal(proposal.auditAfter, 1); assert.equal(proposal.status, 'pending')
  assert.deepEqual(json(actionFile).audits.owner.events, h.events)
  assert.deepEqual(json(actionFile).futureRoot, preserved.futureRoot); assert.deepEqual(json(actionFile).audits.other, preserved.audits.other)
  const asked = event(1, 'approval/asked', { id: 'request', toolName: h.exec.name, callId: h.exec.callId })
  const decided = event(2, 'approval/decided', { id: 'request', outcome: 'allowed-once' })
  h.events.push(asked, decided)
  service.observeSessionEvent(h.agent.session, asked); service.observeSessionEvent(h.agent.session, decided)
  assert.equal(service.authorize(proposal.id, h.exec).allowed, true)
  assert.equal(service.authorize(proposal.id, h.exec).allowed, false)
  assert.equal(json(actionFile).proposals[0].status, 'consumed')
})

test('the live observer fallback still persists a turn before any proposal and proves one allowed-once result', async () => {
  const h = setup({ query: false }), before = read(journal); h.observe(h.events[0])
  assert.equal(addedPrepares(before).length, 1); assert.deepEqual(json(actionFile).audits.owner.events, h.events)
  const proposal = await h.propose()
  h.observe(event(1, 'approval/asked', { id: 'live', toolName: h.exec.name, callId: h.exec.callId }))
  h.observe(event(2, 'approval/decided', { id: 'live', outcome: 'allowed-once' }))
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, true)
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

for (const query of [false, true]) test(`a pending proposal keeps turn/end as a denying approval boundary (${query ? 'query' : 'live fallback'})`, async () => {
  const h = setup({ query }); h.observe(h.events[0]); const proposal = await h.propose()
  const asked = event(1, 'approval/asked', { id: 'interrupted', toolName: h.exec.name, callId: h.exec.callId })
  h.observe(asked); const before = read(journal), ended = event(2, 'turn/end')
  h.observe(ended)
  assert.equal(addedPrepares(before).length, 1); assert.ok(json(actionFile).audits.owner.events.some(row => row.type === 'turn/end'))
  h.observe(event(3, 'approval/decided', { id: 'interrupted', outcome: 'allowed-once' }))
  assert.equal(h.service.authorize(proposal.id, h.exec).allowed, false)
})

test('an existing own audit retains its durable cursor and duplicate-event semantics', () => {
  const h = setup(); fs.writeFileSync(actionFile, JSON.stringify({ ...empty(), audits: { owner: { inheritedEventCount: 0, cursor: 1, events: [h.events[0]] } } }) + '\n')
  const before = read(journal), ended = event(1, 'turn/end'); h.observe(ended)
  assert.equal(addedPrepares(before).length, 1); assert.equal(json(actionFile).audits.owner.cursor, 2)
  const first = json(actionFile); h.observe(ended); assert.deepEqual(json(actionFile), first)
  assert.throws(() => h.observe(event(1, 'turn/start', { turn: 2 })), /事件已变化/)
  assert.throws(() => h.service.observeSessionEvent({ id: 'owner', inheritedEventCount: 1 }, event(2, 'turn/start', { turn: 2 })), /边界已变化/)
})

for (const contents of ['{broken', JSON.stringify({ version: 1, proposals: 'invalid', audits: {} })]) test(`unbound query-backed turn events fail closed on ${contents.startsWith('{broken') ? 'JSON' : 'schema'} damage`, () => {
  const h = setup(); fs.writeFileSync(actionFile, contents); const before = read(journal)
  assert.throws(() => h.observe(h.events[0]), error => error.name === 'StorageError')
  assert.equal(read(actionFile).toString('utf8'), contents); assert.deepEqual(read(journal), before)
})

test('each later no-op candidate validates complete journal bytes even after a same-size restored-mtime edit', () => {
  const h = setup(); h.observe(h.events[0]); const before = read(journal), stamp = fs.statSync(journal), damaged = Buffer.from(before)
  damaged[0] = 91; fs.writeFileSync(journal, damaged); fs.utimesSync(journal, stamp.atime, stamp.mtime)
  assert.throws(() => h.observe(event(1, 'turn/end')), error => error.name === 'StorageError')
  assert.deepEqual(read(journal), damaged)
})

test('a peer proposal between independent events is observed and its audit is not skipped or replaced', async () => {
  const h = setup(); h.observe(h.events[0]); const peer = new ActionApprovalService(h.config), proposal = await peer.propose(h.target, h.identity)
  const value = json(actionFile); value.futureRoot = { peer: true }; value.proposals[0].futureProposal = ['retain']; fs.writeFileSync(actionFile, JSON.stringify(value) + '\n')
  const before = read(journal); h.observe(event(1, 'turn/end'))
  assert.equal(addedPrepares(before).length, 1); const after = json(actionFile)
  assert.equal(after.proposals[0].id, proposal.id); assert.deepEqual(after.proposals[0].futureProposal, ['retain'])
  assert.deepEqual(after.futureRoot, { peer: true }); assert.ok(after.audits.owner.events.some(row => row.type === 'turn/end'))
})

test('a same-session proposal remains meaningful even when its own audit row is absent', async () => {
  const h = setup(), proposal = await h.propose(), value = json(actionFile)
  delete value.audits.owner; fs.writeFileSync(actionFile, JSON.stringify(value) + '\n')
  const before = read(journal); h.observe(event(1, 'turn/start', { turn: 1 }))
  assert.equal(addedPrepares(before).length, 1)
  assert.equal(json(actionFile).proposals[0].id, proposal.id)
  assert.deepEqual(json(actionFile).audits.owner.events, [event(1, 'turn/start', { turn: 1 })])
})

test('query capability reentry is resolved before the fresh snapshot and cannot hide a peer proposal', async () => {
  const h = setup(); await h.propose()
  const peerContent = read(actionFile).toString('utf8'), nativeQuery = h.config.sessionQuery
  fs.writeFileSync(actionFile, JSON.stringify(empty()) + '\n'); let armed = true
  Object.defineProperty(h.config, 'sessionQuery', { get() {
    if (armed) {
      armed = false
      peerStore.commitFiles({ kind: 'test.peer', targetId: 'peer', operationId: 'peer-before-event-snapshot',
        writes: [{ path: actionFile, format: 'json', content: peerContent }] })
    }
    return nativeQuery
  } })
  h.observe(event(1, 'turn/end'))
  assert.equal(armed, false); assert.equal(json(actionFile).proposals.length, 1)
  assert.ok(json(actionFile).audits.owner.events.some(row => row.type === 'turn/end'))
  assert.equal(store.readCommittedOperation('peer-before-event-snapshot').kind, 'test.peer')
})

test('a runFor peer write during a meaningful event still fails CAS and preserves the peer operation', async () => {
  let armed = false, peerBytes, peerWal
  const h = setup({ contextsOptions: { runFor() {
    if (armed) {
      armed = false; const current = json(actionFile), next = { ...current, futurePeer: { kept: true } }
      peerStore.commitFiles({ kind: 'test.peer', targetId: 'peer', operationId: 'peer-during-event',
        writes: [{ path: actionFile, format: 'json', content: JSON.stringify(next) + '\n' }] })
      peerBytes = read(actionFile); peerWal = read(journal)
    }
    return 'run-owner'
  } } })
  await h.propose(); armed = true
  assert.throws(() => h.observe(event(1, 'turn/end')), error => error.name === 'StorageError' && /冲突/.test(error.message))
  assert.equal(armed, false); assert.deepEqual(read(actionFile), peerBytes); assert.deepEqual(read(journal), peerWal)
  assert.equal(store.readCommittedOperation('peer-during-event').kind, 'test.peer')
})
