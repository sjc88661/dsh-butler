import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { TaskBudgets } from '../src/host/budget.ts'
import { installRuntimeControls } from '../src/host/runtime-controls.ts'
const { installToolLoading } = await import('../src/host/tool-loading.ts').catch(() => ({}))
const recorded = JSON.parse(readFileSync(new URL('./fixtures/tools-251.json', import.meta.url), 'utf8'))
const target = recorded.find(tool => tool.name.startsWith('mcp__') && /decompil/i.test(tool.name))
assert.ok(target, 'recorded tool fixture must contain a real deferred capability')

test('native final-answer planning cannot be undone by discovery fallback or PTC mode', async () => {
  for (const mode of ['native', 'ptc']) {
    const e = environment(), a = e.agent(`final-${mode}`); a.mode = mode
    const assembly = { tools: [], sections: [], contexts: [{ name: 'butler:budget-final', text: 'Final answer only' }] }
    const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
    assert.deepEqual(result.tools, [])
    assert.ok(!result.contexts.some(row => row.name === 'butler:tool-loading'), 'Finalization is not a discovery service failure')
    assert.equal(e.loading.status().scopes[0].mode, 'final-answer')
    e.loading.stop()
  }
})

test('final-answer prompt removes action-only instructions but retains identity, evidence and permissions', async () => {
  const e = environment(), a = e.agent('final-prompt')
  const keep = [{ name: 'butler:identity', text: 'Identity' }, { name: 'butler:evidence', text: 'Do not claim unexecuted actions' }, { name: 'permission', text: 'Native permissions' }, { name: 'butler:profile', text: 'User preferences' }]
  const assembly = { tools: [], contexts: [{ name: 'butler:budget-final', text: 'Final answer only' }], sections: [...keep,
    { name: 'butler:duty', text: 'First use overview' }, { name: 'butler:packs', text: 'Open a task and write notes' },
    { name: 'butler:tools', text: '# 你的手（butler_* 工具）\n- `butler_task`：open' }, { name: 'tool:read', text: 'Read files' }] }
  const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
  for (const section of keep) assert.deepEqual(result.sections.find(s => s.name === section.name), section)
  for (const name of ['butler:duty', 'butler:packs', 'butler:tools', 'tool:read']) assert.ok(!result.sections.some(s => s.name === name), `final answer must not advertise unavailable actions: ${name}`)
  assert.ok(result.sections.some(s => s.name === 'butler:final-answer' && s.text))
  assert.deepEqual(assembly.sections.slice(0, keep.length), keep, 'source prompt stays intact for the next tool-enabled turn')
})

