/**
 * 试用限额层（可选服务）验收。
 *
 * 目标：plugin options.trial 启用后，在真正的模型请求路径上做按北京时间自然日的
 * 持久预留/结算/拒绝；未配置或配置不完整时显式降级（不发布服务、不展示假限额）。
 * 所有宿主交互都用合成 ctx；不联网、不发起模型请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'trial-'))
// 插件入口的 state/vault 常量在导入期读取；先指向本测试的临时目录，绝不碰真实 profile。
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { installTrial, TrialDenied, TRIAL_SERVICE_NAME } = await import('../src/host/trial.ts')
const { registerWorkspaceApi } = await import('../src/host/workspace-api.ts')

const CONFIG = {
  enabled: true,
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  maxRequests: 4,
  maxTokens: 200000,
  maxMs: 180000,
  maxOutputTokens: 1536,
  dailyRequests: 10,
  dailyTokens: 400000,
  allowedSessionIds: ['session-butler-trial'],
  allowedSourceRefs: ['dsh:research:118'],
}
const TRIAL_DAY = '2026-10-22'
const AT = Date.UTC(2026, 9, 22, 2) // 北京时间 2026-10-22 10:00

let seq = 0
const stateFile = (name) => join(home, `${seq++}-${name}.json`)

/** 合成宿主：on/provide/get 足够跑通真实安装路径。 */
function host() {
  const hooks = new Map(), services = new Map(), agents = []
  let current
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'agents') return { currentInitiator: () => current, list: () => agents }
      return services.get(name)
    },
    on(name, listener) {
      const set = hooks.get(name) ?? new Set()
      set.add(listener)
      hooks.set(name, set)
      return () => set.delete(listener)
    },
    provide(name, value) {
      if (services.has(name)) throw new Error(`duplicate service ${name}`)
      services.set(name, value)
      return () => services.delete(name)
    },
  }
  return {
    ctx, hooks, services, agents,
    setCurrent(agent) { current = agent },
    listeners(name) { return [...(hooks.get(name) ?? [])] },
  }
}

function trialAgent(id = 'session-butler-trial') {
  return { id, session: { requestContext: () => ({ contextWindow: 100000, provider: CONFIG.provider, model: CONFIG.model }) } }
}
function request(overrides = {}) {
  return {
    provider: CONFIG.provider, model: CONFIG.model, maxTokens: 20,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [], system: '', ...overrides,
  }
}
const usageChunk = (inputTokens, outputTokens) => ({ type: 'usage', usage: { inputTokens, outputTokens } })
const finishChunk = () => ({ type: 'finish', reason: { kind: 'stop' } })
const snapshotOf = (h) => h.services.get(TRIAL_SERVICE_NAME).snapshot('session-butler-trial')

async function preStep(h, agent, messageId) {
  const listeners = h.listeners('agent/pre-step')
  assert.equal(listeners.length, 1, '启用的试用层必须安装 agent/pre-step 运行窗口钩子')
  return listeners[0]({ agent, step: 1, messages: [{ id: messageId, role: 'user', source: { kind: 'user' } }] }, () => ({ kind: 'continue' }))
}
function streamRequest(h, value, chunks) {
  const listeners = h.listeners('llm/stream')
  const calls = { count: 0 }
  const drive = (index, req) => {
    if (index >= listeners.length) {
      calls.count++
      return (async function* () { for (const chunk of chunks) yield chunk })()
    }
    return listeners[index](req, () => drive(index + 1, req))
  }
  return { iterable: drive(0, value), calls }
}
async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
async function rejectionOf(value) {
  try { await value; assert.fail('试用层本应拒绝该模型请求') } catch (error) { return error }
}

