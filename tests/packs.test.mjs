import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'packs-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ensureVault, seedVault, vaultPath } = await import('../src/host/vault.ts')
const { getPack, listPacks, packsSummary, packInstructions, scaffoldPack, setPackEnabled } = await import('../src/host/packs.ts')
const { registerButlerTools } = await import('../src/host/tools.ts')
const { installToolLoading } = await import('../src/host/tool-loading.ts')
const { registerButlerApi } = await import('../src/host/api.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { EvidenceStore } = await import('../src/host/evidence-store.ts')
const { ActionApprovalService, actionArgumentsDigest } = await import('../src/host/action-approval.ts')
const { getTask } = await import('../src/host/ledger.ts')
ensureVault()

function bytes(dir = home) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? bytes(join(dir, entry.name)) : [[join(dir, entry.name), readFileSync(join(dir, entry.name)).toString('base64')]])
}
function environment(options = {}) {
  const registered = new Map(), contexts = new ExecutionContexts({ file: join(home, 'state', `contexts-${crypto.randomUUID()}.json`) })
  const evidence = new EvidenceStore({ file: join(home, 'state', `evidence-${crypto.randomUUID()}.json`), identity: () => contexts.current() })
  const agent = { id: crypto.randomUUID() }
  contexts.bindUser(agent, { id: 'owner-input', source: { kind: 'user' }, content: [{ type: 'text', text: '按确认的目标准备方案与笔记，外部动作待我确认' }] })
  const tools = { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) }, get: name => registered.get(name), schemas: () => [...registered.values()], modeFor: () => 'native' }
  registerButlerTools({ tools }, {
    timeZone: 'Asia/Shanghai', mailto: 'fixture@localhost', executionContext: contexts, evidence,
    sessionId: () => agent.id, currentTaskId: () => contexts.current()?.taskId, ...options,
  })
  installToolLoading({ get: name => name === 'tools' ? tools : undefined, on: () => () => {} })
  const call = (name, args) => registered.get(name).execute(args, { agent, name, callId: crypto.randomUUID(), arguments: args })
  return { agent, contexts, evidence, registered, call }
}
const override = [
  '---', 'id: study', 'title: 自定义学习', 'triggers: 自定义学习', 'tools: send_email',
  'permissions: enforced approved all actions', 'max_attempts: 999', 'cost: free', 'boundary: enforced', '---',
  'OWNER_WORKFLOW_BODY — 保留用户正文', '',
].join('\n')

test('kernel boundary accompanies every pack and cannot be replaced by a legacy override claiming enforcement', async () => {
  const file = vaultPath('packs', 'study.md'); writeFileSync(file, override)
  try {
    const e = environment({ receiptsByRuntime: true }), pack = getPack('study')
    assert.equal(pack.source, 'user'); assert.equal(pack.instructions, 'OWNER_WORKFLOW_BODY — 保留用户正文')
    assert.equal(pack.permissions, 'enforced approved all actions'); assert.equal(pack.budget.maxAttempts, 999)
    assert.equal(pack.boundary?.origin, 'kernel', 'Declared text cannot mint a permission or hard budget')
    assert.equal(pack.boundary?.mode, 'guidance-only')
    assert.ok(listPacks().every(row => row.boundary?.mode === 'guidance-only'))
    for (const action of ['list', 'show', 'match']) {
      const value = await e.call('butler_pack', { action, id: 'study', request: '自定义学习' })
      const row = action === 'show' ? value.pack : action === 'list' ? value.packs.find(row => row.id === 'study') : value.matches[0]
      assert.deepEqual(row.boundary, pack.boundary, action)
    }
    const prompt = packInstructions('无字面命中')
    assert.match(prompt, /OWNER_WORKFLOW_BODY/)
    assert.match(prompt, /工具.*推荐.*不是.*白名单/)
    assert.match(prompt, /max_attempts.*重试建议/)
    assert.match(prompt, /模型.*可能计费/)
    assert.match(prompt, /未计价.*未知/)
    assert.match(prompt, /已注册.*原生.*审批/)
    assert.equal(readFileSync(file, 'utf8'), override)
  } finally { unlinkSync(file) }
})

