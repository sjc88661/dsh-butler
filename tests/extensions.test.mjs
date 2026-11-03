/**
 * Extension surface (`schemaVersion: 1`): manifest/adapter validation, the
 * runtime registry, its integration with the pack read model, lifecycle, and
 * the example bundle.
 *
 * These tests are the executable half of docs/extension-api.md: every declared
 * limit and every lifecycle promise asserted here must keep matching the doc.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'extensions-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
const {
  BUILTIN_PACK_IDS, getPack, listPacks, matchPacks, packInstructions, packsSummary, setPackEnabled, setExtensionPackSource,
} = await import('../src/host/packs.ts')
const { KERNEL_PACK_IDS, PACK_BOUNDARY } = await import('../src/shared/packs.ts')
const {
  BUTLER_EXTENSION_SCHEMA_VERSION, BUTLER_EXTENSIONS_SERVICE, EXTENSION_LIMITS, validateChannelAdapter, validatePackManifest,
} = await import('../src/shared/extension.ts')
const { createButlerExtensions, installButlerExtensions } = await import('../src/host/extensions.ts')
const exampleBundle = await import('../examples/butler-pack-example/index.js')
ensureVault()

/** A valid pack used across tests; each test that needs a unique id overrides `id`. */
const PACK = Object.freeze({
  schemaVersion: 1,
  id: 'weekly-review',
  title: '每周回顾',
  triggers: ['每周回顾', '周复盘'],
  instructions: '每周回顾：先列出本周完成与未完成，再写下一步和需要的证据。',
  evidence: '回顾必须引用本周实际笔记或任务回执，不能凭印象。',
  permissions: '写笔记和开任务按用户请求；外发消息仍需具体授权。',
  tools: ['butler_note', 'butler_task'],
  budget: { maxAttempts: 2, note: '回顾没进展就停下来问用户。' },
  cost_class: 'free',
})

/** A valid channel adapter; counters prove validation never calls it. */
function channelAdapter(overrides = {}) {
  const calls = { send: 0, isReady: 0 }
  const adapter = {
    schemaVersion: 1,
    id: 'weekly-outbox',
    title: '周报外发（示例）',
    isReady: () => { calls.isReady += 1; return false },
    send: async () => { calls.send += 1; return { ok: false, reason: '示例通道未接投递' } },
    limits: { note: '纯声明：内核不解释也不执行。', maxPayloadChars: 4000 },
    ...overrides,
  }
  return { adapter, calls }
}

/** Assert a thrown `Error` with the `管家扩展：` prefix containing every needle. */
function expectError(run, needles) {
  let error
  try { run() } catch (caught) { error = caught }
  assert.ok(error instanceof Error, `应当抛 Error，实际：${String(error)}`)
  assert.match(error.message, /^管家扩展：/, `错误信息必须带「管家扩展：」前缀：${error.message}`)
  for (const needle of needles) assert.ok(error.message.includes(needle), `错误信息应包含 ${JSON.stringify(needle)}：${error.message}`)
  return error
}

/** A registry wired into the shared pack read model, with cleanup. */
function installed(options = {}) {
  const registry = createButlerExtensions(options)
  const detach = setExtensionPackSource(() => registry.list().packs)
  return {
    registry,
    stop() {
      detach()
      registry.dispose()
    },
  }
}

/** Synthetic Cordis-like host: records provided services and effect disposers. */
function fakeHost({ provide = true, provideError } = {}) {
  const provided = new Map()
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return provided.get(name) },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    provide(name, value) {
      if (provideError !== undefined) throw provideError
      provided.set(name, value)
      return () => provided.delete(name)
    },
  }
  if (!provide) delete ctx.provide
  return {
    ctx,
    provided,
    effects,
    dispose() {
      for (const effect of effects.splice(0).reverse()) effect()
    },
  }
}

