import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { contextHarness } from './helpers/task-context.mjs'
import { chatUserMessage } from './fixtures/lark-chat-user-message.mjs'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'lark-integration-'))
process.env.DSH_BUTLER_HOME = join(root, 'state')
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
const api = await import('../src/channels.ts')
const { ensureVault } = await import('../src/host/vault.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { channelContextPolicy } = await import('../src/host/channel-attribution.ts')
const { installBusinessWorkflows } = await import('../src/host/workflow-runtime.ts')

const binding = { accountId: 'app-personal', ownerId: 'owner-personal', senderId: 'ou-personal', chatId: 'oc-private' }
const destination = () => ({ provider: 'lark', ...binding })
const digest = text => createHash('sha256').update(text).digest('hex')
const body = '完整正文\n保留换行与尾部空格  '
const execution = () => ({ sessionId: 'local-session', rootSessionId: 'local-session', ownerId: binding.ownerId, originMessageId: 'native-input', callId: 'remind-call', turn: 1, step: 1 })
const localUser = () => ({ sessionId: 'local-session', messageId: 'native-input', ownerId: binding.ownerId, source: 'user', text: '宿主原生授权文字', rpcId: 'native-rpc' })
const outbound = (changes = {}) => ({ scheduleId: 'native-job', occurrenceMessageId: 'native-occurrence', taskId: 'task-reminder', sessionId: 'isolated-reminder', ownerId: binding.ownerId,
  turn: 1, assistantEventSeq: 3, textSha256: digest(body), ...changes })
function create(ctx, port, options) {
  assert.equal(typeof api.createLarkButlerIntegration, 'function', 'the published channels entry must provide the host integration factory')
  return api.createLarkButlerIntegration(ctx, port, options)
}
function portFixture() {
  const listeners = new Map(), calls = { connect: 0, disconnect: 0, send: [] }
  let state = 'disconnected', receipt = { messageId: 'actual-lark-message', chunkIds: ['actual-lark-message'] }, onSend
  const port = {
    on(name, listener) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener) },
    async connect() { calls.connect++; state = 'connected'; return 'host-connected' },
    async disconnect() { calls.disconnect++; state = 'disconnected' },
    getConnectionStatus() { return { state } },
    async send(chatId, content) { calls.send.push({ chatId, content }); onSend?.(); return receipt },
  }
  return { port, calls, listeners, state(value) { state = value }, receipt(value) { receipt = value }, onSend(value) { onSend = value },
    async emit(name, ...args) { for (const listener of [...(listeners.get(name) ?? [])]) await listener(...args) } }
}
function environment(settings = {}) {
  const prefix = randomUUID(), harness = contextHarness(), native = portFixture()
  const options = { enabled: true, accountId: binding.accountId, ownerId: binding.ownerId, channelOwnerId: binding.ownerId, bindings: [binding],
    file: join(root, 'state', `${prefix}-ingress.json`), receiptFile: join(root, 'state', `${prefix}-receipts.json`), authorize: () => destination(), ...settings }
  const integration = create(harness.ctx, native.port, options)
  return { ...native, harness, options, integration, delivery: integration.delivery }
}

test('default disabled composition reads no port or configuration fields, installs nothing, and writes no files', () => {
  const options = { get accountId() { throw Error('disabled config was read') } }
  const ctx = { on() { throw Error('disabled hook installed') }, get() { throw Error('disabled service read') } }
  const port = new Proxy({}, { get() { throw Error('disabled port inspected') } })
  const before = readdirSync(root, { recursive: true })
  const integration = create(ctx, port, options)
  assert.equal(integration.port, port)
  assert.equal(integration.delivery, undefined)
  assert.deepEqual(integration.status(), { enabled: false, stopped: false, deliveryEnabled: false, connected: false })
  integration.stop(); integration.stop()
  assert.equal(integration.status().stopped, true)
  assert.deepEqual(readdirSync(root, { recursive: true }), before)
})