function environment(options = {}) {
  assert.equal(typeof installToolLoading, 'function', 'on-demand discovery must filter the actual prompt assembly')
  const hooks = new Map(), registrations = new Map(), agents = []
  const tools = {
    register(tool) { if (options.failRegistration) throw new Error('fixture registration unavailable'); registrations.set(tool.name, tool); return () => registrations.delete(tool.name) },
    get(name, agent) { if (agent?.hidden?.has(name)) return undefined; if (name === 'butler_tools' && agent?.shadowDiscovery) return agent.shadowDiscovery; return registrations.get(name) ?? recorded.find(t => t.name === name) },
    schemas: agent => [...recorded.filter(tool => !agent?.hidden?.has(tool.name)), ...registrations.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    modeFor: agent => agent?.mode ?? 'native',
  }
  const ctx = {
    get: name => name === 'tools' ? tools : name === 'agents' ? { list: () => agents, isOwnedBy: (id, parent) => agents.some(a => a.id === id && a.parent === parent) }
      : name === 'agentPresets' ? { serviceFor: () => options.compactor }
      : name === 'systemPrompt' ? { assemble: context => assemble(context.agent) } : undefined,
    on(name, fn, settings) { const list = hooks.get(name) ?? []; settings?.prepend ? list.unshift(fn) : list.push(fn); hooks.set(name, list); return () => list.splice(list.indexOf(fn), 1) },
    logger: { warn() {} },
  }
  const controls = options.runtimeControls ? installRuntimeControls(ctx, { budgets: new TaskBudgets() }) : undefined
  const loading = installToolLoading(ctx, options)
  function agent(id, parent) { const events = []; const a = { id, parent, events, session: { id, snapshotEvents: () => events }, ctx: { get: name => name === 'tools' ? tools : undefined } }; agents.push(a); return a }
  function dispatch(name, args, terminal) {
    const queue = [...(hooks.get(name) ?? []), terminal]
    const next = () => queue.shift()(...args, next)
    return next()
  }
  const assemble = a => dispatch('system-prompt/assemble', [{ tools: tools.schemas(a), sections: [], contexts: [], variables: {} }, { agent: a, scope: a }], () => ({ tools: tools.schemas(a), sections: [], contexts: [{ name: 'permission', text: 'original policy' }], variables: {} }))
  const claim = (a, id, kind = 'user') => {
    if (!id) return
    const message = { id, source: { kind } }
    a.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
    for (const fn of hooks.get('agent/inbox/claimed') ?? []) fn({ agent: a, message, turn: 0 })
  }
  // ReactLoopAgent.preStep claims input, assembles the prompt, then runs pre-step.
  const step = async (a, id, kind = 'user') => {
    claim(a, id, kind)
    const assembly = await assemble(a)
    const decision = await dispatch('agent/pre-step', [{ agent: a, messages: id ? [{ id, source: { kind } }] : [] }], () => ({ kind: 'enter', messages: [] }))
    return { assembly, decision }
  }
  const call = (a, args) => registrations.get('butler_tools').execute(args, { agent: a, id: 'discovery-call' })
  return { ctx, tools, controls, loading, agent, assemble, claim, step, call, registrations, dispatch, hooks }
}

function legacySession(agent, headerTools = recorded, historyTools = recorded, updates = []) {
  let header = { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256000 }, adapterDefaults: { maxTokens: true }, tools: headerTools }
  let history = { tools: historyTools, updates }
  const snapshots = [], originalTools = JSON.stringify(recorded)
  Object.assign(agent.session, { requestHeader: () => header, toolHistory: () => history,
    append(type, data) { assert.equal(type, 'request/header'); snapshots.push(structuredClone(data)); header = data.header
      if (data.reason === 'series' || data.startsSeries) history = { tools: data.header.tools ?? [], updates: [] }
    } })
  return { snapshots, originalTools }
}

test('empty persisted tool baseline starts one native series when tools become available', async () => {
  const e = environment(), a = e.agent('empty-tool-baseline')
  const fixture = legacySession(a, [], [])
  const prior = structuredClone(a.session.requestHeader())
  const oldHistory = structuredClone(a.session.toolHistory())
  const result = await e.assemble(a)
  assert.ok(result.tools.length > 0, 'fixture must expose available base tools')
  assert.ok(a.session.toolHistory().tools.some(tool => tool.deferLoading !== true), 'native history needs an initial non-deferred tool')
  assert.equal(fixture.snapshots.length, 1)
  assert.equal(fixture.snapshots[0].reason, 'series')
  assert.deepEqual(a.session.requestHeader().config, prior.config)
  assert.deepEqual(a.session.requestHeader().adapterDefaults, prior.adapterDefaults)
  assert.deepEqual(prior.tools, [])
  assert.deepEqual(oldHistory, { tools: [], updates: [] })
  assert.equal(JSON.stringify(recorded), fixture.originalTools)
  await e.assemble(a)
  assert.equal(fixture.snapshots.length, 1, 'repeated assembly must not start another series')
})

test('empty persisted tool baseline fails closed when a new series cannot be persisted', async () => {
  const e = environment(), a = e.agent('empty-tool-baseline-write-failed')
  legacySession(a, [], [])
  a.session.append = () => { throw Error('fixture durable baseline failed') }
  await assert.rejects(e.assemble(a), /durable baseline failed/)
  assert.deepEqual(a.session.toolHistory(), { tools: [], updates: [] })
})

test('PTC resumes tools after an empty baseline without exposing the native registry', async () => {
  const e = environment(), a = e.agent('empty-ptc-baseline'); a.mode = 'ptc'
  const fixture = legacySession(a, [], [])
  const ptcTools = [{ name: 'run_code', description: 'Native PTC', parameters: { type: 'object' } }]
  const assembly = { tools: ptcTools, sections: [], contexts: [] }
  const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
  assert.deepEqual(result.tools, ptcTools)
  assert.deepEqual(a.session.toolHistory(), { tools: ptcTools, updates: [] })
  assert.equal(fixture.snapshots.length, 1)
  assert.equal(e.loading.status().scopes[0].mode, 'ptc-passthrough')
})

