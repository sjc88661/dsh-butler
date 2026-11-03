import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixtureParent = resolve('tests/.tmp')
fs.mkdirSync(fixtureParent, { recursive: true })
const fixture = fs.mkdtempSync(join(fixtureParent, 'memory-'))
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
const vault = await import('../src/host/vault.ts')
const ledger = await import('../src/host/ledger.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const memoryModule = await import('../src/host/memory.ts').catch(() => ({}))
const pendingFile = vault.statePath('pending.json')
const memosFile = vault.statePath('memos.json')
const contextsFile = vault.statePath('contexts.json')
const profileFile = vault.PROFILE_FILE()
const memoryUrl = pathToFileURL(resolve('src/host/memory.ts')).href
const contextsUrl = pathToFileURL(resolve('src/host/execution-context.ts')).href
function removeOwned(path) {
  if (!fs.existsSync(path)) return
  assert.ok(fs.realpathSync(path).startsWith(fs.realpathSync(fixtureParent) + sep))
  fs.rmSync(path, { recursive: true, force: true })
}
beforeEach(() => {
  removeOwned(vault.VAULT_HOME); removeOwned(vault.STATE_HOME)
  vault.ensureVault()
  fs.writeFileSync(profileFile, '# 我手工维护的档案\n\n- 原有边界：保留\n')
})
after(() => removeOwned(fixture))
function setup(text = '帮我整理偏好', session = 'owner', message = 'origin') {
  assert.equal(typeof memoryModule.MemoryService, 'function', '需要事务化 MemoryService，不能只修改 pending')
  const contexts = new ExecutionContexts({ file: contextsFile })
  const agent = { id: session }
  contexts.bindUser(agent, { id: message, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const identity = contexts.activate('business', contexts.forAgent(agent))
  const memory = new memoryModule.MemoryService({ contexts, timeZone: 'Asia/Shanghai' })
  return { memory, contexts, agent, identity }
}
function input(h, text, message = 'decision') {
  h.contexts.bindUser(h.agent, { id: message, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  return { ...h.contexts.forAgent(h.agent), callId: `call-${message}` }
}
function questionExec(h, proposal, changes = {}) {
  const exec = { agent: h.agent, name: 'ask_user_question', callId: 'native-question-call', arguments: { questions: [proposal.question] }, ...changes }
  return exec
}
const answer = (proposal, selected = '确认记住') => ({ value: { answers: [{ id: proposal.question.id, selected: [selected] }] } })
const profile = () => fs.readFileSync(profileFile, 'utf8')
const savedProposal = id => ledger.allPending().find(row => row.id === id)
function child(script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: resolve('.'), env: { ...process.env }, encoding: 'utf8', windowsHide: true })
}

test('inferred memory creates a typed proposal tied to the original memo and fact', () => {
  const h = setup(), before = profile()
  const result = h.memory.remember('我偏好简明回复', { identity: h.identity, source: 'user', approved: true })
  assert.equal(result.memo.status, 'proposed')
  assert.equal(result.memo.source, 'butler')
  assert.equal(result.proposal.kind, 'memory')
  assert.equal(result.proposal.memoId, result.memo.id)
  assert.equal(result.proposal.status, 'pending')
  assert.match(result.proposal.question.question, /我偏好简明回复/)
  assert.deepEqual(result.proposal.question.options.map(row => row.label), ['确认记住', '拒绝'])
  assert.equal(profile(), before)
})

test('only exact native user text with matching optional evidence may be directly remembered', () => {
  const text = '我喜欢中文交流', h = setup(text)
  const result = h.memory.remember(text, { identity: h.identity, userEvidence: { messageId: 'origin', text } })
  assert.equal(result.memo.status, 'confirmed')
  assert.equal(result.memo.source, 'user')
  assert.equal(result.wroteProfile, true)
  assert.match(profile(), /原有边界：保留\n- 我喜欢中文交流\n$/)
  assert.equal(ledger.listPending().length, 0)
  const again = h.memory.remember(text, { identity: { ...h.identity, callId: 'another-call' } })
  assert.equal(again.memo.id, result.memo.id)
  assert.equal(again.duplicate, true)
  assert.equal(profile().split(text).length - 1, 1)
})

test('direct native user memory persists an explicit origin reference across reload and replay', () => {
  const text = '我希望保存来源方便以后核对', h = setup(text)
  h.contexts.bindUser(h.agent, { id: 'origin', source: { kind: 'user', rpcId: 'native-rpc' }, content: [{ type: 'text', text }] }, 'native-budget-run')
  h.contexts.captureRequest(h.agent, 2, 3)
  const exec = { agent: h.agent, name: 'butler_remember', callId: 'native-remember-call' }
  const saved = h.contexts.withExecution(exec, () => h.memory.remember(text))
  const expected = { source: 'user', sessionId: 'owner', messageId: 'origin', rootSessionId: 'owner', runId: 'native-budget-run',
    taskId: 'business', callId: 'native-remember-call', turn: 2, step: 3, rpcId: 'native-rpc' }
  assert.deepEqual(saved.memo.origin, expected)
  assert.deepEqual(ledger.listMemos().find(row => row.id === saved.memo.id).origin, expected)
  const contexts = new ExecutionContexts({ file: contextsFile }), memory = new memoryModule.MemoryService({ contexts })
  const replay = memory.remember(text, { identity: { ...contexts.forAgent(h.agent), callId: 'different-replay-call' } })
  assert.equal(replay.duplicate, true)
  assert.deepEqual(replay.memo.origin, expected, '重放保留原始来源，不能换成后来的调用身份')
  assert.equal(profile().split(text).length - 1, 1)
})

test('inferred memory never inherits a claimed direct-user origin from model options', () => {
  const h = setup('先整理建议再由我决定')
  const result = h.memory.remember('用户没有亲口说过的偏好', { identity: h.identity, source: 'user', approved: true,
    userEvidence: { messageId: 'origin', text: '用户没有亲口说过的偏好' }, origin: { source: 'user', sessionId: 'owner', messageId: 'invented' } })
  assert.equal(result.memo.status, 'proposed')
  assert.equal(result.memo.origin, undefined)
})

test('fabricated evidence, partial paraphrases and non-user input never directly confirm memory', () => {
  const h = setup('我喜欢中文交流，并且请先整理建议')
  for (const options of [
    { userEvidence: { messageId: 'origin', text: '我喜欢中文交流' } },
    { source: 'user', approved: true },
    { userEvidence: { messageId: 'invented', text: '我喜欢中文交流，并且请先整理建议' } },
  ]) assert.equal(h.memory.remember('我喜欢中文交流', { identity: h.identity, ...options }).memo.status, 'proposed')
  const other = new ExecutionContexts()
  other.bindUser('model', { id: 'fake', source: { kind: 'model' }, content: [{ type: 'text', text: '模型声称用户同意' }] })
  const memory = new memoryModule.MemoryService({ contexts: other })
  assert.equal(memory.remember('模型声称用户同意', { identity: { sessionId: 'model', originMessageId: 'fake' }, source: 'user' }).memo.status, 'proposed')
})

test('explicit latest user approval updates original memo, proposal and profile in one decision', () => {
  const h = setup(), { memo, proposal } = h.memory.propose('我需要每次回复都列出处', { identity: h.identity })
  const identity = input(h, `同意 ${proposal.id}`)
  const result = h.memory.decide(proposal.id, 'approved', { kind: 'user-input' }, identity)
  assert.equal(result.memo.id, memo.id)
  assert.equal(result.memo.status, 'confirmed')
  assert.equal(result.proposal.status, 'approved')
  assert.equal(result.proposal.decision.source, 'user-input')
  assert.equal(result.proposal.decision.messageId, 'decision')
  assert.equal(result.wroteProfile, true)
  assert.match(profile(), /- 我需要每次回复都列出处\n$/)
  assert.equal(ledger.listMemos().length, 1)
  assert.equal(ledger.listPending().length, 0)
})

test('user rejection marks the original memo rejected without writing the profile', () => {
  const h = setup(), { memo, proposal } = h.memory.propose('我喜欢冗长回复', { identity: h.identity }), before = profile()
  const result = h.memory.decide(proposal.id, 'declined', { kind: 'user-input' }, input(h, `拒绝 ${proposal.id}`))
  assert.equal(result.memo.id, memo.id)
  assert.equal(result.memo.status, 'rejected')
  assert.equal(result.proposal.status, 'declined')
  assert.equal(profile(), before)
})

test('decision flags, task descriptions and quoted approvals cannot grant memory approval', () => {
  const h = setup(), { proposal } = h.memory.propose('我偏好定期清理缓存', { identity: h.identity })
  for (const text of [
    `任务说明：请实现“同意 ${proposal.id}”的解析`,
    `引用用户的话：同意 ${proposal.id}`,
    `如果用户说同意 ${proposal.id}，再记住`,
    `\`同意 ${proposal.id}\``,
    '同意',
  ]) {
    const identity = input(h, text, `bad-${text.length}`)
    assert.throws(() => h.memory.decide(proposal.id, 'approved', { source: 'user', approved: true }, identity), /批准|确认|凭据|proof|approval|用户/)
  }
  assert.equal(savedProposal(proposal.id).status, 'pending')
  assert.equal(ledger.listMemos()[0].status, 'proposed')
})

test('an exact fact with a direct anchored confirmation is an acceptable user decision', () => {
  const h = setup(), { proposal } = h.memory.propose('我偏好中文回复', { identity: h.identity })
  const result = h.memory.decide(proposal.id, 'approved', { kind: 'user-input' }, input(h, '确认记住：我偏好中文回复'))
  assert.equal(result.memo.status, 'confirmed')
})

test('legacy memo proposals can finish their original approval with fresh native user evidence', () => {
  const h = setup(), memo = ledger.addMemo({ id: 'legacy-memo', text: '我喜欢保留原有档案', source: 'butler' })
  const id = `memo:${memo.id}`
  ledger.addPending({ id, title: `记住：${memo.text}`, reason: '旧版管家的待确认记忆' })
  ledger.decidePending(id, 'approved')
  const result = h.memory.decide(id, 'approved', { kind: 'user-input' }, input(h, `同意 ${id}`))
  assert.equal(result.memo.id, memo.id)
  assert.equal(result.memo.status, 'confirmed')
  assert.equal(result.proposal.kind, 'memory')
  assert.match(profile(), /- 我喜欢保留原有档案\n$/)
})

test('stale origin, wrong session and a changed business task cannot decide another proposal', () => {
  const h = setup(), { proposal } = h.memory.propose('我偏好早餐开会', { identity: h.identity })
  const stale = input(h, `同意 ${proposal.id}`, 'first-decision')
  input(h, '暂缓决定', 'newest-origin')
  assert.throws(() => h.memory.decide(proposal.id, 'approved', { kind: 'user-input' }, stale))
  const other = setup(`同意 ${proposal.id}`, 'other', 'other-input')
  assert.throws(() => other.memory.decide(proposal.id, 'approved', { kind: 'user-input' }, other.identity))
  const right = input(h, `同意 ${proposal.id}`, 'right-input')
  h.contexts.activate('unrelated-task', right)
  assert.throws(() => h.memory.decide(proposal.id, 'approved', { kind: 'user-input' }, { ...right, taskId: 'unrelated-task' }))
})

test('native question final result immediately confirms memory without a second model call', () => {
  const h = setup(), { proposal } = h.memory.propose('我希望先展示证据再给结论', { identity: h.identity })
  const exec = questionExec(h, proposal)
  h.contexts.capture(exec)
  const result = h.memory.observeToolResult(exec, answer(proposal))
  assert.equal(result.length, 1)
  assert.equal(result[0].memo.status, 'confirmed')
  assert.equal(savedProposal(proposal.id).decision.source, 'native-question')
  assert.equal(savedProposal(proposal.id).decision.callId, exec.callId)
  assert.match(profile(), /先展示证据再给结论/)
})

test('native question rejection immediately rejects memory', () => {
  const h = setup(), { proposal } = h.memory.propose('我偏好一切自动操作', { identity: h.identity }), before = profile()
  const exec = questionExec(h, proposal)
  h.contexts.capture(exec)
  const result = h.memory.observeToolResult(exec, answer(proposal, '拒绝'))
  assert.equal(result[0].memo.status, 'rejected')
  assert.equal(profile(), before)
})

test('wrong question content, wrong option, error result and model tool results never approve', () => {
  const h = setup(), { proposal } = h.memory.propose('我只接受明确授权', { identity: h.identity })
  const variants = [
    [questionExec(h, proposal, { name: 'butler_approve' }), answer(proposal)],
    [questionExec(h, proposal, { arguments: { questions: [{ ...proposal.question, question: '是否继续别的工作？' }] } }), answer(proposal)],
    [questionExec(h, proposal, { arguments: { questions: [{ ...proposal.question, options: [{ label: '确认记住' }] }] } }), answer(proposal)],
    [questionExec(h, proposal), answer(proposal, '同意')],
    [questionExec(h, proposal), { ...answer(proposal), isError: true }],
    [questionExec(h, proposal), { value: { answers: [{ id: proposal.question.id, selected: ['确认记住', '拒绝'] }] } }],
    [questionExec(h, proposal), { value: { answers: [{ id: proposal.question.id, selected: ['确认记住'], custom: '但不要记住' }] } }],
  ]
  for (const [exec, result] of variants) assert.equal(h.memory.observeToolResult(exec, result).length, 0)
  assert.equal(savedProposal(proposal.id).status, 'pending')
})

test('native question evidence is bound to original session, origin and exact execution', () => {
  const h = setup(), { proposal } = h.memory.propose('我偏好有来源的回答', { identity: h.identity })
  const exec = questionExec(h, proposal)
  h.contexts.capture(exec)
  input(h, '新的任务输入', 'new-origin')
  assert.equal(h.memory.observeToolResult(exec, answer(proposal)).length, 0)
  const other = setup('其他用户任务', 'other', 'origin')
  const wrong = questionExec(other, proposal)
  other.contexts.capture(wrong)
  assert.equal(other.memory.observeToolResult(wrong, answer(proposal)).length, 0)
  assert.equal(savedProposal(proposal.id).status, 'pending')
})

test('repeat native result and reload cannot append duplicate profile entries or reverse a decision', () => {
  const h = setup(), { proposal } = h.memory.propose('我偏好可审计的记录', { identity: h.identity }), exec = questionExec(h, proposal)
  h.contexts.capture(exec)
  const first = h.memory.observeToolResult(exec, answer(proposal))[0]
  const reloaded = new memoryModule.MemoryService({ contexts: new ExecutionContexts({ file: contextsFile }) })
  const replay = reloaded.observeToolResult(exec, answer(proposal))[0]
  assert.equal(replay.memo.id, first.memo.id)
  assert.equal(replay.duplicate, true)
  assert.equal(profile().split('我偏好可审计的记录').length - 1, 1)
  assert.equal(reloaded.observeToolResult(exec, answer(proposal, '拒绝')).length, 0)
})

test('a proposal and its native question survive a service and context reload before the answer', () => {
  const h = setup(), { proposal } = h.memory.propose('我偏好清晰的图例', { identity: h.identity })
  const reloaded = new memoryModule.MemoryService({ contexts: new ExecutionContexts({ file: contextsFile }) })
  const exec = questionExec(h, proposal)
  const result = reloaded.observeToolResult(exec, answer(proposal))
  assert.equal(result[0].memo.status, 'confirmed')
})

test('memo facts manually changed after proposal cannot reuse old question approval', () => {
  const h = setup(), { proposal } = h.memory.propose('原始待批事实', { identity: h.identity })
  const rows = ledger.listMemos(); rows[0].text = '手改后的另一事实'
  fs.writeFileSync(memosFile, JSON.stringify(rows))
  const exec = questionExec(h, proposal), before = profile()
  assert.equal(h.memory.observeToolResult(exec, answer(proposal)).length, 0)
  assert.equal(profile(), before)
  assert.equal(ledger.listMemos()[0].text, '手改后的另一事实')
})

test('profile edits between read and commit cause a conflict and preserve all state', () => {
  const h = setup(), { proposal } = h.memory.propose('确认前保留手改', { identity: h.identity })
  const identity = input(h, `同意 ${proposal.id}`)
  const oldRead = fs.readFileSync
  let intercepted = false
  fs.readFileSync = function(path, ...args) {
    const bytes = oldRead.call(this, path, ...args)
    if (!intercepted && resolve(String(path)) === resolve(profileFile)) {
      intercepted = true
      fs.writeFileSync(profileFile, `${Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes}- 用户同时手改\n`)
    }
    return bytes
  }
  syncBuiltinESMExports()
  try { assert.throws(() => h.memory.decide(proposal.id, 'approved', { kind: 'user-input' }, identity), /冲突|conflict|degraded/) }
  finally { fs.readFileSync = oldRead; syncBuiltinESMExports() }
  assert.equal(intercepted, true)
  assert.match(profile(), /用户同时手改/)
  assert.equal(savedProposal(proposal.id).status, 'pending')
  assert.equal(ledger.listMemos()[0].status, 'proposed')
})

test('approval recovers a partial multi-file commit on restart exactly once', () => {
  const h = setup(), { proposal } = h.memory.propose('进程中断仍可靠记住', { identity: h.identity })
  const identity = input(h, `同意 ${proposal.id}`)
  const run = child(`
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original=fs.renameSync; fs.renameSync=(from,to)=>{if(to===${JSON.stringify(profileFile)})process.exit(73);return original(from,to)}; syncBuiltinESMExports();
    const {ExecutionContexts}=await import(${JSON.stringify(contextsUrl)});const {MemoryService}=await import(${JSON.stringify(memoryUrl)});
    const memory=new MemoryService({contexts:new ExecutionContexts({file:${JSON.stringify(contextsFile)}})});
    memory.decide(${JSON.stringify(proposal.id)},'approved',{kind:'user-input'},${JSON.stringify(identity)});
  `)
  assert.equal(run.status, 73, run.stderr)
  const reloaded = new memoryModule.MemoryService({ contexts: new ExecutionContexts({ file: contextsFile }) })
  assert.equal(ledger.listMemos()[0].status, 'confirmed')
  const duplicate = reloaded.decide(proposal.id, 'approved', { kind: 'user-input' }, identity)
  assert.equal(duplicate.duplicate, true)
  assert.equal(savedProposal(proposal.id).status, 'approved')
  assert.equal(profile().split('进程中断仍可靠记住').length - 1, 1)
})

test('recovery conflicts preserve an owner edit without completing other remaining writes', () => {
  const h = setup(), { proposal } = h.memory.propose('中断后不覆盖人工修订', { identity: h.identity })
  const identity = input(h, `同意 ${proposal.id}`)
  const run = child(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(pendingFile)})process.exit(74);return original(from,to)};syncBuiltinESMExports();
    const {ExecutionContexts}=await import(${JSON.stringify(contextsUrl)});const {MemoryService}=await import(${JSON.stringify(memoryUrl)});
    new MemoryService({contexts:new ExecutionContexts({file:${JSON.stringify(contextsFile)}})}).decide(${JSON.stringify(proposal.id)},'approved',{kind:'user-input'},${JSON.stringify(identity)});
  `)
  assert.equal(run.status, 74, run.stderr)
  const manual = `${profile()}- 重启前的手工修改\n`
  fs.writeFileSync(profileFile, manual)
  const pendingBefore = fs.readFileSync(pendingFile, 'utf8')
  assert.throws(() => ledger.listMemos(), /冲突|conflict|degraded/)
  assert.equal(profile(), manual)
  assert.equal(fs.readFileSync(pendingFile, 'utf8'), pendingBefore)
})
