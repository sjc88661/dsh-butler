import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'prompt-cost-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ensureVault } = await import('../src/host/vault.ts'); ensureVault()
const { packInstructions, getPack, setPackEnabled } = await import('../src/host/packs.ts')
const { installToolLoading } = await import('../src/host/tool-loading.ts')
const { registerButlerTools } = await import('../src/host/tools.ts')

test('a reminder task expands its full daily contract and keeps other packs discoverable', () => {
  const all = packInstructions(), text = packInstructions('明天十点提醒我喝水')
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(all) * .5)
  assert.ok(text.includes(getPack('daily').instructions))
  assert.ok(!text.includes(getPack('research').instructions))
  assert.match(text, /research.*科研包/)
  assert.match(text, /butler_pack.*show/)
})

test('all matching domains expand without a top-three cutoff and disabled packs stay disabled', () => {
  const request = '提醒我学习，查论文与文献，翻译PDF摘要，对比机票价格'
  const text = packInstructions(request)
  for (const id of ['daily', 'life', 'documents', 'study', 'research']) assert.ok(text.includes(getPack(id).instructions))
  setPackEnabled('research', false)
  assert.ok(!packInstructions(request).includes(getPack('research').instructions))
  setPackEnabled('research', true)
})

test('unmatched user pack instructions and broken-pack warnings remain visible', () => {
  writeFileSync(join(home, 'vault/packs/personal.md'), '---\nid: personal\ntitle: 自建契约\ntriggers: 飞船\ntools: butler_note\nevidence: 用户证据规则\npermissions: 必须确认\n---\nUSER_CUSTOM_CONTRACT\n')
  setPackEnabled('personal', true)
  assert.match(packInstructions('修复加法'), /USER_CUSTOM_CONTRACT/)
  assert.match(packInstructions('修复加法'), /必须确认/)
  assert.ok(getPack('research').instructions.includes('Crossref'))
})

function environment(events = []) {
  const hooks = [], definitions = new Map()
  const names = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'skill', 'butler_overview', 'web_search', 'create_goal', 'mcp__rea__inspect']
  const tools = { register(t) { definitions.set(t.name, t); return () => {} }, get(n) { return definitions.get(n) ?? (names.includes(n) ? { name: n } : undefined) },
    schemas() { return [...names.map(name => ({ name, description: name, parameters: { type: 'object' } })), ...definitions.values()] }, modeFor: () => 'native' }
  const ctx = { get: key => key === 'tools' ? tools : undefined, on(name, fn) { if (name === 'system-prompt/assemble') hooks.push(fn); return () => {} } }
  installToolLoading(ctx)
  const agent = { id: 'test', ctx, session: { snapshotEvents: () => events } }
  const assembly = { sections: [
    { name: 'butler:packs', text: packInstructions() },
    { name: 'tool:read', text: 'READ_RULE' }, { name: 'tool:web_search', text: 'WEB_RULE' },
    { name: 'tool:goal', text: 'GOAL_RULE' }, { name: 'mcp:rea', text: 'REA_RULE' },
    { name: 'mcp-resource-servers', text: 'RESOURCES_RULE' }, { name: 'unknown:policy', text: 'KEEP_POLICY' },
  ], contexts: [{ name: 'sandbox:policy', text: 'KEEP_SANDBOX' }], variables: { butler_profile: 'KEEP_PROFILE', butler_open_work: 'KEEP_MEMORY_AND_TASKS' }, tools: tools.schemas() }
  const assemble = () => hooks[0](assembly, { agent }, async () => assembly)
  const load = names => definitions.get('butler_tools').execute({ action: 'load', names }, { agent })
  return { agent, assembly, assemble, load }
}

