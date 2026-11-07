/** Real Cordis authority regression; in-memory services/React hooks, no Host, DOM or HTTP. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
const nativeRequire = createRequire(join(checkout, 'package.json'))
const ts = nativeRequire('typescript')
assert.equal(ts.version, '6.0.3')
const archive = readFileSync(process.env.DSH_NATIVE_ASAR || 'E:/DSH/resources/app.asar')
const offset = 8 + archive.readUInt32LE(4)
const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)))
function member(path, expectedSha256) {
  let row = header
  for (const key of path.split('/')) row = row.files[key]
  assert.ok(!row.link && !row.unpacked && Number.isSafeInteger(row.size))
  const bytes = archive.subarray(offset + Number(row.offset), offset + Number(row.offset) + row.size)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha256, `Native member changed: ${path}`)
  return bytes.toString('utf8')
}
const nativeSources = new Map([
  ['@deepseek-ai/cordis', member('dsh/node_modules/@deepseek-ai/cordis/lib/index.js', '627409afa06a265f7253200d3bc4648e88805c39fd3768568eb9b9518a31fe8f')],
  ['@deepseek-ai/cosmokit', member('dsh/node_modules/@deepseek-ai/cosmokit/lib/index.js', 'ba44c0871656e4c7cac2c3c8a2ff644e0d2eb9d6bda7f6355866d686d513268e')],
])
const react = { createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useMemo: value => value(), useCallback: value => value,
  useRef: value => ({ current: value }) }
const cache = new Map()
function evaluate(id, source, require) {
  if (cache.has(id)) return cache.get(id).exports
  const module = { exports: {} }; cache.set(id, module)
  const compiled = ts.transpileModule(source, { fileName: id.endsWith('.ts') ? id : id + '.js',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true, allowImportingTsExtensions: true } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports, require,
    console: { info() {}, warn() {}, error() {}, log() {} }, setTimeout, clearTimeout, setImmediate, queueMicrotask, Buffer, TextEncoder, TextDecoder, AbortController, URL }, { filename: id })
  return module.exports
}
function load(id) {
  if (id === 'react') return react
  if (nativeSources.has(id)) return evaluate(id, nativeSources.get(id), load)
  const file = resolve(id)
  return evaluate(file, readFileSync(file, 'utf8'), specifier => specifier === 'react' ? react : load(resolve(dirname(file), specifier)))
}
const { Context } = load('@deepseek-ai/cordis')
const client = load(join(root, 'src/client/index.ts'))
const navigation = load(join(root, 'src/client/navigate.ts'))

async function mounted(plugin, exercise) {
  const ctx = new Context(), registrations = [], selected = [], tabTypes = []
  const slots = { inject(_name, callback) { return callback() }, register(options, component) { registrations.push({ options, component }); return () => {} } }
  const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: null }) }, selectPanel: id => selected.push(id) }
  const provider = ctx.plugin({ name: 'layout-regression-provider', apply(scope) { scope.provide('slots', slots); scope.provide('layout', layout); scope.provide('sidebarRightTabs', { register(definition) { tabTypes.push(definition); return () => {} } }) } })
  await provider.await()
  const consumer = ctx.plugin({ name: 'layout-regression-client', inject: Array.from(plugin.inject), apply: plugin.apply })
  await consumer.await()
  try {
    assert.equal(provider.state, 2); assert.equal(consumer.state, 2)
    assert.deepEqual(registrations.map(row => row.options.name), ['conversation.session.header.actions', 'sidebar.panellist', 'main', 'conversation.view', 'conversation.input.dock', 'sidebar.right.pane.tab'])
    assert.equal(tabTypes[0].kind, 'butler-workspace')
    assert.equal(registrations.find(row => row.options.name === 'sidebar.right.pane.tab').options.key, tabTypes[0].id, 'Native registry and body use the same exact public identity')
    assert.equal(registrations.find(row => row.options.name === 'sidebar.panellist').options.id, 'butler')
    const headerAction = registrations[0], ownedContext = headerAction.options.inject().ctx
    return await exercise({ headerAction, ownedContext, selected })
  } finally { await consumer.dispose(); await provider.dispose() }
}

test('real native Cordis reproduces denied layout access with the legacy slots-only declaration', async () => {
  await mounted({ ...client, inject: ['slots'] }, ({ headerAction, ownedContext }) => {
    assert.throws(() => headerAction.component({ ctx: ownedContext }), /cannot get property "layout" without inject/)
    assert.throws(() => navigation.selectWorkbench(ownedContext), /cannot get property "layout" without inject/)
  })
})

test('client declares layout authority so the real header and workbench navigation can access it', async () => {
  await mounted(client, ({ headerAction, ownedContext, selected }) => {
    assert.doesNotThrow(() => headerAction.component({ ctx: ownedContext }))
    assert.equal(navigation.selectWorkbench(ownedContext).ok, true)
    assert.deepEqual(selected, ['butler'])
  })
})

test('client metadata requests the actual slot renderer and layout providers', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@dsh-external/dsh-butler')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-layout'])
})
