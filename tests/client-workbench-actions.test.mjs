import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'

const nativeRequire = createRequire(join(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'), 'package.json'))
const ts = nativeRequire('typescript')
assert.equal(ts.version, '6.0.3')
const pause = () => new Promise(resolve => setImmediate(resolve))
const at = '2026-10-21T12:00:00Z'
const tasks = ['task-a-full-id', 'task-b-full-id'].map(id => ({ id, title: `Title ${id}`, status: 'interrupted', updatedAt: at,
  sessionId: `recorded-${id}`, usage: { calls: 0 }, execution: { available: false, reason: 'unknown' } }))
const readySession = { id: 'current-butler-session', state: 'live', title: '管家', titlePinned: true,
  ready: { id: 'current-butler-session', canonicalCwd: 'E:/test/vault', workspaceId: 'ready-workspace', attached: true, flushed: true } }
const overview = (generatedAt = at, extra = {}) => ({ ok: true, generatedAt, timeZone: 'Asia/Shanghai', session: readySession,
  vault: { home: 'E:/test/vault', files: [] }, ledger: { open: tasks, interrupted: [], pending: [], recent: [] },
  reminders: [], remindersAvailable: true, taskHistory: { total: tasks.length, tasks }, ...extra })
const detail = (task = tasks[0], artifacts = []) => ({ ok: true, generatedAt: at, task,
  usage: { calls: 0, withoutUsage: 0, totalTokens: 0, pricedCalls: 0, cost: 0 }, budgets: [], budgetHistory: [],
  receipts: [], receiptCount: 0, evidence: [], evidenceCount: 0, evidenceAvailable: true, artifacts, artifactCount: artifacts.length,
  usageRecords: [], usageRecordCount: 0, reminderOperations: [], storage: { degraded: false }, limits: {} })
const noteEntries = ['alpha', 'beta'].map(slug => ({ path: `notes/${slug}.md`, size: 12, modified: at }))
const note = slug => ({ slug, path: `E:/test/vault/notes/${slug}.md`, text: `Body ${slug}` })

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  // HistorySection displays this real preview until the user opens its browser.
  return tree && typeof tree === 'object' ? [tree, ...nodes(tree.children), ...nodes(tree.props?.preview)] : []
}
// Component elements are not rendered by this host-element harness, so a
// component's user-facing text arrives through its props (e.g. InlineError
// `message`, ErrorState `title`). Host elements keep text as string children.
const text = tree => nodes(tree).flatMap(node => [
  ...(node.children ?? []).filter(child => typeof child === 'string'),
  ...['message', 'title', 'description'].map(key => node.props?.[key]).filter(value => typeof value === 'string'),
]).join('\n')
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.children.includes(label))
const taskPane = tree => nodes(tree).find(node => node.props?.['data-butler-task-detail'])
// The design system's overlays are components; the harness finds them by their
// declared function name, exactly like the native planner finds host elements.
const componentName = node => typeof node.type === 'function' ? node.type.name : undefined
const drawer = tree => nodes(tree).find(node => componentName(node) === 'Drawer')
const isAlert = node => node.props?.role === 'alert' || componentName(node) === 'InlineError' || componentName(node) === 'ErrorState'

