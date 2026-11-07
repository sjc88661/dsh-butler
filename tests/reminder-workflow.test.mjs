import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'reminder-workflow-'))
process.env.DSH_BUTLER_HOME = join(root, 'state')
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
const { ReminderOperations } = await import('../src/host/reminder-operations.ts').catch(() => ({}))
const ledger = await import('../src/host/ledger.ts')
const { ensureVault, readText, vaultPath } = await import('../src/host/vault.ts')
const { executionKey } = await import('../src/host/execution-context.ts')
ensureVault()
after(() => {
  assert.ok(realpathSync(root).startsWith(realpathSync(base) + sep))
  rmSync(root, { recursive: true, force: true })
})

let sequence = 0
function environment(options = {}) {
  assert.equal(typeof ReminderOperations, 'function', 'reminder creation needs a durable operation service')
  const number = ++sequence, created = [], deleted = [], historyRequests = [], destinations = [], rows = []
  let receipts = []
  const schedule = {
    // 0.2.2: one request object plus the acting butler session, never a session-first pair.
    async create(request, actorSessionId) {
      created.push({ request, actorSessionId })
      const row = { id: `schedule-${number}-${created.length}`, kind: request.timing.kind, title: request.title, prompt: request.prompt,
        scheduledAt: '2030-01-02T03:04:00+08:00', target: request.target, status: 'active' }
      rows.push(row)
      return row
    },
    async catalog() { return structuredClone(rows) },
    // 0.2.2: cancellation is edit({ action: 'delete' }); ids are host-wide.
    async edit(request) { deleted.push(request); return { id: request.id, deleted: true } },
    async history(ref) { historyRequests.push(ref); return { records: structuredClone(receipts) } },
    async list() { return [] }, async update() {},
  }
  const identity = { sessionId: `development-${number}`, rootSessionId: `development-${number}`, turn: 2, step: 1, callId: 'native-call', runId: 'budget-run' }
  const reminder = { title: 'Read the paper', prompt: 'Read figure 2', at: '2030-01-02T03:04', timeZone: 'Asia/Shanghai' }
  const settings = {
    file: join(process.env.DSH_BUTLER_HOME, `reminder-operations-${number}.json`),
    schedule: () => schedule,
    destination: async (sourceSessionId, title, callKey) => {
      destinations.push({ sourceSessionId, title, callKey })
      return `session-butler-reminder-${number}-${destinations.length}`
    },
    now: () => '2026-10-15T01:00:00.000Z',
    ...options,
  }
  return { operations: new ReminderOperations(settings), settings, schedule, identity, reminder, created, deleted, historyRequests, destinations, rows,
    receipts: value => { receipts = value }, create: () => ({ identity, reminder }) }
}

test('same complete native execution replays one successful rule and one business task', async () => {
  const e = environment()
  const first = await e.operations.create(e.create())
  const replay = await e.operations.create(e.create())
  assert.equal(first.ok, true)
  assert.deepEqual(replay, first)
  assert.equal(e.created.length, 1)
  assert.equal(e.created[0].actorSessionId, e.identity.sessionId, 'the acting butler session is passed beside the request')
  assert.equal(e.destinations.length, 1)
  assert.equal(e.destinations[0].callKey, executionKey(e.identity))
  assert.deepEqual(e.created[0].request.target, { kind: 'session', sessionId: first.reminder.sessionId })
  assert.deepEqual(e.created[0].request.timing, { kind: 'at', at: { date: '2030-01-02', time: '03:04:00', time_zone: 'Asia/Shanghai' } })
  assert.notEqual(first.taskId, e.identity.runId)
  assert.equal(ledger.getTask(first.taskId).reminder.scheduleId, first.reminder.id)
  assert.equal(ledger.getTask(first.taskId).reminder.deliveryState, 'scheduled')
  const state = JSON.parse(readFileSync(e.settings.file, 'utf8'))
  const operation = Object.values(state.operations)[0]
  assert.deepEqual(operation.identity, e.identity)
  assert.equal(operation.state, 'committed')
  assert.equal(operation.confirmedAt, e.reminder.at)
  assert.equal(operation.actualReceipt.id, first.reminder.id)
  assert.match(operation.requestDigest, /^[a-f0-9]{64}$/)
})

