import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskBudgets } from '../src/host/budget.ts'
const { installRuntimeControls, installBudgetFailure } = await import('../src/host/runtime-controls.ts').catch(() => ({}))

function environment(options = {}) {
  assert.equal(typeof installRuntimeControls, 'function', 'budget enforcement must be attached to real runtime waterfalls')
  const hooks = new Map()
  let current
  const agents = []
  const registry = {
    currentInitiator: () => current, list: () => agents,
    isOwnedBy: (id, parent) => agents.some(a => a.id === id && a.parent === parent),
  }
  const ctx = {
    on(name, fn, settings) { const list = hooks.get(name) ?? []; settings?.prepend ? list.unshift(fn) : list.push(fn); hooks.set(name, list); return () => list.splice(list.indexOf(fn), 1) },
    get: name => name === 'agents' ? registry : name === 'agentPresets' ? { serviceFor: (agent, service) => service === 'compaction' ? agent.isolatedCompaction : undefined } : undefined,
    logger: { warn() {}, info() {} },
  }
  const budgets = options.budgets ?? new TaskBudgets(options)
  const controls = installRuntimeControls(ctx, { budgets, ...options })
  function dispatch(name, args, terminal) {
    const chain = [...(hooks.get(name) ?? []), terminal]
    const next = () => chain.shift()(...args, next)
    return next()
  }
  function agent(id, parent) {
    const compaction = { config: { thresholdRatio: .8, retainRatio: .16, headroomTokens: 65536, maxTokens: 65536, compactionRetries: 1, modelPolicies: [] }, async compactIfNeeded() { return this.config } }
    const a = { id, parent, session: { id, requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1000000 }), requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) },
      ctx: { get: name => name === 'compaction' ? compaction : undefined } }
    agents.push(a)
    return a
  }
  async function step(a, messages = []) {
    current = a
    return dispatch('agent/pre-step', [{ agent: a, messages, step: 1, turn: 1, signal: new AbortController().signal }], () => ({ kind: 'enter', messages }))
  }
  async function request(a, stream, options = {}) {
    current = a
    const request = { sessionId: a.id, maxTokens: 16, messages: [], ...options }
    const chunks = []
    for await (const chunk of dispatch('llm/stream', [Object.freeze(request)], stream)) chunks.push(chunk)
    return chunks
  }
  return { ctx, hooks, controls, budgets, dispatch, agent, step, request }
}
const human = id => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] })
async function* usage(totalTokens = 20) { yield { type: 'usage', usage: { totalTokens } }; yield { type: 'finish', reason: { kind: 'stop' } } }

test('the last request is a tool-free answer and automatic compaction cannot spend it', async () => {
  const e = environment({ normal: { maxRequests: 6, maxTokens: 160000 } }), a = e.agent('answer-reserve')
  const service = a.ctx.get('compaction'); let summaries = 0
  service.compactIfNeeded = async () => { summaries++; return null }
  await e.step(a, [human('reserve-input')])
  for (let i = 0; i < 5; i++) await e.request(a, () => usage(1000))
  const assembly = { tools: [{ name: 'butler_literature' }], contexts: [], sections: [] }
  const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
  assert.deepEqual(result.tools, [])
  assert.ok(result.contexts.some(item => item.name === 'butler:budget-final' && /最终|答复/.test(item.text)))
  assert.equal(await service.compactIfNeeded(a, 'pressure', new AbortController().signal), null)
  assert.equal(summaries, 0)
  await e.request(a, () => usage(1000), { maxTokens: 8192 })
  assert.equal(e.budgets.status(a.id).requests, 6)
  assert.equal(e.budgets.status(a.id).blocked, undefined)
  e.controls.stop()
})

test('optional summary refusal does not latch a task failure or consume the final answer credit', async () => {
  const e = environment({ normal: { maxRequests: 2 } }), a = e.agent('skip-summary')
  await e.step(a, [human('input')]); await e.request(a, () => usage(20))
  e.dispatch('session/event', [a.session, { type: 'compaction/start', data: { compactionId: 'optional' } }], () => undefined)
  let sent = false, reason
  try { await e.request(a, () => { sent = true; return usage() }, { purpose: 'compaction' }) } catch (error) { reason = error.message }
  assert.match(reason, /COMPACTION_DEFERRED/)
  assert.equal(sent, false)
  e.dispatch('session/event', [a.session, { type: 'compaction/end', data: { compactionId: 'optional', error: reason } }], () => undefined)
  assert.equal(e.budgets.status(a.id).blocked, undefined)
  assert.equal(e.budgets.status(a.id).requests, 1)
  await e.request(a, () => usage(20))
  e.controls.stop()
})