/** Run the real panel, API and effects with deferred read responses and commit refs before effects. */
function carrier({ ctx = {}, clipboard } = {}) {
  let cursor = 0, dirty = true, mounted = true, tree, component, writes = 0, commit
  const states = [], effects = new Map(), pending = [], requests = [], intervals = new Map(), timeouts = new Map(), scrolls = [], pluginDisposers = []
  if (!ctx.effect) ctx.effect = run => { const dispose = run(); pluginDisposers.push(dispose); return dispose }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => {
        assert.equal(mounted, true, 'An obsolete response updated an unmounted panel')
        const next = typeof value === 'function' ? value(states[index]) : value
        if (!Object.is(next, states[index])) { states[index] = next; dirty = true; writes++ }
      }]
    },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect(run, deps) {
      const index = cursor++, old = effects.get(index)
      if (!old || deps === undefined || deps.some((value, i) => !Object.is(value, old.deps[i]))) pending.push(() => {
        old?.cleanup?.(); effects.set(index, { deps, cleanup: run() })
      })
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      react.useEffect(() => subscribe(() => { assert.equal(mounted, true, 'An unmounted subscriber was retained'); dirty = true }), [subscribe])
      return getSnapshot()
    },
  }
  const cache = new Map(), navigator = clipboard === undefined ? {} : { clipboard }
  function load(path) {
    if (path === 'react') return react
    const file = resolve(path)
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true } }).outputText
    vm.runInNewContext(source, { module, exports: module.exports,
      require: id => load(id === 'react' ? id : resolve(dirname(file), id)), AbortController, URLSearchParams, navigator,
      window: { setInterval(callback) { const id = intervals.size + 1; intervals.set(id, callback); return id }, clearInterval(id) { intervals.delete(id) },
        setTimeout(callback, ms) { assert.ok(ms > 0 && ms <= 30000); const id = Math.random(); timeouts.set(id, callback); return id }, clearTimeout(id) { timeouts.delete(id) } },
      fetch(path, options = {}) {
        const method = options.method ?? 'GET'
        // Exactly one mutation is allowed from the panel: the owner's own task
        // bookkeeping. Everything else must stay a read.
        if (path === '/dsh-butler/api/action' || path === '/dsh-butler/api/reminder-action' || path === '/dsh-butler/api/memo-action' || path === '/dsh-butler/api/capture') {
          assert.equal(method, 'POST', 'Task bookkeeping must use POST')
          assert.ok(typeof options.body === 'string' && options.body.length > 0)
          return new Promise((resolve, reject) => requests.push({ path, method, body: JSON.parse(options.body), signal: options.signal, resolve, reject, replied: false }))
        }
        assert.equal(method, 'GET', 'Workbench actions must not send a command or mutate host state')
        assert.equal(options.body, undefined)
        return new Promise((resolve, reject) => requests.push({ path, signal: options.signal, resolve, reject, replied: false }))
      } }, { filename: file })
    return module.exports
  }
  async function flush() {
    for (let round = 0; round < 4; round++) {
      let renders = 0
      while (dirty) {
        assert.ok(++renders < 30, 'Panel render loop did not settle')
        dirty = false; cursor = 0; tree = component({ ctx })
        for (const node of nodes(tree)) if (node.props?.ref) node.props.ref.current = {
          scrollIntoView(options) { scrolls.push({ options, tree: node }) },
        }
        commit?.()
        while (pending.length) pending.shift()()
      }
      await pause()
    }
  }
  const latest = pattern => requests.findLast(request => !request.replied && !request.signal?.aborted && pattern.test(request.path))
  const reply = (request, payload) => { assert.ok(request, 'Expected a pending read'); request.replied = true; request.resolve({ ok: true, json: async () => structuredClone(payload) }) }
  return {
    requests, scrolls, load, latest, reply, get tree() { return tree }, get writes() { return writes }, flush,
    async mount() {
      mounted = true; dirty = true; commit = undefined; component = load('src/client/panel.ts').ButlerWorkbench; await flush()
      reply(latest(/\/overview$/), overview()); await flush()
      reply(latest(/\/note$/), { notes: noteEntries }); await flush()
    },
    async selectTask(index = 0) {
      nodes(tree).find(node => node.props?.['aria-label'] === `查看任务：${tasks[index].title}`).props.onClick(); await flush()
      return latest(/\/task\?id=/)
    },
    async openTask(value = detail()) { const request = await this.selectTask(tasks.findIndex(task => task.id === value.task.id)); reply(request, value); await flush() },
    async selectNote(slug) { nodes(tree).find(node => node.props?.['aria-label'] === `查看笔记：${slug}`).props.onClick(); await flush(); return latest(/\/note\?slug=/) },
    async poll(payload) { for (const callback of intervals.values()) callback(); reply(latest(/\/overview$/), payload ?? overview(`${requests.length}`)); await flush() },
    async mountHeader(onCommit) { mounted = true; dirty = true; commit = onCommit; component = load('src/client/header.ts').ButlerHeaderAction; await flush() },
    expireTimeouts() { for (const [id, callback] of [...timeouts]) { timeouts.delete(id); callback() } },
    disposePlugin() { for (const dispose of pluginDisposers.splice(0)) dispose?.() },
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); pending.length = 0; states.length = 0; mounted = false; dirty = false },
  }
}

function fileSurface({ initial, fail = false } = {}) {
  let selected = initial, ready = false
  const listeners = new Set(), opened = [], navigated = []
  const mounted = { getSnapshot: () => selected, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) } }
  const ctx = { sidebarRight: { mounted, openResource(address) {
    assert.equal(selected, tasks[0].sessionId, 'The exact recorded source must be on screen')
    assert.equal(ready, true, 'The native store is created during its source header render, after mounted changes')
    if (fail) throw new Error('native viewer refused after mount')
    opened.push(address)
  } }, uiWorkspace: { openSession: id => navigated.push(id) } }
  return { ctx, opened, navigated, get subscriptions() { return listeners.size },
    show(id) { selected = id; for (const callback of [...listeners]) callback() }, commit() { ready = true } }
}

