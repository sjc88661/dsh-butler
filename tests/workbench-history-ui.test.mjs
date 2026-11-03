import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'

const nativeRequire = createRequire(join(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'), 'package.json'))
const ts = nativeRequire('typescript'), revision = 'b'.repeat(64)
const pause = () => new Promise(resolve => setImmediate(resolve))

/** In-memory React lifecycle carrier; runs the real component/effects and read client, no host or DOM. */
function carrier(initialStates = []) {
  let cursor = 0, dirty = true, mounted = true, tree, component, props, writes = 0
  const states = [...initialStates], effects = new Map(), pending = [], requests = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { writes++; assert.equal(mounted, true, 'An obsolete response updated an unmounted history'); states[index] = typeof value === 'function' ? value(states[index]) : value; dirty = true }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
    useEffect(run, deps) {
      const index = cursor++, old = effects.get(index)
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) pending.push(() => {
        old?.cleanup?.(); effects.set(index, { deps, cleanup: run() })
      })
    },
  }
  const cache = new Map()
  function load(path) {
    if (path === 'react') return react
    const file = resolve(path)
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true } }).outputText
    vm.runInNewContext(source, { module, exports: module.exports, require: id => load(id === 'react' ? id : resolve(dirname(file), id)), AbortController, URLSearchParams,
      fetch(path, options) { return new Promise(resolve => requests.push({ path, signal: options.signal, resolve })) } }, { filename: file })
    return module.exports
  }
  const flush = async () => {
    for (let round = 0; round < 3; round++) {
      while (dirty) { dirty = false; cursor = 0; tree = component(props); while (pending.length) pending.shift()() }
      await pause()
    }
  }
  return {
    load,
    requests, get tree() { return tree }, get writes() { return writes },
    async mount(nextProps) { component = load('src/client/history.ts').HistoryBrowser; props = nextProps; await flush() },
    async update(nextProps) { props = nextProps; dirty = true; await flush() }, flush,
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); mounted = false },
  }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
}
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.children.includes(label))
const page = (taskId, offset = 0) => ({ ok: true, kind: 'receipts', taskId, items: [{ taskId, tool: `${taskId}-${offset}`, ok: false }], total: 2, limit: 1, offset, revision, ...(offset === 0 ? { nextOffset: 1 } : {}) })
const props = taskId => ({ kind: 'receipts', taskId, limit: 1, renderPage: value => ({ type: 'records', props: {}, children: value.items.map(row => row.tool) }) })

test('channels summary renders one read-only line with unknown connection and no private target', () => {
  const view = carrier(), model = view.load('src/client/workbench-model.ts'), details = view.load('src/client/workbench-details.ts')
  const controls = { active: true, channels: { active: true, enabled: true, configuredOwner: true, received: 2, accepted: 2, nativeMapped: 1, acceptedWithoutNative: 1, pending: 0, uncertain: 0,
    ownerId: 'PRIVATE-owner', chatId: 'PRIVATE-chat', senderId: 'PRIVATE-sender' } }
  const tree = details.runtimeContent(model.runtimeView(controls), () => {})
  const text = JSON.stringify(tree)
  assert.match(text, /飞书归因/)
  assert.match(text, /连接状态未知/)
  assert.match(text, /返回未关联 1/)
  assert.match(text, /可能是.*命令/)
  assert.doesNotMatch(text, /PRIVATE-|已连接|任务已完成/)
  assert.equal(nodes(tree).filter(node => node.type === 'button').length, 0)
})

test('history navigation keeps its revision across dashboard rerenders and discards a cancelled task response', async () => {
  const first = carrier(); await first.mount(props('task-a'))
  first.requests[0].resolve(new Response(JSON.stringify(page('task-a')))); await first.flush()
  button(first.tree, '下一页').props.onClick(); await first.flush()
  const oldPage = first.requests[1], url = new URL(oldPage.path, 'http://test.invalid')
  assert.equal(url.searchParams.get('offset'), '1'); assert.equal(url.searchParams.get('revision'), revision)
  first.unmount(); assert.equal(oldPage.signal.aborted, true)
  const writes = first.writes, second = carrier(); await second.mount(props('task-b'))
  second.requests[0].resolve(new Response(JSON.stringify(page('task-b')))); await second.flush()
  oldPage.resolve(new Response(JSON.stringify(page('task-a', 1)))); await pause()
  assert.equal(first.writes, writes)
  assert.ok(JSON.stringify(second.tree).includes('task-b-0'))
  assert.ok(!JSON.stringify(second.tree).includes('task-a'))
  await second.update(props('task-b'))
  assert.equal(second.requests.length, 1, 'Dashboard polling must not reset an active history page')
  second.unmount()
})

