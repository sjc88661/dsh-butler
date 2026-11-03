/**
 * 轮询可见性判据的单元测试。
 *
 * `src/client/visibility.ts` 被 `useWorkspaceRead` 和工作台 15s 轮询共用：
 * 文档隐藏或右栏页签隐藏时，轮询不应继续发请求。这里在 vm 里用假的
 * document/window 验证三个导出；不启动宿主，也不渲染 React。
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
const sourcePath = join(root, 'src/client/visibility.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

/** Load the compiled module inside a fresh vm context with the given DOM globals. */
function load(globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: () => ({}),
    console,
    ...globals,
  }, { filename: sourcePath })
  return module.exports
}

test('no DOM: hidden is false and the visible listener is a safe no-op', () => {
  const visibility = load()
  assert.equal(visibility.documentHidden(), false)
  assert.equal(visibility.rightPaneVisible(), true, 'unmounted right pane must not gate other pollers')
  const cancel = visibility.onDocumentVisible(() => { throw new Error('must not fire without DOM') })
  assert.equal(typeof cancel, 'function')
  assert.doesNotThrow(cancel)
})

test('documentHidden follows the document visibility state', () => {
  let state = 'visible'
  const visibility = load({ document: { get visibilityState() { return state }, addEventListener() {}, removeEventListener() {} } })
  assert.equal(visibility.documentHidden(), false)
  state = 'hidden'
  assert.equal(visibility.documentHidden(), true)
  state = 'visible'
  assert.equal(visibility.documentHidden(), false)
})

test('the right pane flag is reported and readable by pollers', () => {
  const visibility = load()
  visibility.setRightPaneVisible(false)
  assert.equal(visibility.rightPaneVisible(), false)
  visibility.setRightPaneVisible(true)
  assert.equal(visibility.rightPaneVisible(), true)
})

test('onDocumentVisible fires only when returning to visible and its disposer detaches', () => {
  let state = 'hidden'
  const listeners = new Set()
  const document = {
    get visibilityState() { return state },
    addEventListener(type, handler) { if (type === 'visibilitychange') listeners.add(handler) },
    removeEventListener(type, handler) { if (type === 'visibilitychange') listeners.delete(handler) },
  }
  const visibility = load({ document, window: { addEventListener() {} } })
  let fired = 0
  const cancel = visibility.onDocumentVisible(() => { fired += 1 })
  assert.equal(listeners.size, 1)
  // hidden -> still hidden: no callback
  for (const handler of listeners) handler()
  assert.equal(fired, 0)
  state = 'visible'
  for (const handler of listeners) handler()
  assert.equal(fired, 1)
  cancel()
  assert.equal(listeners.size, 0)
  for (const handler of listeners) handler()
  assert.equal(fired, 1, 'disposed listener must not fire again')
})