test('artifact preview and history keep paths, sources and MD notes while offering native file actions only for absolute local files', async () => {
  const e = carrier(); await e.mount()
  const artifacts = [{ path: 'E:\\资料 空间\\a #100%?.RIS' }, { kind: 'file', reference: '/tmp/中文 report.bib' },
    { path: 'E:/test/vault/notes/alpha.md' }, { reference: '/generic/reference.ris' }, { path: 'relative.ris' },
    { path: 'https://example.com/remote.bib' }, { kind: 'file', reference: 'file:///tmp/not-a-native-path' },
    { path: 'E:/bad\nname.ris' }, { path: 'E:/bad\0name.ris' }, { path: 'E:/bad\u007fname.ris' }, { kind: 'url', reference: 'https://example.com/source' }]
  await e.openTask(detail(tasks[0], artifacts))
  const pane = taskPane(e.tree), actions = nodes(pane).filter(node => node.type === 'button' && node.children.includes('用DSH打开文件'))
  assert.equal(actions.length, 3, 'RIS/BIB/local MD need explicit native actions; generic, relative and URL references do not')
  assert.ok(button(pane, '在工作台查看笔记'))
  assert.ok(text(pane).includes(artifacts[0].path), 'A failed native action must never remove its recorded path')
  assert.ok(nodes(pane).some(node => node.type === 'a' && node.props.href === 'https://example.com/source'))
  const history = nodes(pane).find(node => node.props?.kind === 'artifacts')
  assert.equal(nodes(history.props.renderPage({ items: artifacts })).filter(node => node.type === 'button' && node.children.includes('用DSH打开文件')).length, 3)
  e.unmount()
})

test('native file actions use the selected recorded session and the shipped segment encoder for drive, UNC and POSIX paths', async () => {
  const sessionId = 'recorded:会话/#% ?'
  const opened = [], gets = [], ctx = { get(name, strict) { gets.push([name, strict]); return name === 'sidebarRight' ? { mounted: { getSnapshot: () => sessionId, subscribe: () => () => {} }, openResource(address) { opened.push(address) } } : undefined } }
  const e = carrier({ ctx }); await e.mount()
  const task = { ...tasks[0], sessionId }
  const paths = ['E:\\资料 空间\\a #100%?.RIS', '\\\\server\\共享\\file #%.BIB', '/tmp/中文 a#%?.md']
  await e.openTask(detail(task, paths.map(path => ({ path }))))
  assert.deepEqual(opened, [], 'Rendering must not open resources')
  const expected = [
    'dsh-resource://file/session/recorded:%E4%BC%9A%E8%AF%9D%2F%23%25%20%3F/E:/%E8%B5%84%E6%96%99%20%E7%A9%BA%E9%97%B4/a%20%23100%25%3F.RIS',
    'dsh-resource://file/session/recorded:%E4%BC%9A%E8%AF%9D%2F%23%25%20%3F///server/%E5%85%B1%E4%BA%AB/file%20%23%25.BIB',
    'dsh-resource://file/session/recorded:%E4%BC%9A%E8%AF%9D%2F%23%25%20%3F//tmp/%E4%B8%AD%E6%96%87%20a%23%25%3F.md',
  ]
  for (let index = 0; index < paths.length; index++) {
    const open = nodes(taskPane(e.tree)).filter(node => node.type === 'button' && node.children.includes('用DSH打开文件'))[index]
    assert.ok(open, 'Each absolute artifact needs a native open action'); open.props.onClick(); await e.flush()
    assert.equal(opened[index], expected[index])
  }
  assert.ok(gets.every(([name, strict]) => name === 'sidebarRight' && strict === false), 'An optional native service needs lenient lookup')
  assert.match(text(taskPane(e.tree)), /已请求.*DSH.*打开|已请求.*打开.*文件/)
  assert.doesNotMatch(text(taskPane(e.tree)), /任务已继续|任务已完成/)
  e.unmount()
})

test('native file errors remain inside the selected detail and never borrow the current butler session', async () => {
  for (const failure of ['missing-session', 'invalid-session', 'missing-service', 'throwing-service', 'strict-context']) {
    const opened = [], file = 'E:/资料/keep.ris'
    let ctx = { get: () => ({ mounted: { getSnapshot: () => tasks[0].sessionId, subscribe: () => () => {} }, openResource(address) { if (failure === 'throwing-service') throw new Error('native viewer refused'); opened.push(address) } }) }
    if (failure === 'missing-service') ctx = {}
    if (failure === 'strict-context') ctx = { get() { throw new Error('optional unavailable') }, get sidebarRight() { throw new Error('strict property denied') } }
    const e = carrier({ ctx }); await e.mount()
    const task = { ...tasks[0], ...(failure === 'missing-session' ? { sessionId: undefined } : failure === 'invalid-session' ? { sessionId: 'wrong\nsession' } : {}) }
    await e.openTask(detail(task, [{ path: file }]))
    const open = button(taskPane(e.tree), '用DSH打开文件'); assert.ok(open); open.props.onClick(); await e.flush()
    assert.equal(opened.length, 0, failure)
    assert.ok(nodes(taskPane(e.tree)).some(isAlert), failure + ' must surface in this task')
    assert.ok(text(taskPane(e.tree)).includes(file))
    if (failure === 'throwing-service') assert.match(text(taskPane(e.tree)), /native viewer refused/)
    if (failure === 'strict-context') assert.match(text(taskPane(e.tree)), /strict property denied/)
    e.unmount()
  }
})