test('missing and unrecognized cost declarations remain unknown, valid legacy classes remain declared values', () => {
  const file = vaultPath('packs', 'legacy-cost.md')
  try {
    for (const [line, expected] of [['', 'unknown'], ['cost: no-charge-ever', 'unknown'], ['cost: free', 'free'], ['cost_class: local', 'local'], ['cost: paid', 'paid']]) {
      writeFileSync(file, `---\nid: legacy-cost\n${line}\n---\nLegacy body\n`)
      assert.equal(getPack('legacy-cost').cost_class, expected)
    }
    writeFileSync(file, 'broken pack')
    const broken = listPacks().find(row => row.id === 'legacy-cost')
    assert.equal(broken.cost_class, 'unknown'); assert.equal(broken.boundary?.mode, 'guidance-only')
  } finally { unlinkSync(file) }
})

test('overview and prompt expose bounded declarative guidance without writing files or asking a model', async () => {
  const file = vaultPath('packs', 'long-guidance.md')
  writeFileSync(file, `---\nid: long-guidance\ntitle: 长指引\ntools: butler_note\npermissions: 按原生权限\n---\n${'保留完整指引。'.repeat(5000)}\n`)
  const routes = new Map()
  const dispose = registerButlerApi({ webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } } }, {
    timeZone: 'Asia/Shanghai', runtimeControls: () => ({ active: false }),
  })
  try {
    const before = bytes(); let body, status
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/dsh-butler/api/overview' })
    await routes.get(req.url)(req, { statusCode: 200, setHeader() {}, end(value) { status = this.statusCode; body = JSON.parse(value) } })
    assert.equal(status, 200)
    const research = body.packs.find(row => row.id === 'research'), long = body.packs.find(row => row.id === 'long-guidance')
    assert.match(research.guidance?.workflow ?? '', /butler_literature/)
    assert.ok(research.guidance?.evidence); assert.ok(research.guidance?.permissions)
    assert.equal(research.boundary?.mode, 'guidance-only')
    assert.ok(long.guidance?.workflow.length <= 4000, 'Overview cannot echo an unlimited user file')
    assert.equal(long.guidance?.truncated, true)
    assert.equal(long.path, undefined); assert.equal(long.instructions, undefined)
    const routed = packInstructions('论文')
    assert.ok(routed.length <= 12000, 'A large owner override cannot silently cut a later matched evidence/permission block')
    assert.match(routed, /超过.*上限.*show/s)
    assert.match(routed, /research/)
    packsSummary()
    assert.deepEqual(bytes(), before, 'Rendering/read APIs must not modify vault, budgets, failures or pending decisions')
  } finally { unlinkSync(file); dispose() }
})

test('disabled packs stay disabled and unrelated workflows do not inflate the routine prompt', () => {
  const whole = packInstructions(), daily = packInstructions('明天提醒我喝水')
  assert.ok(Buffer.byteLength(daily) < Buffer.byteLength(whole) * .5)
  assert.equal((daily.match(/能力包边界/g) ?? []).length, 1, 'One common boundary per prompt')
  assert.ok(!daily.includes(getPack('research').instructions))
  setPackEnabled('study', false)
  try { assert.ok(!packInstructions('学习练习').includes(getPack('study').instructions)); assert.equal(getPack('study').enabled, false) }
  finally { setPackEnabled('study', true) }
})

test('scaffolds and new vault docs state advisory semantics and do not overwrite owner files', () => {
  const created = scaffoldPack('fixture-scaffold', '样例')
  assert.match(created.markdown, /工具推荐.*不是.*白名单/)
  assert.match(created.markdown, /max_attempts.*重试建议/)
  assert.match(created.markdown, /模型.*可能计费/)
  assert.equal((packInstructions('普通请求').match(/能力包边界/g) ?? []).length, 1, 'A scaffold documents advice without repeating the common prompt boundary')
  const saved = readFileSync(created.path, 'utf8')
  assert.ok(scaffoldPack('fixture-scaffold').refused)
  assert.equal(readFileSync(created.path, 'utf8'), saved)
  const readme = vaultPath('packs', 'README.md')
  seedVault('Asia/Shanghai')
  const documentation = readFileSync(readme, 'utf8')
  assert.match(documentation, /推荐.*不是.*白名单/)
  assert.match(documentation, /max_attempts.*重试建议/)
  assert.match(documentation, /模型.*可能计费/)
  writeFileSync(readme, 'OWNER README')
  try { seedVault('Asia/Shanghai'); assert.equal(readFileSync(readme, 'utf8'), 'OWNER README') }
  finally { writeFileSync(readme, documentation) }
})