test('未配置、显式禁用或配置不完整时降级：不发布服务、不安装拦截', () => {
  const cases = [
    [undefined, 'trial-not-configured'],
    [{}, 'trial-not-configured'],
    [{ enabled: false }, 'trial-disabled'],
    [{ enabled: true, provider: CONFIG.provider, model: CONFIG.model, allowedSessionIds: [] }, 'trial-config-incomplete'],
    [{ enabled: true, provider: '', model: CONFIG.model, allowedSessionIds: ['session-butler-trial'] }, 'trial-config-incomplete'],
  ]
  for (const [raw, code] of cases) {
    const h = host()
    const installation = installTrial(h.ctx, { raw, file: stateFile('idle') })
    assert.equal(installation.availability().available, false)
    assert.equal(installation.availability().code, code)
    assert.equal(h.services.has(TRIAL_SERVICE_NAME), false, '未启用时不得发布 butlerDailyTrial 服务')
    assert.equal(installation.snapshot('session-butler-trial'), undefined)
    for (const name of ['agent/pre-step', 'agent/request', 'llm/stream', 'tools/pre-execute']) {
      assert.equal(h.listeners(name).length, 0, `${name} 未启用时不应安装拦截`)
    }
    installation.stop()
  }
})

test('启用后发布只读快照：限额、允许会话与来源来自配置', () => {
  const h = host()
  const installation = installTrial(h.ctx, { raw: CONFIG, file: stateFile('snapshot'), now: () => AT })
  assert.equal(installation.availability().available, true)
  const service = h.services.get(TRIAL_SERVICE_NAME)
  assert.ok(service, '启用后必须发布 butlerDailyTrial 服务')
  const snapshot = service.snapshot('session-butler-trial')
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.sessionAllowed, true)
  assert.equal(snapshot.provider, CONFIG.provider)
  assert.equal(snapshot.model, CONFIG.model)
  assert.deepEqual(snapshot.limits, {
    maxRequests: 4, maxTokens: 200000, maxMs: 180000, maxOutputTokens: 1536, dailyRequests: 10, dailyTokens: 400000,
  })
  assert.deepEqual(snapshot.refs, [{ provider: 'dsh', sessionId: 'research', eventId: '118' }])
  assert.equal(snapshot.sourceTitles[0], 'dsh:research:118')
  assert.equal(snapshot.channel, 'unknown')
  assert.equal(snapshot.daily.requests, 0)
  assert.equal(snapshot.daily.remainingRequests, 10)
  const denied = service.snapshot('session-other')
  assert.equal(denied.sessionAllowed, false)
  assert.match(denied.reason, /不在/)
  installation.stop()
  assert.equal(h.services.has(TRIAL_SERVICE_NAME), false, '卸载后服务必须撤销')
})

test('请求前持久预留，拿到 provider usage 后结算；缺 usage 保留预留上界', async () => {
  const file = stateFile('settle'), h = host()
  const installation = installTrial(h.ctx, { raw: CONFIG, file, now: () => AT })
  const agent = trialAgent()
  h.setCurrent(agent)
  await preStep(h, agent, 'user-message-1')

  const first = streamRequest(h, request(), [usageChunk(20, 10), finishChunk()])
  assert.deepEqual(await collect(first.iterable), [usageChunk(20, 10), finishChunk()])
  assert.equal(first.calls.count, 1)
  let snapshot = snapshotOf(h)
  assert.equal(snapshot.daily.requests, 1)
  assert.equal(snapshot.daily.chargedTokens, 30, '有 usage 时按实际 input+output 结算')

  const second = streamRequest(h, request(), [usageChunk(7, 3), finishChunk()])
  await collect(second.iterable)
  snapshot = snapshotOf(h)
  assert.equal(snapshot.daily.requests, 2)
  assert.equal(snapshot.daily.chargedTokens, 40)

  const unknown = streamRequest(h, request(), [finishChunk()])
  await collect(unknown.iterable)
  snapshot = snapshotOf(h)
  assert.equal(snapshot.daily.requests, 3)
  assert.ok(snapshot.daily.chargedTokens > 40 + 500, '缺 usage 时不得按 0 结算，必须保留预留上界')

  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.days[TRIAL_DAY].requests, 3)
  assert.equal(saved.days[TRIAL_DAY].chargedTokens, snapshot.daily.chargedTokens)
  assert.deepEqual(saved.pending, {})
  installation.stop()
})

