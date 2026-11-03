import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { contextHarness } from './helpers/task-context.mjs'

const base = resolve('tests/.tmp')
fs.mkdirSync(base, { recursive: true })
const fixture = fs.mkdtempSync(join(base, 'memory-retrieval-'))
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts')
const ledger = await import('../src/host/ledger.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { MemoryService } = await import('../src/host/memory.ts')
beforeEach(() => {
  for (const path of [vault.STATE_HOME, vault.VAULT_HOME]) fs.rmSync(path, { force: true, recursive: true })
  vault.ensureVault()
  fs.writeFileSync(vault.PROFILE_FILE(), '# 用户档案\n\n- 保留手写内容\n')
})
after(() => fs.rmSync(fixture, { recursive: true, force: true }))
function setup(text = '整理长期记忆') {
  const contexts = new ExecutionContexts({ file: vault.statePath('contexts.json') })
  const agent = { id: 'owner' }
  const h = { contexts, agent, memory: new MemoryService({ contexts }) }
  input(h, text, 'origin')
  return h
}
function input(h, text, id) {
  h.contexts.bindUser(h.agent, { id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  return { ...h.contexts.forAgent(h.agent), callId: `call-${id}` }
}
function remember(h, text, options = {}, id = text) {
  return h.memory.remember(text, { ...options, identity: input(h, text, id) })
}
function approve(h, proposal, id = 'decision') {
  return h.memory.decide(proposal.id, 'approved', {}, input(h, `同意 ${proposal.id}`, id))
}

test('a critical boundary at the end of a long hand-edited profile is retrieved within a UTF-8 byte budget', () => {
  const h = setup()
  fs.writeFileSync(vault.PROFILE_FILE(), `# 用户档案\n${Array.from({ length: 100 }, (_, i) => `- 普通背景${i}：日常阅读和项目资料。`).join('\n')}\n- 重要边界：未获确认禁止发送第三方消息。\n`)
  assert.equal(typeof h.memory.retrieve, 'function', 'long profile retrieval must choose relevant boundaries beyond the prefix')
  const result = h.memory.retrieve('查找阅读资料', { maxBytes: 600, maxTopics: 2 })
  assert.match(result.profile, /禁止发送第三方消息/)
  assert.ok(Buffer.byteLength(result.text) <= 600)
  assert.equal(result.bytes, Buffer.byteLength(result.text))
  assert.deepEqual(result, h.memory.retrieve('查找阅读资料', { maxBytes: 600, maxTopics: 2 }))
})

test('topic retrieval finds an old relevant topic after more than twenty topics and reads local edits next turn', () => {
  const h = setup()
  const old = remember(h, '项目 Orion 使用冷冻电镜研究膜蛋白', { scope: 'topic', topic: 'Orion 项目' })
  for (let i = 0; i < 25; i++) remember(h, `无关项目${i}研究土壤样本`, { scope: 'topic', topic: `土壤${i}` })
  assert.equal(typeof h.memory.retrieve, 'function', 'topic relevance cannot be the first twenty index rows')
  const result = h.memory.retrieve('Orion 膜蛋白', { maxBytes: 1600, maxTopics: 2 })
  assert.equal(result.topics.length, 1)
  assert.equal(result.topics[0].memoIds[0], old.memo.id)
  assert.equal(result.topics[0].source.kind, 'user-input')
  assert.doesNotMatch(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), /Orion/)
  assert.match(fs.readFileSync(vault.MEMORY_INDEX_FILE(), 'utf8'), /Orion 项目/)
  fs.appendFileSync(result.topics[0].path, '\n- 用户手改：Orion 下一阶段做脂质组学。\n')
  assert.match(h.memory.retrieve('Orion 脂质组学', { maxBytes: 1600 }).text, /脂质组学/)
})

test('correct replaces the effective preference and preserves the old value, source and restart state', () => {
  const h = setup(), original = remember(h, '我喜欢简短回复', { scope: 'profile', key: 'reply-style' })
  assert.equal(typeof h.memory.correct, 'function', 'confirmed preferences need an audited replacement')
  const proposal = h.memory.correct(original.memo.id, '我喜欢详细回复', { identity: input(h, '请整理相反偏好', 'change'), source: 'user', approved: true })
  assert.equal(proposal.memo.status, 'proposed')
  assert.match(h.memory.retrieve('回复').text, /简短回复/)
  assert.doesNotMatch(h.memory.retrieve('回复').text, /详细回复/)
  const result = approve(h, proposal.proposal)
  assert.equal(result.memo.status, 'confirmed')
  assert.equal(result.memo.supersedes, original.memo.id)
  const retired = h.memory.read(original.memo.id)
  assert.equal(retired.memo.status, 'retracted')
  assert.equal(retired.memo.text, '我喜欢简短回复')
  assert.equal(retired.memo.origin.messageId, '我喜欢简短回复')
  assert.equal(retired.memo.supersededBy, result.memo.id)
  const restarted = new MemoryService({ contexts: new ExecutionContexts({ file: vault.statePath('contexts.json') }) })
  assert.doesNotMatch(restarted.retrieve('回复').text, /简短回复/)
  assert.match(restarted.retrieve('回复').text, /详细回复/)
  assert.equal(approve(h, proposal.proposal).duplicate, true)
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8').split('详细回复').length - 1, 1)
})

test('opposite remember calls with the same preference key require a replacement decision instead of appending contradictions', () => {
  const h = setup(), original = remember(h, '我偏好简明回复')
  const changed = remember(h, '我偏好详细回复')
  assert.equal(changed.memo.status, 'proposed')
  assert.equal(changed.proposal.action, 'correct')
  assert.equal(changed.proposal.targetMemoId, original.memo.id)
  approve(h, changed.proposal)
  assert.doesNotMatch(h.memory.retrieve('回复').text, /简明回复/)
  assert.match(h.memory.retrieve('回复').text, /详细回复/)
})

test('withdrawal requires a real decision and removes a topic from recall while retaining its audit record', () => {
  const h = setup(), original = remember(h, 'Nebula 项目使用去年的旧基因组', { scope: 'topic', topic: 'Nebula' })
  assert.equal(typeof h.memory.withdraw, 'function', 'withdrawn memory needs a persisted inactive status')
  const withdrawal = h.memory.withdraw(original.memo.id, { identity: input(h, '模型认为应该撤回', 'propose-withdraw'), source: 'user', approved: true })
  assert.equal(withdrawal.proposal.status, 'pending')
  assert.equal(h.memory.read(original.memo.id).memo.status, 'confirmed')
  const result = approve(h, withdrawal.proposal)
  assert.equal(result.memo.status, 'retracted')
  assert.equal(h.memory.retrieve('Nebula').topics.length, 0)
  assert.equal(h.memory.search('Nebula').items.length, 0)
  assert.equal(h.memory.search('Nebula', { includeInactive: true }).items[0].status, 'retracted')
  assert.equal(approve(h, withdrawal.proposal).duplicate, true)
})

test('native ask approval applies a correction with exact action binding and rejects a changed target', () => {
  const h = setup(), original = remember(h, '我偏好简短回复', { key: 'verbosity' })
  assert.equal(typeof h.memory.correct, 'function')
  const proposed = h.memory.correct(original.memo.id, '我偏好详细回复', { identity: input(h, '整理偏好', 'proposal') })
  const exec = { agent: h.agent, callId: 'native-change', name: 'ask_user_question', arguments: { questions: [proposed.proposal.question] } }
  h.contexts.capture(exec)
  const result = h.memory.observeToolResult(exec, { value: { answers: [{ id: proposed.proposal.question.id, selected: [proposed.proposal.question.options[0].label] }] } })
  assert.equal(result[0].memo.status, 'confirmed')
  assert.doesNotMatch(h.memory.retrieve('回复').text, /简短回复/)
  const later = h.memory.correct(result[0].memo.id, '我偏好适中回复', { identity: input(h, '整理最新偏好', 'later-proposal') })
  const rows = ledger.listMemos(); rows.find(row => row.id === result[0].memo.id).text = '用户手改另一事实'
  fs.writeFileSync(vault.statePath('memos.json'), JSON.stringify(rows))
  assert.throws(() => approve(h, later.proposal, 'later-decision'), /变化|手改|冲突/)
})

test('a hand-edited managed preference is visible but cannot be overwritten by a stale correction', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  assert.equal(typeof h.memory.correct, 'function')
  const candidate = h.memory.correct(original.memo.id, '我偏好详细回复', { identity: input(h, '整理偏好', 'proposal') })
  fs.writeFileSync(vault.PROFILE_FILE(), fs.readFileSync(vault.PROFILE_FILE(), 'utf8').replace('我偏好简短回复', '用户手改：请给中等长度回复'))
  const before = fs.readFileSync(vault.PROFILE_FILE(), 'utf8')
  assert.match(h.memory.retrieve('回复').text, /中等长度/)
  assert.throws(() => approve(h, candidate.proposal), /手改|冲突|变化/)
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), before)
  assert.equal(h.memory.read(candidate.memo.id).memo.status, 'proposed')
})

