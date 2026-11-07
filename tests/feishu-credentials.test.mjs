/**
 * 飞书密钥凭据层：config 优先、credentials 兜底、空值不等于已配置、写入不读回。
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
const sourcePath = join(root, 'src/host/feishu-credentials.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, console, Promise, Error, String, Object }, { filename: sourcePath })
const { FEISHU_SECRET_REF, resolveFeishuSecret, storeFeishuSecret, clearFeishuSecret, describeFeishuSecret } = module.exports
/** Cross-realm plain copy so deepEqual does not compare prototypes. */
const plain = value => JSON.parse(JSON.stringify(value))

/** A small credentials double. */
function credentials({ stored, writable = true } = {}) {
  const calls = { set: [], unset: [], describe: 0, resolve: 0 }
  let value = stored
  return {
    calls,
    async resolve(ref) { calls.resolve += 1; return ref === FEISHU_SECRET_REF && value !== undefined ? { value, source: 'store' } : undefined },
    async set(ref, next) { calls.set.push([ref, next]); if (!writable) throw new Error('read only'); value = next },
    async unset(ref) { calls.unset.push(ref); value = undefined },
    async describe(ref) { calls.describe += 1; return { configured: value !== undefined && ref === FEISHU_SECRET_REF, writable, source: value === undefined ? undefined : 'store' } },
  }
}

test('an explicit config secret wins over the credential store', async () => {
  const service = credentials({ stored: 'from-store' })
  assert.deepEqual(plain(await resolveFeishuSecret('from-config', service)), { source: 'config', secret: 'from-config' })
  assert.equal(service.calls.resolve, 0, 'the store is not consulted when config already has the secret')
})

test('an empty config secret falls back to the credential store and empty is not configured', async () => {
  const service = credentials({ stored: '  from-store  ' })
  assert.deepEqual(plain(await resolveFeishuSecret('', service)), { source: 'credentials', secret: 'from-store' })
  assert.deepEqual(plain(await resolveFeishuSecret(undefined, credentials())), { source: 'none' })
  const broken = { async resolve() { throw new Error('locked') }, async set() {}, async unset() {} }
  assert.deepEqual(plain(await resolveFeishuSecret('', broken)), { source: 'none' })
  assert.deepEqual(plain(await resolveFeishuSecret('', undefined)), { source: 'none' })
})

test('store/clear are write-only and describe never returns the value', async () => {
  const service = credentials()
  await storeFeishuSecret(service, '  fresh-secret  ')
  assert.deepEqual(service.calls.set, [[FEISHU_SECRET_REF, 'fresh-secret']])
  const described = await describeFeishuSecret(service)
  assert.deepEqual(plain(described), { configured: true, writable: true, source: 'store' })
  assert.doesNotMatch(JSON.stringify(described), /fresh-secret/)
  await clearFeishuSecret(service)
  assert.deepEqual(service.calls.unset, [FEISHU_SECRET_REF])
  await assert.rejects(storeFeishuSecret(undefined, 'x'), /credentials/)
  await assert.rejects(storeFeishuSecret(service, '   '), /不能为空/)
  assert.deepEqual(plain(await describeFeishuSecret(undefined)), { configured: false, writable: false })
})
