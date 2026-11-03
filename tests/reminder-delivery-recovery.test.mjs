import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'reminder-recovery-'))
process.env.DSH_BUTLER_HOME = join(root, 'state')
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
const { ensureVault } = await import('../src/host/vault.ts')
const { ReminderDeliveries } = await import('../src/host/reminder-delivery.ts')
ensureVault()

const body = 'A harmless recovery reminder.'
const hash = value => createHash('sha256').update(value).digest('hex')
const tick = () => new Promise(resolve => setImmediate(resolve))
function environment(settings = {}) {
  const file = join(root, 'state', `${crypto.randomUUID()}.json`), sends = [], checks = [], listeners = new Set()
  let ready = settings.ready ?? false, binding, available = true, verify = true
  const original = { executionKey: 'execution', scheduleId: 'native-job', taskId: 'business-task', sessionId: 'reminder-session', ownerId: 'owner',
    destination: { provider: 'lark', ownerId: 'owner', accountId: 'account', chatId: 'chat' } }
  binding = structuredClone(original)
  const service = { destinationFor: () => original.destination, isReady: () => ready,
    onReady(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async send(destination, text, identity) {
      sends.push({ destination, text, identity })
      assert.equal(Object.values(JSON.parse(readFileSync(file, 'utf8')).deliveries).find(row => row.occurrenceMessageId === identity.occurrenceMessageId)?.state,
        'pending', 'claim must be durable before SDK send')
      return settings.send ? settings.send(destination, text, identity) : { messageId: 'platform-receipt' }
    },
    async reconcile(destination, identity) {
      checks.push({ destination, identity })
      return settings.reconcile?.(destination, identity)
    } }
  let liveService = service
  const options = { file, service: () => available ? liveService : undefined, binding: () => binding, verifyOccurrence: async () => verify }
  let manager = new ReminderDeliveries(options)
  const occurrence = async () => {
    const session = { id: original.sessionId, inheritedEventCount: 0 }
    for (const [seq, type, data] of [
      [1, 'turn/start', { turn: 1 }],
      [2, 'user/message', { id: 'occurrence', source: { kind: 'schedule', scheduleId: original.scheduleId } }],
      [3, 'assistant/message', { turn: 1, step: 1, message: { id: 'assistant', content: [{ type: 'text', text: body }] } }],
      [4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ]) await manager.observeSessionEvent(session, { seq, type, data })
  }
  return { file, sends, checks, listeners, service, original, occurrence,
    rows: () => manager.status(), recover: () => manager.recover(), stop: () => manager.stop(),
    ready(value = true) { ready = value }, available(value) { available = value }, binding(value) { binding = value }, verify(value) { verify = value },
    replace(value) { liveService = value }, notify() { for (const listener of [...listeners]) listener() },
    reload() { manager.stop(); manager = new ReminderDeliveries(options) },
    sibling: () => new ReminderDeliveries(options),
  }
}

test('offline occurrence persists its exact body and reconnect sends once after a durable claim', async () => {
  const e = environment()
  await e.occurrence()
  assert.equal(e.sends.length, 0)
  assert.equal(e.rows()[0].state, 'waiting')
  assert.equal(e.rows()[0].queuedText, body)
  assert.equal(e.rows()[0].textSha256, hash(body))
  e.ready(); e.notify(); await tick(); await e.recover(); e.notify(); await tick()
  assert.equal(e.sends.length, 1)
  assert.equal(e.rows()[0].state, 'delivered')
  assert.equal(e.rows()[0].queuedText, undefined)
  assert.equal(e.sends[0].text, body)
  e.stop(); assert.equal(e.listeners.size, 0)
})

test('stop while native occurrence revalidation is pending cannot send from the old lifecycle', async () => {
  const e = environment()
  await e.occurrence()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const pendingManager = new ReminderDeliveries({ file: e.file, service: () => e.service, binding: () => e.original,
    async verifyOccurrence() { await gate; return true } })
  e.ready()
  const recovering = pendingManager.recover(); await tick()
  pendingManager.stop(); release(); await recovering
  assert.equal(e.sends.length, 0)
  assert.equal(e.rows()[0].state, 'waiting')
  e.stop()
})

test('a readiness notification received during recovery rescans an earlier offline queue', async () => {
  const e = environment()
  await e.occurrence()
  const saved = JSON.parse(readFileSync(e.file, 'utf8')), original = Object.values(saved.deliveries)[0]
  const second = { ...structuredClone(original), occurrenceMessageId: 'second-occurrence' }
  second.key = hash(JSON.stringify([second.scheduleId, second.occurrenceMessageId]))
  saved.deliveries[second.key] = second
  writeFileSync(e.file, JSON.stringify(saved))
  e.stop()
  let firstReady = false, release, checkingSecond
  const gate = new Promise(resolve => { release = resolve }), inSecond = new Promise(resolve => { checkingSecond = resolve })
  e.service.isReady = (_destination, identity) => identity.occurrenceMessageId !== 'occurrence' || firstReady
  const manager = new ReminderDeliveries({ file: e.file, service: () => e.service, binding: () => e.original,
    async verifyOccurrence(_binding, id) { if (id === 'second-occurrence') { checkingSecond(); await gate } return true } })
  const recovering = manager.recover(); await inSecond
  firstReady = true
  e.notify()
  release(); await recovering
  assert.equal(e.sends.length, 2, 'the notification must cause a second scan of the earlier offline occurrence')
  assert.ok(e.rows().every(row => row.state === 'delivered'))
  manager.stop(); e.stop()
})

test('reloaded and concurrent managers claim only one never-sent waiting occurrence', async () => {
  const e = environment()
  await e.occurrence(); e.reload(); e.ready()
  const sibling = e.sibling()
  await Promise.all([e.recover(), e.recover(), sibling.recover()])
  assert.equal(e.sends.length, 1)
  assert.equal(e.rows()[0].state, 'delivered')
  e.stop(); sibling.stop()
})

for (const changed of ['task', 'owner', 'destination', 'job', 'occurrence', 'body']) {
  test(`waiting recovery rejects a changed ${changed} without calling send`, async () => {
    const e = environment()
    await e.occurrence()
    if (changed === 'body') {
      const saved = JSON.parse(readFileSync(e.file, 'utf8'))
      Object.values(saved.deliveries)[0].queuedText = 'Tampered body.'
      writeFileSync(e.file, JSON.stringify(saved))
    } else if (changed === 'occurrence') e.verify(false)
    else {
      const binding = structuredClone(e.original)
      if (changed === 'destination') binding.destination.chatId = 'another-chat'
      else binding[changed === 'job' ? 'scheduleId' : changed === 'task' ? 'taskId' : 'ownerId'] = 'changed'
      e.binding(binding)
    }
    e.ready(); await e.recover()
    assert.equal(e.sends.length, 0)
    assert.notEqual(e.rows()[0].state, 'delivered')
    e.stop()
  })
}

test('SDK send exceptions stay unknown even if the exception claims not-sent', async () => {
  const e = environment({ ready: true, send() { throw Object.assign(Error('network lost, not-sent'), { notSent: true }) } })
  await e.occurrence()
  assert.equal(e.rows()[0].state, 'uncertain')
  const reason = e.rows()[0].reason
  e.reload(); e.ready(); await e.recover(); e.notify(); await e.recover()
  assert.equal(e.sends.length, 1)
  assert.equal(e.rows()[0].reason, reason)
  assert.equal(e.rows()[0].state, 'uncertain')
  e.stop()
})

test('a matching read-only platform check repairs an unknown receipt without another send and retains failure history', async () => {
  const e = environment({ ready: true, send() { throw Error('response lost') },
    reconcile(destination, identity) { return { destination, textSha256: identity.textSha256, receipt: { messageId: 'verified-platform-message' } } } })
  await e.occurrence()
  const reason = e.rows()[0].reason
  e.reload(); await e.recover()
  assert.equal(e.sends.length, 1)
  assert.equal(e.checks.length, 1)
  assert.equal(e.rows()[0].state, 'delivered')
  assert.equal(e.rows()[0].receipt.messageId, 'verified-platform-message')
  assert.equal(e.rows()[0].reason, reason)
  assert.ok(e.rows()[0].audit.some(row => row.kind === 'send-failed'))
  assert.equal(e.rows()[0].audit.at(-1).kind, 'reconcile-verified')
  e.stop()
})

for (const outcome of ['not-found', 'wrong-target', 'wrong-hash', 'invalid-receipt', 'error']) {
  test(`platform check ${outcome} cannot mark an unknown message delivered`, async () => {
    const e = environment({ ready: true, send() { throw Error('original unknown result') }, reconcile(destination, identity) {
      if (outcome === 'error') throw Error('query unavailable')
      if (outcome === 'not-found') return
      return { destination: outcome === 'wrong-target' ? { ...destination, chatId: 'foreign-chat' } : destination,
        textSha256: outcome === 'wrong-hash' ? hash('another body') : identity.textSha256,
        receipt: { messageId: outcome === 'invalid-receipt' ? '' : 'some-platform-message' } }
    } })
    await e.occurrence()
    const reason = e.rows()[0].reason
    await e.recover()
    assert.equal(e.sends.length, 1)
    assert.equal(e.rows()[0].state, 'uncertain')
    assert.equal(e.rows()[0].receipt, undefined)
    assert.equal(e.rows()[0].reason, reason)
    e.stop()
  })
}

test('legacy pending and uncertain records are retained and never resent', async () => {
  const e = environment()
  await e.occurrence()
  for (const state of ['pending', 'uncertain']) {
    const saved = JSON.parse(readFileSync(e.file, 'utf8')), row = Object.values(saved.deliveries)[0]
    row.state = state; row.reason = 'legacy failure'; delete row.queuedText; delete row.audit
    writeFileSync(e.file, JSON.stringify(saved))
    e.reload(); e.ready(); await e.recover()
    assert.equal(e.sends.length, 0)
    assert.equal(e.rows()[0].state, 'uncertain')
    assert.equal(e.rows()[0].reason, 'legacy failure')
  }
  e.stop()
})

test('an active send is not reconciled while a new manager recovers', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const e = environment({ ready: true, async send() { await gate; return { messageId: 'real-send-receipt' } } })
  const delivery = e.occurrence(); await tick()
  e.reload(); await e.recover()
  assert.equal(e.checks.length, 0)
  assert.equal(e.rows()[0].state, 'pending')
  release(); await delivery
  assert.equal(e.rows()[0].receipt.messageId, 'real-send-receipt')
  assert.equal(e.sends.length, 1)
  e.stop()
})

test('stop and a replaced service detach old notifications before they can resume a queue', async () => {
  const e = environment()
  await e.occurrence(); await e.recover()
  assert.equal(e.listeners.size, 1)
  const oldNotification = [...e.listeners][0]
  e.replace({ ...e.service, isReady: () => false, onReady: () => () => {} })
  await e.recover(); assert.equal(e.listeners.size, 0)
  e.ready(); oldNotification(); await tick()
  assert.equal(e.sends.length, 0)
  e.stop(); await e.recover(); oldNotification(); await tick()
  assert.equal(e.sends.length, 0)
})

test('status reads neither probe the service nor reconcile or recover an unrelated prepared WAL', async () => {
  const e = environment()
  await e.occurrence()
  let probes = 0
  e.service.isReady = () => { probes++; return true }
  const journal = join(root, 'state', 'store-operations.jsonl'), target = join(root, 'state', 'readonly-sentinel.txt')
  const before = readFileSync(journal, 'utf8'), original = 'old\n', changed = 'prepared\n'
  writeFileSync(target, original)
  const prepared = { version: 1, phase: 'prepared', operationId: crypto.randomUUID(), kind: 'test.readonly', targetId: target, time: new Date().toISOString(),
    writes: [{ path: target, content: changed, format: 'text', beforeSha256: hash(original), afterSha256: hash(changed) }] }
  const bytes = before + JSON.stringify(prepared) + '\n'
  writeFileSync(journal, bytes)
  try {
    const fileBefore = readFileSync(e.file, 'utf8')
    assert.equal(e.rows()[0].state, 'waiting')
    assert.equal(e.rows()[0].state, 'waiting')
    assert.equal(probes, 0); assert.equal(e.checks.length, 0); assert.equal(e.sends.length, 0)
    assert.equal(readFileSync(e.file, 'utf8'), fileBefore)
    assert.equal(readFileSync(target, 'utf8'), original); assert.equal(readFileSync(journal, 'utf8'), bytes)
  } finally { writeFileSync(journal, before); e.stop() }
})