test('claiming a new direct human input resets planning before native prompt assembly', async () => {
  const e = environment({ normal: { maxRequests: 1 } }), a = e.agent('new-claim')
  await e.step(a, [human('old')]); await e.request(a, () => usage())
  const previous = e.budgets.status(a.id).taskId
  e.dispatch('agent/inbox/claimed', [{ agent: a, message: human('new') }], () => undefined)
  assert.notEqual(e.budgets.status(a.id).taskId, previous)
  assert.equal(e.budgets.status(a.id).requests, 0)
  const child = e.agent('child-claim', a)
  e.dispatch('agent/inbox/claimed', [{ agent: child, message: human('child-new') }], () => undefined)
  assert.equal(e.budgets.status(a.id).originId, 'new')
  e.controls.stop()
})

test('remaining credit lowers context pressure without ratcheting later tasks or shared agents', async () => {
  const e = environment({ normal: { maxRequests: 6, maxTokens: 160000 } }), a = e.agent('adaptive-context')
  await e.step(a, [human('input')])
  await e.request(a, () => usage(80000))
  await e.step(a)
  assert.ok((await a.ctx.get('compaction').compactIfNeeded(a)).modelPolicies[0].thresholdRatio <= .01)
  await e.step(a, [human('fresh')])
  assert.equal((await a.ctx.get('compaction').compactIfNeeded(a)).modelPolicies[0].thresholdRatio, .02)
  e.controls.stop()
})

test('planning includes a newly claimed message before the native surface appends it', async () => {
  const e = environment({ normal: { maxRequests: 6, maxTokens: 160000 } }), a = e.agent('large-claim')
  a.session.surface = { nodes: [] }; a.session.eventAt = () => undefined; a.session.deriveEventMessage = () => undefined
  const input = { id: 'large-human', source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(90000) }] }
  e.dispatch('agent/inbox/claimed', [{ agent: a, message: input }], () => undefined)
  const assembly = { tools: [{ name: 'search' }], contexts: [] }
  const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
  assert.deepEqual(result.tools, [])
  assert.equal(e.controls.status().plans[0].allowSummary, false)
  assert.equal(e.budgets.status(a.id).requests, 0)
  e.controls.stop()
})

test('a small task budget compacts before a large tool batch can exhaust admission capacity', async () => {
  const e = environment({ normal: { maxRequests: 6, maxTokens: 160000 } }), a = e.agent('small-task')
  await e.step(a, [human('small-task-input')])
  const policy = (await a.ctx.get('compaction').compactIfNeeded(a)).modelPolicies[0]
  assert.equal(policy.thresholdRatio, .02)
  assert.ok(policy.retainTokens <= 10000)
  assert.ok(policy.maxTokens <= 5000)
  assert.equal(e.budgets.reports()[0].limits.maxTokens, 160000)
  assert.equal(e.budgets.reports()[0].limits.maxRequests, 6)
  e.controls.stop()
})

test('long compaction input uses its own native route capacity and preserves the task budget', async () => {
  const e = environment(), a = e.agent('long-compaction')
  await e.step(a, [human('fresh-explicit-task')])
  let dispatches = 0
  const options = { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 8192, purpose: 'compaction',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(3_200_000) }] }] }
  await e.request(a, () => { dispatches++; return usage(321) }, options)
  assert.equal(dispatches, 1); assert.equal(e.budgets.status(a.id).requests, 1)
  assert.equal(e.budgets.status(a.id).tokens, 321); assert.equal(e.budgets.status(a.id).reservedTokens, 0)
  assert.equal(e.controls.status().inputReservations[0].inputUpperBound, 991808)
  e.controls.stop()
})