test('unloaded tool guidance is omitted and restored when its native tool is loaded; policy and memory are exact', async () => {
  const e = environment(), before = JSON.stringify(e.assembly), a = await e.assemble()
  assert.ok(!a.sections.some(s => s.text === 'READ_RULE'))
  assert.ok(!a.contexts.some(s => s.text.includes('READ_RULE')))
  assert.ok(!a.sections.some(s => s.text === 'WEB_RULE' || s.text === 'REA_RULE' || s.text === 'GOAL_RULE'))
  assert.deepEqual(a.contexts.slice(0, 1), e.assembly.contexts)
  assert.deepEqual(a.variables, e.assembly.variables)
  assert.ok(a.sections.some(s => s.text === 'KEEP_POLICY'))
  assert.equal((await e.load(['read', 'web_search', 'create_goal', 'mcp__rea__inspect'])).ok, true)
  const b = await e.assemble()
  for (const text of ['READ_RULE', 'WEB_RULE', 'GOAL_RULE', 'REA_RULE', 'RESOURCES_RULE']) assert.ok(b.contexts.some(s => s.text.includes(text)))
  assert.deepEqual(b.contexts.slice(0, 1), e.assembly.contexts)
  assert.deepEqual(b.variables, e.assembly.variables)
  assert.ok(b.sections.some(s => s.text === 'KEEP_POLICY'))
  assert.deepEqual(a.sections, b.sections, 'tool loads cannot append a full system snapshot in DeepSeek in-history mode')
  assert.equal(JSON.stringify(e.assembly), before, 'do not mutate shared assembly or scoped registrations')
})

test('pack routing reads consumed native input before user/message commit, ignoring queued and cancelled text', async () => {
  const human = text => ({ id: text, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const claimed = human('提醒我喝水'), future = human('论文'), cancelled = human('机票')
  const events = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [claimed] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [future] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [cancelled] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
  ]
  const e = environment(events), a = await e.assemble()
  const text = a.sections.find(s => s.name === 'butler:packs').text
  assert.ok(text.includes(getPack('daily').instructions))
  assert.ok(!text.includes(getPack('research').instructions))
  assert.ok(!text.includes(getPack('life').instructions))
  const other = await environment([{ type: 'user/message', data: human('查论文') }]).assemble()
  assert.ok(other.sections.find(s => s.name === 'butler:packs').text.includes(getPack('research').instructions))
})

test('reminder render removes duplicate success internals but leaves raw value, failures and uncertain states complete', () => {
  const definitions = new Map()
  registerButlerTools({ tools: { register: tool => { definitions.set(tool.name, tool); return () => {} } } }, {})
  const render = value => JSON.parse(definitions.get('butler_remind').output.render({ action: 'create' }, value)[0].text)
  const value = { ok: true, state: 'committed', operation: { identity: { secretInternal: 'internal' }, state: 'committed', deliveryState: 'scheduled', confirmedAt: '2030-01-01', reason: 'receipt saved' },
    reminder: { id: 'schedule-real', sessionId: 'independent', scheduledAt: '2030-01-01', raw: { id: 'schedule-real', prompt: 'DUPLICATE_PROMPT' } },
    taskId: 'task-real', task: { id: 'task-real', status: 'pending' }, evidenceIds: ['ev-real'], evidenceState: 'pending-final-result', tz: 'Asia/Shanghai' }
  const copy = structuredClone(value), compact = render(value)
  assert.equal(compact.reminder.id, 'schedule-real'); assert.equal(compact.reminder.sessionId, 'independent')
  assert.equal(compact.deliveryState, 'scheduled'); assert.equal(compact.task.status, 'pending')
  assert.deepEqual(compact.evidenceIds, ['ev-real']); assert.equal(compact.evidenceState, 'pending-final-result')
  assert.equal(compact.operation, undefined); assert.equal(compact.reminder.raw, undefined)
  assert.deepEqual(value, copy)
  for (const state of ['uncertain', 'creating']) assert.deepEqual(render({ ...value, state }), { ...value, state })
  assert.deepEqual(render({ ...value, ok: false }), { ...value, ok: false })
})