test('concurrent same execution shares the pending host request across managers', async () => {
  const e = environment()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const create = e.schedule.create
  e.schedule.create = async (...args) => { await gate; return create(...args) }
  const first = e.operations.create(e.create())
  const second = new ReminderOperations(e.settings).create(e.create())
  release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results[0], results[1])
  assert.equal(e.created.length, 1)
})

test('committed create replays after restart without another destination or host create', async () => {
  const e = environment()
  const first = await e.operations.create(e.create())
  const replay = await new ReminderOperations(e.settings).create(e.create())
  assert.deepEqual(replay, first)
  assert.equal(e.created.length, 1)
  assert.equal(e.destinations.length, 1)
})

test('a relative reminder freezes its first host-clock instant for replay and rejects changed seconds', async () => {
  let clock = '2026-10-21T03:00:00.000Z'
  const e = environment({ now: () => clock })
  const { at: _at, ...fields } = e.reminder
  const request = { identity: e.identity, reminder: { ...fields, afterSeconds: 60 } }
  const first = await e.operations.create(request)
  assert.equal(first.ok, true)
  assert.equal(first.operation.request.at, '2026-10-21T03:01:00.000Z')
  assert.deepEqual(e.created[0].request.timing, { kind: 'at', at: '2026-10-21T03:01:00.000Z' })
  clock = '2026-10-21T04:00:00.000Z'
  const replay = await new ReminderOperations(e.settings).create(request)
  assert.deepEqual(replay, first)
  assert.equal(e.created.length, 1)
  await assert.rejects(e.operations.create({ ...request, reminder: { ...request.reminder, afterSeconds: 61 } }), /payload|请求内容/)
  assert.equal(e.created.length, 1)
})

test('invalid or missing reminder times are rejected before any operation, task, session or native rule is created', async () => {
  for (const time of [{}, { at: 'not-a-time' }, { at: '2030-02-30T10:00:00Z' }, { afterSeconds: 0 }, { at: '2030-01-01T10:00:00Z', afterSeconds: 60 }]) {
    const e = environment(), { at: _at, ...fields } = e.reminder
    await assert.rejects(e.operations.create({ identity: e.identity, reminder: { ...fields, ...time } }), /时间|秒|at|afterSeconds/)
    assert.deepEqual(e.operations.status(), [])
    assert.equal(e.created.length, 0)
    assert.equal(e.destinations.length, 0)
  }
})

test('a call id reused in a later step creates an independent operation and destination', async () => {
  const e = environment()
  const first = await e.operations.create(e.create())
  const second = await e.operations.create({ ...e.create(), identity: { ...e.identity, step: 2 } })
  assert.notEqual(first.taskId, second.taskId)
  assert.notEqual(first.reminder.sessionId, second.reminder.sessionId)
  assert.notEqual(e.destinations[0].callKey, e.destinations[1].callKey)
  assert.equal(e.created.length, 2)
})

test('same native execution with changed payload refuses before another host effect', async () => {
  const e = environment()
  await e.operations.create(e.create())
  await assert.rejects(e.operations.create({ ...e.create(), reminder: { ...e.reminder, prompt: 'changed' } }), /payload|请求内容/)
  assert.equal(e.created.length, 1)
})

test('missing stable execution position refuses before creating a session or rule', async () => {
  const e = environment()
  await assert.rejects(e.operations.create({ ...e.create(), identity: { sessionId: 'dev', callId: 'reused-id' } }), /identity|身份/)
  assert.equal(e.created.length, 0)
  assert.equal(e.destinations.length, 0)
})

test('host acceptance followed by lost response stays uncertain across restart without blind retry', async () => {
  const e = environment()
  const create = e.schedule.create
  e.schedule.create = async (...args) => { await create(...args); throw new Error('response lost') }
  const first = await e.operations.create(e.create())
  assert.equal(first.ok, false)
  assert.equal(first.state, 'uncertain')
  const retry = await new ReminderOperations(e.settings).create(e.create())
  assert.equal(retry.ok, false)
  assert.equal(retry.state, 'uncertain')
  assert.equal(retry.operation.scheduleId, undefined, 'a title/time match is no ownership receipt')
  assert.equal(e.created.length, 1)
  assert.notEqual(ledger.getTask(first.taskId)?.status, 'done')
})