test('baseline repair rejects explicitly deferred-only current tools instead of granting availability', async () => {
  const e = environment(), a = e.agent('deferred-only-ptc'); a.mode = 'ptc'
  const fixture = legacySession(a, [], [])
  const assembly = { tools: [{ name: 'run_code', description: 'PTC', parameters: {}, deferLoading: true }], sections: [], contexts: [] }
  await assert.rejects(e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly), /BUTLER_TOOL_BASELINE/)
  assert.equal(fixture.snapshots.length, 0)
  assert.equal(assembly.tools[0].deferLoading, true)
})

test('PTC mode changes retain an immediate declaration after addition-only filtering', async () => {
  const e = environment(), a = e.agent('disjoint-ptc-baseline'); a.mode = 'ptc'
  const nativeTools = [recorded.find(tool => tool.name === 'read')]
  const fixture = legacySession(a, nativeTools, nativeTools)
  const ptcTools = [{ name: 'run_code', description: 'Native PTC', parameters: { type: 'object' } }]
  const assembly = { tools: ptcTools, sections: [], contexts: [] }
  await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
  assert.ok(a.session.toolHistory().tools.some(tool => tool.deferLoading !== true && tool.name === 'run_code'), 'the native wire route removes inactive baseline declarations')
  assert.equal(fixture.snapshots.length, 1)
  await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
  assert.equal(fixture.snapshots.length, 1)
})

test('final-answer clears an invalid addition-only history while leaving ordinary dialogue intact', async () => {
  for (const mode of ['native', 'ptc']) {
    const e = environment(), a = e.agent(`invalid-final-${mode}`); a.mode = mode
    const update = { messageId: 'restored-tools', additions: recorded.slice(0, 2) }
    const fixture = legacySession(a, recorded.slice(0, 2), [], [update])
    const dialogue = [{ type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '到11-1，每次学1个小时左右' }] } }]
    a.events.push(...structuredClone(dialogue))
    const assembly = { tools: [], sections: [], contexts: [{ name: 'butler:budget-final', text: 'Final answer only' }] }
    const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
    assert.deepEqual(result.tools, [])
    assert.deepEqual(a.session.toolHistory(), { tools: [], updates: [] })
    assert.deepEqual(a.events, dialogue)
    assert.equal(fixture.snapshots.length, 1)
    await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
    assert.equal(fixture.snapshots.length, 1)
  }
})

test('unmanaged native and PTC sessions preserve assembly, history, compactor and deny discovery', async () => {
  const compactor = { compactNow() { return 'native' } }, original = compactor.compactNow
  const e = environment({ appliesTo: agent => agent.id === 'managed', compactor })
  for (const mode of ['native', 'ptc']) {
    const a = e.agent(`zotero-${mode}`); a.mode = mode
    const fixture = legacySession(a)
    const schemas = e.tools.schemas(a), assembly = { tools: schemas, sections: [], contexts: [] }
    const result = await e.dispatch('system-prompt/assemble', [assembly, { agent: a }], () => assembly)
    assert.equal(result, assembly)
    assert.equal(result.tools, schemas)
    assert.equal(fixture.snapshots.length, 0)
    assert.equal((await e.call(a, { action: 'search', query: '文献' })).ok, false)
  }
  assert.equal(compactor.compactNow, original)
  const managed = e.agent('managed')
  assert.ok((await e.assemble(managed)).tools.length < recorded.length)
  assert.notEqual(compactor.compactNow, original, 'managed scope may wrap a shared compactor')
  const outsider = e.agent('zotero-shared-compactor'), fixture = legacySession(outsider)
  assert.equal(compactor.compactNow(outsider), 'native')
  assert.equal(fixture.snapshots.length, 0, 'shared wrapper must not modify external history')
})

test('legacy251 header and history are rebased before pressure checks, preserving native config and registries', async () => {
  const e = environment(), a = e.agent('legacy-header'), fixture = legacySession(a)
  const prior = structuredClone(a.session.requestHeader())
  const result = await e.assemble(a)
  assert.equal(a.session.requestHeader().tools.length, result.tools.length, 'pressure must see the bounded header')
  assert.deepEqual(a.session.requestHeader().tools, result.tools, 'pressure measurement must see the small catalog before pre-step')
  assert.deepEqual(a.session.toolHistory(), { tools: result.tools, updates: [] })
  assert.deepEqual(a.session.requestHeader().config, prior.config)
  assert.deepEqual(a.session.requestHeader().adapterDefaults, prior.adapterDefaults)
  assert.equal(fixture.snapshots.length, 1); assert.equal(fixture.snapshots[0].reason, 'series')
  assert.equal(JSON.stringify(recorded), fixture.originalTools, 'old native schemas must not be mutated')
  assert.ok(e.tools.get(target.name, a), 'deferred capabilities remain registered')
  await e.assemble(a); assert.equal(fixture.snapshots.length, 1, 'repeated assembly must not flood header events')
})

