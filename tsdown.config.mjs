/**
 * tsdown bundles for @dsh-external/dsh-butler.
 *
 * Both halves are bundled so the installed bundle declares no runtime
 * dependencies: the Host half must not import `@deepseek-ai/schemastery` (or any
 * other dsh package) from a linked workspace directory, because module
 * resolution there walks the workspace tree, not the profile's node_modules.
 * Only Node builtins stay external on the Host side; the browser side keeps the
 * shell's module table (`react`) and the ordering-only dsh client entries.
 *
 * Plain JS on purpose: a .ts config that imports types from 'tsdown' resolves
 * into a pnpm store outside the checkout, which may be unreachable.
 */
import { builtinModules } from 'node:module'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const PLUGIN_ID = '@dsh-external/dsh-butler'

/**
 * Resolve a dsh-bundled package for the Host bundle.
 *
 * The Host half is linked into the profile as a workspace directory, so at
 * runtime its relative Node resolution walks the workspace tree and cannot see
 * the profile's `node_modules`. Bundling the value here removes that runtime
 * dependency entirely; the build still has to find the package somewhere, and
 * the installed profile (or the prepared checkout) is the authority.
 */
function resolveDshPackage(name) {
  const bases = []
  if (process.env.DSH_PROFILE_DIR) bases.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  if (process.env.DSH_CHECKOUT) bases.push(join(process.env.DSH_CHECKOUT, 'package.json'))
  for (const base of bases) {
    try {
      return createRequire(base).resolve(name)
    } catch {}
  }
  throw new Error(
    `cannot resolve ${name} for the Host bundle; set DSH_PROFILE_DIR (active profile) or DSH_CHECKOUT (prepared checkout) to an installation that ships it`,
  )
}

/** Host-side packages that must be inlined instead of imported at runtime. */
const HOST_ALIAS = {
  '@deepseek-ai/schemastery': resolveDshPackage('@deepseek-ai/schemastery'),
}

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Node builtins, with and without the `node:` prefix, stay external. */
const NODE_BUILTINS = [
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
]

/** @type {import('tsdown').UserConfig} */
const hostBundle = {
  entry: {
    index: 'src/index.ts',
    channels: 'src/channels.ts',
    'reminder-delivery': 'src/reminder-delivery.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  alias: HOST_ALIAS,
  deps: {
    neverBundle: NODE_BUILTINS,
    alwaysBundle: () => true,
  },
  outputOptions: {
    entryFileNames: '[name].js',
  },
}

/** @type {import('tsdown').UserConfig} */
const clientBundle = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [hostBundle, clientBundle]