test('task continuation shows its exact full ID, copies only on click and opens its exact recorded source with a truthful navigation receipt', async () => {
  const copied = [], opened = [], ctx = { uiWorkspace: { openSession(id) { opened.push(id) } } }
  const e = carrier({ ctx, clipboard: { writeText: async value => { copied.push(value) } } }); await e.mount(); await e.openTask()
  const command = nodes(taskPane(e.tree)).find(node => node.type === 'input' && node.props['aria-label'] === '任务接续指令')
  assert.ok(command, 'The exact continuation command needs a manual copy field')
  assert.equal(command.props.readOnly, true); assert.equal(command.props.value, `继续任务 ${tasks[0].id}`)
  assert.deepEqual(copied, []); assert.deepEqual(opened, [])
  button(taskPane(e.tree), '复制接续指令').props.onClick()
  assert.deepEqual([...copied], [`继续任务 ${tasks[0].id}`], 'Clipboard access must start directly in the user click gesture')
  await e.flush()
  assert.deepEqual(copied, [`继续任务 ${tasks[0].id}`]); assert.match(text(taskPane(e.tree)), /已复制/)
  button(taskPane(e.tree), '打开来源会话').props.onClick(); await e.flush()
  assert.deepEqual(opened, [tasks[0].sessionId]); assert.match(text(taskPane(e.tree)), /已请求.*来源会话/)
  assert.doesNotMatch(text(taskPane(e.tree)), /任务已继续|任务已恢复|任务已完成/)
  assert.equal(e.requests.filter(row => !/^\/dsh-butler\/api\/(overview|note|task)/.test(row.path)).length, 0)
  e.unmount()
})

test('unavailable or rejected clipboard keeps the exact manual command and a useful copy error in the selected task', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('clipboard blocked') } }]) {
    const e = carrier({ clipboard }); await e.mount(); await e.openTask()
    const copy = button(taskPane(e.tree), '复制接续指令'); assert.ok(copy); copy.props.onClick(); await e.flush()
    assert.match(text(taskPane(e.tree)), /手动复制/)
    assert.equal(nodes(taskPane(e.tree)).find(node => node.props?.['aria-label'] === '任务接续指令').props.value, `继续任务 ${tasks[0].id}`)
    if (clipboard) assert.match(text(taskPane(e.tree)), /clipboard blocked/)
    assert.ok(nodes(taskPane(e.tree)).some(isAlert))
    e.unmount()
  }
})

test('continuation and source navigation validate single-line bounded identifiers without deriving them from titles', async () => {
  const e = carrier(), { taskDetailPane } = e.load('src/client/workbench-details.ts')
  for (const id of ['', '   ', 'bad\ncommand', 'bad\rcommand', 'bad\0command', 'bad\u2028command', 'x'.repeat(513)]) {
    const tree = taskDetailPane(detail({ ...tasks[0], id }), () => {}, () => {}, () => {}, {})
    const field = nodes(tree).find(node => node.props?.['aria-label'] === '任务接续指令')
    assert.ok(!field || field.props.value === '', 'Invalid IDs must never become executable-looking commands')
    const copy = button(tree, '复制接续指令'); assert.ok(!copy || copy.props.disabled)
    assert.match(text(tree), /任务.*ID.*无效|任务.*标识.*无效/)
  }
  for (const sessionId of [undefined, '', 'bad\nsession', 'x'.repeat(513)]) {
    const opened = [], view = carrier({ ctx: { uiWorkspace: { openSession: id => opened.push(id) } } })
    await view.mount(); await view.openTask(detail({ ...tasks[0], sessionId }))
    const open = button(taskPane(view.tree), '打开来源会话'); assert.ok(open); open.props.onClick(); await view.flush()
    assert.deepEqual(opened, []); assert.ok(nodes(taskPane(view.tree)).some(isAlert)); view.unmount()
  }
})

test('source navigation surfaces optional-service absence and native exceptions', async () => {
  for (const ctx of [{}, { get: () => ({ openSession() { throw new Error('source denied') } }) }]) {
    const e = carrier({ ctx }); await e.mount(); await e.openTask()
    const open = button(taskPane(e.tree), '打开来源会话'); assert.ok(open); open.props.onClick(); await e.flush()
    assert.ok(nodes(taskPane(e.tree)).some(isAlert))
    assert.match(text(taskPane(e.tree)), /uiWorkspace\.openSession|source denied/); e.unmount()
  }
})