test('北京时间自然日切分：跨日重新计数，旧日额度不再占用', async () => {
  let now = Date.UTC(2026, 9, 22, 15, 59) // 北京时间 23:59
  const h = host()
  installTrial(h.ctx, { raw: { ...CONFIG, dailyRequests: 2 }, file: stateFile('day'), now: () => now })
  const agent = trialAgent()
  h.setCurrent(agent)
  for (let index = 0; index < 2; index += 1) {
    await preStep(h, agent, `user-a-${index}`)
    await collect(streamRequest(h, request(), [usageChunk(5, 5), finishChunk()]).iterable)
  }
  assert.equal(snapshotOf(h).daily.remainingRequests, 0)
  await preStep(h, agent, 'user-a-blocked')
  const blocked = await rejectionOf(collect(streamRequest(h, request(), [finishChunk()]).iterable))
  assert.ok(blocked instanceof TrialDenied)
  assert.equal(blocked.code, 'TRIAL_DAILY_REQUESTS')

  now += 120000 // 北京时间次日 00:01
  await preStep(h, agent, 'user-b-1')
  const next = streamRequest(h, request(), [usageChunk(4, 4), finishChunk()])
  await collect(next.iterable)
  assert.equal(next.calls.count, 1)
  const snapshot = snapshotOf(h)
  assert.equal(snapshot.daily.requests, 1)
  assert.equal(snapshot.daily.chargedTokens, 8)
})

test('超限、路由或输出不合规时拒绝，且下游模型请求完全没有被调用', async () => {
  const h = host()
  installTrial(h.ctx, { raw: { ...CONFIG, maxRequests: 1 }, file: stateFile('limit') })
  const agent = trialAgent()
  h.setCurrent(agent)
  await preStep(h, agent, 'user-limit')

  const ok = streamRequest(h, request(), [usageChunk(5, 5), finishChunk()])
  await collect(ok.iterable)
  assert.equal(ok.calls.count, 1)

  const exceeded = streamRequest(h, request(), [finishChunk()])
  const exceededError = await rejectionOf(collect(exceeded.iterable))
  assert.equal(exceededError.code, 'TRIAL_RUN_REQUESTS')
  assert.equal(exceeded.calls.count, 0, '超限时不得调用下游模型流转发')

  const routed = streamRequest(h, request({ provider: 'other-provider' }), [finishChunk()])
  const routeError = await rejectionOf(collect(routed.iterable))
  assert.equal(routeError.code, 'TRIAL_ROUTE_DENIED')
  assert.equal(routed.calls.count, 0)

  const output = streamRequest(h, request({ maxTokens: CONFIG.maxOutputTokens + 1 }), [finishChunk()])
  const outputError = await rejectionOf(collect(output.iterable))
  assert.equal(outputError.code, 'TRIAL_OUTPUT_INVALID')
  assert.equal(output.calls.count, 0)

  // 没有可信用户消息（未经过 pre-step）时不得凭空建立一个可花钱的试用窗口。
  const fresh = host()
  installTrial(fresh.ctx, { raw: CONFIG, file: stateFile('no-run') })
  const freshAgent = trialAgent()
  fresh.setCurrent(freshAgent)
  const noRun = streamRequest(fresh, request(), [finishChunk()])
  const noRunError = await rejectionOf(collect(noRun.iterable))
  assert.equal(noRunError.code, 'TRIAL_NO_RUN')
  assert.equal(noRun.calls.count, 0)
})

