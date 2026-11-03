#!/usr/bin/env node
/** Native offline build: compilation never installs packages or repairs junctions. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function preflight() {
  const lock = JSON.parse(readFileSync(join(root, 'toolchain.lock.json'), 'utf8'))
  if (process.versions.node !== lock.node) throw new Error(`node version mismatch: expected ${lock.node}, got ${process.versions.node}; select the pinned native Node`)
  const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
  if (!existsSync(checkout)) throw new Error(`DSH_CHECKOUT not found: ${checkout}; set DSH_CHECKOUT to the prepared local checkout`)
  const require = createRequire(join(checkout, 'package.json'))
  function tool(name, bin) {
    let pkg
    try { pkg = require.resolve(`${name}/package.json`) }
    catch { throw new Error(`${name} missing from DSH_CHECKOUT; prepare the pinned toolchain once (no automatic install)`) }
    const meta = JSON.parse(readFileSync(pkg, 'utf8'))
    if (meta.version !== lock[name]) throw new Error(`${name} version mismatch: expected ${lock[name]}, got ${meta.version}`)
    const entry = resolve(dirname(pkg), bin)
    if (!existsSync(entry)) throw new Error(`${name} entry not found: ${entry}`)
    return entry
  }
  const tsc = tool('typescript', 'bin/tsc'), tsdown = tool('tsdown', 'dist/run.mjs')
  for (const part of ['types/node/package.json', 'types/undici-types/package.json', 'types/harness.d.ts']) {
    if (!existsSync(join(root, part))) throw new Error(`vendored dependency missing: ${part}; restore it from the plugin source`)
  }
  return { checkout, tsc, tsdown, versions: { node: lock.node, typescript: lock.typescript, tsdown: lock.tsdown } }
}
function run(stage, entry, args) {
  console.log(`build: ${stage}`)
  const child = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_ENV: 'production' } })
  if (child.error) throw new Error(`${stage}: ${child.error.message}`)
  if (child.status !== 0) throw new Error(`${stage} failed (exit ${child.status}); fix the reported error before another build`)
}
try {
  const flags = new Set(process.argv.slice(2))
  for (const flag of flags) if (!['--check', '--typecheck', '--no-pack'].includes(flag)) throw new Error(`unknown build option: ${flag}`)
  const tools = preflight()
  console.log(`build preflight: ${JSON.stringify({ checkout: tools.checkout, ...tools.versions })}`)
  if (!flags.has('--check')) {
    run('host typecheck', tools.tsc, ['-p', 'tsconfig.json', '--noEmit'])
    run('client typecheck', tools.tsc, ['-p', 'tsconfig.client.json'])
    if (!flags.has('--typecheck')) {
      // lib/ is pure build output: stale tsdown chunks from an older build would
      // otherwise stay in the package (files: ["lib"]) forever. Only emitted
      // artifacts are removed here - src/, types/ and junctions are untouched.
      rmSync(join(root, 'lib'), { recursive: true, force: true })
      // Both halves are bundled by tsdown: the Host bundle must not import
      // dsh packages at runtime (a linked workspace package resolves modules
      // from its own tree, not the profile's node_modules). tsc therefore only
      // emits type declarations; lib/index.js, lib/channels.js,
      // lib/reminder-delivery.js and lib/client.js all come from tsdown.
      run('host declarations', tools.tsc, ['-p', 'tsconfig.json', '--emitDeclarationOnly'])
      run('client declarations', tools.tsc, ['-p', 'tsconfig.client.json', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--rootDir', 'src', '--outDir', 'lib/types'])
      run('bundles (host + client)', tools.tsdown, ['-c', 'tsdown.config.mjs', '--logLevel', 'warn'])
      if (!flags.has('--no-pack')) {
        const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
        if (!existsSync(npm)) throw new Error('npm pack CLI missing beside pinned Node; use --no-pack for a local build')
        run('pack', npm, ['pack', '--ignore-scripts', '--offline', '--cache', join(root, '.build-cache/npm')])
      }
      console.log('build complete: lib/index.js and lib/client.js')
    }
  }
} catch (error) {
  console.error(`build preflight/stage error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