test('a bounded active header cannot retain the251-tool historical baseline', async () => {
  const e = environment(), a = e.agent('legacy-history')
  const bounded = (await e.assemble(a)).tools
  const fixture = legacySession(a, bounded, recorded)
  await e.assemble(a)
  assert.equal(a.session.toolHistory().tools.length, bounded.length)
  assert.equal(fixture.snapshots.length, 1)
})

test('legacy rebasing keeps explicitly loaded native schemas and reminder read-only restrictions', async () => {
  const e = environment(), a = e.agent('legacy-loaded')
  assert.equal((await e.call(a, { action: 'load', names: [target.name] })).ok, true)
  legacySession(a)
  const assembled = await e.assemble(a)
  assert.deepEqual(assembled.tools.find(tool => tool.name === target.name).parameters, target.parameters)
  assert.equal(a.session.requestHeader().tools.length, assembled.tools.length)
  assert.deepEqual(a.session.requestHeader().tools, assembled.tools)
  const reminder = e.agent('session-butler-reminder-legacy'); legacySession(reminder)
  await e.assemble(reminder)
  assert.deepEqual(reminder.session.requestHeader().tools.map(tool => tool.name), ['butler_tools'])
  assert.equal((await e.call(reminder, { action: 'load', names: ['pwsh'] })).ok, false)
})

test('PTC and already bounded tool headers retain native behavior', async () => {
  const e = environment(), a = e.agent('bounded-header')
  const bounded = (await e.assemble(a)).tools, normal = legacySession(a, bounded, bounded)
  await e.assemble(a); assert.equal(normal.snapshots.length, 0)
  const ptc = e.agent('legacy-ptc'); ptc.mode = 'ptc'
  const untouched = legacySession(ptc)
  await e.assemble(ptc); assert.equal(untouched.snapshots.length, 0)
})

test('header persistence failure stops assembly instead of sending the old catalog', async () => {
  const e = environment(), a = e.agent('header-write-failed'); legacySession(a)
  a.session.append = () => { throw Error('fixture durable header failed') }
  await assert.rejects(e.assemble(a), /durable header failed/)
  assert.equal(a.session.requestHeader().tools.length, recorded.length)
})

test('legacy schema byte pressure is rebased even with a small tool count, and empty schemas are canonically omitted', async () => {
  const e = environment(), large = e.agent('legacy-large-schema')
  const huge = [{ ...recorded[0], description: 'x'.repeat(80000) }]
  legacySession(large, huge, huge)
  await e.assemble(large)
  assert.ok(Buffer.byteLength(JSON.stringify(large.session.requestHeader().tools)) < 16000)
  const empty = e.agent('empty-native-scope')
  empty.hidden = new Set([...recorded.map(tool => tool.name), 'butler_tools'])
  legacySession(empty)
  assert.equal((await e.assemble(empty)).tools.length, 0)
  assert.equal(Object.hasOwn(empty.session.requestHeader(), 'tools'), false, 'native headers omit an empty tools property')
})

test('automatic and manual compaction refresh legacy headers before reading pressure, retaining native service context', async () => {
  const visited = [], nativeCtx = { native: true }
  const compactor = { ctx: nativeCtx,
    async compactIfNeeded(agent, trigger) { assert.equal(this.ctx, nativeCtx); visited.push(trigger); assert.ok(agent.session.requestHeader().tools.length < 20); assert.ok(agent.session.toolHistory().tools.length < 20); return null },
    compactNow(agent) { assert.equal(this.ctx, nativeCtx); assert.ok(agent.session.requestHeader().tools.length < 20); return 'native-manual-result' } }
  const original = compactor.compactIfNeeded, e = environment({ compactor }), a = e.agent('direct-compaction'); legacySession(a)
  for (const fn of e.hooks.get('agent/created') ?? []) fn({ agent: a })
  assert.equal(await compactor.compactIfNeeded(a, 'pressure'), null)
  legacySession(a)
  assert.equal(await compactor.compactNow(a), 'native-manual-result')
  assert.deepEqual(visited, ['pressure'])
  e.loading.stop(); assert.equal(compactor.compactIfNeeded, original)
})