test('interrupted creating record is inspected instead of recreated after reload', async () => {
  const e = environment()
  await e.operations.create(e.create())
  const state = JSON.parse(readFileSync(e.settings.file, 'utf8'))
  const row = Object.values(state.operations)[0]
  row.state = 'creating'
  delete row.actualReceipt
  delete row.scheduleId
  delete row.result
  writeFileSync(e.settings.file, JSON.stringify(state))
  const resumed = await new ReminderOperations(e.settings).create(e.create())
  assert.equal(resumed.state, 'uncertain')
  assert.equal(resumed.ok, false)
  assert.equal(e.created.length, 1)
})

test('host success followed by local task failure retains receipt and retries local state only', async () => {
  let fail = true
  const e = environment({ ledger: {
    ...ledger,
    setTaskStatus(...args) { if (fail) throw new Error('fixture ledger unavailable'); return ledger.setTaskStatus(...args) },
  } })
  const first = await e.operations.create(e.create())
  assert.equal(first.state, 'uncertain')
  assert.equal(first.ok, false)
  assert.equal(first.operation.actualReceipt.id, e.rows[0].id)
  fail = false
  const resumed = await new ReminderOperations(e.settings).create(e.create())
  assert.equal(resumed.ok, true)
  assert.equal(e.created.length, 1)
  assert.equal(ledger.getTask(first.taskId).status, 'pending')
  const daily = readText(vaultPath('daily', '2026-10-15.md'))
  assert.equal(daily.split(`已建立提醒 ${e.rows[0].id}`).length - 1, 1)
})

test('cancel resolves the catalog owner and atomically closes the associated task', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  const input = { identity: { ...e.identity, step: 2 }, id: created.reminder.id, timeZone: e.reminder.timeZone }
  const cancelled = await e.operations.cancel(input)
  const replay = await new ReminderOperations(e.settings).cancel(input)
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.cancelled, created.reminder.id)
  assert.equal(cancelled.taskId, created.taskId)
  assert.equal(ledger.getTask(created.taskId).status, 'cancelled')
  assert.deepEqual(e.deleted, [{ id: created.reminder.id, action: 'delete' }])
  assert.deepEqual(replay, cancelled)
})

test('deleted false does not claim cancellation or close the business task', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  e.schedule.edit = async request => { e.deleted.push(request); return { id: request.id, deleted: false, code: 'native_missing' } }
  const result = await e.operations.cancel({ identity: { ...e.identity, step: 2 }, id: created.reminder.id, timeZone: e.reminder.timeZone })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, null)
  assert.equal(result.code, 'native_missing')
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
})

test('history returns native records and distinguishes scheduled from delivered', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  e.receipts([{ scheduledAt: e.rows[0].scheduledAt }])
  let result = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: created.reminder.id, timeZone: e.reminder.timeZone })
  assert.equal(result.available, true)
  assert.equal(result.deliveryState, 'scheduled')
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
  e.receipts([{ scheduledAt: e.rows[0].scheduledAt, deliveredAt: '2030-01-01T19:04:01Z', messageId: 'native-delivery-1' }])
  result = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: created.reminder.id, limit: 7, timeZone: e.reminder.timeZone })
  assert.equal(result.records[0].messageId, 'native-delivery-1')
  assert.equal(result.deliveryState, 'delivered')
  assert.equal(ledger.getTask(created.taskId).status, 'running')
  assert.equal(ledger.getTask(created.taskId).reminder.deliveryState, 'delivered')
  assert.deepEqual(e.historyRequests.at(-1), { id: created.reminder.id, limit: 7 })
})

test('missing native history reports unavailable instead of synthesizing a successful receipt', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  e.schedule.history = undefined
  const result = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: created.reminder.id })
  assert.equal(result.ok, false)
  assert.equal(result.available, false)
  assert.equal(result.deliveryState, 'unknown')
  assert.equal(result.records, undefined)
})

test('native history failure is unavailable and does not infer delivery from create success', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  e.schedule.history = async () => { throw new Error('native history offline') }
  const result = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: created.reminder.id })
  assert.equal(result.available, false)
  assert.equal(result.deliveryState, 'unknown')
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
})