test('continue with butler performs a fresh readiness read on every click and never sends the displayed command', async () => {
  const opened = [], panels = [], ctx = { uiWorkspace: { openSession: id => opened.push(id) }, layout: { selectPanel: id => panels.push(id) } }
  const e = carrier({ ctx }); await e.mount(); await e.openTask()
  const continued = button(taskPane(e.tree), '和管家继续'); assert.ok(continued); continued.props.onClick(); await e.flush()
  const fresh = e.latest(/\/overview$/); assert.ok(fresh, 'Cached readiness must not navigate immediately'); assert.deepEqual(opened, [])
  e.reply(fresh, { ok: true, session: { ...readySession, ready: undefined, note: 'native not ready' } }); await e.flush()
  assert.deepEqual(opened, []); assert.deepEqual(panels, ['butler']); assert.match(text(taskPane(e.tree)), /native not ready/)
  button(taskPane(e.tree), '和管家继续').props.onClick(); await e.flush()
  e.reply(e.latest(/\/overview$/), { ok: true, session: readySession }); await e.flush()
  assert.deepEqual(opened, [readySession.id]); assert.match(text(taskPane(e.tree)), /已请求.*管家会话/)
  assert.doesNotMatch(text(taskPane(e.tree)), /任务已继续|任务已恢复/)
  assert.ok(e.requests.every(row => /^\/dsh-butler\/api\/(overview|note|task)/.test(row.path))); e.unmount()
})

test('an old async copy result cannot replace feedback after the user selects another task', async () => {
  let resolveCopy
  const e = carrier({ clipboard: { writeText: () => new Promise(resolve => { resolveCopy = resolve }) } }); await e.mount(); await e.openTask()
  const copy = button(taskPane(e.tree), '复制接续指令'); assert.ok(copy); copy.props.onClick(); await e.flush()
  const request = await e.selectTask(1); e.reply(request, detail(tasks[1])); await e.flush()
  resolveCopy(); await e.flush()
  assert.doesNotMatch(text(taskPane(e.tree)), /已复制/); assert.ok(text(taskPane(e.tree)).includes(tasks[1].id)); e.unmount()
})

test('a delayed task detail opens its drawer when settled and dashboard polls never reset the open drawer', async () => {
  const e = carrier(); await e.mount(); const request = await e.selectTask()
  const loading = drawer(e.tree); assert.ok(loading, 'Selection opens the detail drawer before the read settles')
  assert.equal(loading.props.open, true); assert.equal(loading.props.title, '任务详情')
  assert.equal(e.scrolls.length, 0, 'Opening a detail drawer must not scroll the page')
  e.reply(request, detail()); await e.flush()
  assert.ok(taskPane(e.tree)); assert.equal(drawer(e.tree).props.title, tasks[0].title)
  await e.poll(); e.reply(e.latest(/\/task\?id=/), detail()); await e.flush()
  assert.ok(taskPane(e.tree), 'A poll of the same task must keep the open drawer content')
  assert.equal(drawer(e.tree).props.open, true); assert.equal(e.scrolls.length, 0)
  button(taskPane(e.tree), '关闭任务详情').props.onClick(); await e.flush()
  assert.equal(drawer(e.tree), undefined, 'Closing the detail resets the selection')
  await e.openTask(); assert.ok(drawer(e.tree), 'A later explicit open mounts the drawer again')
  assert.equal(e.scrolls.length, 0); e.unmount()
})

test('a task read error settles visibly in the drawer and stays closeable', async () => {
  const e = carrier(); await e.mount(); const request = await e.selectTask()
  assert.ok(drawer(e.tree), 'The drawer stays mounted while the read is pending')
  request.reject(new Error('selected task unavailable')); await e.flush()
  assert.equal(e.scrolls.length, 0)
  const failed = drawer(e.tree); assert.ok(failed)
  assert.equal(failed.props.title, '任务详情')
  assert.match(JSON.stringify(failed), /selected task unavailable/)
  assert.ok(nodes(failed).some(isAlert), 'A failed read must be announced')
  failed.props.onClose(); await e.flush()
  assert.equal(drawer(e.tree), undefined); assert.doesNotMatch(text(e.tree), /selected task unavailable/); e.unmount()
})

test('aborted task requests cannot replace a later selection or a closed drawer', async () => {
  const e = carrier(); await e.mount(); const first = await e.selectTask(), second = await e.selectTask(1)
  assert.equal(first.signal.aborted, true); e.reply(second, detail(tasks[1])); await e.flush()
  e.reply(first, detail()); await e.flush()
  assert.ok(text(taskPane(e.tree)).includes(tasks[1].id))
  await e.poll(); const late = e.latest(/\/task\?id=/)
  button(taskPane(e.tree), '关闭任务详情').props.onClick(); await e.flush(); assert.equal(late.signal.aborted, true)
  e.reply(late, detail(tasks[1])); await e.flush(); assert.equal(drawer(e.tree), undefined); assert.equal(taskPane(e.tree), undefined); e.unmount()
})

