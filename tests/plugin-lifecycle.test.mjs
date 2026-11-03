import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { registerHooks } from 'node:module'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'plugin-lifecycle-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
// This test exercises apply and native effect semantics with a synthetic host.
const schemaUrl = new URL('./fixtures/schema-for-entry.mjs', import.meta.url).href
const dependencyHook = registerHooks({ resolve(specifier, context, next) {
  return specifier === '@deepseek-ai/schemastery' ? { url: schemaUrl, shortCircuit: true } : next(specifier, context)
} })
const { apply } = await import('../src/index.ts')
const { TaskBudgets } = await import('../src/host/budget.ts')
dependencyHook.deregister()

test('plugin load keeps attribution and business hooks alive until the native effect disposer runs', async () => {
  const budgetFile = join(home, 'state', 'task-budgets.json'), seed = new TaskBudgets({ file: budgetFile })
  const oldRun = seed.begin('lifecycle-history', { humanMessageId: 'old-input' })
  seed.halt('lifecycle-history', '原失败停止记录', oldRun.taskId)
  const currentRun = seed.begin('lifecycle-history', { humanMessageId: 'new-input' })
  const hooks = new Map(), definitions = new Map(), routes = new Map(), effects = []
  const tools = { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) },
    schemas() { return [] }, get(name) { return definitions.get(name) }, guard() { return () => {} } }
  function scopedAgent(id) {
    const scoped = new Map()
    const registry = { register(tool) { scoped.set(tool.name, tool); return () => scoped.delete(tool.name) },
      schemas() { return [...scoped.values()] }, get(name) { return scoped.get(name) }, guard() { return () => {} } }
    return { agent: { id, session: { id }, ctx: { get: name => name === 'tools' ? registry : undefined } }, scoped }
  }
  const managed = scopedAgent('session-butler-home'), external = scopedAgent('zotero')
  const agents = { list: () => [managed.agent, external.agent], isOwnedBy: () => false }
  const ctx = { tools, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return name === 'tools' ? tools : name === 'agents' ? agents : name === 'timer' ? { setTimeout() { return 0 } } : undefined },
    on(name, fn) { const set = hooks.get(name) ?? new Set(); set.add(fn); hooks.set(name, set); return () => set.delete(fn) },
    // Cordis effect executes setup now and calls its returned disposer on unload.
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') effects.push(dispose) } }
  apply(ctx, { timeZone: 'Asia/Shanghai', mailto: 'test@localhost', profileChars: 2000, sessionTitleName: '管家',
    taskMaxRequests: 50, taskMaxTokens: 2000000, taskMaxMinutes: 15, contextTokens: 64000 })
  await Promise.resolve()
  assert.equal(hooks.get('tools/result')?.size, 2, 'attribution and final business result hooks must both remain installed')
  assert.equal(hooks.get('session/event')?.size, 5, 'attribution, approvals/reminders, compaction guard, usage and readable archive hooks must remain installed')
  assert.ok(managed.scoped.has('butler_task'))
  assert.ok(!definitions.has('butler_task'))
  assert.ok(!external.scoped.has('butler_task'))
  assert.ok(routes.has('/dsh-butler/api/overview'))
  assert.ok(routes.has('/dsh-butler/api/history'))
  assert.ok(routes.has('/dsh-butler/api/workspace'))
  assert.ok(managed.scoped.has('butler_conversations'))
  assert.ok(!definitions.has('butler_conversations'))
  assert.ok(!external.scoped.has('butler_conversations'))
  const beforeHistory = readFileSync(budgetFile)
  let response
  await routes.get('/dsh-butler/api/history').handler({ method: 'GET', url: '/dsh-butler/api/history?kind=budgets' }, {
    statusCode: 200, setHeader() {}, end(body) { response = { status: this.statusCode, body: JSON.parse(body) } },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.items.find(row => row.taskId === oldRun.taskId).blocked, '原失败停止记录')
  assert.equal(response.body.items.find(row => row.taskId === oldRun.taskId).current, false)
  assert.equal(response.body.items.find(row => row.taskId === currentRun.taskId).current, true)
  assert.deepEqual(readFileSync(budgetFile), beforeHistory, 'The assembled API must read the real budget service without rewriting saved runs')
  for (const dispose of effects.reverse()) dispose()
  assert.equal(hooks.get('tools/result')?.size, 0)
  assert.equal(hooks.get('session/event')?.size, 0)
  assert.equal(definitions.size, 0)
  assert.equal(managed.scoped.size, 0)
  assert.equal(external.scoped.size, 0)
  assert.equal(routes.size, 0)
})