test('the schema version is exported and a minimal valid manifest normalizes to frozen defaults', () => {
  assert.equal(BUTLER_EXTENSION_SCHEMA_VERSION, 1)
  assert.equal(BUTLER_EXTENSIONS_SERVICE, 'butlerExtensions')
  const minimal = { schemaVersion: 1, id: 'minimal-pack', title: '最小包', triggers: [], instructions: '照做。', evidence: '带回执。', permissions: '先问。' }
  const resolved = validatePackManifest(minimal)
  assert.equal(resolved.id, 'minimal-pack')
  assert.deepEqual(resolved.triggers, [])
  assert.deepEqual(resolved.tools, [])
  assert.deepEqual(resolved.budget, {})
  assert.equal(resolved.cost_class, 'unknown')
  assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved.triggers) && Object.isFrozen(resolved.tools))
  assert.ok(!('cost_class' in minimal), 'validation must not mutate the caller manifest')
  assert.deepEqual(validatePackManifest(PACK).budget, { maxAttempts: 2, note: '回顾没进展就停下来问用户。' })
  assert.equal(validatePackManifest(PACK).cost_class, 'free')
})

test('a missing or mismatched schemaVersion is rejected with the expected version', () => {
  const { schemaVersion, ...noVersion } = PACK
  expectError(() => validatePackManifest(noVersion), ['schemaVersion', '缺少', '1'])
  expectError(() => validatePackManifest({ ...PACK, schemaVersion: 2 }), ['schemaVersion', '必须是 1', '2'])
  expectError(() => validatePackManifest({ ...PACK, schemaVersion: '1' }), ['schemaVersion', '必须是 1'])
  expectError(() => validateChannelAdapter({ ...channelAdapter().adapter, schemaVersion: undefined }), ['通道 adapter', 'schemaVersion', '1'])
  expectError(() => validateChannelAdapter({ ...channelAdapter().adapter, schemaVersion: 3 }), ['通道 adapter', 'schemaVersion', '3'])
})

test('pack ids follow the documented pattern and kernel-owned ids are refused', () => {
  assert.equal(validatePackManifest({ ...PACK, id: 'ab' }).id, 'ab')
  assert.equal(validatePackManifest({ ...PACK, id: 'a1-b2-c3' }).id, 'a1-b2-c3')
  for (const id of ['A-bad', '1starts-with-digit', 'has_underscore', '-leading']) {
    expectError(() => validatePackManifest({ ...PACK, id }), ['能力包 manifest 的 id', EXTENSION_LIMITS.idPattern])
  }
  expectError(() => validatePackManifest({ ...PACK, id: 'x'.repeat(EXTENSION_LIMITS.idMax + 1) }), ['能力包 manifest 的 id', '上限 32'])
  expectError(() => validatePackManifest({ ...PACK, id: 'daily' }), ['daily', 'builtin', '内核内置包'])
  assert.equal(EXTENSION_LIMITS.idMax, 32)
})

test('title and trigger limits are enforced while an empty trigger list stays legal', () => {
  expectError(() => validatePackManifest({ ...PACK, title: '' }), ['title', '不能为空'])
  expectError(() => validatePackManifest({ ...PACK, title: 'x'.repeat(EXTENSION_LIMITS.titleMax + 1) }), ['title', '上限 64'])
  expectError(() => validatePackManifest({ ...PACK, triggers: Array.from({ length: EXTENSION_LIMITS.triggersMax + 1 }, (_, i) => `t${i}`) }), ['triggers', '最多 32'])
  expectError(() => validatePackManifest({ ...PACK, triggers: ['x'.repeat(EXTENSION_LIMITS.triggerMax + 1)] }), ['triggers[0]', '上限 32'])
  expectError(() => validatePackManifest({ ...PACK, triggers: ['ok', 7] }), ['triggers[1]', '必须是字符串'])
  expectError(() => validatePackManifest({ ...PACK, triggers: ['ok', '  '] }), ['triggers[1]', '不能为空'])
  assert.deepEqual(validatePackManifest({ ...PACK, triggers: ['  空格边界  '] }).triggers, ['空格边界'])
})

