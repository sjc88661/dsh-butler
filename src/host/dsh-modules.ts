/**
 * 加载 DSH 安装自带的模块（当前只有 `@deepseek-ai/dsh-agent`）。
 *
 * 管家以官方 bundle 安装，本机是 `link:` 到工作区目录 `E:\opendots\dsh-butler`；
 * 从 `lib/index.js` 出发的普通 Node 解析只会走工作区目录树，看不到 DSH 安装
 * 目录里的 `node_modules`，于是 `import('@deepseek-ai/dsh-agent')` 失败，管家
 * 专属会话因此无法建立（工作台会显示"专属会话尚未准备好"）。
 *
 * 这里按顺序尝试：
 * 1. 普通解析（插件被复制进 profile / 依赖声明可用时命中）；
 * 2. 宿主可执行文件旁的打包布局：`<exe dir>/resources/app.asar/dsh/node_modules`；
 * 3. 进程参数里出现的 `app.asar` 安装根，以及 `.../app.asar/dsh` 这类目录参数。
 *
 * 命中后使用安装自带的同一份模块；全部失败时抛出带"尝试清单"的错误，让
 * 工作台的失败提示能说明到底试过哪些位置，而不是只报一句 Cannot find package。
 *
 * @module @dsh-external/dsh-butler/host/dsh-modules
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** A place we looked for the module, in the order the caller reported them. */
export interface LoadAttempt {
  /** Where we tried: a specifier, a directory, or a resolved file. */
  where: string
  /** Why it failed, when it did. */
  error: string
}

/**
 * Candidate `node_modules` roots for the running host installation.
 *
 * Pure function so the layout rules are testable without a real host: the caller
 * passes `process.execPath` and `process.argv`.
 * @param execPath - the host executable path (`process.execPath`).
 * @param argv - the host process arguments (`process.argv`).
 * @returns unique candidate roots, most specific first.
 */
export function candidateRoots(execPath: string, argv: readonly string[]): string[] {
  const roots: string[] = []
  const push = (value: string | undefined): void => {
    if (value !== undefined && value !== '' && !roots.includes(value)) roots.push(value)
  }
  // Packaged Electron layout: <install>/resources/app.asar/dsh/node_modules.
  push(join(dirname(execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
  push(join(dirname(execPath), 'resources', 'app.asar', 'node_modules'))
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.includes('app.asar')) continue
    const index = arg.indexOf('app.asar') + 'app.asar'.length
    const asar = arg.slice(0, index)
    push(join(asar, 'dsh', 'node_modules'))
    push(join(asar, 'node_modules'))
    // `...\app.asar\dsh` passed as the dsh root directory.
    const rest = arg.slice(index).replace(/^[\\/]+/, '')
    if (rest === 'dsh') push(join(arg, 'node_modules'))
    if (rest.startsWith(`dsh${sep}`) || rest === 'dsh') push(join(asar, 'dsh', 'node_modules'))
  }
  return roots
}

/**
 * 该安装根里声明的版本号；用来在失败信息里区分"找到但版本不同"与"没找到"。
 * @param root - a `node_modules` root.
 * @param name - package name such as `@deepseek-ai/dsh-agent`.
 * @returns the package version, when readable.
 */
export function installedVersion(root: string, name: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(root, ...name.split('/'), 'package.json'), 'utf8')) as { version?: string }
    return meta.version
  } catch {
    return undefined
  }
}

/** Resolve a package specifier as if from `root`, or `undefined`. */
function resolveFrom(root: string, name: string): string | undefined {
  try {
    return createRequire(join(root, '__butler_resolver__.cjs')).resolve(name)
  } catch {
    return undefined
  }
}

/**
 * Load one DSH-installation module from the first location that works.
 * @param name - bare package specifier, e.g. `@deepseek-ai/dsh-agent`.
 * @param options - optional `onResolved` callback for one-line diagnostics.
 * @returns the loaded module namespace.
 * @throws Error listing every attempted location and its failure.
 */
export async function importDshModule<T>(name: string, options: { onResolved?: (where: string) => void } = {}): Promise<T> {
  const attempts: LoadAttempt[] = []
  try {
    const loaded = await import(name) as T
    options.onResolved?.(`${name}（普通解析）`)
    return loaded
  } catch (error) {
    attempts.push({ where: `${name}（普通解析）`, error: describe(error) })
  }
  for (const root of candidateRoots(process.execPath, process.argv)) {
    const resolved = resolveFrom(root, name)
    const version = installedVersion(root, name)
    if (resolved === undefined) {
      attempts.push({ where: root, error: version === undefined ? '未解析到该包' : `已解析到但无入口（声明版本 ${version}）` })
      continue
    }
    try {
      const loaded = await import(pathToFileURL(resolved).href) as T
      options.onResolved?.(`${resolved}${version === undefined ? '' : `（声明版本 ${version}）`}`)
      return loaded
    } catch (error) {
      attempts.push({ where: `${resolved}`, error: describe(error) })
    }
  }
  throw new Error(`加载宿主模块 ${name} 失败；已尝试：${attempts.map(item => `${item.where} → ${item.error}`).join('；')}`)
}

/** One-line error text, without stack noise. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message
  return String(error)
}