test('read-only memory state distinguishes confirmation, proposal, rejection and withdrawal with native sources', () => {
  const h = setup(), confirmed = remember(h, '我喜欢中文交流')
  const proposed = h.memory.propose('我喜欢早餐开会', { identity: input(h, '整理推断', 'inference') })
  const rejected = h.memory.propose('我喜欢自动花钱', { identity: input(h, '另一个推断', 'reject') })
  h.memory.decide(rejected.proposal.id, 'declined', {}, input(h, `拒绝 ${rejected.proposal.id}`, 'decline'))
  assert.equal(typeof h.memory.withdraw, 'function')
  h.memory.withdraw(confirmed.memo.id, { identity: input(h, `撤回 ${confirmed.memo.id}`, 'withdraw') })
  const state = h.memory.status()
  assert.deepEqual(state.counts, { confirmed: 0, proposed: 1, rejected: 1, retracted: 1 })
  assert.equal(state.entries.find(row => row.id === confirmed.memo.id).origin.messageId, '我喜欢中文交流')
  assert.equal(h.memory.read(proposed.memo.id).memo.status, 'proposed')
  assert.doesNotMatch(h.memory.retrieve('偏好').text, /早餐开会|自动花钱|喜欢中文交流/)
})

test('model flags and quoted withdrawal text cannot retract a confirmed memory', () => {
  const h = setup(), original = remember(h, '我需要每次附上来源')
  assert.equal(typeof h.memory.withdraw, 'function')
  for (const text of [`任务说明：实现“撤回 ${original.memo.id}”`, `引用：撤回 ${original.memo.id}`]) {
    const result = h.memory.withdraw(original.memo.id, { identity: input(h, text, text), source: 'user', approved: true })
    assert.equal(result.memo.status, 'confirmed')
    assert.equal(result.proposal.status, 'pending')
  }
  assert.equal(h.memory.read(original.memo.id).memo.status, 'confirmed')
})