test('instructions, evidence and permissions are required and bounded', () => {
  expectError(() => validatePackManifest({ ...PACK, instructions: 'x'.repeat(EXTENSION_LIMITS.instructionsMax + 1) }), ['instructions', '上限 8000'])
  expectError(() => validatePackManifest({ ...PACK, instructions: '   ' }), ['instructions', '不能为空'])
  expectError(() => validatePackManifest({ ...PACK, evidence: 'x'.repeat(EXTENSION_LIMITS.evidenceMax + 1) }), ['evidence', '上限 2000'])
  expectError(() => validatePackManifest({ ...PACK, permissions: undefined }), ['permissions', '必须是字符串'])
  expectError(() => validatePackManifest({ ...PACK, permissions: 'x'.repeat(EXTENSION_LIMITS.permissionsMax + 1) }), ['permissions', '上限 2000'])
  assert.equal(validatePackManifest({ ...PACK, instructions: 'x'.repeat(EXTENSION_LIMITS.instructionsMax) }).instructions.length, 8000)
})

test('cost_class defaults to unknown and rejects invented classes', () => {
  for (const value of ['free', 'local', 'paid', 'unknown']) assert.equal(validatePackManifest({ ...PACK, cost_class: value }).cost_class, value)
  expectError(() => validatePackManifest({ ...PACK, cost_class: 'cheap' }), ['cost_class', 'free、local、paid 或 unknown', 'cheap'])
  expectError(() => validatePackManifest({ ...PACK, cost_class: 0 }), ['cost_class', 'free、local、paid 或 unknown'])
})

test('budget only accepts the declared retry-advice shape', () => {
  assert.deepEqual(validatePackManifest({ ...PACK, budget: { maxAttempts: 10 } }).budget, { maxAttempts: 10 })
  for (const budget of [{ maxAttempts: 0 }, { maxAttempts: 11 }, { maxAttempts: 1.5 }, { maxAttempts: '3' }, { note: 'x'.repeat(EXTENSION_LIMITS.budgetNoteMax + 1) }, { note: '' }, { hardLimit: 10 }, []]) {
    expectError(() => validatePackManifest({ ...PACK, budget }), ['budget'])
  }
  expectError(() => validatePackManifest({ ...PACK, budget: { maxAttempts: 0 } }), ['maxAttempts', '1..10'])
  expectError(() => validatePackManifest({ ...PACK, budget: { hardLimit: 10 } }), ['hardLimit', 'maxAttempts、note'])
})

test('tools are optional but bounded, typed and non-empty', () => {
  assert.deepEqual(validatePackManifest({ ...PACK, tools: undefined }).tools, [])
  assert.deepEqual(validatePackManifest({ ...PACK, tools: ['  butler_note  '] }).tools, ['butler_note'])
  expectError(() => validatePackManifest({ ...PACK, tools: Array.from({ length: EXTENSION_LIMITS.toolsMax + 1 }, (_, i) => `tool_${i}`) }), ['tools', '最多 24'])
  expectError(() => validatePackManifest({ ...PACK, tools: ['ok', 42] }), ['tools[1]', '必须是字符串'])
  expectError(() => validatePackManifest({ ...PACK, tools: [''] }), ['tools[0]', '不能为空'])
  expectError(() => validatePackManifest({ ...PACK, tools: ['x'.repeat(EXTENSION_LIMITS.toolNameMax + 1)] }), ['tools[0]', '上限 160'])
  assert.equal(validatePackManifest({ ...PACK, tools: Array.from({ length: 24 }, (_, i) => `tool_${i}`) }).tools.length, 24)
})

test('pack manifests reject undeclared fields instead of silently ignoring typos', () => {
  expectError(() => validatePackManifest({ ...PACK, costClass: 'free' }), ['costClass', '未声明的字段', 'cost_class'])
  expectError(() => validatePackManifest({ ...PACK, schema_version: 1 }), ['schema_version', '未声明的字段'])
  expectError(() => validatePackManifest('not-a-manifest'), ['能力包 manifest', '必须是普通对象'])
  expectError(() => validatePackManifest(null), ['能力包 manifest', 'null'])
})