test('并发请求按预留上界拒绝，不允许超卖；结算后释放预留', async () => {
  const h = host()
  installTrial(h.ctx, { raw: { ...CONFIG, maxTokens: 1500 }, file: stateFile('concurrent') })
  const agent = trialAgent()
  h.setCurrent(agent)
  await preStep(h, agent, 'user-concurrent')

  const first = streamRequest(h, request(), [usageChunk(5, 5), finishChunk()])
  const second = streamRequest(h, request(), [usageChunk(5, 5), finishChunk()])
  const firstIterator = first.iterable[Symbol.asyncIterator]()
  await firstIterator.next() // 预留已落盘，但尚未结算
  const secondIterator = second.iterable[Symbol.asyncIterator]()
  const overSold = await rejectionOf(secondIterator.next())
  assert.equal(overSold.code, 'TRIAL_RUN_TOKENS', '第二个并发请求必须按预留上界被拒绝')
  assert.equal(second.calls.count, 0)

  await firstIterator.return() // 结算（这里 usage 已读到 10）
  assert.equal(snapshotOf(h).daily.chargedTokens, 10)
  const afterSettle = streamRequest(h, request(), [usageChunk(2, 2), finishChunk()])
  await collect(afterSettle.iterable)
  assert.equal(afterSettle.calls.count, 1, '结算释放预留后应可继续请求')
})

test('重启后每日计数与任务窗口保留，在途预留不退还', async () => {
  const file = stateFile('restart')
  const first = host()
  const firstInstallation = installTrial(first.ctx, { raw: CONFIG, file, now: () => AT })
  const agent = trialAgent()
  first.setCurrent(agent)
  await preStep(first, agent, 'user-restart-1')
  await collect(streamRequest(first, request(), [usageChunk(10, 5), finishChunk()]).iterable)

  // 模拟崩溃：预留已写盘、结算未发生
  const inFlight = streamRequest(first, request(), [usageChunk(1, 1), finishChunk()])
  const iterator = inFlight.iterable[Symbol.asyncIterator]()
  await iterator.next()
  const before = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Object.keys(before.pending).length, 1, '在途请求必须先持久预留')
  firstInstallation.stop()

  const second = host()
  second.setCurrent(agent)
  const secondInstallation = installTrial(second.ctx, { raw: CONFIG, file, now: () => AT })
  const snapshot = second.services.get(TRIAL_SERVICE_NAME).snapshot(agent.id)
  assert.equal(snapshot.daily.requests, 2, '重启后每日请求计数不清零')
  assert.equal(snapshot.daily.chargedTokens, before.days[TRIAL_DAY].chargedTokens, '重启后 token 账不清零')
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(after.pending, {})
  assert.equal(after.recoveredUnknownRequests, 1, '中断的在途请求记为未知用量，已记的预留不退')

  // 任务窗口也持久化：不需要新的 pre-step 就能继续同一任务
  const resumed = streamRequest(second, request(), [usageChunk(2, 2), finishChunk()])
  await collect(resumed.iterable)
  assert.equal(resumed.calls.count, 1)
  secondInstallation.stop()
})

test('计数损坏时拒绝重置并阻止模型请求（故障关闭）', async () => {
  const file = stateFile('corrupt')
  writeFileSync(file, JSON.stringify({ version: 2 }))
  const h = host()
  const installation = installTrial(h.ctx, { raw: CONFIG, file })
  assert.equal(installation.availability().available, false)
  assert.equal(installation.availability().code, 'trial-state-unreadable')
  assert.equal(h.services.has(TRIAL_SERVICE_NAME), false)
  assert.equal(h.listeners('llm/stream').length, 1, '状态不可读时仍须安装故障关闭拦截')
  const agent = trialAgent()
  h.setCurrent(agent)
  const blocked = streamRequest(h, request(), [finishChunk()])
  const error = await rejectionOf(collect(blocked.iterable))
  assert.match(error.message, /TRIAL_STATE_UNREADABLE/)
  assert.equal(blocked.calls.count, 0)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2 }, '损坏的计数文件不得被重置覆盖')
  installation.stop()
})