test('a different summary route cannot borrow the parent context ceiling or gain credit by retry', async () => {
  const e = environment(), a = e.agent('different-summary')
  await e.step(a, [human('fresh')])
  let dispatches = 0
  const options = { provider: 'deepseek-official', model: 'different-model', maxTokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(3_200_000) }] }] }
  await assert.rejects(e.request(a, () => { dispatches++; return usage() }, options), /发送前预检/)
  await assert.rejects(e.request(a, () => { dispatches++; return usage() }, options), /发送前预检/)
  assert.equal(dispatches, 0); assert.equal(e.budgets.status(a.id).requests, 0); assert.equal(e.budgets.status(a.id).reservedTokens, 0)
  e.controls.stop()
})

test('real model middleware blocks downstream dispatch at the request budget', async () => {
  const e = environment({ normal: { maxRequests: 2 } })
  const a = e.agent('dev')
  await e.step(a, [human('h1')])
  let dispatched = 0
  const adapter = () => { dispatched++; return usage() }
  await e.request(a, adapter); await e.request(a, adapter)
  await assert.rejects(e.request(a, adapter), /调用/)
  assert.equal(dispatched, 2)
  assert.equal(e.budgets.status('dev').tokens, 40)
})

test('retry and compaction calls share their initiating task budget', async () => {
  const e = environment({ normal: { maxRequests: 2 } })
  const a = e.agent('dev')
  await e.step(a, [human('h1')])
  await assert.rejects(e.request(a, () => { throw new Error('network failed') }), /network/)
  await e.request(a, () => usage(), { messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }] })
  await assert.rejects(e.request(a, () => usage()), /调用/)
})

test('child agents cannot acquire separate credit', async () => {
  const e = environment({ normal: { maxRequests: 2 } })
  const root = e.agent('dev'), child = e.agent('child', root)
  await e.step(root, [human('h1')]); await e.step(child, [human('child-prompt')])
  await e.request(root, () => usage()); await e.request(child, () => usage())
  await assert.rejects(e.request(root, () => usage()), /调用/)
  assert.equal(e.budgets.status('child'), undefined)
})

test('output is capped in the request waterfall before the immutable header is logged', async () => {
  const e = environment(), a = e.agent('dev')
  await e.step(a, [human('h1')])
  const config = await e.dispatch('agent/request', [{ agent: a }], () => ({ provider: 'p', model: 'm', maxTokens: 256000 }))
  assert.equal(config.maxTokens, 8192)
})

test('the scoped compactor gets a 64k pressure threshold and 12k retained tail', async () => {
  const e = environment(), a = e.agent('dev')
  await e.step(a, [human('h1')])
  const policy = (await a.ctx.get('compaction').compactIfNeeded(a)).modelPolicies.find(p => p.provider === 'deepseek-official' && p.model === 'deepseek-flash')
  assert.equal(policy.thresholdRatio, .064)
  assert.equal(policy.retainTokens, 12000)
  assert.equal(policy.maxTokens, 8192)
  e.controls.stop()
  assert.equal(a.ctx.get('compaction').config.modelPolicies.length, 0)
})

test('the preset registry resolves the isolated compactor invisible to agent.ctx', async () => {
  const e = environment(), a = e.agent('dev')
  const service = a.ctx.get('compaction')
  a.isolatedCompaction = service
  a.ctx.get = () => undefined
  await e.step(a, [human('h1')])
  assert.equal((await service.compactIfNeeded(a)).modelPolicies[0].thresholdRatio, .064)
  assert.equal((await service.compactIfNeeded(a)).modelPolicies[0].maxTokens, 8192)
})

test('shared preset summaries capture independent normal and reminder output limits', async () => {
  const e = environment(), normal = e.agent('normal-summary'), reminder = e.agent('session-butler-reminder-summary')
  const service = normal.ctx.get('compaction')
  const original = async function (_input, _agent) {
    await Promise.resolve() // Configuration must remain scoped after an asynchronous boundary.
    return { maxTokens: this.config.modelPolicies[0].maxTokens, context: this.ctx }
  }
  service.ctx = { native: true }; service.summarize = original
  normal.isolatedCompaction = service; reminder.isolatedCompaction = service
  await e.step(normal, [human('normal-input')])
  await e.step(reminder, [{ id: 'scheduled-input', source: { kind: 'schedule' }, content: [] }])
  const installed = service.config
  const [a, b] = await Promise.all([service.summarize({}, normal), service.summarize({}, reminder)])
  assert.equal(a.maxTokens, 8192)
  assert.equal(b.maxTokens, 1024)
  assert.equal(a.context, service.ctx)
  assert.equal(service.config, installed, 'per-call output policy must not mutate shared preset state')
  e.controls.stop()
  assert.equal(service.summarize, original)
})