test('a repeated direct withdrawal after restart is idempotent across different native call ids', () => {
  const h = setup(), original = remember(h, '我喜欢中文交流')
  const identity = input(h, `撤回 ${original.memo.id}`, 'direct-withdraw')
  const first = h.memory.withdraw(original.memo.id, { identity })
  assert.equal(first.memo.status, 'retracted')
  const restarted = new MemoryService({ contexts: new ExecutionContexts({ file: vault.statePath('contexts.json') }) })
  const duplicate = restarted.withdraw(original.memo.id, { identity: { ...identity, callId: 'replayed-with-another-call' } })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.memo.status, 'retracted')
})

test('repeated historical correction approvals cannot revive an earlier preference after a later correction', () => {
  const h = setup(), original = remember(h, '我喜欢简短回复')
  const first = h.memory.correct(original.memo.id, '我喜欢详细回复', { identity: input(h, '更正偏好', 'first') })
  const approved = approve(h, first.proposal, 'first-decision')
  const second = h.memory.correct(approved.memo.id, '我喜欢适中回复', { identity: input(h, '再次更正', 'second') })
  approve(h, second.proposal, 'second-decision')
  assert.equal(approve(h, first.proposal, 'repeat-first').duplicate, true)
  assert.doesNotMatch(h.memory.retrieve('回复').text, /简短|详细/)
  assert.match(h.memory.retrieve('回复').text, /适中/)
})

test('a full profile cannot divert a replacement into a second contradictory active topic', () => {
  const h = setup(), original = remember(h, '我偏好简明回复')
  for (let i = 0; i < 12; i++) remember(h, `我偏好工作习惯${i}`, { key: `habit-${i}` })
  const changed = remember(h, '我偏好详细回复')
  assert.equal(changed.memo.status, 'proposed')
  assert.equal(changed.proposal.targetMemoId, original.memo.id)
  const duplicate = remember(h, '我偏好简明回复', {}, 'new-user-message-same-fact')
  assert.equal(duplicate.memo.id, original.memo.id)
})