test('来源门控在工具执行前校验；非允许会话不受试用层影响', async () => {
  const h = host()
  installTrial(h.ctx, { raw: CONFIG, file: stateFile('tools') })
  const agent = trialAgent()
  h.setCurrent(agent)
  const listener = h.listeners('tools/pre-execute')[0]
  assert.ok(listener, '工具执行前必须安装来源门控')
  const run = (name, args) => listener({ agent, name, arguments: args }, () => ({ kind: 'continue' }))

  assert.deepEqual(await run('butler_conversations', { action: 'read', provider: 'dsh', sessionId: 'research', eventId: '118' }), { kind: 'continue' })
  const outOfScope = await run('butler_conversations', { action: 'read', provider: 'dsh', sessionId: 'research', eventId: '119' })
  assert.equal(outOfScope.kind, 'deny')
  assert.match(outOfScope.reason, /来源/)
  assert.equal((await run('butler_conversations', { action: 'list' })).kind, 'deny', '批量枚举会绕过来源白名单')
  assert.equal((await run('butler_organize', { action: 'save', sources: [{ provider: 'codex', sessionId: 'other' }] })).kind, 'deny')
  assert.deepEqual(await run('butler_organize', { action: 'save', sources: [{ provider: 'dsh', sessionId: 'research', eventId: '118' }] }), { kind: 'continue' })

  // 不在允许会话列表里的会话：试用层不管，模型请求原样放行且不记账
  const owner = trialAgent('session-owner-own')
  h.setCurrent(owner)
  assert.deepEqual(await listener({ agent: owner, name: 'butler_conversations', arguments: { action: 'list' } }, () => ({ kind: 'continue' })), { kind: 'continue' })
  const passthrough = streamRequest(h, request({ sessionId: owner.id }), [finishChunk()])
  await collect(passthrough.iterable)
  assert.equal(passthrough.calls.count, 1, '非试用会话的模型请求直接放行')
  assert.equal(h.services.get(TRIAL_SERVICE_NAME).snapshot(agent.id).daily.requests, 0)
})

test('工作台接口：未启用时 available:false 且无假限额，启用时给出真实快照', async () => {
  const routes = []
  const deps = (extra) => ({
    workspace: { snapshot: () => ({}), owns: (id) => id === 'butler', ids: () => ['butler'] },
    sources: {}, organization: {}, ...extra,
  })
  const request = async (path) => {
    const route = routes.find((row) => row.path === path.split('?')[0])
    assert.ok(route, `${path} 必须注册`)
    const req = Object.assign(new EventEmitter(), {
      method: 'GET', url: path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:19394', origin: 'http://127.0.0.1:19394' },
    })
    let result
    await route.handler(req, { statusCode: 0, setHeader() {}, end(body) { result = { status: this.statusCode, body: JSON.parse(body) } } })
    return result
  }

  const stopOff = registerWorkspaceApi(
    { webServer: { register(route) { routes.push(route); return () => {} } } },
    deps({ trial: () => undefined, trialAvailability: () => ({ available: false, code: 'trial-not-configured', reason: '未配置 trial' }) }),
  )
  const off = await request('/dsh-butler/api/workspace/trial?sessionId=butler')
  assert.equal(off.status, 200)
  assert.equal(off.body.available, false)
  assert.equal(off.body.code, 'trial-not-configured')
  assert.equal(off.body.trial, null)
  stopOff()
  routes.length = 0

  const h = host()
  const installation = installTrial(h.ctx, { raw: CONFIG, file: stateFile('api'), now: () => AT })
  const stopOn = registerWorkspaceApi(
    { webServer: { register(route) { routes.push(route); return () => {} } } },
    deps({ trial: (id) => installation.snapshot(id), trialAvailability: () => installation.availability() }),
  )
  const on = await request('/dsh-butler/api/workspace/trial?sessionId=butler')
  assert.equal(on.body.available, true)
  assert.equal(on.body.trial.provider, CONFIG.provider)
  assert.equal(on.body.trial.limits.maxRequests, 4)
  assert.equal(on.body.trial.daily.remainingRequests, 10)
  stopOn()
  installation.stop()
})