test('Cordis caller proxies retain the native summarizer context and install only once', async () => {
  const e = environment(), a = e.agent('cordis-summary')
  const native = a.ctx.get('compaction')
  native.ctx = { llm: { native: true } }
  native.summarize = async function () {
    assert.equal(this.ctx.llm?.native, true, 'The summarizer must retain its own injected context')
    return this.config.modelPolicies[0].maxTokens
  }
  const proxy = () => new Proxy(native, { get(target, key) {
    if (key === Symbol.for('cordis.original')) return target
    if (key === 'ctx') return { callerWithoutLlm: true }
    return Reflect.get(target, key)
  } })
  a.isolatedCompaction = proxy()
  await e.step(a, [human('one')])
  const wrapped = native.summarize
  a.isolatedCompaction = proxy()
  await e.step(a)
  assert.equal(native.summarize, wrapped, 'Fresh caller proxies must not accumulate wrappers')
  assert.equal(await native.summarize({}, a), 8192)
  assert.equal(e.controls.status().configuredCompactors, 1)
  e.controls.stop()
})

test('native summaries turn off default reasoning and set a concise checkpoint target without mutating the shared context', async () => {
  const e = environment(), normal = e.agent('bounded-summary'), reminder = e.agent('session-butler-reminder-bounded-summary')
  const service = normal.ctx.get('compaction'), requests = []
  const llm = { stream(request) { assert.equal(this, llm); requests.push(request); return usage(30) } }
  const nativeContext = { llm, marker: 'native context' }
  const originalMessage = Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: 'Native checkpoint instruction: preserve critical facts.' })]) })
  service.ctx = nativeContext
  service.summarize = async function (_input, owner) {
    assert.equal(this.ctx.marker, 'native context')
    const request = Object.freeze({ purpose: 'compaction', sessionId: owner.id, maxTokens: this.config.maxTokens, messages: Object.freeze([originalMessage]) })
    for await (const _chunk of this.ctx.llm.stream(request)) {}
    assert.equal(request.reasoningEffort, undefined)
    assert.equal(request.messages[0], originalMessage)
  }
  normal.isolatedCompaction = service; reminder.isolatedCompaction = service
  await e.step(normal, [human('normal-summary-origin')])
  await e.step(reminder, [{ id: 'reminder-summary-origin', source: { kind: 'schedule' }, content: [] }])
  await Promise.all([service.summarize({}, normal), service.summarize({}, reminder)])
  assert.deepEqual(requests.map(request => request.reasoningEffort), ['off', 'off'], 'Unspecified DeepSeek requests otherwise default to high reasoning')
  assert.deepEqual(requests.map(request => request.maxTokens), [8192, 1024])
  assert.match(requests[0].messages.at(-1).content.at(-1).text, /6144/)
  assert.match(requests[1].messages.at(-1).content.at(-1).text, /768/)
  assert.match(requests[0].messages.at(-1).content[0].text, /^Native checkpoint instruction:/)
  assert.equal(service.ctx, nativeContext)
  assert.equal(service.ctx.llm, llm)
  assert.equal(originalMessage.content.length, 1)
  e.controls.stop()
})