test('channel adapters are validated without being called', () => {
  const { adapter, calls } = channelAdapter()
  const resolved = validateChannelAdapter(adapter)
  assert.equal(resolved.schemaVersion, 1)
  assert.equal(resolved.id, adapter.id)
  assert.equal(resolved.title, adapter.title)
  assert.equal(resolved.isReady, adapter.isReady)
  assert.equal(resolved.send, adapter.send)
  assert.deepEqual(resolved.limits, adapter.limits)
  assert.equal(calls.send, 0, 'validation must never call send')
  assert.equal(calls.isReady, 0, 'validation must never call isReady')
})

test('channel adapters reject missing or mistyped required members', () => {
  const { adapter } = channelAdapter()
  expectError(() => validateChannelAdapter({ ...adapter, id: 'Bad_Id' }), ['通道 adapter 的 id', EXTENSION_LIMITS.idPattern])
  expectError(() => validateChannelAdapter({ ...adapter, title: '' }), ['通道 adapter 的 title'])
  expectError(() => validateChannelAdapter({ ...adapter, isReady: true }), ['isReady', '必须是函数'])
  expectError(() => validateChannelAdapter({ ...adapter, send: 'later' }), ['send', '必须是函数'])
  expectError(() => validateChannelAdapter({ ...adapter, send: undefined }), ['send', '必须是函数'])
  expectError(() => validateChannelAdapter({ ...adapter, limits: 'none' }), ['limits', '必须是普通对象'])
  const { isReady, send, ...withoutTransport } = adapter
  expectError(() => validateChannelAdapter({ ...withoutTransport, send }), ['isReady', '必须是函数'])
  expectError(() => validateChannelAdapter({ ...withoutTransport, isReady }), ['send', '必须是函数'])
})

test('a registered pack is visible to the shared read model with the kernel boundary', () => {
  const env = installed()
  try {
    env.registry.registerPack(PACK)
    const fromList = listPacks().find(pack => pack.id === PACK.id)
    assert.ok(fromList, 'listPacks must report registered extension packs')
    assert.equal(fromList.source, 'extension')
    assert.equal(fromList.enabled, true)
    assert.equal(fromList.instructions, PACK.instructions)
    assert.deepEqual(fromList.boundary, PACK_BOUNDARY)
    assert.equal(fromList.boundary.origin, 'kernel', 'boundary comes from the kernel, never the manifest')
    assert.equal(getPack(PACK.id).source, 'extension')
    const summary = packsSummary().find(pack => pack.id === PACK.id)
    assert.equal(summary.source, 'extension')
    assert.deepEqual(summary.boundary, PACK_BOUNDARY)
    assert.equal(summary.guidance.workflow, PACK.instructions)
    assert.equal(summary.cost_class, 'free')
    const match = matchPacks('帮我做每周回顾').find(row => row.pack.id === PACK.id)
    assert.ok(match, 'extension packs participate in keyword matching')
    assert.deepEqual(match.hits, ['每周回顾'])
    const matched = packInstructions('帮我做每周回顾')
    assert.ok(matched.includes(PACK.instructions), 'a trigger hit expands the instructions into the prompt')
    assert.match(matched, /扩展注册/)
    const unrelated = packInstructions('帮我订一张机票')
    assert.ok(!unrelated.includes(PACK.instructions), 'an unrelated request does not spend prompt space on it')
    assert.ok(unrelated.includes(`${PACK.id}=`), 'the catalog line still makes it discoverable by id')
    assert.deepEqual(env.registry.list().packs.map(pack => pack.id), [PACK.id])
  } finally {
    env.stop()
  }
})

test('duplicate ids and built-in ids are refused with the existing source named', () => {
  const env = installed()
  try {
    env.registry.registerPack(PACK)
    expectError(() => env.registry.registerPack(PACK), [PACK.id, '已在本注册表注册', 'extension'])
    expectError(() => env.registry.registerPack({ ...PACK, id: 'daily', title: '抢占内置' }), ['daily', 'builtin'])
    assert.deepEqual(env.registry.list().packs.map(pack => pack.id), [PACK.id], 'a refused registration changes nothing')
  } finally {
    env.stop()
  }
})