test('two proposals for the same preference slot cannot both become active without a bound correction', () => {
  const h = setup()
  const first = h.memory.propose('我偏好简短回复', { identity: input(h, '整理偏好', 'first') })
  const second = h.memory.propose('我偏好详细回复', { identity: input(h, '整理另一个偏好', 'second') })
  approve(h, first.proposal, 'first-decision')
  assert.throws(() => approve(h, second.proposal, 'second-decision'), /偏好|冲突|更正/)
  assert.match(h.memory.retrieve('回复').text, /简短/)
  assert.doesNotMatch(h.memory.retrieve('回复').text, /详细/)
})

test('a confirmed boundary is recalled first even when a model suggests topic placement', () => {
  const h = setup(), boundary = remember(h, '重要边界：未经确认禁止发送第三方消息', { scope: 'topic', topic: '旧项目' })
  assert.equal(boundary.memo.scope, 'profile')
  assert.match(h.memory.retrieve('阅读文学', { maxBytes: 600 }).profile, /禁止发送第三方消息/)
})

test('an unprojected inferred or rejected proposal cannot hide an identical hand-written profile boundary', () => {
  const h = setup(), fact = '重要边界：未经确认禁止发送第三方消息'
  fs.appendFileSync(vault.PROFILE_FILE(), `- ${fact}\n`)
  const bytes = fs.readFileSync(vault.PROFILE_FILE(), 'utf8')
  const candidate = h.memory.remember(fact, { identity: input(h, '帮我整理阅读资料', 'unrelated-input') })
  assert.equal(candidate.memo.status, 'proposed')
  assert.equal(candidate.memo.projection, undefined)
  assert.match(h.memory.retrieve('阅读资料').profile, /未经确认禁止发送第三方消息/)
  h.memory.decide(candidate.proposal.id, 'declined', {}, input(h, `拒绝 ${candidate.proposal.id}`, 'decline-shadow'))
  assert.match(h.memory.retrieve('阅读资料').profile, /未经确认禁止发送第三方消息/)
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), bytes)
  const restarted = new MemoryService({ contexts: new ExecutionContexts({ file: vault.statePath('contexts.json') }) })
  assert.match(restarted.retrieve('阅读资料').profile, /未经确认禁止发送第三方消息/)
})

test('an unprojected topic proposal cannot hide matching owner-written topic text', () => {
  const h = setup(), fact = 'Orion 项目的人手工维护的膜蛋白背景'
  const candidate = h.memory.propose(fact, { scope: 'topic', topic: 'Orion', identity: input(h, '整理推断背景', 'topic-shadow') })
  const audit = h.memory.search('Orion', { includeInactive: true }).items.find(item => item.id === candidate.memo.id)
  fs.writeFileSync(audit.path, `# Orion\n\n- ${fact}\n`)
  const recall = h.memory.retrieve('Orion 膜蛋白')
  assert.equal(recall.topics.length, 1)
  assert.match(recall.text, /人手工维护的膜蛋白背景/)
  assert.equal(recall.topics[0].source.kind, 'local-file')
})

for (const [firstScope, secondScope] of [['profile', 'topic'], ['topic', 'profile']]) {
  test(`approval rechecks the known slot globally across ${firstScope} then ${secondScope} proposals`, () => {
    const h = setup(), identity = input(h, '整理两个偏好', 'parallel-proposals')
    const first = h.memory.propose('我偏好简短回复', { scope: firstScope, ...(firstScope === 'topic' ? { topic: '表达习惯' } : {}), identity })
    const second = h.memory.propose('我偏好详细回复', { scope: secondScope, ...(secondScope === 'topic' ? { topic: '另一主题' } : {}), identity })
    approve(h, first.proposal, 'approve-first')
    const before = fs.readFileSync(vault.statePath('memos.json'), 'utf8')
    assert.throws(() => approve(h, second.proposal, 'approve-second'), /偏好|冲突|更正/)
    assert.equal(fs.readFileSync(vault.statePath('memos.json'), 'utf8'), before)
    assert.equal(h.memory.read(second.memo.id).memo.status, 'proposed')
    assert.equal(h.memory.read(first.memo.id).memo.status, 'confirmed')
    assert.match(h.memory.retrieve('回复').text, /简短回复/)
    assert.doesNotMatch(h.memory.retrieve('回复').text, /详细回复/)
  })
}