test('failed native compaction stops before the next main request and cannot repeat in the same task', async () => {
  const e = environment(), a = e.agent('failed-compaction')
  const nativeFailure = 'summarization truncated at the token cap (incomplete checkpoint)'
  let attempts = 0
  // Match the real native order: failure is durably logged, caught, and next() still enters.
  e.ctx.on('agent/pre-step', async ({ agent }, next) => {
    attempts++
    e.dispatch('session/event', [agent.session, { type: 'compaction/start', data: { compactionId: 'first' } }], () => undefined)
    await e.request(agent, () => usage(300), { purpose: 'compaction', maxTokens: 8192 })
    e.dispatch('session/event', [agent.session, { type: 'compaction/end', data: { compactionId: 'first', error: nativeFailure } }], () => undefined)
    return next()
  })
  await assert.rejects(e.step(a, [human('one-input')]), /COMPACTION_FAILED/)
  assert.equal(e.budgets.status(a.id).requests, 1)
  assert.equal(e.budgets.status(a.id).tokens, 300)
  let sent = false
  await assert.rejects(e.request(a, () => { sent = true; return usage() }), /COMPACTION_FAILED/)
  await assert.rejects(e.step(a, [human('one-input')]), /COMPACTION_FAILED/)
  assert.equal(attempts, 1)
  assert.equal(sent, false)
  e.controls.stop()
})

test('stale compaction errors cannot poison a newer direct human task', async () => {
  const e = environment(), a = e.agent('stale-compaction')
  await e.step(a, [human('old')])
  e.dispatch('session/event', [a.session, { type: 'compaction/start', data: { compactionId: 'old-attempt' } }], () => undefined)
  await e.step(a, [human('new')])
  e.dispatch('session/event', [a.session, { type: 'compaction/end', data: { compactionId: 'old-attempt', error: 'old failure' } }], () => undefined)
  await e.request(a, () => usage())
  assert.equal(e.budgets.status(a.id).blocked, undefined)
  assert.equal(e.budgets.status(a.id).requests, 1)
  e.controls.stop()
})

test('compaction failure is shared with children and survives runtime-control reload', async () => {
  const e = environment(), root = e.agent('parent-compaction'), child = e.agent('child-compaction', root)
  await e.step(root, [human('original')]); await e.step(child)
  e.dispatch('session/event', [child.session, { type: 'compaction/start', data: { compactionId: 'child-attempt' } }], () => undefined)
  e.dispatch('session/event', [child.session, { type: 'compaction/end', data: { compactionId: 'child-attempt', error: 'network failed' } }], () => undefined)
  e.controls.stop()
  const reloaded = installRuntimeControls(e.ctx, { budgets: e.budgets })
  try {
    await assert.rejects(e.step(child), /COMPACTION_FAILED/)
    await assert.rejects(e.step(root, [human('original')]), /COMPACTION_FAILED/)
    await e.step(root, [human('fresh-human-authorization')])
    await e.request(root, () => usage())
    assert.equal(e.budgets.status(root.id).requests, 1)
  } finally { reloaded.stop() }
})

test('three failed tools with changing arguments stop the next step', async () => {
  const e = environment(), a = e.agent('dev')
  await e.step(a, [human('h1')])
  for (let i = 0; i < 3; i++) await e.dispatch('tools/post-execute', [{ agent: a, id: `c${i}`, name: 'pwsh', arguments: { command: `different-${i}` } }, { isError: true, content: [{ type: 'text', text: 'same failure' }] }], () => ({ kind: 'accept' }))
  await assert.rejects(e.step(a), /pwsh/)
})

test('reminder sessions deny shell and edits but allow bounded reads', async () => {
  const e = environment(), a = e.agent('session-butler-reminder-abc')
  await e.step(a, [{ id: 'schedule-1', source: { kind: 'schedule' }, content: [] }])
  for (const name of ['pwsh', 'write', 'edit', 'dev_inject_plugin', 'create_agent', 'butler_remind']) {
    const decision = await e.dispatch('tools/pre-execute', [{ agent: a, name, arguments: {}, id: name }], () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny', name)
  }
  assert.equal((await e.dispatch('tools/pre-execute', [{ agent: a, name: 'read', arguments: {} }], () => ({ kind: 'allow' }))).kind, 'allow')
  const config = await e.dispatch('agent/request', [{ agent: a }], () => ({ maxTokens: 256000 }))
  assert.equal(config.maxTokens, 1024)
})

test('reminders send only their allowed tool schemas instead of the whole development catalog', async () => {
  const e = environment(), a = e.agent('session-butler-reminder-abc')
  const assembly = { tools: [{ name: 'pwsh' }, { name: 'read' }, { name: 'edit' }, { name: 'web_search' }], sections: [], contexts: [], variables: {} }
  const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
  assert.deepEqual(result.tools.map(t => t.name), ['read', 'web_search'])
})

test('reminder tool presentation is native before assembly and restored on disposal', async () => {
  const e = environment(), a = e.agent('session-butler-reminder-ptc')
  const get = a.ctx.get
  let mode = 'ptc', declarations = 0
  const tools = {
    presentAs(next) { declarations++; mode = next; return () => { mode = 'ptc' } },
    schemas: () => [{ name: 'read' }, { name: 'pwsh' }],
  }
  a.ctx.get = name => name === 'tools' ? tools : get(name)
  for (let i = 0; i < 2; i++) {
    const result = await e.dispatch('system-prompt/assemble', [{ tools: [] }, { agent: a }], () => {
      assert.equal(mode, 'native', 'native presentation must be selected before the terminal assembles tool schemas')
      return { tools: tools.schemas() }
    })
    assert.deepEqual(result.tools.map(t => t.name), ['read'])
  }
  assert.equal(declarations, 1)
  e.controls.stop()
  assert.equal(mode, 'ptc')
})

test('ordinary task tool schemas remain available', async () => {
  const e = environment(), a = e.agent('dev')
  const assembly = { tools: [{ name: 'pwsh' }, { name: 'edit' }] }
  assert.equal(await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly), assembly)
})