test('task rendering preserves local uncertain snapshots, native unavailability and the original planned timezone', () => {
  const e = carrier(), { taskDetailPane } = e.load('src/client/workbench-details.ts')
  const operation = { action: 'create', executionKey: 'owned-op', taskId: 'task-render', state: 'uncertain', reason: 'response lost', sourceSessionId: 'owner',
    createdAt: '2026-10-20T02:00:00Z', updatedAt: '2026-10-20T02:00:01Z', timeZone: 'Asia/Shanghai',
    request: { title: 'Own reminder', at: '2026-10-21T10:00:00+08:00' }, lastDelivery: { messageId: 'native-local-event' } }
  const detail = { task: { id: 'task-render', title: 'Own task', status: 'pending', updatedAt: operation.updatedAt },
    usage: { calls: 0, withoutUsage: 0, totalTokens: 0, pricedCalls: 0, cost: 0 }, budgets: [], budgetHistory: [],
    receipts: [], receiptCount: 0, evidence: [], evidenceAvailable: true, artifacts: [], usageRecords: [],
    reminderOperations: [operation], reminderOperationsAvailable: true, storage: { degraded: false },
    reminder: { link: { creationState: 'creating' }, history: { available: false, deliveryState: 'unknown', reason: 'native history offline' } } }
  const tree = taskDetailPane(detail, () => {}, () => {}, () => {}), text = JSON.stringify(tree)
  assert.ok(text.includes('待核对'))
  assert.ok(text.includes('native history offline'))
  assert.ok(text.includes('native-local-event'))
  assert.ok(text.includes('2026-10-21T10:00:00+08:00 · Asia/Shanghai'))
  assert.ok(!text.includes('02:00 · Asia/Shanghai'))
})

test('a changed revision preserves the last snapshot, blocks further paging, and refresh starts from page zero', async () => {
  const e = carrier(); await e.mount(props('task-c'))
  e.requests[0].resolve(new Response(JSON.stringify(page('task-c')))); await e.flush()
  button(e.tree, '下一页').props.onClick(); await e.flush()
  e.requests[1].resolve(new Response(JSON.stringify({ error: '历史已变化，请刷新后重新翻页' }), { status: 409 })); await e.flush()
  assert.ok(JSON.stringify(e.tree).includes('请刷新'))
  assert.ok(JSON.stringify(e.tree).includes('task-c-0'))
  assert.equal(button(e.tree, '下一页').props.disabled, true)
  button(e.tree, '刷新历史').props.onClick(); await e.flush()
  const url = new URL(e.requests[2].path, 'http://test.invalid')
  assert.equal(url.searchParams.get('offset'), '0'); assert.equal(url.searchParams.has('revision'), false)
  assert.ok(!JSON.stringify(e.tree).includes('task-c-0'))
  e.requests[2].resolve(new Response(JSON.stringify(page('task-c')))); await e.flush()
  assert.equal(button(e.tree, '下一页').props.disabled, false)
  e.unmount()
})

test('browsed budget pages retain saved counters when dashboard polling supplies a newer current report', () => {
  const e = carrier(), { taskDetailPane } = e.load('src/client/workbench-details.ts')
  const saved = { taskId: 'run-snapshot', sessionId: 'owner', current: true, kind: 'normal', startedAt: 1000,
    requests: 2, tokens: 20, reservedTokens: 7, pending: { pending: 7 }, failures: {} }
  const live = { ...saved, requests: 99, tokens: 999, blocked: 'new stop after historical snapshot',
    remaining: { requests: 0, tokens: 0, ms: 0 }, limits: {}, inFlight: 0 }
  const detail = { task: { id: 'budget-task', title: 'Budget task', status: 'pending', updatedAt: '2026-10-20T02:00:00Z' },
    usage: { calls: 0, withoutUsage: 0, totalTokens: 0, pricedCalls: 0, cost: 0 }, budgets: [live], budgetHistory: [saved],
    receipts: [], receiptCount: 0, evidence: [], evidenceAvailable: true, artifacts: [], usageRecords: [], reminderOperations: [], storage: { degraded: false } }
  const tree = taskDetailPane(detail, () => {}, () => {}, () => {}), browser = nodes(tree).find(node => node.props?.kind === 'taskBudgets')
  assert.ok(JSON.stringify(browser.props.preview).includes('99 次发送'), 'Current preview may show the current report')
  const historical = JSON.stringify(browser.props.renderPage({ items: [saved], revision }))
  assert.ok(historical.includes('2 次发送'))
  assert.ok(!historical.includes('99 次发送'))
  assert.ok(!historical.includes('new stop after historical snapshot'))
})