test('the recorded251-tool catalog is reduced to a small native first-request catalog', async () => {
  const e = environment(), a = e.agent('normal')
  const result = await e.assemble(a)
  assert.ok(result.tools.some(tool => tool.name === 'butler_tools'))
  assert.ok(!result.tools.some(tool => tool.name === 'pwsh'))
  assert.ok(!result.tools.some(tool => tool.name.startsWith('mcp__')))
  assert.ok(result.tools.length <= 11)
  assert.ok(Buffer.byteLength(JSON.stringify(result.tools)) < 16000)
  assert.ok(result.contexts.some(context => context.text === 'original policy'))
  assert.equal(e.loading.status().enabled, true)
})

test('managed base is four tools and an explicitly loaded operation remains executable', async () => {
  const e = environment(), a = e.agent('base-four')
  const schemas = e.tools.schemas
  e.tools.schemas = agent => [...schemas(agent), ...['butler_skills', 'ask_user_question'].filter(name => !schemas(agent).some(tool => tool.name === name)).map(name => ({ name, description: name, parameters: {} }))]
  const first = await e.assemble(a)
  assert.deepEqual(first.tools.map(tool => tool.name).sort(), ['ask_user_question', 'butler_overview', 'butler_skills', 'butler_tools'])
  assert.equal((await e.call(a, { action: 'load', names: ['pwsh'] })).ok, true)
  assert.ok((await e.assemble(a)).tools.some(tool => tool.name === 'pwsh'))
  const decision = await e.dispatch('tools/pre-execute', [{ agent: a, name: 'pwsh' }], () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
})

test('shared compactor wrapper preserves the invocation receiver', async () => {
  const compactor = { compactNow() { return this.marker } }, e = environment({ compactor }), a = e.agent('receiver')
  legacySession(a)
  for (const fn of e.hooks.get('agent/created') ?? []) fn({ agent: a })
  assert.equal(await compactor.compactNow.call({ marker: 'borrowed' }, a), 'borrowed')
})

test('registration failure exposes bounded core capabilities and does not instruct a missing discovery call', async () => {
  const e = environment({ failRegistration: true }), a = e.agent('discovery-failed')
  const result = await e.assemble(a)
  assert.ok(!result.tools.some(t => t.name === 'butler_tools'))
  assert.ok(result.tools.some(t => t.name === 'butler_task'))
  assert.ok(!result.tools.some(t => t.name.startsWith('mcp__')))
  assert.ok(result.tools.length < 24)
  assert.ok(!result.contexts.some(c => c.text.includes('butler_tools search')))
  assert.ok(result.contexts.some(c => /不可用|unavailable/.test(c.text)))
})

test('a hidden or shadowed scoped discovery is respected without silently removing all core work', async () => {
  for (const mode of ['hidden', 'shadow']) {
    const e = environment(), a = e.agent(`discovery-${mode}`)
    if (mode === 'hidden') a.hidden = new Set(['butler_tools', 'butler_note'])
    else a.shadowDiscovery = { name: 'butler_tools' }
    const result = await e.assemble(a)
    assert.ok(result.tools.some(t => t.name === 'butler_task'))
    if (mode === 'hidden') assert.ok(!result.tools.some(t => t.name === 'butler_note'))
    assert.ok(!result.contexts.some(c => c.text.includes('butler_tools search')))
    assert.ok(!result.tools.some(t => t.name.startsWith('mcp__')))
  }
})

test('search returns bounded short summaries and does not load all matching schemas', async () => {
  const e = environment(), a = e.agent('normal')
  const result = await e.call(a, { action: 'search', query: '反编译 decompile', limit: 3 })
  assert.equal(result.ok, true)
  assert.ok(result.matches.length > 0 && result.matches.length <= 3)
  assert.ok(result.matches.some(tool => /decompil/i.test(tool.name)))
  assert.ok(result.matches.every(tool => !('parameters' in tool) && tool.description.length <= 160))
  assert.ok(!(await e.assemble(a)).tools.some(tool => tool.name === target.name))
})

test('load exposes the original native schema on the next request without executing the target', async () => {
  const e = environment(), a = e.agent('normal')
  assert.equal((await e.call(a, { action: 'load', names: [target.name] })).ok, true)
  assert.deepEqual((await e.assemble(a)).tools.find(tool => tool.name === target.name).parameters, target.parameters)
  assert.ok(!(await e.assemble(e.agent('other'))).tools.some(tool => tool.name === target.name))
})

test('automatic continuation preserves selection and a fresh human message resets it', async () => {
  const e = environment(), a = e.agent('normal')
  await e.step(a, 'human-1'); await e.call(a, { action: 'load', names: [target.name] })
  await e.step(a)
  assert.ok((await e.assemble(a)).tools.some(tool => tool.name === target.name))
  const fresh = await e.step(a, 'human-2')
  assert.ok(!fresh.assembly.tools.some(tool => tool.name === target.name), 'the first request after claiming new input must release previous selections')
})

test('a historical butler call must load its exact schema before a later request can execute it', async () => {
  const e = environment(), a = e.agent('historical-butler-call')
  const pre = (name, decision = { kind: 'allow' }) => e.dispatch('tools/pre-execute', [{ agent: a, name,
    arguments: { action: 'write', content: 'Old argument shape' }, callId: 'historical-call' }], () => decision)
  await e.step(a, 'human-1')
  assert.equal((await e.call(a, { action: 'load', names: ['butler_note'] })).ok, true)
  assert.ok((await e.assemble(a)).tools.some(tool => tool.name === 'butler_note'))
  const fresh = await e.step(a, 'human-2')
  assert.ok(!fresh.assembly.tools.some(tool => tool.name === 'butler_note'))
  const denied = await pre('butler_note')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /butler_tools.*load.*butler_note/)
  assert.match(denied.reason, /下一次.*schema|下一次.*参数/)
  assert.ok(!(await e.assemble(a)).tools.some(tool => tool.name === 'butler_note'), 'the refusal must not auto-load a schema')
  assert.equal((await e.call(a, { action: 'load', names: ['butler_note'] })).ok, true)
  assert.equal((await pre('butler_note')).kind, 'deny', 'load does not expose parameters until the next prompt assembly')
  const loaded = await e.assemble(a)
  assert.deepEqual(loaded.tools.find(tool => tool.name === 'butler_note').parameters, recorded.find(tool => tool.name === 'butler_note').parameters)
  assert.equal((await pre('butler_note')).kind, 'allow')
  await e.step(a, 'human-3')
  const nativeDeny = { kind: 'deny', reason: 'native permission refused' }, nativeAsk = { kind: 'ask', reason: 'native permission required' }
  assert.deepEqual(await pre('butler_note', nativeDeny), nativeDeny)
  assert.deepEqual(await pre('butler_note', nativeAsk), nativeAsk)
  e.loading.stop()
})