test('an approved correction cannot move an unrelated memory into an occupied known preference slot', () => {
  const h = setup(), first = remember(h, '我偏好简短回复'), other = remember(h, '我喜欢晨间锻炼')
  const candidate = h.memory.correct(other.memo.id, '我偏好详细回复', { identity: input(h, '更正锻炼偏好', 'correction-slot') })
  const profile = fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), memos = fs.readFileSync(vault.statePath('memos.json'), 'utf8')
  assert.throws(() => approve(h, candidate.proposal, 'approve-colliding-correction'), /偏好|冲突|更正/)
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), profile)
  assert.equal(fs.readFileSync(vault.statePath('memos.json'), 'utf8'), memos)
  assert.equal(h.memory.read(first.memo.id).memo.status, 'confirmed')
  assert.equal(h.memory.read(other.memo.id).memo.status, 'confirmed')
  assert.equal(h.memory.read(candidate.memo.id).memo.status, 'proposed')
  const native = h.memory.correct(other.memo.id, '我偏好详细回复', { identity: input(h, '通过原生问答审核更正', 'native-correct-collision') })
  const exec = { agent: h.agent, callId: 'native-cross-slot-correction', name: 'ask_user_question', arguments: { questions: [native.proposal.question] } }
  assert.throws(() => h.memory.observeToolResult(exec, { value: { answers: [{ id: native.proposal.question.id, selected: [native.proposal.question.options[0].label] }] } }), /偏好|冲突|更正/)
  assert.equal(h.memory.read(other.memo.id).memo.status, 'confirmed')
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), profile)
})

test('a correction into an empty known slot records that actual slot and preserves its source chain', () => {
  const h = setup(), other = remember(h, '我喜欢晨间锻炼')
  const candidate = h.memory.correct(other.memo.id, '我偏好详细回复', { identity: input(h, '更正这个事实', 'empty-correction-slot') })
  assert.equal(candidate.memo.key, 'reply-length')
  const result = approve(h, candidate.proposal, 'approve-empty-slot')
  assert.equal(result.memo.key, 'reply-length')
  assert.equal(result.memo.supersedes, other.memo.id)
  assert.equal(h.memory.read(other.memo.id).memo.status, 'retracted')
})

test('native question approval also refuses a conflicting slot in another topic without changing the target', () => {
  const h = setup(), identity = input(h, '整理两个偏好', 'native-parallel-proposals')
  const first = h.memory.propose('我偏好简短回复', { scope: 'profile', identity })
  const second = h.memory.propose('我偏好详细回复', { scope: 'topic', topic: '表达习惯', identity })
  const exec = proposal => ({ agent: h.agent, callId: `native-${proposal.id}`, name: 'ask_user_question', arguments: { questions: [proposal.question] } })
  const result = proposal => ({ value: { answers: [{ id: proposal.question.id, selected: [proposal.question.options[0].label] }] } })
  assert.equal(h.memory.observeToolResult(exec(first.proposal), result(first.proposal))[0].memo.status, 'confirmed')
  assert.throws(() => h.memory.observeToolResult(exec(second.proposal), result(second.proposal)), /偏好|冲突|更正/)
  assert.equal(h.memory.read(first.memo.id).memo.status, 'confirmed')
  assert.equal(h.memory.read(second.memo.id).memo.status, 'proposed')
  assert.doesNotMatch(h.memory.retrieve('回复').text, /详细回复/)
})

test('a direct native remember cannot create a second global explicit slot in a different topic', () => {
  const h = setup(), first = remember(h, '当前项目背景是 Orion', { scope: 'topic', topic: 'Orion', key: 'current-project' })
  const before = fs.readFileSync(vault.statePath('memos.json'), 'utf8')
  assert.throws(() => remember(h, '当前项目背景是 Nebula', { scope: 'topic', topic: 'Nebula', key: 'current-project' }), /偏好|冲突|更正/)
  assert.equal(fs.readFileSync(vault.statePath('memos.json'), 'utf8'), before)
  assert.equal(h.memory.read(first.memo.id).memo.status, 'confirmed')
  assert.doesNotMatch(h.memory.retrieve('当前项目').text, /Nebula/)
})