/** Drive one Cordis waterfall chain in registration order (next() takes no replacement args). */
function waterfall(hooks, name, args, terminal) {
  const list = [...(hooks.get(name) ?? [])]
  const call = (index) => index >= list.length ? terminal(...args) : list[index](...args, () => call(index + 1))
  return call(0)
}

test('独立管家入口停用历史试用限额配置，普通管家请求原样交给宿主', async () => {
  const schemaUrl = new URL('./fixtures/schema-for-entry.mjs', import.meta.url).href
  const dependencyHook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === '@deepseek-ai/schemastery' ? { url: schemaUrl, shortCircuit: true } : next(specifier, context)
    },
  })
  let apply
  try { ({ apply } = await import('../src/index.ts')) } finally { dependencyHook.deregister() }

  const hooks = new Map(), services = new Map(), effects = []
  const agent = { id: 'session-butler-home', session: { requestContext: () => ({}) } }
  let current = agent
  const tools = { register() { return () => {} }, schemas() { return [] }, get() { return undefined }, guard() { return () => {} }, presentAs() { return () => {} } }
  agent.ctx = { get: name => name === 'tools' ? tools : undefined }
  const ctx = {
    tools,
    webServer: { register() { return () => {} } },
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'agents') return { currentInitiator: () => current, list: () => [agent] }
      if (name === 'tools') return tools
      if (name === 'timer') return { setTimeout() { return 0 } }
      return services.get(name)
    },
    on(name, listener) {
      const set = hooks.get(name) ?? new Set()
      set.add(listener)
      hooks.set(name, set)
      return () => set.delete(listener)
    },
    provide(name, value) {
      if (services.has(name)) throw new Error(`duplicate ${name}`)
      services.set(name, value)
      return () => services.delete(name)
    },
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') effects.push(dispose) },
  }
  apply(ctx, {
    timeZone: 'Asia/Shanghai', mailto: 'test@localhost', profileChars: 2000, sessionTitleName: '管家',
    taskMaxRequests: 50, taskMaxTokens: 2000000, taskMaxMinutes: 15, contextTokens: 64000,
    trial: { enabled: true, provider: CONFIG.provider, model: CONFIG.model,
      allowedSessionIds: ['session-butler-home'], allowedSourceRefs: ['dsh:research:118'] },
  })
  await Promise.resolve()
  const service = services.get(TRIAL_SERVICE_NAME)
  assert.equal(service, undefined, '旧试用配置不能重新启用普通管家的硬预算')

  // 真实钩子链：pre-step 建立可信任务窗口，llm/stream 预留 + 结算。
  const decision = await waterfall(hooks, 'agent/pre-step',
    [{ agent, step: 1, messages: [{ id: 'user-entry-1', role: 'user', source: { kind: 'user' } }] }],
    () => ({ kind: 'continue', messages: [] }))
  assert.equal(decision.kind, 'continue')
  const chunks = []
  const stream = waterfall(hooks, 'llm/stream', [request({ maxTokens: 20 })],
    () => (async function* () { yield usageChunk(10, 5); yield finishChunk() })())
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks.length, 2)
  // 超过旧试用输出上限/160k输入预检，仍由宿主负责原生上下文准入。
  let downstream = 0
  const native = waterfall(hooks, 'llm/stream', [request({ maxTokens: 8192, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200000) }] }] })],
    () => { downstream += 1; return (async function* () { yield finishChunk() })() })
  await collect(native)
  assert.equal(downstream, 1)

  for (const dispose of effects.reverse()) dispose()
})