test('a delayed note opens its drawer, keeps it across same-note polling and reopens after close', async () => {
  const e = carrier(); await e.mount(); const request = await e.selectNote('alpha')
  assert.ok(drawer(e.tree), 'Selecting a note opens its drawer before the read settles')
  assert.equal(e.scrolls.length, 0); e.reply(request, note('alpha')); await e.flush()
  assert.match(text(e.tree), /Body alpha/); assert.equal(e.scrolls.length, 0)
  await e.poll(); e.reply(e.latest(/\/note\?slug=/), note('alpha')); await e.flush()
  assert.match(text(e.tree), /Body alpha/, 'A poll keeps the open note drawer')
  button(e.tree, '关闭').props.onClick(); await e.flush(); assert.doesNotMatch(text(e.tree), /Body alpha/)
  const again = await e.selectNote('alpha'); e.reply(again, note('alpha')); await e.flush()
  assert.match(text(e.tree), /Body alpha/); e.unmount()
})

test('a selected note error stays visible and closeable while aborted old note reads cannot replace it', async () => {
  const e = carrier(); await e.mount(); const alpha = await e.selectNote('alpha'), beta = await e.selectNote('beta')
  assert.equal(alpha.signal.aborted, true); beta.reject(new Error('beta failed')); await e.flush()
  assert.equal(e.scrolls.length, 0); assert.match(text(e.tree), /beta failed/)
  assert.ok(nodes(drawer(e.tree)).some(isAlert))
  e.reply(alpha, note('alpha')); await e.flush(); assert.doesNotMatch(text(e.tree), /Body alpha/)
  const close = button(e.tree, '关闭'); assert.ok(close); close.props.onClick(); await e.flush()
  const loading = await e.selectNote('alpha'), closeLoading = button(e.tree, '关闭'); assert.ok(closeLoading); closeLoading.props.onClick(); await e.flush()
  assert.equal(loading.signal.aborted, true); e.reply(loading, note('alpha')); await e.flush()
  assert.doesNotMatch(text(e.tree), /Body alpha|beta failed/); e.unmount()
})

