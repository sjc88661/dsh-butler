/**
 * 宿主模块加载器的定位规则测试。
 *
 * 背景：管家以 `link:` 工作区目录安装时，普通 Node 解析看不到 DSH 安装自带的
 * `node_modules`，专属会话需要的 `@deepseek-ai/dsh-agent` 会加载失败。这里在
 * Node 里验证"候选安装根"的排序/去重/布局规则，以及失败时的错误清单，不启动
 * 宿主、不加载真实 dsh-agent。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
const ts = createRequire(join(checkout, 'package.json'))('typescript')
const nodeRequire = createRequire(import.meta.url)
const modulePath = join(root, 'src/host/dsh-modules.ts')
const source = readFileSync(modulePath, 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: modulePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

function load() {
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: id => nodeRequire(id),
    console,
    process,
    URL,
  }, { filename: modulePath })
  return module.exports
}

const mod = load()

test('packaged Electron layout is the first candidate root', () => {
  const execPath = join('E:', 'DSH', 'DeepSeek Harness.exe')
  const roots = mod.candidateRoots(execPath, ['DeepSeek Harness.exe'])
  assert.equal(roots[0], join('E:', 'DSH', 'resources', 'app.asar', 'dsh', 'node_modules'))
  assert.ok(roots.includes(join('E:', 'DSH', 'resources', 'app.asar', 'node_modules')))
})

test('an app.asar argument contributes the dsh and root node_modules directories', () => {
  const asar = join('E:', 'DSH', 'resources', 'app.asar')
  const hostEntry = join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const roots = mod.candidateRoots(join('C:', 'nodejs', 'node.exe'), [join('C:', 'nodejs', 'node.exe'), hostEntry, join(asar, 'dsh'), join('C:', 'Users', 'x', '.dsh', 'profiles', 'desktop')])
  assert.ok(roots.includes(join(asar, 'dsh', 'node_modules')), 'dsh node_modules root')
  assert.ok(roots.includes(join(asar, 'node_modules')), 'asar root node_modules')
  assert.ok(roots.includes(join(join(asar, 'dsh'), 'node_modules')), 'the dsh directory argument itself')
})

test('candidate roots are unique even when several sources agree', () => {
  const execPath = join('E:', 'DSH', 'DeepSeek Harness.exe')
  const asarEntry = join('E:', 'DSH', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  const roots = mod.candidateRoots(execPath, [execPath, asarEntry])
  assert.equal(new Set(roots).size, roots.length)
})

test('installedVersion reads the declaration and tolerates a missing package', () => {
  const dir = mkdtempSync(join(root, 'tests', '.tmp', 'dsh-modules-'))
  try {
    mkdirSync(join(dir, 'node_modules', '@fake', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@fake', 'pkg', 'package.json'), JSON.stringify({ name: '@fake/pkg', version: '9.9.9' }))
    assert.equal(mod.installedVersion(join(dir, 'node_modules'), '@fake/pkg'), '9.9.9')
    assert.equal(mod.installedVersion(join(dir, 'node_modules'), '@fake/missing'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing module fails with an attempt list instead of a bare specifier error', async () => {
  await assert.rejects(
    () => mod.importDshModule('@butler-test/definitely-not-installed'),
    error => /加载宿主模块/.test(String(error)) && /已尝试/.test(String(error)) && /@butler-test\/definitely-not-installed/.test(String(error)),
  )
})