test('task detail renders inbox, completed assistant and platform receipt as three separate facts', () => {
  const e = carrier(), { taskDetailPane } = e.load('src/client/workbench-details.ts')
  const detail = { task: { id: 'delivery-task', kind: 'reminder', title: 'Delivery task', status: 'running', updatedAt: '2026-10-21T03:00:00Z' },
    usage: { calls: 0, withoutUsage: 0, totalTokens: 0, pricedCalls: 0, cost: 0 }, budgets: [], budgetHistory: [],
    receipts: [], receiptCount: 0, evidence: [], evidenceAvailable: true, artifacts: [], usageRecords: [], reminderOperations: [], storage: { degraded: false },
    reminder: { link: { creationState: 'committed', deliveryState: 'assistant-completed', destinationSessionId: 'private-target-session' },
      history: { available: true, deliveryState: 'delivered', records: [{ messageId: 'native-inbox-only', deliveredAt: '2026-10-21T03:00:00Z' }] },
      outbound: [{ key: 'external-one', provider: 'lark', state: 'delivered', createdAt: '2026-10-21T03:00:01Z', updatedAt: '2026-10-21T03:00:02Z', receipt: { messageId: 'actual-platform-receipt' } }] } }
  const text = JSON.stringify(taskDetailPane(detail, () => {}, () => {}, () => {}))
  assert.ok(text.includes('已入提醒会话'), 'Native delivery must name the reminder inbox')
  assert.ok(text.includes('已记录助手完成'), 'A saved assistant completion must be visible')
  assert.ok(text.includes('飞书平台已收到'), 'An external receipt must have its own platform status')
  assert.match(text, /入箱消息 native-inbox-only/)
  assert.match(text, /平台回执 actual-platform-receipt/)
  assert.match(text, /回执记录时间 2026-10-21T03:00:02Z/)
  assert.match(text, /用户已读未核实/)
  assert.doesNotMatch(text, /private-target-session/)
})

test('dashboard task rows distinguish native-only delivery from assistant completion and their own external state', () => {
  const own = { id: 'own-reminder', title: 'Own reminder', kind: 'reminder', status: 'running', reminder: { creationState: 'committed', deliveryState: 'delivered' } }
  const other = { ...own, id: 'other-reminder', title: 'Other reminder' }
  const external = state => ({ key: state, provider: 'lark', state, createdAt: '2026-10-21T03:00:00Z', updatedAt: '2026-10-21T03:00:01Z', ...(state === 'delivered' ? { receipt: { messageId: 'receipt-detail-only' } } : {}) })
  for (const state of ['native-only', 'pending', 'uncertain', 'delivered']) {
    const operation = (taskId, outboundState) => ({ action: 'create', executionKey: taskId, taskId, state: 'committed', outbound: outboundState === 'native-only' ? [] : [external(outboundState)] })
    const overview = { generatedAt: '2026-10-21T03:00:00Z', timeZone: 'Asia/Shanghai', vault: { home: 'fixture-vault', files: [] }, reminders: [], remindersAvailable: true,
      ledger: { open: [own, other], interrupted: [], pending: [], recent: [] }, taskHistory: { total: 2, tasks: [own, other] },
      runtimeControls: { active: true, reminderOperations: [operation(own.id, state), operation(other.id, 'delivered')] } }
    const e = carrier([overview]), { ButlerWorkbench } = e.load('src/client/panel.ts'), tree = ButlerWorkbench({})
    const row = nodes(tree).find(node => node.props?.['aria-label'] === '查看任务：Own reminder'), text = JSON.stringify(row)
    const expected = state === 'native-only' ? '外部渠道送达未核实' : state === 'pending' ? '外发处理中' : state === 'uncertain' ? '外发有待核对记录' : '飞书平台已收到'
    assert.ok(text.includes(expected), `${state} must be visible on the task row before opening detail`)
    const completion = state === 'native-only' ? '助手完成未核实' : '已记录助手完成'
    assert.ok(text.includes(completion), `${state} must keep assistant completion separate from native inbox delivery`)
    if (state !== 'delivered') assert.ok(!text.includes('平台已收到'), 'A receipt for another task cannot confirm this task')
    assert.ok(!text.includes('receipt-detail-only'), 'Receipt details belong in the task detail pane')
    const history = nodes(tree).find(node => node.props?.kind === 'tasks')
    assert.ok(JSON.stringify(history.props.renderPage({ items: [own] })).includes(expected), 'Paged task rows keep the same external status')
    assert.ok(JSON.stringify(history.props.renderPage({ items: [own] })).includes(completion), 'Paged task rows keep the same assistant completion status')
    assert.equal(e.requests.length, 0, 'Rendering a saved overview must not issue an external action')
  }
})


test('runtime protection renders native normal budget policy alongside reminder budget history', () => {
  const view = carrier(), model = view.load('src/client/workbench-model.ts'), details = view.load('src/client/workbench-details.ts')
  const controls = { active: true, controlScope: 'isolated-reminders-only',
    layer: { mode: 'dedicated-layer', normalTokenBudget: null, normalExecutionPolicy: 'native' },
    taskBudgets: [{ taskId: 'reminder-run', sessionId: 'reminder-session', kind: 'reminder', startedAt: 1, requests: 1, tokens: 20, reservedTokens: 0, pending: {}, failures: {} }] }
  const text = JSON.stringify(details.runtimeContent(model.runtimeView(controls), () => {}))
  assert.match(text, /普通管家不设 token 硬预算；仅统计实际消耗。提醒会话保留隔离限额。/)
  assert.match(text, /提醒 · 限额未知/)
  assert.match(text, /reminder-run/)
  assert.doesNotMatch(text, /预算已关闭/)
})
