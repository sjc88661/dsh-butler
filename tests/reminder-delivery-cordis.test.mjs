import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const cordisPath = '../../diagnostics/acceptance-20261021-p3-live/deps/node_modules/@deepseek-ai/cordis/lib/index.js'
const cordisUrl = new URL(cordisPath, import.meta.url)
assert.equal(createHash('sha256').update(readFileSync(cordisUrl)).digest('hex'), '6a9394c0877ff45218818c6e815edd038f8057e1a1deb390a8d43ec81c57691e', 'exercise the actual pinned native Cordis')
const { Context, Service } = await import(cordisUrl.href)
const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'reminder-cordis-'))
process.env.DSH_BUTLER_HOME = join(root, 'state')
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
const { ensureVault } = await import('../src/host/vault.ts')
const { ReminderDeliveries } = await import('../src/host/reminder-delivery.ts')
ensureVault()

test('actual Cordis traceable service proxies do not churn readiness subscriptions or epochs', async () => {
  const ctx = new Context(), listeners = new Set(), sends = [], disposals = []
  let ready = false, manager, scope, serviceEvents = 0
  const binding = { executionKey: 'execution', scheduleId: 'native-job', taskId: 'task', sessionId: 'session', ownerId: 'owner',
    destination: { provider: 'lark', ownerId: 'owner', accountId: 'account', chatId: 'chat' } }
  const provider = ctx.plugin({ name: 'reminder-service-provider', apply(owner) {
    new class extends Service {
      constructor() { super(owner, 'butlerReminderDelivery') }
      destinationFor() { return binding.destination }
      isReady() { return ready }
      onReady(listener) { listeners.add(listener); return () => { disposals.push(listener); listeners.delete(listener) } }
      async send(_destination, text) { sends.push(text); return { messageId: 'real-proxy-receipt' } }
    }()
  } })
  await provider.await()
  const consumer = ctx.plugin({ name: 'reminder-service-consumer', inject: ['butlerReminderDelivery'], apply(consumer) {
    scope = consumer
    consumer.on('internal/service', () => { serviceEvents++ })
    manager = new ReminderDeliveries({ file: join(root, 'state', 'outbound.json'), service: () => consumer.get('butlerReminderDelivery', false),
      binding: () => binding, verifyOccurrence: async () => true })
  } })
  await consumer.await()
  try {
    assert.notEqual(scope.get('butlerReminderDelivery', false), scope.get('butlerReminderDelivery', false), 'Cordis creates a new traceable Proxy for each read')
    const event = (seq, type, data) => manager.observeSessionEvent({ id: 'session', inheritedEventCount: 0 }, { seq, type, data })
    await event(1, 'turn/start', { turn: 1 })
    await event(2, 'user/message', { id: 'occurrence', source: { kind: 'schedule', scheduleId: binding.scheduleId } })
    await event(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'assistant', content: [{ type: 'text', text: 'Harmless proxy recovery.' }] } })
    await event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    assert.equal(manager.status()[0].state, 'waiting')
    assert.equal(listeners.size, 1)
    const beforeEvents = serviceEvents
    ready = true
    let notified = 0
    // Bound the reproducer so a regression reports an assertion instead of exhausting the heap.
    for (const listener of listeners) { if (++notified > 3) break; listener() }
    await manager.recover()
    assert.equal(notified, 1, 'recover must not delete and append listeners during Set notification')
    assert.equal(disposals.length, 0, 'reading the same Cordis implementation is not a lifecycle switch')
    assert.deepEqual(sends, ['Harmless proxy recovery.'])
    assert.equal(manager.status()[0].state, 'delivered')
    assert.equal(serviceEvents, beforeEvents, 'ctx.get itself does not emit internal/service')
    manager.stop(); assert.equal(listeners.size, 0)
  } finally { manager?.stop(); await consumer.dispose(); await provider.dispose() }
})
