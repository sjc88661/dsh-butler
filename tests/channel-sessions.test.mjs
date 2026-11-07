/**
 * Chat-channel session ownership: the lark- prefix is the channel's own stable
 * session-id derivation, so treating it as butler-owned must be exact.
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
const sourcePath = join(root, 'src/host/channel-sessions.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, console, Object }, { filename: sourcePath })
const { LARK_SESSION_PREFIX, isChannelSession } = module.exports

test('lark-derived session ids are channel sessions', () => {
  assert.equal(LARK_SESSION_PREFIX, 'lark-')
  assert.equal(isChannelSession('lark-oc_55aaf163dfedfc54302e0d6ff9e337a0'), true)
  assert.equal(isChannelSession('lark-on_abc'), true)
})

test('butler desktop and reminder session ids stay butler-owned, not channel-owned', () => {
  assert.equal(isChannelSession('session-butler-topic-69e8f8f5-e6cb-4d51-ba40-da6859ed12a6'), false)
  assert.equal(isChannelSession('session-butler-reminder-3ca8caac'), false)
  assert.equal(isChannelSession('session-a468b284-65e0-4617-a297-69cdcf4b4c8b'), false)
  assert.equal(isChannelSession(''), false)
  assert.equal(isChannelSession('larkspur'), false)
})