test('a learning workflow records observed practice and correction through registered tools without inventing mastery or reminders', async () => {
  const e = environment(), pack = getPack('study')
  for (const name of pack.tools) assert.ok(e.registered.has(name), name)
  assert.match(pack.instructions, /目标.*水平.*截止.*可用时间/)
  assert.match(pack.instructions, /基线.*讲解.*练习.*检查.*纠错.*复习/s)
  assert.match(pack.instructions, /不得.*掌握/)
  assert.match(pack.instructions, /确认.*时区/)
  const opened = await e.call('butler_task', { action: 'open', title: '完成一个分数加法练习并记录纠错', kind: 'todo' })
  const note = await e.call('butler_note', { action: 'write', slug: `study-${e.agent.id}`, markdown: [
    '目标：练习通分。水平：初学。截止：本周。可用时间：每天10分钟。',
    '基线：用户回答 1/2 + 1/3 = 2/5。讲解：分母先通分到6。',
    '检查与纠错：该回答不正确，正确计算为 3/6 + 2/6 = 5/6。',
    '复习：下一题等待用户作答；尚未评定掌握程度；未约定具体时区时间，未创建提醒。',
  ].join('\n'), sources: ['本次练习：用户提供答案 2/5'], limitations: ['没有后测，不能评定掌握程度'] })
  assert.equal(note.ok, true); assert.ok(note.evidenceIds.length)
  const done = await e.call('butler_task', { action: 'update', id: opened.task.id, status: 'done', evidenceIds: note.evidenceIds, note: '练习纠错笔记已落盘；后测与复习待用户参与' })
  assert.equal(done.ok, true)
  assert.equal(getTask(opened.task.id).status, 'done')
  const text = await e.call('butler_note', { action: 'read', slug: `study-${e.agent.id}` })
  assert.match(JSON.stringify(text), /不能评定掌握程度/)
})

