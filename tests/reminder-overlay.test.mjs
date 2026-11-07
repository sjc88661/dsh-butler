/**
 * 到期提醒浮层的纯逻辑：occurrence key、已确认过滤、localStorage 往返/坏数据。
 *
 * 组件本身依赖 React 与轮询副作用，由面板 harness 覆盖；这里用最小 fake
 * require 只测可被 UI 误用的判定逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
const ts = createRequire(join(checkout, 'package.json'))('typescript')
const sourcePath = join(root, 'src/client/reminder-overlay.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

/** Minimal module map: the overlay's UI/service imports are not under test here. */
function load({ storage } = {}) {
  const module = { exports: {} }
  const store = storage ?? new Map()
  const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => { store.set(key, String(value)) },
  }
  const require = id => {
    if (id === 'react') return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
    if (id.endsWith('./api.ts')) return {}
    if (id.endsWith('./navigate.ts')) return { openButlerConversation: async () => ({ ok: true }) }
    if (id.endsWith('./ui/index.ts')) return { BUTLER_COLORS: { bgOverlay: '#fff', labelPrimary: '#000', labelSecondary: '#666', warn: '#c60' }, BUTLER_SPACE: { xs: '4px', sm: '8px', md: '12px' } }
    if (id.endsWith('./visibility.ts')) return { documentHidden: () => false, onDocumentVisible: () => () => {} }
    throw new Error(`unexpected import: ${id}`)
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, require, localStorage, console, JSON, Object, Array, Date, String, Number }, { filename: sourcePath })
  return { ...module.exports, store }
}

const { dueCardKey, visibleDueReminders, readDismissed, writeDismissed, DUE_DISMISS_KEY } = load()

const occurrence = (id, scheduledAt) => ({ id, title: id, scheduledAt })

test('an occurrence key includes the scheduled instant so a recurring rule resurfaces', () => {
  assert.equal(dueCardKey(occurrence('rem-1', '2026-11-07T12:00:00.000Z')), 'rem-1@2026-11-07T12:00:00.000Z')
  assert.notEqual(dueCardKey(occurrence('rem-1', '2026-11-07T12:00:00.000Z')), dueCardKey(occurrence('rem-1', '2026-11-08T12:00:00.000Z')))
  assert.equal(dueCardKey({ id: 'rem-no-time' }), 'rem-no-time@')
})

test('acknowledged occurrences are filtered while a new occurrence of the same rule shows', () => {
  const old = occurrence('rem-1', '2026-11-07T12:00:00.000Z')
  const next = occurrence('rem-1', '2026-11-08T12:00:00.000Z')
  const other = occurrence('rem-2', '2026-11-07T12:00:00.000Z')
  const dismissed = { [dueCardKey(old)]: true }
  assert.deepEqual([...visibleDueReminders([old, next, other], dismissed)].map(row => dueCardKey(row)), [dueCardKey(next), dueCardKey(other)])
  assert.deepEqual([...visibleDueReminders([old], {})].map(row => row.id), ['rem-1'])
})

test('dismissed keys round-trip through storage and tolerate damaged values', () => {
  const instance = load()
  const value = { 'rem-1@2026-11-07T12:00:00.000Z': true }
  instance.writeDismissed(value)
  assert.equal(instance.store.get(DUE_DISMISS_KEY), JSON.stringify(value))
  assert.deepEqual(JSON.parse(JSON.stringify(instance.readDismissed())), value)

  const damaged = load({ storage: new Map([[DUE_DISMISS_KEY, '{not-json']]) })
  assert.deepEqual(JSON.parse(JSON.stringify(damaged.readDismissed())), {})

  const wrongShape = load({ storage: new Map([[DUE_DISMISS_KEY, '["a"]']]) })
  assert.deepEqual(JSON.parse(JSON.stringify(wrongShape.readDismissed())), {})

  const partial = load({ storage: new Map([[DUE_DISMISS_KEY, JSON.stringify({ a: true, b: 'yes', c: false })]]) })
  assert.deepEqual(JSON.parse(JSON.stringify(partial.readDismissed())), { a: true })
})

test('an unreadable storage backend degrades to "nothing acknowledged" instead of throwing', () => {
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: id => {
      if (id === 'react') return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
      if (id.endsWith('./api.ts') || id.endsWith('./navigation.ts')) return {}
      if (id.endsWith('./navigate.ts')) return { openButlerConversation: async () => ({ ok: true }) }
      if (id.endsWith('./ui/index.ts')) return { BUTLER_COLORS: {}, BUTLER_SPACE: {} }
      if (id.endsWith('./visibility.ts')) return { documentHidden: () => false, onDocumentVisible: () => () => {} }
      return {}
    },
    localStorage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } },
    console, JSON, Object, Array, Date, String, Number,
  }, { filename: sourcePath })
  assert.deepEqual(JSON.parse(JSON.stringify(module.exports.readDismissed())), {})
  assert.doesNotThrow(() => module.exports.writeDismissed({ a: true }))
})
