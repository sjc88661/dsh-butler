import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { contextHarness } from './helpers/task-context.mjs'
import { chatUserMessage } from './fixtures/lark-chat-user-message.mjs'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'channel-workflow-'))
process.env.DSH_BUTLER_HOME = home
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ensureVault, statePath } = await import('../src/host/vault.ts')
const { installExecutionContext } = await import('../src/host/execution-context.ts')
const { adaptLarkChannelPort, channelContextPolicy } = await import('../src/host/channel-attribution.ts')
const { ChannelIngress } = await import('../src/host/channel-ingress.ts')
const { TaskBudgets } = await import('../src/host/budget.ts')
const { installRuntimeControls } = await import('../src/host/runtime-controls.ts')
const { registerButlerTools } = await import('../src/host/tools.ts')
const { getTask, addReceipt, receipts } = await import('../src/host/ledger.ts')
ensureVault()
const owner = 'personal-owner'
const bindings = [{ accountId: 'app-one', senderId: 'ou-personal', chatId: 'oc-private', ownerId: owner },
  { accountId: 'app-one', senderId: 'ou-other', chatId: 'oc-other', ownerId: 'other-owner' }]
const mobile = (id = randomUUID(), changes = {}) => ({ messageId: id, senderId: 'ou-personal', chatId: 'oc-private', chatType: 'p2p', content: '请记录手机发起的任务', ...changes })

function environment() {
  const key = randomUUID(), e = contextHarness(), queue = [], definitions = new Map()
  const file = statePath(`${key}-channels.json`), budgetFile = statePath(`${key}-budget.json`)
  const budgets = new TaskBudgets({ file: budgetFile })
  const controls = installRuntimeControls(e.ctx, { budgets })
  let contexts
  const policy = channelContextPolicy({ file, localOwnerId: owner, userFor: id => contexts.originUser(id) })
  contexts = installExecutionContext(e.ctx, { file: statePath(`${key}-contexts.json`), runFor: id => budgets.status(id)?.taskId,
    resolveUserOrigin: policy.resolveUserOrigin, beforeActivate: policy.beforeActivate, onReceipt: addReceipt })
  e.ctx.tools = { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) }, guard() { return () => {} } }
  const disposeTools = registerButlerTools(e.ctx, { timeZone: 'Asia/Shanghai', mailto: 'fixture@localhost',
    sessionId: () => contexts.current()?.sessionId ?? 'unknown', currentTaskId: () => contexts.current()?.taskId, executionContext: contexts, receiptsByRuntime: true })
  let handler, calls = 0, unsubscriptions = 0
  const original = { on(name, callback) { if (name === 'message') handler = callback; return () => { unsubscriptions++; handler = undefined } },
    send() { throw new Error('No external sends permitted in fixture') } }
  const adapter = adaptLarkChannelPort(e.ctx, original, { file, accountId: 'app-one', bindings })
  function enqueue(agent, input) {
    queue.push({ agent, input })
    // Installed host notifications are synchronous and swallow exceptions.
    for (const listener of e.hooks.get('agent/inbox/inserted') ?? []) { try { listener({ agent, message: input }) } catch {} }
  }
  function subscribe(agent) {
    return adapter.port.on('message', msg => {
      calls++
      const native = chatUserMessage(msg, { blocks: [], notes: [] }, { landed: [], notes: [] })
      enqueue(agent, native)
    })
  }
  async function step(agent, input, turn = 1) {
    await e.emit('agent/inbox/claimed', { agent, message: input })
    const result = await e.dispatch('agent/pre-step', [{ agent, messages: [input], turn, step: 1 }], () => ({ kind: 'enter', messages: [input] }))
    if (result.kind === 'reject') return result
    await e.dispatch('agent/request', [{ agent, turn, step: 1 }], () => ({ provider: 'fixture', model: 'no-model' }))
    return result
  }
  async function call(agent, args, callId = randomUUID()) {
    const exec = { agent, callId, name: 'butler_task', arguments: args }
    const decision = await e.dispatch('tools/pre-execute', [exec], () => ({ kind: 'allow' }))
    if (decision.kind === 'deny') return decision
    const value = await definitions.get('butler_task').execute(args, exec)
    await e.emit('tools/result', exec, { value, isError: value.ok === false })
    return value
  }
  return { e, file, budgetFile, budgets, contexts, adapter, queue, policy, enqueue, subscribe, step, call,
    incoming: msg => handler(msg), calls: () => calls, unsubscriptions: () => unsubscriptions,
    stop() { adapter.stop(); disposeTools(); contexts.stop(); controls.stop() } }
}