test('native scheduled user message records delivery only for the exact isolated destination', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  const event = { type: 'user/message', data: { id: 'native-occurrence', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'Read figure 2' }] } }
  await e.operations.observeSessionEvent({ id: e.identity.sessionId }, event)
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
  await e.operations.observeSessionEvent({ id: created.reminder.sessionId }, event)
  assert.equal(ledger.getTask(created.taskId).reminder.lastDelivery.messageId, 'native-occurrence')
  assert.equal(ledger.getTask(created.taskId).status, 'running')
  await e.operations.observeSessionEvent({ id: created.reminder.sessionId }, { type: 'assistant/message', data: { id: 'assistant-said-done', content: [{ type: 'text', text: 'Completed' }] } })
  assert.notEqual(ledger.getTask(created.taskId).status, 'done', 'plain assistant text is not a native terminal receipt')
})

test('concurrent changed payload cannot attach to another pending creation', async () => {
  const e = environment()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const create = e.schedule.create
  e.schedule.create = async (...args) => { await gate; return create(...args) }
  const pending = e.operations.create(e.create())
  await assert.rejects(new ReminderOperations(e.settings).create({ ...e.create(), reminder: { ...e.reminder, at: '2030-01-03T03:04' } }), /payload|请求内容/)
  release()
  await pending
  assert.equal(e.created.length, 1)
})

test('cancel native success followed by local task failure repairs state without deleting again', async () => {
  let fail = false
  const e = environment({ ledger: {
    ...ledger,
    setTaskStatus(...args) { if (fail) throw new Error('fixture cancelled task unavailable'); return ledger.setTaskStatus(...args) },
  } })
  const created = await e.operations.create(e.create())
  const input = { identity: { ...e.identity, step: 2 }, id: created.reminder.id, timeZone: e.reminder.timeZone }
  fail = true
  const cancelled = await e.operations.cancel(input)
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.state, 'uncertain')
  assert.equal(cancelled.operation.actualReceipt.deleted, true)
  fail = false
  const resumed = await new ReminderOperations(e.settings).cancel(input)
  assert.equal(resumed.ok, true)
  assert.equal(e.deleted.length, 1)
  assert.equal(ledger.getTask(created.taskId).status, 'cancelled')
})

test('cancel missing native catalog owner leaves the task open', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  e.rows.splice(0)
  const result = await e.operations.cancel({ identity: { ...e.identity, step: 2 }, id: created.reminder.id, timeZone: e.reminder.timeZone })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, null)
  assert.equal(e.deleted.length, 0)
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
})

test('cancel legacy native rule uses the actual source owner without inventing a business task', async () => {
  const e = environment()
  e.rows.push({ id: 'legacy-rule', sessionId: e.identity.sessionId })
  const result = await e.operations.cancel({ identity: e.identity, id: 'legacy-rule', timeZone: e.reminder.timeZone })
  assert.equal(result.ok, true)
  assert.equal(result.taskId, undefined)
  assert.deepEqual(e.deleted, [{ id: 'legacy-rule', action: 'delete' }])
})

test('empty native history stays unknown even when the scheduler accepted a rule', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  const result = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: created.reminder.id })
  assert.equal(result.available, true)
  assert.deepEqual(result.records, [])
  assert.equal(result.deliveryState, 'unknown')
  assert.equal(ledger.getTask(created.taskId).reminder.deliveryState, 'scheduled')
})

test('native session event time records delivery time and no user text can forge it', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  const payload = { id: 'delivery-native-time', source: { kind: 'user' }, content: [] }
  await e.operations.observeSessionEvent({ id: created.reminder.sessionId }, { type: 'user/message', seq: 5, time: 1893524641000, data: payload })
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
  payload.source.kind = 'schedule'
  await e.operations.observeSessionEvent({ id: created.reminder.sessionId }, { type: 'user/message', seq: 6, time: 1893524641000, data: payload })
  const task = ledger.getTask(created.taskId)
  assert.equal(task.reminder.lastDelivery.messageId, 'delivery-native-time')
  assert.equal(task.reminder.lastDelivery.deliveredAt, new Date(1893524641000).toISOString())
})