test('disposing a registration removes it everywhere and extension packs ignore user switches', () => {
  const env = installed()
  try {
    const dispose = env.registry.registerPack(PACK)
    assert.ok(listPacks().some(pack => pack.id === PACK.id))
    dispose()
    dispose()
    assert.ok(!listPacks().some(pack => pack.id === PACK.id), 'listPacks drops a disposed pack')
    assert.ok(!packsSummary().some(pack => pack.id === PACK.id), 'summary drops a disposed pack')
    assert.ok(!packInstructions('帮我做每周回顾').includes(PACK.instructions), 'prompt instructions drop a disposed pack')
    assert.deepEqual(env.registry.list().packs, [])
    // Re-registering after dispose is allowed and yields the same visibility.
    const second = env.registry.registerPack(PACK)
    assert.ok(getPack(PACK.id))
    expectError(() => setPackEnabled(PACK.id, false), [PACK.id, '注册生命周期', 'source: extension'])
    assert.equal(getPack(PACK.id).enabled, true, 'extension packs stay enabled while registered')
    second()
  } finally {
    env.stop()
  }
})

test('a same-id user markdown pack outranks an extension pack', () => {
  const id = 'weekly-review'
  const file = vaultPath('packs', `${id}.md`)
  writeFileSync(file, ['---', `id: ${id}`, 'title: 我的每周回顾', 'triggers: 每周回顾', '---', 'USER_OWNED_WORKFLOW：按我自己的步骤回顾。', ''].join('\n'))
  const env = installed()
  try {
    env.registry.registerPack(PACK)
    const merged = getPack(id)
    assert.equal(merged.source, 'user', 'user markdown wins over the extension registration')
    assert.equal(merged.instructions, 'USER_OWNED_WORKFLOW：按我自己的步骤回顾。')
    const prompt = packInstructions('帮我做每周回顾')
    assert.ok(prompt.includes('USER_OWNED_WORKFLOW'))
    assert.ok(!prompt.includes(PACK.instructions), 'the hidden extension text never reaches the prompt')
    const summary = packsSummary().find(pack => pack.id === id)
    assert.equal(summary.source, 'user')
    assert.deepEqual(env.registry.list().packs.map(pack => pack.id), [id], 'the registry keeps its registration; the read model just prefers the user file')
  } finally {
    env.stop()
    unlinkSync(file)
  }
})

test('disposing the registry clears packs and channels and blocks later registrations', () => {
  const env = installed()
  env.registry.registerPack(PACK)
  env.registry.registerChannel(channelAdapter().adapter)
  assert.equal(env.registry.list().packs.length, 1)
  assert.equal(env.registry.list().channels.length, 1)
  env.registry.dispose()
  env.registry.dispose()
  assert.equal(env.registry.closed, true)
  assert.deepEqual(env.registry.list(), { packs: [], channels: [] })
  assert.ok(!listPacks().some(pack => pack.id === PACK.id), 'the read model stops seeing a disposed registry')
  expectError(() => env.registry.registerPack(PACK), ['能力包注册表已关闭'])
  expectError(() => env.registry.registerChannel(channelAdapter().adapter), ['通道注册表已关闭'])
  env.stop()
})

test('two registry instances do not see or dispose each other', () => {
  const first = createButlerExtensions()
  const other = createButlerExtensions()
  try {
    first.registerPack({ ...PACK, id: 'first-pack' })
    other.registerPack({ ...PACK, id: 'other-pack' })
    assert.deepEqual(first.list().packs.map(pack => pack.id), ['first-pack'])
    assert.deepEqual(other.list().packs.map(pack => pack.id), ['other-pack'])
    first.dispose()
    assert.deepEqual(first.list().packs, [])
    assert.deepEqual(other.list().packs.map(pack => pack.id), ['other-pack'])
  } finally {
    first.dispose()
    other.dispose()
  }
})