test('retired records without a recorded projection cannot hide a later hand-written legacy value', () => {
  const h = setup(), fact = '我偏好简短回复'
  const legacy = ledger.addMemo({ id: 'legacy-without-projection', text: fact, source: 'user' })
  fs.appendFileSync(vault.PROFILE_FILE(), `- ${fact}\n`)
  h.memory.withdraw(legacy.id, { identity: input(h, `撤回 ${legacy.id}`, 'legacy-withdraw') })
  assert.equal(h.memory.read(legacy.id).memo.projection, undefined)
  fs.appendFileSync(vault.PROFILE_FILE(), `- ${fact}\n`)
  assert.match(h.memory.retrieve('回复').profile, /简短回复/)
})

test('a proven withdrawn projection remains excluded from recall if stale projected bytes reappear', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  h.memory.withdraw(original.memo.id, { identity: input(h, `撤回 ${original.memo.id}`, 'withdraw-projected') })
  const retired = h.memory.read(original.memo.id).memo
  assert.equal(retired.status, 'retracted')
  assert.equal(retired.retraction.decision, 'approved')
  assert.equal(typeof retired.projection.entry, 'string')
  fs.appendFileSync(vault.PROFILE_FILE(), retired.projection.entry)
  assert.doesNotMatch(h.memory.retrieve('回复').profile, /简短回复/)
})

test('prefixing a managed line by hand is a conflict even if its old text remains as a substring', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  const candidate = h.memory.correct(original.memo.id, '我偏好详细回复', { identity: input(h, '更正偏好', 'proposal') })
  const edited = fs.readFileSync(vault.PROFILE_FILE(), 'utf8').replace('- 我偏好简短回复', '- 手工说明：- 我偏好简短回复')
  fs.writeFileSync(vault.PROFILE_FILE(), edited)
  assert.equal(h.memory.read(original.memo.id).projectionState, 'changed')
  assert.throws(() => approve(h, candidate.proposal), /手改|冲突|变化/)
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), edited)
})

test('changing a model supplied preference key cannot append a contrary value to the same known slot', () => {
  const h = setup(), original = remember(h, '我偏好简短回复', { key: 'model-key-one' })
  const changed = remember(h, '我偏好详细回复', { key: 'model-key-two' })
  assert.equal(changed.memo.status, 'proposed')
  assert.equal(changed.proposal.targetMemoId, original.memo.id)
})

test('known legacy preference slots can be corrected without adding a contradictory active record', () => {
  const h = setup(), original = ledger.addMemo({ id: 'legacy-short', text: '我偏好简短回复', source: 'user' })
  fs.appendFileSync(vault.PROFILE_FILE(), '- 我偏好简短回复\n')
  const changed = remember(h, '我偏好详细回复')
  assert.equal(changed.memo.status, 'proposed')
  assert.equal(changed.proposal.targetMemoId, original.id)
  approve(h, changed.proposal)
  assert.doesNotMatch(h.memory.retrieve('回复').text, /简短/)
  assert.match(h.memory.retrieve('回复').text, /详细/)
})

test('declining stale maintenance proposals settles them without reviving a corrected target', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  const correct = h.memory.correct(original.memo.id, '我偏好详细回复', { identity: input(h, '更正偏好', 'correct') })
  const staleCorrect = h.memory.correct(original.memo.id, '我偏好适中回复', { identity: input(h, '另一个更正', 'stale-correct') })
  const staleWithdraw = h.memory.withdraw(original.memo.id, { identity: input(h, '撤回提议', 'stale-withdraw') })
  approve(h, correct.proposal)
  const decline = proposal => h.memory.decide(proposal.id, 'declined', {}, input(h, `拒绝 ${proposal.id}`, `decline-${proposal.id}`))
  assert.equal(decline(staleCorrect.proposal).memo.status, 'rejected')
  assert.equal(decline(staleWithdraw.proposal).memo.status, 'retracted')
  assert.equal(decline(staleWithdraw.proposal).duplicate, true)
  assert.equal(ledger.listPending().length, 0)
  assert.doesNotMatch(h.memory.retrieve('回复').text, /简短|适中/)
  assert.match(h.memory.retrieve('回复').text, /详细/)
})