test('legacy schedule deliveries are forwarded and do not enter the development model', async () => {
  const forwarded = []
  const e = environment({ redirectReminder: async (_a, message) => { forwarded.push(message.id) } })
  const a = e.agent('dev')
  const decision = await e.step(a, [{ id: 'legacy-schedule', source: { kind: 'schedule' }, content: [] }])
  assert.equal(decision.kind, 'reject')
  assert.deepEqual(forwarded, ['legacy-schedule'])
  assert.equal(e.budgets.status('dev'), undefined)
})

test('mixed human and scheduled input forwards only the reminder and retains human input', async () => {
  const e = environment({ redirectReminder: async () => {} })
  const a = e.agent('dev')
  const decision = await e.step(a, [human('h1'), { id: 'legacy-schedule', source: { kind: 'schedule' }, content: [] }])
  assert.deepEqual(decision.messages.map(m => m.id), ['h1'])
})

test('a tool error is returned with tool and execution identities', async () => {
  const e = environment(), a = e.agent('dev')
  await e.step(a, [human('h1')])
  const decision = await e.dispatch('tools/post-execute', [{ agent: a, name: 'butler_literature', id: 'call-316' }, { isError: true, content: [{ type: 'text', text: 'args.action required' }] }], () => ({ kind: 'accept' }))
  assert.match(decision.content[0].text, /butler_literature/)
  assert.match(decision.content[0].text, /call-316/)
})

test('request deadlines reach the adapter without mutating frozen requests', async () => {
  const e = environment(), a = e.agent('dev')
  await e.step(a, [human('h1')])
  await e.request(a, () => usage())
  assert.equal(e.budgets.status('dev').requests, 1)
})

test('task deadline cancels an active agent while a tool is running', async () => {
  const e = environment({ normal: { maxMs: 30 } }), a = e.agent('dev')
  let cancelled
  a.cancel = reason => { cancelled = reason }
  await e.step(a, [human('h1')])
  await new Promise(resolve => setTimeout(resolve, 65))
  assert.equal(cancelled?.kind, 'hook', 'DSH cancel accepts its closed cause union, not an Error object')
  assert.match(cancelled?.reason ?? '', /时长预算/)
  e.controls.stop()
})

test('hot reload restores the persisted task deadline for an already running tool', async () => {
  const e = environment({ normal: { maxMs: 150 } }), a = e.agent('dev')
  let cancelled
  a.cancel = reason => { cancelled = reason }
  await e.step(a, [human('h1')])
  e.controls.stop()
  const reloaded = installRuntimeControls(e.ctx, { budgets: e.budgets })
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(cancelled?.kind, 'hook')
    assert.match(cancelled?.reason ?? '', /时长预算/)
  } finally { reloaded.stop() }
})