test('the schema guard preserves native base, PTC and degraded modes and reminder write isolation', async () => {
  const e = environment(), normal = e.agent('guard-exemptions')
  await e.assemble(normal)
  const pre = (env, agent, name) => env.dispatch('tools/pre-execute', [{ agent, name, arguments: {}, callId: name }], () => ({ kind: 'allow' }))
  assert.equal((await pre(e, normal, 'read')).kind, 'allow')
  assert.equal((await pre(e, normal, 'butler_overview')).kind, 'allow')
  normal.mode = 'ptc'
  assert.equal((await pre(e, normal, 'butler_note')).kind, 'allow')
  e.loading.stop()
  const degraded = environment({ failRegistration: true }), unfiltered = degraded.agent('guard-degraded')
  await degraded.assemble(unfiltered)
  assert.equal((await pre(degraded, unfiltered, 'butler_note')).kind, 'allow')
  degraded.loading.stop()
  const isolated = environment({ runtimeControls: true }), reminder = isolated.agent('session-butler-reminder-guard')
  try {
    await isolated.step(reminder, 'occurrence', 'schedule')
    assert.equal((await isolated.call(reminder, { action: 'load', names: ['butler_note'] })).ok, false)
    const refusal = await pre(isolated, reminder, 'butler_note')
    assert.equal(refusal.kind, 'deny')
    assert.match(refusal.reason, /REMINDER_ISOLATION/)
  } finally { isolated.loading.stop(); isolated.controls.stop() }
})

test('unknown or oversized definitions fail atomically and never fall back to all tools', async () => {
  const e = environment({ maxExtraBytes: 100 }), a = e.agent('normal')
  assert.equal((await e.call(a, { action: 'load', names: [target.name, 'missing-tool'] })).ok, false)
  assert.equal((await e.call(a, { action: 'load', names: [target.name] })).ok, false)
  assert.ok(!(await e.assemble(a)).tools.some(tool => tool.name === target.name))
  assert.equal((await e.call(a, { action: 'load', names: recorded.filter(tool => tool.name.startsWith('mcp__')).slice(0, 5).map(tool => tool.name) })).ok, false)
})