test('a corrupted committed operation cannot become a successful receipt or another host create', async () => {
  const e = environment()
  await e.operations.create(e.create())
  const state = JSON.parse(readFileSync(e.settings.file, 'utf8'))
  delete Object.values(state.operations)[0].actualReceipt
  writeFileSync(e.settings.file, JSON.stringify(state))
  assert.throws(() => new ReminderOperations(e.settings), /结构损坏|存储/)
  assert.equal(e.created.length, 1)
})

test('another source cannot cancel a known reminder or change its business task', async () => {
  const e = environment({ ownsDestination: () => true })
  const created = await e.operations.create(e.create())
  const result = await e.operations.cancel({ identity: { ...e.identity, sessionId: 'other-source', rootSessionId: 'other-source', step: 2 }, id: created.reminder.id, timeZone: e.reminder.timeZone })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, null)
  assert.equal(result.code, 'schedule_owner_mismatch')
  assert.equal(result.taskId, undefined)
  assert.equal(result.task, undefined)
  assert.equal(result.operation.destinationSessionId, undefined)
  assert.equal(e.deleted.length, 0)
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
})

test('another source cannot read known reminder history or upgrade its task to delivered', async () => {
  const e = environment({ ownsDestination: () => true })
  const created = await e.operations.create(e.create())
  e.receipts([{ messageId: 'private-native-delivery', deliveredAt: '2030-01-01T19:04:01Z' }])
  const result = await e.operations.history({ sourceSessionId: 'other-source', id: created.reminder.id })
  assert.equal(result.ok, false)
  assert.equal(result.available, false)
  assert.equal(result.taskId, undefined)
  assert.equal(result.records, undefined)
  assert.equal(e.historyRequests.length, 0)
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
})

test('an isolated legacy destination prefix alone grants neither cancellation nor history', async () => {
  const e = environment()
  e.rows.push({ id: 'unbound-legacy', sessionId: 'session-butler-reminder-unknown-source' })
  const cancelled = await e.operations.cancel({ identity: e.identity, id: 'unbound-legacy', timeZone: e.reminder.timeZone })
  const history = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: 'unbound-legacy' })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.code, 'schedule_owner_mismatch')
  assert.equal(history.available, false)
  assert.equal(e.deleted.length, 0)
  assert.equal(e.historyRequests.length, 0)
})

test('a trusted source binding permits its isolated legacy destination and rejects other sources', async () => {
  const destination = 'session-butler-reminder-legacy-owned'
  const e = environment({ ownsDestination: (source, owner) => source.startsWith('development-') && owner === destination })
  e.rows.push({ id: 'bound-legacy', sessionId: destination })
  e.receipts([{ messageId: 'trusted-legacy-delivery' }])
  const allowed = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: 'bound-legacy' })
  assert.equal(allowed.available, true)
  const denied = await e.operations.history({ sourceSessionId: 'other-source', id: 'bound-legacy' })
  assert.equal(denied.available, false)
  assert.equal(e.historyRequests.length, 1)
  const deniedCancel = await e.operations.cancel({ identity: { ...e.identity, sessionId: 'other-source', rootSessionId: 'other-source' }, id: 'bound-legacy', timeZone: e.reminder.timeZone })
  assert.equal(deniedCancel.ok, false)
  const cancelled = await e.operations.cancel({ identity: e.identity, id: 'bound-legacy', timeZone: e.reminder.timeZone })
  assert.equal(cancelled.ok, true)
  assert.deepEqual(e.deleted, [{ id: 'bound-legacy', action: 'delete' }])
})