test('enabled attribution remains usable without a host authorization policy and never exposes delivery', () => {
  const e = environment({ authorize: undefined })
  assert.equal(e.integration.status().enabled, true)
  assert.equal(e.delivery, undefined)
  assert.equal(e.calls.connect, 0)
  assert.equal(e.calls.send.length, 0)
  assert.equal(e.harness.hooks.get('agent/pre-step').length, 1)
  e.integration.stop()
  assert.equal(e.harness.hooks.get('agent/pre-step').length, 0)
})

for (const settings of [{ channelOwnerId: 'different-owner' }, { bindings: [{ ...binding, ownerId: 'different-owner' }] },
  { bindings: [{ ...binding, accountId: 'different-account' }] }, { bindings: [binding, binding] }]) {
  test(`invalid main owner or binding is rejected before installing hooks: ${JSON.stringify(settings)}`, () => {
    const e = contextHarness(), native = portFixture()
    assert.throws(() => create(e.ctx, native.port, { enabled: true, accountId: binding.accountId, ownerId: binding.ownerId, channelOwnerId: binding.ownerId, bindings: [binding], ...settings }), /LARK_INTEGRATION/)
    assert.equal(e.hooks.size, 0)
    assert.equal(native.calls.connect, 0)
  })
}

test('wrapped successful connect and actual reconnect events notify readiness without taking connection ownership', async () => {
  const e = environment(), ready = []
  const release = e.delivery.onReady(() => ready.push(e.delivery.isReady(destination(), outbound())))
  assert.equal(e.calls.connect, 0)
  assert.equal(e.delivery.isReady(destination(), outbound()), false)
  assert.equal(await e.integration.port.connect(), 'host-connected')
  assert.deepEqual(ready, [true])
  e.state('disconnected'); await e.emit('reconnected')
  assert.deepEqual(ready, [true])
  e.state('connected'); await e.emit('reconnected')
  assert.deepEqual(ready, [true, true])
  release(); await e.emit('reconnected')
  assert.deepEqual(ready, [true, true])
  const oldService = e.delivery
  oldService.onReady(() => ready.push(true))
  e.integration.port.on('message', () => {})
  e.integration.stop(); e.integration.stop()
  await e.emit('reconnected')
  assert.equal(e.calls.disconnect, 0)
  assert.equal(e.port.getConnectionStatus().state, 'connected')
  assert.equal([...e.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0)
  assert.equal(oldService.isReady(destination(), outbound()), false)
  assert.equal(await oldService.destinationFor(execution(), localUser()), undefined)
  await assert.rejects(oldService.send(destination(), body, outbound()), /LARK_INTEGRATION_STOPPED/)
  assert.equal(e.calls.send.length, 0)
})

test('only matching native local or mobile provenance reaches the explicit host authorization callback', async () => {
  const seen = [], e = environment({ authorize(identity, user) { seen.push({ identity, user }); return destination() } })
  assert.deepEqual(await e.delivery.destinationFor(execution(), localUser()), destination())
  const origin = { provider: 'lark', ...binding, messageId: 'platform-inbound', nativeMessageId: 'native-input', sessionId: 'local-session' }
  const mobileIdentity = { ...execution(), channelOrigin: origin }, mobileUser = { ...localUser(), channelOrigin: origin }
  delete mobileUser.rpcId
  assert.deepEqual(await e.delivery.destinationFor(mobileIdentity, mobileUser), destination())
  assert.equal(seen.length, 2)
  assert.equal(seen[1].user.channelOrigin.messageId, 'platform-inbound')
  e.integration.stop()
})

const invalidSources = [
  ['model originalText without a native user', identity => [{ ...identity, originalText: '宿主原生授权文字' }, undefined]],
  ['wrong identity owner', identity => [{ ...identity, ownerId: 'other' }, localUser()]],
  ['wrong user owner', identity => [identity, { ...localUser(), ownerId: 'other' }]],
  ['wrong native message', identity => [identity, { ...localUser(), messageId: 'another-input' }]],
  ['wrong native session', identity => [identity, { ...localUser(), sessionId: 'another-session' }]],
  ['missing native rpc', identity => { const user = localUser(); delete user.rpcId; return [identity, user] }],
  ['non-user source', identity => [identity, { ...localUser(), source: 'schedule' }]],
  ['mobile native alias mismatch', identity => { const origin = { provider: 'lark', ...binding, messageId: 'platform-input', nativeMessageId: 'wrong-alias', sessionId: 'local-session' }; return [{ ...identity, channelOrigin: origin }, { ...localUser(), channelOrigin: origin }] }],
  ['mobile unbound chat', identity => { const origin = { provider: 'lark', ...binding, chatId: 'unbound-chat', messageId: 'platform-input', nativeMessageId: 'native-input', sessionId: 'local-session' }; return [{ ...identity, channelOrigin: origin }, { ...localUser(), channelOrigin: origin }] }],
  ['unsupported mobile thread', identity => { const origin = { provider: 'lark', ...binding, threadId: 'unproven-thread', messageId: 'platform-input', nativeMessageId: 'native-input', sessionId: 'local-session' }; return [{ ...identity, channelOrigin: origin }, { ...localUser(), channelOrigin: origin }] }],
]
for (const [label, input] of invalidSources) test(`${label} cannot invoke host authorization`, async () => {
  let calls = 0
  const e = environment({ authorize() { calls++; return destination() } })
  assert.equal(await e.delivery.destinationFor(...input(execution())), undefined)
  assert.equal(calls, 0)
  e.integration.stop()
})

for (const target of [{ ...destination(), chatId: 'not-bound' }, { ...destination(), ownerId: 'other' },
  { ...destination(), threadId: 'unproven-thread' }, { ...destination(), senderId: undefined }]) {
  test(`host policy cannot authorize a target outside the exact private binding: ${JSON.stringify(target)}`, async () => {
    const e = environment({ authorize: () => target })
    assert.equal(await e.delivery.destinationFor(execution(), localUser()), undefined)
    e.integration.stop()
  })
}

test('send requires the fixed full target, owner, and complete body digest before one native send', async () => {
  const e = environment(); e.state('connected')
  for (const [to, text, identity] of [[{ ...destination(), chatId: 'wrong' }, body, outbound()], [destination(), body, outbound({ ownerId: 'other' })],
    [destination(), body + 'changed', outbound()], [{ ...destination(), threadId: 'thread' }, body, outbound()]]) {
    await assert.rejects(e.delivery.send(to, text, identity), /LARK_INTEGRATION/)
  }
  assert.equal(e.calls.send.length, 0)
  assert.deepEqual(await e.delivery.send(destination(), body, outbound()), { messageId: 'actual-lark-message', chunkIds: ['actual-lark-message'] })
  assert.deepEqual(e.calls.send, [{ chatId: binding.chatId, content: { text: body } }])
  await assert.rejects(e.delivery.send(destination(), body, outbound()), /LARK_INTEGRATION/)
  assert.equal(e.calls.send.length, 1)
  e.integration.stop()
})

test('SDK receipts persist by exact occurrence without body or credentials and reload only reads the known real ID', async () => {
  const reads = [], readMessage = async messageId => { reads.push(messageId); return { messageId, chatId: binding.chatId, type: 'text', text: body } }
  const e = environment({ readMessage }); e.state('connected')
  e.receipt({ messageId: 'actual-lark-message', chunkIds: ['actual-lark-message'], rawCredential: 'do-not-save-this' })
  await e.delivery.send(destination(), body, outbound())
  const savedBytes = readFileSync(e.options.receiptFile, 'utf8'), saved = JSON.parse(savedBytes)
  const [row] = Object.values(saved.receipts)
  assert.equal(Object.keys(saved.receipts).length, 1)
  assert.deepEqual(row.destination, destination())
  assert.equal(row.identity.textSha256, digest(body))
  assert.equal(row.identity.occurrenceMessageId, 'native-occurrence')
  assert.equal(row.receipt.messageId, 'actual-lark-message')
  assert.equal(savedBytes.includes(body), false)
  assert.equal(savedBytes.includes('do-not-save-this'), false)
  e.integration.stop()
  const fresh = create(e.harness.ctx, e.port, e.options)
  assert.equal(await fresh.delivery.reconcile(destination(), outbound({ occurrenceMessageId: 'another-occurrence' })), undefined)
  assert.deepEqual(reads, [])
  assert.deepEqual(await fresh.delivery.reconcile(destination(), outbound()), { destination: destination(), textSha256: digest(body), receipt: row.receipt })
  assert.deepEqual(reads, ['actual-lark-message'])
  assert.equal(readFileSync(e.options.receiptFile, 'utf8'), savedBytes)
  assert.equal(e.calls.send.length, 1)
  fresh.stop()
})

test('a mutable host argument cannot change the validated destination or digest while SDK send awaits', async () => {
  const e = environment(); e.state('connected')
  const to = destination(), identity = outbound(), sending = e.delivery.send(to, body, identity)
  to.chatId = 'changed-during-send'
  identity.textSha256 = digest('changed-during-send')
  await sending
  const [row] = Object.values(JSON.parse(readFileSync(e.options.receiptFile, 'utf8')).receipts)
  assert.deepEqual(row.destination, destination())
  assert.deepEqual(row.identity, outbound())
  e.integration.stop()
})

test('mutable host arguments cannot authorize a mismatched platform read while reconciliation awaits', async () => {
  let release
  const pendingRead = new Promise(resolve => { release = resolve })
  const differentBody = '正文已被替换', differentChat = 'changed-during-read'
  const e = environment({ async readMessage(messageId) {
    await pendingRead
    return { messageId, chatId: differentChat, type: 'text', text: differentBody }
  } })
  e.state('connected')
  await e.delivery.send(destination(), body, outbound())
  const to = destination(), identity = outbound(), verification = e.delivery.reconcile(to, identity)
  to.chatId = differentChat
  identity.textSha256 = digest(differentBody)
  release()
  assert.equal(await verification, undefined)
  assert.equal(e.calls.send.length, 1)
  e.integration.stop()
})

for (const [label, response, receipt] of [
  ['wrong body', { messageId: 'actual-lark-message', chatId: binding.chatId, type: 'text', text: body.trim() }],
  ['wrong platform id', { messageId: 'native-occurrence', chatId: binding.chatId, type: 'text', text: body }],
  ['wrong platform chat', { messageId: 'actual-lark-message', chatId: 'other-chat', type: 'text', text: body }],
  ['non-text platform message', { messageId: 'actual-lark-message', chatId: binding.chatId, type: 'post', text: body }],
  ['incomplete chunks', { messageId: 'actual-lark-message', chatId: binding.chatId, type: 'text', text: body }, { messageId: 'actual-lark-message', chunkIds: ['actual-lark-message', 'second-chunk'] }],
]) test(`${label} remains unknown and cannot cause a resend`, async () => {
  const e = environment({ readMessage: async () => response }); e.state('connected')
  if (receipt) e.receipt(receipt)
  await e.delivery.send(destination(), body, outbound())
  assert.equal(await e.delivery.reconcile(destination(), outbound()), undefined)
  assert.equal(e.calls.send.length, 1)
  e.integration.stop()
})

test('without a structured lookup even a saved receipt remains unverified', async () => {
  const e = environment(); e.state('connected')
  await e.delivery.send(destination(), body, outbound())
  assert.equal(await e.delivery.reconcile(destination(), outbound()), undefined)
  e.integration.stop()
})

test('the real channel conversion flows through native user lookup into ReminderOperations authorization', async () => {
  ensureVault()
  const seen = [], e = environment({ authorize(identity, user) { seen.push({ identity, user }); return destination() } })
  let contexts
  const policy = channelContextPolicy({ file: e.options.file, localOwnerId: binding.ownerId, userFor: identity => contexts.originUser(identity) })
  contexts = new ExecutionContexts({ file: join(root, 'state', `${randomUUID()}-contexts.json`), runFor: id => `run:${id}`, resolveUserOrigin: policy.resolveUserOrigin })
  e.harness.ctx.tools = {}
  e.harness.services.set('butlerReminderDelivery', e.delivery)
  const target = { id: `session-butler-reminder-${randomUUID()}`, inheritedEventCount: 0 }, agent = e.harness.agent(`mobile-${randomUUID()}`)
  let input
  e.integration.port.on('message', async message => {
    input = chatUserMessage(message, { blocks: [], notes: [] }, { landed: [], notes: [] })
    await e.harness.emit('agent/inbox/inserted', { agent, message: input })
  })
  const source = { messageId: 'actual-mobile-message', chatId: binding.chatId, senderId: binding.senderId, chatType: 'p2p', content: '手机原生提醒输入' }
  await e.emit('message', source)
  contexts.bindUser(agent, input); contexts.captureRequest(agent, 1, 1)
  const workflows = installBusinessWorkflows(e.harness.ctx, { contexts, timeZone: 'Asia/Shanghai', filePrefix: randomUUID(), destination: async () => target.id,
    schedule: () => ({ async create() { return { id: 'native-mobile-schedule', sessionId: target.id } }, async history() { return { records: [{ messageId: 'native-mobile-occurrence' }] } } }) })
  const result = await contexts.withExecution({ agent, callId: 'native-remind', name: 'butler_remind' }, () => workflows.reminderOperations.create({ identity: contexts.current(),
    reminder: { title: '手机提醒', prompt: 'complete native reminder', at: '2030-01-02T03:04', timeZone: 'Asia/Shanghai', originalText: 'model text cannot replace input' } }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.operation.outboundDestination, destination())
  assert.equal(seen.length, 1)
  assert.equal(seen[0].user.text, source.content)
  assert.equal(seen[0].user.channelOrigin.messageId, source.messageId)
  assert.equal(seen[0].user.channelOrigin.nativeMessageId, input.id)
  assert.notEqual(input.id, source.messageId)
  workflows.stop(); e.integration.stop()
})

test('receipt commit failure becomes core uncertain and recovery never repeats the native SDK send', async () => {
  ensureVault()
  const e = environment(); e.state('connected')
  const { ReminderDeliveries } = await import('../src/host/reminder-delivery.ts')
  const bindingRecord = { executionKey: 'execution-key', scheduleId: 'native-job', taskId: 'task-reminder', sessionId: 'isolated-reminder', ownerId: binding.ownerId, destination: destination() }
  const file = join(root, 'state', `${randomUUID()}-outbound.json`)
  const options = { file, service: () => e.delivery, binding: () => bindingRecord, verifyOccurrence: async () => true }
  let manager = new ReminderDeliveries(options)
  e.onSend(() => writeFileSync(e.options.receiptFile, '{"invalid":"schema"}'))
  const event = (seq, type, data) => manager.observeSessionEvent({ id: 'isolated-reminder', inheritedEventCount: 0 }, { seq, type, data })
  await event(1, 'turn/start', { turn: 1 })
  await event(2, 'user/message', { id: 'native-occurrence', source: { kind: 'schedule', scheduleId: 'native-job' } })
  await event(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: body }] } })
  await event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(e.calls.send.length, 1)
  assert.equal(manager.status()[0].state, 'uncertain')
  manager.stop(); manager = new ReminderDeliveries(options)
  await manager.recover()
  assert.equal(manager.status()[0].state, 'uncertain')
  assert.equal(e.calls.send.length, 1)
  manager.stop(); e.integration.stop()
})