test('unreadable persisted budgets install a blocking guard on a successfully active plugin', async () => {
  const e = environment(), a = e.agent('dev')
  assert.equal(typeof installBudgetFailure, 'function')
  const failure = installBudgetFailure(e.ctx, new Error('budget file is corrupt'))
  let dispatched = false
  await assert.rejects(e.request(a, () => { dispatched = true; return usage() }), /budget file is corrupt/)
  assert.equal(dispatched, false)
  assert.equal(failure.status().blocked, true)
  failure.stop(); e.controls.stop()
})

test('external native sessions bypass every scoped budget hook and failure guard', async () => {
  const e = environment({ appliesTo: agent => agent.id.startsWith('session-butler-reminder-') })
  const external = e.agent('zotero'), child = e.agent('zotero-child', external)
  for (const agent of [external, child]) {
    await e.step(agent, [human('outside')])
    assert.equal(e.budgets.status(agent.id), undefined)
    const config = { maxTokens: 256000 }
    assert.equal(await e.dispatch('agent/request', [{ agent }], () => config), config)
    const result = { kind: 'allow', content: [{ type: 'text', text: 'native failure' }] }
    assert.equal(await e.dispatch('tools/post-execute', [{ agent, name: 'native' }, { isError: true }], () => result), result)
    await e.request(agent, () => usage())
    assert.equal(e.budgets.status(agent.id), undefined)
  }
  const failure = installBudgetFailure(e.ctx, Error('unavailable'), { appliesTo: agent => agent.id.startsWith('session-butler-reminder-') })
  await e.request(external, () => usage())
  await assert.rejects(e.request(e.agent('session-butler-reminder-scoped'), () => usage()), /unavailable/)
  failure.stop(); e.controls.stop()
})

test('shared compaction uses invocation receivers for managed and external concurrent agents', async () => {
  const e = environment({ appliesTo: agent => agent.id.startsWith('session-butler-reminder-') })
  const managed = e.agent('session-butler-reminder-shared'), external = e.agent('zotero-shared')
  const service = managed.ctx.get('compaction'), shared = service.config
  service.summarize = async function () { await Promise.resolve(); return { config: this.config, ctx: this.ctx } }
  service.ctx = { marker: 'native' }
  service.compactIfNeeded = async function (agent) {
    await Promise.resolve()
    const summary = await this.summarize({}, agent)
    return { config: this.config, summary }
  }
  external.isolatedCompaction = service
  await e.step(managed, [{ id: 'schedule', source: { kind: 'schedule' } }])
  await e.step(external, [human('native')])
  assert.equal(service.config, shared)
  const [a, b] = await Promise.all([service.compactIfNeeded(managed), service.compactIfNeeded(external)])
  assert.equal(a.config.modelPolicies[0].thresholdRatio, .008)
  assert.equal(a.summary.config.modelPolicies[0].maxTokens, 1024)
  assert.equal(b.config, shared)
  assert.equal(b.summary.config, shared)
  assert.equal(service.config, shared)
  e.controls.stop()
})

test('two managed agents sharing a native compactor keep independent policies across awaits', async () => {
  const e = environment({ appliesTo: agent => agent.id.startsWith('session-butler-reminder-') })
  const first = e.agent('session-butler-reminder-first'), second = e.agent('session-butler-reminder-second')
  second.session.requestContext = () => ({ provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 16000 })
  const service = first.ctx.get('compaction'), baseline = service.config
  service.summarize = async function () { await Promise.resolve(); return this.config }
  service.compactIfNeeded = async function (agent) {
    const policy = this.config
    await Promise.resolve()
    const summary = await this.summarize({}, agent)
    assert.equal(this.config, policy)
    return { policy, summary }
  }
  second.isolatedCompaction = service
  for (const agent of [first, second]) await e.step(agent, [{ id: agent.id, source: { kind: 'schedule' } }])
  const [a, b] = await Promise.all([service.compactIfNeeded(first), service.compactIfNeeded(second)])
  assert.equal(a.policy.modelPolicies[0].thresholdRatio, .008)
  assert.equal(b.policy.modelPolicies[0].thresholdRatio, .5)
  assert.equal(a.summary.modelPolicies[0].thresholdRatio, .008)
  assert.equal(b.summary.modelPolicies[0].thresholdRatio, .5)
  assert.equal(service.config, baseline)
  assert.equal(e.controls.status().compactionPolicies.length, 2)
  e.controls.stop()
})
