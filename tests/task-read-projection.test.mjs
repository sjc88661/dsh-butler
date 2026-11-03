import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'task-read-projection-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
const { upsertTask, addUsage, addReceipt, usageTotals } = await import('../src/host/ledger.ts')
const { registerButlerTools } = await import('../src/host/tools.ts')
const { registerButlerApi } = await import('../src/host/api.ts')
ensureVault()

function environment(budgetHistory) {
  const tools = new Map(), routes = new Map()
  const disposeTools = registerButlerTools({ tools: { register(tool) { tools.set(tool.name, tool); return () => {} } } }, {
    timeZone: 'Asia/Shanghai', mailto: 'test@localhost', sessionId: () => 'same-session', currentTaskId: () => undefined, receiptsByRuntime: true, budgetHistory,
  })
  const disposeApi = registerButlerApi({ webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } } }, { timeZone: 'Asia/Shanghai', budgetHistory })
  return {
    async call(name, args) { return tools.get(name).execute(args) },
    async request(path) {
      let response
      await routes.get(path.split('?')[0])(Object.assign(new EventEmitter(), { method: 'GET', url: path }), {
        statusCode: 200, setHeader() {}, end(text) { response = { status: this.statusCode, body: JSON.parse(text) } },
      })
      assert.equal(response.status, 200)
      return response.body
    }, dispose() { disposeTools(); disposeApi() },
  }
}
const budget = (taskId, requests) => ({ taskId, sessionId: 'same-session', kind: 'normal', startedAt: 1000, requests, tokens: 900, reservedTokens: 100, pending: {}, failures: {}, current: false })

test('tool and workbench task summaries use exact provider usage and distinct saved execution counters while preserving legacy bytes', async () => {
  const id = 'actual-stats', other = 'same-session-other-task'
  upsertTask(id, { title: 'Actual statistics', sessionId: 'same-session', runId: 'first-run', modelTokens: 0, attempts: 0, cost: 999 })
  upsertTask(other, { title: 'Other task', sessionId: 'same-session', runId: 'foreign-run' })
  addUsage({ taskId: id, runId: 'first-run', sessionId: 'same-session', eventSeq: 1, provider: 'unpriced', model: 'unpriced', totalTokens: 30 })
  addUsage({ taskId: id, runId: 'second-run', sessionId: 'same-session', eventSeq: 2, usageState: 'unknown' })
  addUsage({ taskId: other, runId: 'foreign-run', sessionId: 'same-session', eventSeq: 3, totalTokens: 600 })
  addUsage({ runId: 'unattributed-run', sessionId: 'same-session', eventSeq: 4, totalTokens: 700 })
  addReceipt({ taskId: id, runId: 'third-run', sessionId: 'same-session', tool: 'read', ok: true })
  const rows = [budget('first-run', 4), budget('second-run', 2), budget('third-run', 1), budget('foreign-run', 30), budget('unattributed-run', 40)]
  const e = environment(() => rows), before = Object.fromEntries(['tasks', 'usage', 'receipts'].map(name => [name, readFileSync(vaultPath('ledger', `${name}.jsonl`)).toString('base64')]))
  try {
    const listed = (await e.call('butler_task', { action: 'list', filter: 'all' })).tasks.find(row => row.id === id)
    const toolOverview = (await e.call('butler_overview', {})).openTasks.find(row => row.id === id)
    const overview = await e.request('/dsh-butler/api/overview'), detail = await e.request(`/dsh-butler/api/task?id=${id}`)
    const history = await e.request('/dsh-butler/api/history?kind=tasks')
    for (const row of [listed, toolOverview, overview.ledger.open.find(row => row.id === id), overview.taskHistory.tasks.find(row => row.id === id), detail.task, history.items.find(row => row.id === id)]) {
      assert.equal(row.modelTokens, undefined, 'Obsolete task counters must not appear as actual usage')
      assert.equal(row.attempts, undefined, 'Task state transitions do not measure runtime executions')
      assert.equal(row.cost, undefined, 'Legacy task cost is not the provider usage estimate')
      assert.deepEqual(row.usage, usageTotals(id))
      assert.deepEqual(row.execution, { available: true, runCount: 3, requests: 7 })
    }
    assert.equal(detail.usage.calls, 2); assert.equal(detail.usage.withoutUsage, 1); assert.equal(detail.usage.pricedCalls, 0)
    for (const [name, bytes] of Object.entries(before)) assert.equal(readFileSync(vaultPath('ledger', `${name}.jsonl`)).toString('base64'), bytes)
  } finally { e.dispose() }
})

test('missing or unreadable saved budgets never turn usage row counts or old attempts into runtime counts', async () => {
  const id = 'unknown-budget-stats'
  upsertTask(id, { title: 'Unknown budget statistics', attempts: 9, modelTokens: 0 })
  addUsage({ taskId: id, sessionId: 'unknown-budget-session', eventSeq: 1, totalTokens: 20 })
  for (const source of [undefined, () => { throw Error('saved budget unreadable') }]) {
    const e = environment(source)
    try {
      const row = (await e.call('butler_task', { action: 'list', filter: 'all' })).tasks.find(row => row.id === id)
      assert.equal(typeof row.execution, 'object', 'Runtime budget availability must be explicit')
      assert.equal(row.execution.available, false)
      assert.equal(row.execution.runCount, undefined); assert.equal(row.execution.requests, undefined)
      assert.match(row.execution.reason, /不可用|unreadable/)
      assert.equal(row.usage.calls, 1)
    } finally { e.dispose() }
  }
})
