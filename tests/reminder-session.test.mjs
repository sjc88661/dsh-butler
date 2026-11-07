import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
const { ReminderSessions, deleteOwnedReminder } = await import('../src/host/reminder-session.ts').catch(() => ({}))

function environment(options = {}) {
  assert.equal(typeof ReminderSessions, 'function', 'reminders must use an isolated persisted session')
  const created = [], delivered = [], live = new Map()
  const factory = {
    async create(options) {
      created.push(options)
      const agent = { id: options.sessionId, session: { id: options.sessionId }, followup: message => delivered.push({ sessionId: options.sessionId, message }) }
      await options.setup?.({ id: options.sessionId })
      live.set(agent.id, agent)
      return { agent }
    },
    get: id => live.get(id),
    async resume({ resumeSessionId }) { if (!live.has(resumeSessionId)) throw new Error('not found'); return { agent: live.get(resumeSessionId) } },
  }
  const sessions = new ReminderSessions({ agents: () => factory, cwd: 'E:/opendots/.butler/vault', ...options })
  return { sessions, factory, created, delivered }
}

test('each new reminder gets an independent session with no development history', async () => {
  const e = environment()
  const first = await e.sessions.create('development', 'read papers')
  const second = await e.sessions.create('development', 'drink water')
  assert.notEqual(first, 'development')
  assert.notEqual(first, second)
  assert.match(first, /^session-butler-reminder-/)
  assert.equal(e.created[0].seed, undefined)
  assert.equal(e.created[0].agentOptions.maxTokens, 1024)
  assert.equal(e.created[0].meta.cwd, 'E:/opendots/.butler/vault')
})

test('replaying the same accepted reminder creation does not create another session', async () => {
  const e = environment()
  const a = await e.sessions.create('development', 'read papers', 'call-123')
  const b = await e.sessions.create('development', 'read papers', 'call-123')
  assert.equal(a, b)
  assert.equal(e.created.length, 1)
})

test('a fresh isolated reminder resolves the current model and mounts its preset', async () => {
  const mounted = []
  const e = environment({ prepare: () => ({
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
    setup: async ctx => { mounted.push(ctx.id) },
  }) })
  const id = await e.sessions.create('development', 'read papers')
  assert.deepEqual(e.created[0].agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 1024 })
  assert.deepEqual(mounted, [id])
})

test('legacy scheduled messages are delivered only once to a dedicated agent', async () => {
  const e = environment()
  const message = { id: 'schedule-occurrence', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'read a note' }] }
  await e.sessions.redirect({ id: 'development' }, message)
  await e.sessions.redirect({ id: 'development' }, message)
  assert.equal(e.delivered.length, 1)
  assert.notEqual(e.delivered[0].sessionId, 'development')
  assert.equal(e.delivered[0].message.source.kind, 'schedule')
})

test('cancellation resolves the dedicated owner through the scheduler catalog', async () => {
  environment()
  let request
  // 0.2.2 catalog rows carry the destination under `target`, and cancellation is edit({ action: 'delete' }).
  const scheduler = { catalog: async () => [{ id: 'schedule-1', target: { kind: 'session', sessionId: 'session-butler-reminder-abc' } }],
    edit: async value => { request = value; return { id: value.id, deleted: true } } }
  await deleteOwnedReminder(scheduler, 'development', 'schedule-1')
  assert.deepEqual(request, { id: 'schedule-1', action: 'delete' })
})

test('a missing catalog ID is reported instead of cancelling an unrelated rule', async () => {
  environment()
  const scheduler = { catalog: async () => [], edit: async () => { throw new Error('must not delete') } }
  assert.equal((await deleteOwnedReminder(scheduler, 'development', 'missing')).deleted, false)
})

test('a delivery finishing after reload preserves reminders created by the new instance', async () => {
  const base = resolve('tests/.tmp')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'reminder-reload-'))
  try {
    const file = join(dir, 'reminders.json')
    let release
    const gate = new Promise(resolve => { release = resolve })
    const old = environment({ file, flush: async () => gate })
    const delivery = old.sessions.redirect({ id: 'dev' }, { id: 'occurrence-1', source: { kind: 'schedule' }, content: [] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(old.delivered.length, 1)
    const current = new ReminderSessions({ file, cwd: 'E:/opendots/.butler/vault', agents: () => old.factory })
    const newId = await current.create('dev', 'new reminder after reload')
    release(true)
    await delivery
    const restored = new ReminderSessions({ file, cwd: 'E:/opendots/.butler/vault', agents: () => old.factory })
    assert.equal(restored.status().length, 2)
    assert.ok(restored.status().some(binding => binding.id === newId))
    assert.deepEqual(restored.status().find(binding => binding.delivered.length)?.delivered, ['occurrence-1'])
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(base) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('old and reloaded managers claim one occurrence only after asynchronous preparation', async () => {
  const base = resolve('tests/.tmp')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'reminder-claim-'))
  try {
    const file = join(dir, 'reminders.json')
    const old = environment({ file })
    await old.sessions.create('dev', 'reminder', 'delivery:occurrence-1')
    const current = new ReminderSessions({ file, cwd: 'E:/opendots/.butler/vault', agents: () => old.factory })
    const message = { id: 'occurrence-1', source: { kind: 'schedule' }, content: [] }
    const results = await Promise.allSettled([
      old.sessions.redirect({ id: 'dev' }, message),
      current.redirect({ id: 'dev' }, message),
    ])
    assert.ok(results.some(result => result.status === 'fulfilled'))
    assert.equal(old.delivered.length, 1, 'hot reload must not forward the same scheduled occurrence twice')
    assert.deepEqual(current.status()[0].delivered, ['occurrence-1'])
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(base) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})