test('search respects the native scope visibility instead of using the global catalog', async () => {
  const e = environment(), a = e.agent('restricted')
  a.hidden = new Set([target.name])
  assert.ok(!(await e.call(a, { action: 'search', query: target.name })).matches.some(tool => tool.name === target.name))
  assert.equal((await e.call(a, { action: 'load', names: [target.name] })).ok, false)
})

test('reminders start with discovery only and cannot discover or load development capabilities', async () => {
  const e = environment(), a = e.agent('session-butler-reminder-test')
  await e.step(a, 'occurrence-1', 'schedule')
  assert.deepEqual((await e.assemble(a)).tools.map(tool => tool.name), ['butler_tools'])
  assert.equal((await e.call(a, { action: 'load', names: ['pwsh'] })).ok, false)
  assert.ok(!(await e.call(a, { action: 'search', query: 'plugin' })).matches.some(tool => tool.name.startsWith('dev_')))
  assert.equal((await e.call(a, { action: 'load', names: ['read'] })).ok, true)
  assert.deepEqual((await e.assemble(a)).tools.map(tool => tool.name).sort(), ['butler_tools', 'read'])
  const fresh = await e.step(a, 'occurrence-2', 'schedule')
  assert.deepEqual(fresh.assembly.tools.map(tool => tool.name), ['butler_tools'])
})

test('a reminder descendant retains the read-only discovery boundary', async () => {
  const e = environment(), root = e.agent('session-butler-reminder-parent'), child = e.agent('child', root)
  assert.deepEqual((await e.assemble(child)).tools.map(tool => tool.name), ['butler_tools'])
  assert.equal((await e.call(child, { action: 'load', names: ['pwsh'] })).ok, false)
  assert.equal((await e.call(child, { action: 'load', names: ['read'] })).ok, true)
  assert.deepEqual((await e.assemble(root)).tools.map(tool => tool.name), ['butler_tools'])
})

test('the production reminder guards preserve discovery while denying executable tools', async () => {
  const e = environment({ runtimeControls: true }), a = e.agent('session-butler-reminder-integrated')
  try {
    await e.step(a, 'occurrence-1', 'schedule')
    assert.deepEqual((await e.assemble(a)).tools.map(tool => tool.name), ['butler_tools'])
    const pre = name => e.dispatch('tools/pre-execute', [{ agent: a, name, arguments: {}, id: name }], () => ({ kind: 'allow' }))
    assert.equal((await pre('butler_tools')).kind, 'allow')
    assert.equal((await e.call(a, { action: 'load', names: ['read'] })).ok, true)
    assert.deepEqual((await e.assemble(a)).tools.map(tool => tool.name).sort(), ['butler_tools', 'read'])
    assert.equal((await pre('read')).kind, 'allow')
    assert.equal((await pre('pwsh')).kind, 'deny')
  } finally { e.controls.stop() }
})

test('a loaded selection cannot grow past its total extra-tool limit', async () => {
  const e = environment({ maxExtraTools: 2 }), a = e.agent('normal')
  const names = recorded.filter(tool => tool.name.startsWith('mcp__')).slice(0, 3).map(tool => tool.name)
  assert.equal((await e.call(a, { action: 'load', names: names.slice(0, 2) })).ok, true)
  assert.equal((await e.call(a, { action: 'load', names: names.slice(2) })).ok, false)
  const result = await e.assemble(a)
  assert.ok(result.tools.some(tool => tool.name === names[0]))
  assert.ok(result.tools.some(tool => tool.name === names[1]))
  assert.ok(!result.tools.some(tool => tool.name === names[2]))
})

test('unload releases current selection without changing the underlying tool registry', async () => {
  const e = environment(), a = e.agent('normal')
  await e.call(a, { action: 'load', names: [target.name] })
  assert.equal((await e.call(a, { action: 'unload', names: [target.name] })).ok, true)
  assert.ok(!(await e.assemble(a)).tools.some(tool => tool.name === target.name))
  assert.ok(e.tools.schemas(a).some(tool => tool.name === target.name))
})

test('PTC retains its original transport presentation', async () => {
  const e = environment(), a = e.agent('ptc')
  a.mode = 'ptc'
  const result = await e.assemble(a)
  assert.deepEqual(result.tools, e.tools.schemas(a))
})