test('session-local schedule ids remain independently addressable for their own sources', async () => {
  const e = environment(), nativeCreate = e.schedule.create
  e.schedule.create = async (...args) => { const row = await nativeCreate(...args); row.id = 'session-local-id'; return row }
  const first = await e.operations.create(e.create())
  const secondIdentity = { ...e.identity, sessionId: 'second-owner', rootSessionId: 'second-owner' }
  const second = await e.operations.create({ identity: secondIdentity, reminder: e.reminder })
  const firstHistory = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: 'session-local-id' })
  const secondHistory = await e.operations.history({ sourceSessionId: secondIdentity.sessionId, id: 'session-local-id' })
  assert.equal(firstHistory.available, true)
  assert.equal(secondHistory.available, true)
  assert.equal(firstHistory.sessionId, first.reminder.sessionId)
  assert.equal(secondHistory.sessionId, second.reminder.sessionId)
  const firstCancel = await e.operations.cancel({ identity: { ...e.identity, step: 2 }, id: 'session-local-id', timeZone: e.reminder.timeZone })
  assert.equal(firstCancel.ok, true)
  assert.equal(ledger.getTask(first.taskId).status, 'cancelled')
  assert.equal(ledger.getTask(second.taskId).status, 'pending')
  const secondCancel = await e.operations.cancel({ identity: { ...secondIdentity, step: 2 }, id: 'session-local-id', timeZone: e.reminder.timeZone })
  assert.equal(secondCancel.ok, true)
  assert.deepEqual(e.deleted, [{ id: 'session-local-id', action: 'delete' }, { id: 'session-local-id', action: 'delete' }])
})

test('two destinations with the same native id under one source remain explicitly ambiguous', async () => {
  const e = environment(), nativeCreate = e.schedule.create
  e.schedule.create = async (...args) => { const row = await nativeCreate(...args); row.id = 'ambiguous-local-id'; return row }
  await e.operations.create(e.create())
  await e.operations.create({ ...e.create(), identity: { ...e.identity, step: 2 } })
  const history = await e.operations.history({ sourceSessionId: e.identity.sessionId, id: 'ambiguous-local-id' })
  const cancel = await e.operations.cancel({ identity: { ...e.identity, step: 3 }, id: 'ambiguous-local-id', timeZone: e.reminder.timeZone })
  assert.equal(history.available, false)
  assert.equal(cancel.ok, false)
  assert.equal(cancel.code, 'schedule_not_found_or_ambiguous')
  assert.equal(e.deleted.length, 0)
  assert.equal(e.historyRequests.length, 0)
})

test('a native delivery exposes only the unique confirmed task binding for host attribution', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  assert.equal(e.operations.taskForSession(e.identity.sessionId), undefined)
  assert.deepEqual(e.operations.taskForSession(created.reminder.sessionId), { taskId: created.taskId, sessionId: created.reminder.sessionId, scheduleId: created.reminder.id })
  const event = { type: 'user/message', seq: 5, time: Date.parse('2030-01-01T19:04:01Z'), data: { id: 'native-bound-occurrence', source: { kind: 'schedule' }, content: [] } }
  assert.equal(e.operations.observeSessionEvent({ id: e.identity.sessionId }, event), undefined)
  const binding = e.operations.observeSessionEvent({ id: created.reminder.sessionId }, event)
  assert.deepEqual(binding, { taskId: created.taskId, sessionId: created.reminder.sessionId, scheduleId: created.reminder.id, originMessageId: 'native-bound-occurrence' })
  assert.deepEqual(e.operations.taskForSession(created.reminder.sessionId), binding)
})

test('a native schedule source carrying a different rule id cannot claim the destination task', async () => {
  const e = environment()
  const created = await e.operations.create(e.create())
  const source = { kind: 'schedule', scheduleId: 'another-native-rule' }
  const event = { type: 'user/message', seq: 5, time: Date.parse('2030-01-01T19:04:01Z'), data: { id: 'wrong-rule-occurrence', source, content: [] } }
  assert.equal(e.operations.observeSessionEvent({ id: created.reminder.sessionId }, event), undefined)
  assert.equal(ledger.getTask(created.taskId).status, 'pending')
  source.scheduleId = created.reminder.id
  assert.equal(e.operations.observeSessionEvent({ id: created.reminder.sessionId }, event).taskId, created.taskId)
})

test('recording a native delivery never reopens a cancelled or completed business task', async () => {
  for (const status of ['cancelled', 'done']) {
    const e = environment()
    const created = await e.operations.create(e.create())
    ledger.setTaskStatus(created.taskId, status, 'fixture terminal state', e.reminder.timeZone)
    e.operations.observeSessionEvent({ id: created.reminder.sessionId }, { type: 'user/message', data: { id: `native-after-${status}`, source: { kind: 'schedule' } } })
    assert.equal(ledger.getTask(created.taskId).status, status)
  }
})