test('installButlerExtensions publishes the service and unwinding removes it and its registrations', () => {
  const host = fakeHost()
  const installation = installButlerExtensions(host.ctx)
  assert.equal(installation.active, true)
  assert.equal(installation.serviceName, 'butlerExtensions')
  host.ctx.effect(() => installation.stop, 'test: extension registry')
  const service = host.provided.get('butlerExtensions')
  assert.ok(service, 'the service is published for sibling bundles')
  assert.equal(service.schemaVersion, 1)
  assert.equal(typeof service.registerPack, 'function')
  assert.equal(typeof service.registerChannel, 'function')
  assert.equal(typeof service.list, 'function')
  assert.equal(service.dispose, undefined, 'host-only dispose is not published')
  const disposePack = service.registerPack(PACK)
  assert.equal(typeof disposePack, 'function')
  service.registerChannel(channelAdapter().adapter)
  assert.ok(listPacks().some(pack => pack.id === PACK.id))
  assert.equal(installation.registry.list().channels[0].id, 'weekly-outbox')
  host.dispose()
  assert.equal(host.provided.has('butlerExtensions'), false, 'the published service is removed on unload')
  assert.ok(!listPacks().some(pack => pack.id === PACK.id), 'the pack read-model hook is detached on unload')
  assert.equal(installation.registry.closed, true)
  disposePack()
  installation.stop()
})

test('installButlerExtensions degrades explicitly when ctx.provide is missing or throws', () => {
  const missing = installButlerExtensions(fakeHost({ provide: false }).ctx)
  assert.equal(missing.active, false)
  assert.match(missing.problem, /ctx\.provide/)
  assert.equal(missing.registry.closed, false)
  missing.stop()
  missing.stop()
  assert.equal(missing.registry.closed, true)

  const failing = installButlerExtensions(fakeHost({ provideError: new Error('宿主编译器拒绝服务') }).ctx)
  assert.equal(failing.active, false)
  assert.match(failing.problem, /发布 butlerExtensions 服务失败/)
  assert.match(failing.problem, /拒绝服务/)
  failing.stop()
})

test('invalid registrations leave the registry usable', () => {
  const env = installed()
  try {
    expectError(() => env.registry.registerPack({ ...PACK, id: 'BAD' }), ['能力包 manifest 的 id'])
    expectError(() => env.registry.registerChannel({ ...channelAdapter().adapter, send: null }), ['send', '必须是函数'])
    assert.deepEqual(env.registry.list(), { packs: [], channels: [] })
    env.registry.registerPack(PACK)
    assert.deepEqual(env.registry.list().packs.map(pack => pack.id), [PACK.id])
  } finally {
    env.stop()
  }
})

test('the example bundle registers a valid pack and channel and unwinds them', () => {
  assert.equal(exampleBundle.inject[0], 'butlerExtensions')
  assert.equal(validatePackManifest(exampleBundle.pack).id, 'example-weekly-review')
  assert.equal(validateChannelAdapter(exampleBundle.channel).id, 'example-outbox')
  const host = fakeHost()
  const installation = installButlerExtensions(host.ctx)
  host.ctx.effect(() => installation.stop, 'test: extension registry')
  exampleBundle.apply(host.ctx)
  const registered = listPacks().find(pack => pack.id === 'example-weekly-review')
  assert.ok(registered, 'the example pack is visible to butler_pack list')
  assert.equal(registered.source, 'extension')
  assert.equal(registered.title, '示例：每周回顾')
  const channel = installation.registry.list().channels.find(entry => entry.id === 'example-outbox')
  assert.ok(channel, 'the example channel is registered')
  assert.equal(channel.source, 'extension')
  assert.equal(channel.isReady(), false, 'the example channel honestly reports it is not ready')
  host.dispose()
  assert.ok(!listPacks().some(pack => pack.id === 'example-weekly-review'), 'disabling the example bundle removes its pack')
  assert.equal(installation.registry.list().channels.length, 0)
})

test('the kernel reserved id snapshot matches the shipped built-in packs', () => {
  const builtinIds = listPacks().filter(pack => pack.source === 'builtin').map(pack => pack.id).sort()
  assert.deepEqual([...KERNEL_PACK_IDS].sort(), [...BUILTIN_PACK_IDS].sort())
  assert.deepEqual(builtinIds, [...KERNEL_PACK_IDS].sort(), 'shared/packs.ts KERNEL_PACK_IDS must track host/packs.ts BUILTIN')
  for (const id of builtinIds) expectError(() => validatePackManifest({ ...PACK, id }), [id, 'builtin'])
})