test('a native withdrawal answer names the withdrawal action and cannot reuse the remember option', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  const { proposal } = h.memory.withdraw(original.memo.id, { identity: input(h, '建议撤回', 'proposal') })
  assert.equal(proposal.question.options[0].label, '确认撤回')
  const exec = { agent: h.agent, callId: 'withdraw-question', name: 'ask_user_question', arguments: { questions: [proposal.question] } }
  h.contexts.capture(exec)
  assert.equal(h.memory.observeToolResult(exec, { value: { answers: [{ id: proposal.question.id, selected: ['确认记住'] }] } }).length, 0)
  const result = h.memory.observeToolResult(exec, { value: { answers: [{ id: proposal.question.id, selected: ['确认撤回'] }] } })
  assert.equal(result[0].memo.status, 'retracted')
  assert.equal(result[0].memo.retraction.source, 'native-question')
})

test('a correction interrupted after state writes recovers the single effective value and its audit chain', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  const candidate = h.memory.correct(original.memo.id, '我偏好详细回复', { identity: input(h, '整理偏好', 'proposal') })
  const identity = input(h, `同意 ${candidate.proposal.id}`, 'decision')
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(vault.PROFILE_FILE())})process.exit(75);return original(from,to)};syncBuiltinESMExports();
    const {ExecutionContexts}=await import(${JSON.stringify(pathToFileURL(resolve('src/host/execution-context.ts')).href)});
    const {MemoryService}=await import(${JSON.stringify(pathToFileURL(resolve('src/host/memory.ts')).href)});
    new MemoryService({contexts:new ExecutionContexts({file:${JSON.stringify(vault.statePath('contexts.json'))}})}).decide(${JSON.stringify(candidate.proposal.id)},'approved',{},${JSON.stringify(identity)});
  `], { cwd: resolve('.'), env: { ...process.env }, windowsHide: true, encoding: 'utf8' })
  assert.equal(run.status, 75, run.stderr)
  const restarted = new MemoryService({ contexts: new ExecutionContexts({ file: vault.statePath('contexts.json') }) })
  assert.equal(restarted.read(original.memo.id).memo.status, 'retracted')
  assert.equal(restarted.read(candidate.memo.id).memo.status, 'confirmed')
  assert.equal(restarted.decide(candidate.proposal.id, 'approved', {}, identity).duplicate, true)
  assert.doesNotMatch(restarted.retrieve('回复').text, /简短回复/)
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8').split('详细回复').length - 1, 1)
})

test('malformed memory storage fails closed for retrieval and maintenance without changing original bytes', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  const profile = fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), path = vault.statePath('memos.json')
  fs.writeFileSync(path, '{broken')
  assert.throws(() => h.memory.retrieve('回复'), /损坏|degraded/)
  assert.throws(() => h.memory.status(), /损坏|degraded/)
  assert.throws(() => h.memory.correct(original.memo.id, '我偏好详细回复'), /损坏|degraded/)
  assert.equal(fs.readFileSync(path, 'utf8'), '{broken')
  assert.equal(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), profile)
})

test('damaged memory metadata cannot be accepted as a fresh preference or overwrite its original file', () => {
  const h = setup(), original = remember(h, '我偏好简短回复')
  const memos = ledger.listMemos(), path = vault.statePath('memos.json')
  memos[0].key = 42
  const bytes = JSON.stringify(memos)
  fs.writeFileSync(path, bytes)
  assert.throws(() => h.memory.status(), /损坏|degraded/)
  assert.throws(() => remember(h, '我偏好详细回复'), /损坏|degraded/)
  assert.equal(fs.readFileSync(path, 'utf8'), bytes)
  assert.match(fs.readFileSync(vault.PROFILE_FILE(), 'utf8'), new RegExp(original.memo.text))
})

test('butler_remember exposes read/search/correct/withdraw without requiring text for read-only actions', async () => {
  const { registerButlerTools } = await import('../src/host/tools.ts')
  const h = setup(), original = remember(h, '我喜欢简短回复'), definitions = new Map()
  const stop = registerButlerTools({ tools: { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } } },
    { timeZone: 'Asia/Shanghai', mailto: 'test@localhost', sessionId: () => 'owner', currentTaskId: () => undefined, memory: h.memory })
  try {
    const tool = definitions.get('butler_remember')
    const read = await tool.execute({ action: 'read', id: original.memo.id })
    assert.equal(read.ok, true)
    assert.equal(read.memory.memo.id, original.memo.id)
    const search = await tool.execute({ action: 'search', query: '简短回复', maxBytes: 700 })
    assert.equal(search.ok, true)
    assert.match(search.text, /简短回复/)
    const corrected = await tool.execute({ action: 'correct', id: original.memo.id, text: '我喜欢详细回复' })
    assert.equal(corrected.proposal.action, 'correct')
    const withdrawal = await tool.execute({ action: 'withdraw', id: original.memo.id })
    assert.equal(withdrawal.proposal.action, 'withdraw')
  } finally { stop() }
})

test('dedicated prompt retains bounded profile boundaries and loads tasks/topics only on demand', async () => {
  const h = setup()
  remember(h, 'Orion 的膜蛋白项目使用冷冻电镜', { scope: 'topic', topic: 'Orion' })
  for (let i = 0; i < 22; i++) remember(h, `土壤项目${i}的资料`, { scope: 'topic', topic: `土壤${i}` })
  fs.writeFileSync(vault.PROFILE_FILE(), `${'- 早期普通背景资料\n'.repeat(250)}- 重要边界：未经确认禁止发送第三方消息。\n`)
  const stamp = new Date().toISOString()
  const tasks = Array.from({ length: 15 }, (_, i) => ({ id: `new-${i}`, title: `等待用户${i}`, status: 'waiting_review', createdAt: stamp, updatedAt: stamp }))
  tasks.push({ id: 'old-due', title: '很早创建的过期事项', status: 'pending', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', dueAt: '2026-01-01T00:00:00.000Z' })
  fs.writeFileSync(vault.vaultPath('ledger', 'tasks.jsonl'), `${tasks.map(row => JSON.stringify(row)).join('\n')}\n`)
  const schemaUrl = new URL('./fixtures/schema-for-entry.mjs', import.meta.url).href
  const hook = registerHooks({ resolve(specifier, context, next) { return specifier === '@deepseek-ai/schemastery' ? { url: schemaUrl, shortCircuit: true } : next(specifier, context) } })
  let apply
  try { ({ apply } = await import('../src/index.ts')) } finally { hook.deregister() }
  const e = contextHarness(), agent = e.agent('session-butler-home'), variables = new Map(), sections = [], effects = []
  e.services.set('timer', { setTimeout() { return 0 } })
  e.services.set('tools', { register() { return () => {} }, guard() { return () => {} }, schemas() { return [] } })
  agent.ctx = { get: name => e.services.get(name) }
  e.services.set('systemPrompt', { section(section) { sections.push(section); return () => {} }, variable(name, provider) { variables.set(name, provider); return () => variables.delete(name) } })
  e.ctx.tools = e.services.get('tools')
  e.ctx.webServer = { register() { return () => {} } }
  e.ctx.logger = { info() {}, warn() {}, error() {} }
  e.ctx.effect = setup => { const dispose = setup(); if (typeof dispose === 'function') effects.push(dispose) }
  try {
    apply(e.ctx, { timeZone: 'Asia/Shanghai', mailto: 'test@localhost', profileChars: 1200, sessionTitleName: '管家', taskMaxRequests: 50, taskMaxTokens: 2000000, taskMaxMinutes: 15, contextTokens: 64000 })
    await e.emit('agent/inbox/claimed', { agent, message: { id: 'native-query', source: { kind: 'user' }, content: [{ type: 'text', text: '继续 Orion 的膜蛋白研究' }] } })
    const profile = variables.get('butler_profile')({ agent }), work = variables.get('butler_open_work')({ agent, query: '土壤' })
    assert.match(profile, /禁止发送第三方消息/)
    assert.ok(Buffer.byteLength(profile) <= 1200)
    assert.match(work, /butler_overview/)
    assert.match(work, /butler_remember/)
    assert.doesNotMatch(work, /Orion/)
    assert.doesNotMatch(work, /土壤/)
    assert.doesNotMatch(work, /很早创建的过期事项/)
    assert.ok(Buffer.byteLength(work) <= 600)
    const external = { agent: e.agent('zotero-native') }
    for (const variable of variables.values()) assert.ok(!variable(external))
    for (const section of sections) assert.equal(section.text(external), '')
    const reminder = { agent: { id: 'session-butler-reminder-fixture' } }
    assert.equal(variables.get('butler_profile')(reminder), '')
    assert.equal(variables.get('butler_open_work')(reminder), '')
  } finally { for (const dispose of effects.reverse()) dispose() }
})