test('reload preserves names and corrupted state retains only the base catalog', async () => {
  const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'tool-loading-'))
  try {
    const file = join(dir, 'loads.json')
    const old = environment({ file }), a = old.agent('normal')
    await old.step(a, 'human-1'); await old.call(a, { action: 'load', names: [target.name] })
    old.loading.stop()
    const current = environment({ file }), same = current.agent('normal')
    await current.step(same)
    assert.ok((await current.assemble(same)).tools.some(tool => tool.name === target.name))
    current.claim(same, 'human-1')
    assert.ok((await current.assemble(same)).tools.some(tool => tool.name === target.name), 'replayed input identity must not reset restored selection')
    const fresh = await current.step(same, 'human-2')
    assert.ok(!fresh.assembly.tools.some(tool => tool.name === target.name))
    writeFileSync(file, '{broken')
    const broken = environment({ file }), b = broken.agent('normal')
    assert.ok(!(await broken.assemble(b)).tools.some(tool => tool.name === target.name))
    assert.equal((await broken.call(b, { action: 'load', names: [target.name] })).ok, false)
    assert.ok(broken.loading.status().error)
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(base) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed reset followed by reload cannot revive choices from the previous persisted task', async t => {
  const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'tool-reset-failure-'))
  let renameMock
  try {
    const file = join(dir, 'loads.json')
    let persistedTaskOrigin = 'user:human-1'
    const options = { file, originFor: () => persistedTaskOrigin }
    const old = environment(options), a = old.agent('normal')
    old.claim(a, 'human-1')
    assert.equal((await old.call(a, { action: 'load', names: [target.name] })).ok, true)
    renameMock = t.mock.method(fs, 'renameSync', () => { throw new Error('simulated atomic replacement failure') })
    syncBuiltinESMExports()
    old.claim(a, 'human-2')
    renameMock.mock.restore(); syncBuiltinESMExports()
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).scopes.normal.names.includes(target.name), 'The valid old file must still exist')
    assert.ok(!(await old.assemble(a)).tools.some(tool => tool.name === target.name))
    // Production pre-step persists the new task independently before model dispatch.
    persistedTaskOrigin = 'user:human-2'
    old.loading.stop()
    const reloaded = environment(options), same = reloaded.agent('normal')
    const continued = await reloaded.step(same)
    assert.ok(!continued.assembly.tools.some(tool => tool.name === target.name))
    assert.equal((await reloaded.call(same, { action: 'load', names: [target.name] })).ok, true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).scopes.normal.origin, persistedTaskOrigin)
  } finally {
    renameMock?.mock.restore(); syncBuiltinESMExports()
    assert.ok(realpathSync(dir).startsWith(realpathSync(base) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('child reload recovers its own durable claimed origin without a separate child budget', async t => {
  const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'child-tool-reset-'))
  let renameMock
  try {
    const file = join(dir, 'loads.json')
    const old = environment({ file }), root = old.agent('root'), child = old.agent('child', root)
    old.claim(child, 'child-human-1')
    assert.equal((await old.call(child, { action: 'load', names: [target.name] })).ok, true)
    renameMock = t.mock.method(fs, 'renameSync', () => { throw new Error('simulated atomic replacement failure') })
    syncBuiltinESMExports()
    old.claim(child, 'child-human-2')
    renameMock.mock.restore(); syncBuiltinESMExports()
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).scopes.child.names.includes(target.name))
    old.loading.stop()
    const reloaded = environment({ file }), newRoot = reloaded.agent('root'), same = reloaded.agent('child', newRoot)
    same.events.push(...child.events)
    assert.ok(!(await reloaded.step(same)).assembly.tools.some(tool => tool.name === target.name))
    assert.equal((await reloaded.call(same, { action: 'load', names: [target.name] })).ok, true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).scopes.child.origin, 'user:child-human-2')
    // Queued/cancelled human input is not yet the active task.
    same.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'cancelled', source: { kind: 'user' } }] } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'future', source: { kind: 'user' } }] } })
    reloaded.loading.stop()
    const stable = environment({ file }), nextChild = stable.agent('child', stable.agent('root'))
    nextChild.events.push(...same.events)
    assert.ok((await stable.assemble(nextChild)).tools.some(tool => tool.name === target.name))
  } finally {
    renameMock?.mock.restore(); syncBuiltinESMExports()
    assert.ok(realpathSync(dir).startsWith(realpathSync(base) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})