test('a global workbench file click navigates to its exact source, waits for the native header commit and opens once', async () => {
  const surface = fileSurface(), e = carrier({ ctx: surface.ctx }), file = 'E:/资料/from workbench.ris'
  await e.mount(); await e.openTask(detail(tasks[0], [{ path: file }]))
  button(taskPane(e.tree), '用DSH打开文件').props.onClick(); await e.flush()
  assert.deepEqual(surface.navigated, [tasks[0].sessionId], 'The global panel has no native surface; it must reveal the recorded source first')
  assert.equal(surface.opened.length, 0); assert.equal(surface.subscriptions, 1)
  e.unmount(); surface.show(tasks[0].sessionId)
  assert.equal(surface.opened.length, 0, 'The mounted subscriber fires before the native store exists and must not open')
  await e.mountHeader(surface.commit)
  assert.equal(surface.opened.length, 1); assert.match(surface.opened[0], /session\/recorded-task-a-full-id\/E:\//)
  assert.match(text(e.tree), /已请求.*DSH.*打开|已请求.*打开.*文件/)
  surface.show(tasks[0].sessionId); await e.flush(); assert.equal(surface.opened.length, 1, 'Repeated native snapshots cannot repeat the open')
  e.unmount(); e.disposePlugin()
})

test('a newer file request replaces the pending one instead of opening both after mount', async () => {
  const surface = fileSurface(), e = carrier({ ctx: surface.ctx })
  await e.mount(); await e.openTask(detail(tasks[0], [{ path: 'E:/old.ris' }, { path: 'E:/new.bib' }]))
  const opens = nodes(taskPane(e.tree)).filter(node => node.type === 'button' && node.children.includes('用DSH打开文件'))
  opens[0].props.onClick(); opens[1].props.onClick(); await e.flush()
  assert.deepEqual(surface.navigated, [tasks[0].sessionId, tasks[0].sessionId]); assert.equal(surface.subscriptions, 1)
  e.unmount(); surface.show(tasks[0].sessionId); await e.mountHeader(surface.commit)
  assert.equal(surface.opened.length, 1); assert.match(surface.opened[0], /new\.bib$/)
  e.unmount(); e.disposePlugin()
})

test('foreign session selection, timeout and plugin disposal cancel pending native file opens without a late open', async () => {
  for (const cancellation of ['foreign-session', 'timeout', 'plugin-disposal']) {
    const surface = fileSurface(), e = carrier({ ctx: surface.ctx })
    await e.mount(); await e.openTask(detail(tasks[0], [{ path: 'E:/keep.ris' }]))
    button(taskPane(e.tree), '用DSH打开文件').props.onClick(); await e.flush()
    assert.deepEqual(surface.navigated, [tasks[0].sessionId]); e.unmount()
    if (cancellation === 'foreign-session') surface.show('user-selected-another-session')
    if (cancellation === 'timeout') e.expireTimeouts()
    if (cancellation === 'plugin-disposal') e.disposePlugin()
    assert.equal(surface.subscriptions, 0, cancellation + ' must release its native subscription')
    surface.show(tasks[0].sessionId); await e.mountHeader(surface.commit)
    assert.equal(surface.opened.length, 0, cancellation + ' must not open a late resource')
    if (cancellation !== 'plugin-disposal') assert.match(text(e.tree), /已取消|超时/)
    e.unmount(); e.disposePlugin()
  }
})

test('a native failure after handoff appears in its source header and when the owner returns to that exact task', async () => {
  const surface = fileSurface({ fail: true }), e = carrier({ ctx: surface.ctx }), file = 'E:/keep failure.ris'
  await e.mount(); await e.openTask(detail(tasks[0], [{ path: file }]))
  button(taskPane(e.tree), '用DSH打开文件').props.onClick(); await e.flush()
  assert.deepEqual(surface.navigated, [tasks[0].sessionId]); e.unmount(); surface.show(tasks[0].sessionId)
  await e.mountHeader(surface.commit); assert.match(text(e.tree), /native viewer refused after mount/)
  assert.ok(text(e.tree).includes(file)); assert.ok(nodes(e.tree).some(isAlert))
  e.unmount(); surface.show(undefined); await e.mount(); await e.openTask(detail(tasks[1], [{ path: 'E:/unrelated.bib' }]))
  assert.doesNotMatch(text(taskPane(e.tree)), /native viewer refused after mount/)
  await e.openTask(detail(tasks[0], [{ path: file }]))
  assert.match(text(taskPane(e.tree)), /native viewer refused after mount/); assert.ok(text(taskPane(e.tree)).includes(file))
  e.unmount(); e.disposePlugin()
})

test('one-click task actions send exactly one local bookkeeping request and refresh the dashboard', async () => {
  const e = carrier(); await e.mount()
  const button = nodes(e.tree).find(node => node.props?.ariaLabel === `完成任务：${tasks[0].title}`)
  assert.equal(typeof button?.props?.onClick, 'function', 'Open tasks offer one-click completion')
  button.props.onClick(); await e.flush()

  const actions = e.requests.filter(request => request.path === '/dsh-butler/api/action')
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].body, { action: 'task-done', id: tasks[0].id })

  e.reply(actions[0], { ok: true, action: 'task-done', task: { id: tasks[0].id, title: tasks[0].title, status: 'done', updatedAt: at } })
  await e.flush()
  const notices = nodes(e.tree).find(node => node.type?.name === 'NoticeRegion')?.props?.notices ?? []
  assert.ok(notices.some(notice => String(notice.text).includes(`已标记完成：${tasks[0].title}`)), 'The action is announced in the live region')
  const refreshed = e.latest(/\/overview$/)
  assert.ok(refreshed, 'A successful action re-reads the dashboard instead of trusting local state')
  e.reply(refreshed, overview(`${at}-refreshed`)); await e.flush()
  assert.equal(e.requests.filter(request => request.path === '/dsh-butler/api/action').length, 1)
})

test('due reminders surface above the zones and can be acknowledged', async () => {
  const e = carrier(); await e.mount()
  const due = { id: 'reminder-due-1', title: '吃药', scheduledAt: '2026-10-21T11:00:00Z', status: 'active' }
  await e.poll(overview(at, { reminders: [due] }))
  assert.match(text(e.tree), /到期提醒 1 条/)
  assert.match(text(e.tree), /吃药/)
  const acknowledge = nodes(e.tree).find(node => node.props?.['aria-label'] === '知道了：吃药')
  assert.equal(typeof acknowledge?.props?.onClick, 'function', 'Each due reminder can be acknowledged')
  acknowledge.props.onClick(); await e.flush()
  assert.doesNotMatch(text(e.tree), /到期提醒 1 条/, 'Acknowledged reminders leave the banner')
})

test('a due reminder in the banner can be snoozed or completed through the reminder action route', async () => {
  const e = carrier(); await e.mount()
  const due = { id: 'rem-one-shot', kind: 'at', title: '吃药', scheduledAt: '2026-10-21T11:00:00Z', status: 'active' }
  await e.poll(overview(at, { reminders: [due] }))
  const complete = nodes(e.tree).find(node => node.props?.['aria-label'] === '完成提醒：吃药')
  assert.equal(typeof complete?.props?.onClick, 'function', 'A due one-shot reminder can be completed')
  complete.props.onClick(); await e.flush()

  const actions = e.requests.filter(request => request.path === '/dsh-butler/api/reminder-action')
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].body, { action: 'complete', id: 'rem-one-shot' })
  e.reply(actions[0], { ok: true, action: 'complete', scheduleId: 'rem-one-shot', task: null })
  await e.flush()
  const refreshed = e.latest(/\/overview$/)
  assert.ok(refreshed, 'A successful reminder action re-reads the dashboard')
  e.reply(refreshed, overview(`${at}-reminder-refreshed`, { reminders: [] })); await e.flush()
  assert.doesNotMatch(text(e.tree), /到期提醒 1 条/)
})