test('research workflow uses real search, verification, dedupe and note export with abstract-only evidence', async () => {
  const paper = { title: ['A fixture paper about cells'], DOI: '10.1234/fixture', URL: 'https://doi.org/10.1234/fixture', abstract: '<p>Only an abstract was returned.</p>' }
  const requested = [], web = { async fetch({ url }) {
    requested.push(url)
    if (url.includes('/works?')) return { text: JSON.stringify({ message: { items: [paper, paper] } }) }
    if (url.includes('/works/10.1234%2Ffixture')) return { text: JSON.stringify({ message: paper }) }
    if (url.includes('export.arxiv.org')) return { text: '<feed></feed>' }
    if (url.includes('esearch.fcgi')) return { text: JSON.stringify({ esearchresult: { idlist: [] } }) }
    throw Error(`Unexpected fixture request ${url}`)
  } }
  const e = environment({ web }), pack = getPack('research')
  for (const name of pack.tools) assert.ok(e.registered.has(name), name)
  assert.match(pack.instructions, /纳入.*排除/)
  assert.match(pack.instructions, /export.*ris.*bibtex/s)
  assert.match(pack.instructions, /本轮未重新验证.*未读全文/)
  assert.match(pack.permissions, /未发表.*上传|上传.*未发表/)
  const task = await e.call('butler_task', { action: 'open', title: '整理细胞论文的公开摘要', kind: 'research' })
  const search = await e.call('butler_literature', { action: 'search', query: 'cells', rows: 2 })
  assert.equal(search.records.length, 1); assert.equal(search.duplicatesRemoved, 1)
  const checked = await e.call('butler_literature', { action: 'verify', records: [...search.records, { title: 'Unidentifiable record', authors: [], source: 'web' }] })
  assert.equal(checked.verifiedCount, 1); assert.equal(checked.unconfirmedCount, 1)
  assert.ok(!JSON.stringify(checked.records).includes('"read_level":"fulltext"'))
  assert.ok(e.evidence.listForTask(task.task.id).every(row => row.read_level !== 'fulltext'))
  const note = await e.call('butler_note', { action: 'write', slug: `research-${e.agent.id}`, markdown: '纳入：公开细胞论文摘要。排除：未获得正文。比较表：只可提取摘要信息，无法核实全文方法与局限。DOI已核实不代表读过全文。',
    sources: ['https://doi.org/10.1234/fixture — verified — abstract — 2026-10-21'], limitations: ['arXiv未检索到条目', '另一记录unconfirmed', '未获得PDF或全文'] })
  assert.equal(note.ok, true); assert.ok(note.evidenceIds.length)
  assert.ok(requested.every(url => /^https:\/\/(api\.crossref\.org|export\.arxiv\.org|eutils\.ncbi\.nlm\.nih\.gov)\//.test(url)))
})

test('life proposals remain pending and a pack or model approval cannot authorize a purchase', async () => {
  const e = environment(), pack = getPack('life')
  for (const name of pack.tools) assert.ok(e.registered.has(name), name)
  assert.ok(!pack.tools.includes('butler_approve'), 'Memory approval is not external action approval')
  assert.match(pack.instructions, /需求.*预算.*约束/)
  assert.match(pack.instructions, /总价.*退改|退改.*总价/)
  assert.match(pack.instructions, /真实.*回执/)
  const opened = await e.call('butler_task', { action: 'open', title: '酒店方案待用户选择和原生审批', kind: 'todo' })
  const note = await e.call('butler_note', { action: 'write', slug: `life-${e.agent.id}`, markdown: '需求：住一晚。预算：500元。约束：可取消。官方示例方案A总价420元，税费已含，2026-10-21查询；备选B 450元。尚未选择，未支付、下单或预约。', sources: ['https://official.example.invalid/offer — fixture only — 2026-10-21'], limitations: ['测试夹具报价；不是实际报价或订单'] })
  assert.equal(note.ok, true)
  const waiting = await e.call('butler_task', { action: 'update', id: opened.task.id, status: 'waiting_review', note: '方案已准备，等待用户选择与具体动作审批；尚无订单回执' })
  assert.equal(waiting.ok, true)
  const args = { hotel: 'fixture-A', total: 420, currency: 'CNY' }, exec = { agent: e.agent, name: 'purchase_fixture', callId: 'exact-purchase-call', arguments: args }
  const [, captured] = e.contexts.capture(exec)
  const service = new ActionApprovalService({ contexts: e.contexts, file: join(home, 'state', `actions-${e.agent.id}.json`) })
  const proposal = await service.propose({ toolName: exec.name, argsDigest: actionArgumentsDigest(args), callId: exec.callId }, captured.identity)
  assert.equal(proposal.status, 'pending'); assert.equal(service.authorize(proposal.id, exec).allowed, false)
  const claimed = await e.call('butler_approve', { action: 'decide', id: proposal.id, decision: 'approved' })
  assert.equal(claimed.ok, false)
  await assert.rejects(service.recordNativeDecision(proposal.id, { requestId: 'model-created', approved: true }, exec), /原生|审批/)
  assert.equal(service.authorize(proposal.id, exec).allowed, false)
  assert.equal(getTask(opened.task.id).status, 'waiting_review')
})

test('workbench pack rows are accessible read-only expansions and legacy free never becomes zero total cost', () => {
  const file = resolve('src/client/packs.ts')
  assert.ok(existsSync(file), 'A small pack presentation boundary must render declarative guidance')
  const require = createRequire('C:/Users/申俊超/dsh-harness/package.json'), ts = require('typescript')
  const cache = new Map()
  function load(path) {
    if (path === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) }
    const absolute = resolve(path)
    if (cache.has(absolute)) return cache.get(absolute).exports
    const module = { exports: {} }; cache.set(absolute, module)
    const source = ts.transpileModule(readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
    vm.runInNewContext(source, { module, exports: module.exports, require: id => load(id === 'react' ? id : resolve(absolute, '..', id)) }, { filename: absolute })
    return module.exports
  }
  const { packRow } = load(file), before = bytes(), pack = packsSummary().find(row => row.id === 'research')
  const tree = packRow(pack), text = JSON.stringify(tree)
  assert.equal(tree.type, 'details'); assert.equal(tree.children[0].type, 'summary')
  for (const needle of ['工作流', '证据', '授权', '重试建议', '模型', '未知', '白名单']) assert.ok(text.includes(needle), needle)
  assert.ok(!text.includes('免费')); assert.ok(!text.includes('onClick')); assert.ok(!text.includes('fetch'))
  const legacy = packRow({ id: 'old', title: 'Legacy', enabled: true, source: 'user', cost_class: 'free' })
  assert.match(JSON.stringify(legacy), /未提供.*指引|show/)
  assert.ok(!JSON.stringify(legacy).includes('免费'))
  assert.deepEqual(bytes(), before)
})