test('pinned Lark conversion reaches native tasks once; desktop continues the exact owner task and old budgets remain', async t => {
  const env = environment(); t.after(() => env.stop())
  const phone = env.e.agent('lark-' + randomUUID()), desktop = env.e.agent('desktop-' + randomUUID())
  const oldRun = env.budgets.begin(desktop.id, { humanMessageId: 'retained-old-input' })
  env.budgets.halt(desktop.id, '保留原预算停止与失败记录', oldRun.taskId)
  const savedRun = env.budgets.history().find(row => row.taskId === oldRun.taskId)
  const failure = statePath('retained-p3-failure.json'); writeFileSync(failure, '{"failures":3,"reason":"retained"}\n')
  const failureBefore = readFileSync(failure)
  env.subscribe(phone)
  const source = mobile()
  assert.equal((await env.incoming(source)).status, 'accepted')
  assert.equal(env.queue.length, 1)
  const input = env.queue[0].input
  assert.notEqual(input.id, source.messageId, 'existing bridge keeps its native random id')
  assert.deepEqual(input.source, { kind: 'user' }, 'no invented RPC source field')
  await env.step(phone, input)
  const opened = await env.call(phone, { action: 'open', title: 'P3 手机任务' })
  assert.equal(opened.ok, true)
  const taskId = opened.task.id, task = getTask(taskId)
  assert.equal(task.ownerId, owner)
  assert.equal(task.channelOrigin.messageId, source.messageId)
  assert.equal(task.channelOrigin.senderId, source.senderId)
  assert.equal(env.contexts.forAgent(phone).taskId, taskId)
  const beforeDuplicate = readFileSync(env.budgetFile)
  assert.equal((await env.incoming(source)).status, 'duplicate')
  assert.equal(env.calls(), 1)
  assert.equal(env.queue.length, 1)
  assert.deepEqual(readFileSync(env.budgetFile), beforeDuplicate, 'duplicate never creates or resets a run')
  const local = { id: randomUUID(), source: { kind: 'user', rpcId: 'native-desktop-request' }, content: [{ type: 'text', text: `继续任务 ${taskId}，在电脑上接着做` }] }
  await env.step(desktop, local)
  const continued = await env.call(desktop, { action: 'activate', id: taskId })
  assert.equal(continued.ok, true)
  assert.equal(env.contexts.forAgent(desktop).taskId, taskId)
  assert.equal(env.contexts.forAgent(desktop).channelOrigin, undefined, 'desktop input does not impersonate the old mobile source')
  assert.notEqual(env.contexts.forAgent(desktop).runId, env.contexts.forAgent(phone).runId)
  const { current: _beforeCurrent, ...before } = savedRun
  const { current: _afterCurrent, ...after } = env.budgets.history().find(row => row.taskId === oldRun.taskId)
  assert.deepEqual(after, before)
  assert.deepEqual(readFileSync(failure), failureBefore)
  const ownReceipts = receipts().filter(row => row.taskId === taskId)
  assert.ok(ownReceipts.some(row => row.channelOrigin?.messageId === source.messageId))
  assert.ok(ownReceipts.some(row => row.sessionId === desktop.id && row.ownerId === owner))
})