test('a proposed memory can be confirmed from the workbench drawer and refreshes the dashboard', async () => {
  const e = carrier(); await e.mount()
  const memo = { id: 'memo-proposed-1', text: '偏好中文交流', source: 'butler', createdAt: at, status: 'proposed' }
  await e.poll(overview(at, { ledger: { open: tasks, interrupted: [], pending: [], recent: [], proposedMemos: [memo] } }))
  const row = nodes(e.tree).find(node => node.props?.['aria-label'] === '查看记忆提案：偏好中文交流')
  assert.equal(typeof row?.props?.onClick, 'function', 'A proposed memory shows in the decisions zone')
  row.props.onClick(); await e.flush()
  const confirm = nodes(e.tree).find(node => node.props?.['aria-label'] === '确认记忆提案')
  assert.equal(typeof confirm?.props?.onClick, 'function', 'The memo drawer offers a direct confirmation')
  confirm.props.onClick(); await e.flush()

  const actions = e.requests.filter(request => request.path === '/dsh-butler/api/memo-action')
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].body, { action: 'confirm', id: 'memo-proposed-1' })
  e.reply(actions[0], { ok: true, action: 'confirm', memo: { id: memo.id, status: 'confirmed', text: memo.text } })
  await e.flush()
  const notices = nodes(e.tree).find(node => node.type?.name === 'NoticeRegion')?.props?.notices ?? []
  assert.ok(notices.some(notice => String(notice.text).includes('已记住')), 'The decision is announced')
  const refreshed = e.latest(/\/overview$/)
  assert.ok(refreshed, 'A confirmed memory re-reads the dashboard')
  e.reply(refreshed, overview(`${at}-memo-refreshed`, { ledger: { open: tasks, interrupted: [], pending: [], recent: [], proposedMemos: [] } })); await e.flush()
})

test('global search asks the host and opens the selected note result', async () => {
  const e = carrier(); await e.mount()
  const input = nodes(e.tree).find(node => node.props?.['aria-label'] === '搜索管家资料')
  assert.equal(typeof input?.props?.onChange, 'function', 'The workbench offers a global search input')
  input.props.onChange({ target: { value: 'alpha' } }); await e.flush()
  const form = nodes(e.tree).find(node => node.type === 'form')
  form.props.onSubmit({ preventDefault() {} }); await e.flush()

  const request = e.latest(/\/search\?q=/)
  assert.equal(request.path, '/dsh-butler/api/search?q=alpha')
  e.reply(request, { ok: true, query: 'alpha', notes: [{ kind: 'note', id: 'alpha', title: 'Alpha', snippet: '…alpha…', path: 'notes/alpha.md' }], tasks: [], memory: [], total: 1, truncated: false })
  await e.flush()
  const hit = nodes(e.tree).find(node => node.props?.['aria-label'] === '打开搜索结果：Alpha')
  assert.equal(typeof hit?.props?.onClick, 'function', 'Search hits are clickable')
  hit.props.onClick(); await e.flush()
  assert.ok(e.latest(/\/note\?slug=alpha/), 'A note hit opens the note drawer')
})

test('quick capture turns one typed thought into a pending task and refreshes', async () => {
  const e = carrier(); await e.mount()
  const input = nodes(e.tree).find(node => node.props?.['aria-label'] === '捕获内容（记成待办）')
  assert.equal(typeof input?.props?.onChange, 'function', 'The workbench offers a quick capture input')
  input.props.onChange({ target: { value: '写一篇酶稳定性综述' } }); await e.flush()
  const form = nodes(e.tree).find(node => node.type === 'form'
    && node.children.some(child => child?.type === 'button' && child.children?.includes('记成待办')))
  form.props.onSubmit({ preventDefault() {} }); await e.flush()

  const action = e.requests.find(request => request.path === '/dsh-butler/api/capture')
  assert.deepEqual(action.body, { title: '写一篇酶稳定性综述' })
  e.reply(action, { ok: true, task: { id: 'task-captured', title: '写一篇酶稳定性综述', status: 'pending', createdAt: at, updatedAt: at } })
  await e.flush()
  const notices = nodes(e.tree).find(node => node.type?.name === 'NoticeRegion')?.props?.notices ?? []
  assert.ok(notices.some(notice => String(notice.text).includes('已记为待办')), 'Capture is announced')
  assert.ok(e.latest(/\/overview$/), 'Capture re-reads the dashboard')
  const refreshed = e.latest(/\/overview$/)
  e.reply(refreshed, overview(`${at}-capture`)); await e.flush()
})