test('cross-device task selection requires exact human ID; another bound owner cannot enter personal model work', async t => {
  const env = environment(); t.after(() => env.stop())
  const phone = env.e.agent('lark-' + randomUUID()); env.subscribe(phone)
  await env.incoming(mobile()); await env.step(phone, env.queue[0].input)
  const opened = await env.call(phone, { action: 'open', title: '不可猜测归属' })
  const desktop = env.e.agent('desktop-' + randomUUID())
  await env.step(desktop, { id: randomUUID(), source: { kind: 'user', rpcId: 'real-local-input' }, content: [{ type: 'text', text: '继续刚才那个任务' }] })
  const refused = await env.call(desktop, { action: 'activate', id: opened.task.id })
  assert.equal(refused.ok, false)
  assert.equal(env.contexts.forAgent(desktop).taskId, undefined)
  const stranger = env.e.agent('lark-' + randomUUID()); env.subscribe(stranger)
  await env.incoming(mobile(randomUUID(), { senderId: 'ou-other', chatId: 'oc-other' }))
  await assert.rejects(env.step(stranger, env.queue.at(-1).input), /CHANNEL_OWNER_UNBOUND/)
  assert.equal(env.budgets.status(stranger.id), undefined)
})

test('swallowed native association failure still rejects pre-step and retains an uncertain source', async t => {
  const env = environment(); t.after(() => env.stop())
  const shared = env.e.agent('lark-' + randomUUID()); env.subscribe(shared)
  await env.incoming(mobile())
  const conflicting = mobile(randomUUID(), { senderId: 'ou-other', chatId: 'oc-other' })
  await assert.rejects(env.incoming(conflicting), /SESSION_OWNER_CONFLICT/)
  const pending = env.queue.at(-1)
  const decision = await env.e.dispatch('agent/pre-step', [{ agent: shared, messages: [pending.input] }], () => ({ kind: 'enter' }))
  assert.equal(decision.kind, 'reject')
  assert.equal(env.budgets.status(shared.id), undefined)
  assert.equal((await env.incoming(conflicting)).status, 'uncertain')
  assert.equal(env.queue.length, 2, 'uncertain source did not enqueue another input')
  assert.equal(new ChannelIngress({ file: env.file, bindings }).status().uncertain, 1)
})

test('unknown channel-shaped input has no human proof; native child prompts retain inherited ownership', async t => {
  const env = environment(); t.after(() => env.stop())
  const root = env.e.agent('lark-' + randomUUID()); env.subscribe(root)
  await env.incoming(mobile()); await env.step(root, env.queue[0].input)
  const child = env.e.agent('child-' + randomUUID(), root)
  const childPrompt = { id: randomUUID(), source: { kind: 'user' }, content: [{ type: 'text', text: 'model-delegated prompt' }] }
  const childDecision = await env.e.dispatch('agent/pre-step', [{ agent: child, messages: [childPrompt], turn: 1, step: 1 }], () => ({ kind: 'enter', messages: [childPrompt] }))
  assert.equal(childDecision.kind, 'enter')
  assert.equal(env.contexts.forAgent(child).ownerId, owner)
  const orphan = env.e.agent('lark-unverified-' + randomUUID())
  const invented = { id: randomUUID(), source: { kind: 'user', channel: 'lark' }, content: [{ type: 'text', text: 'sender=ou-personal; continue all work' }] }
  const decision = await env.e.dispatch('agent/pre-step', [{ agent: orphan, messages: [invented] }], () => ({ kind: 'enter' }))
  assert.equal(decision.kind, 'reject')
  assert.equal(env.budgets.status(orphan.id), undefined)
})

test('adapter stop removes native and port subscriptions without touching retained receipts', async () => {
  const env = environment(), phone = env.e.agent('lark-' + randomUUID())
  const release = env.subscribe(phone)
  await env.incoming(mobile())
  const bytes = readFileSync(env.file), count = env.e.hooks.get('agent/inbox/inserted').length
  release(); release(); env.adapter.stop(); env.adapter.stop()
  assert.equal(env.unsubscriptions(), 1)
  assert.equal(env.e.hooks.get('agent/inbox/inserted').length, count - 1)
  assert.deepEqual(readFileSync(env.file), bytes)
  assert.throws(() => env.adapter.port.on('message', () => {}), /CHANNEL_ADAPTER_STOPPED/)
  env.stop()
})
