import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'nature-pack-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
const { getPack, matchPacks, packInstructions, packsSummary, setPackEnabled } = await import('../src/host/packs.ts')
ensureVault()

const workflows = [
  'nature-academic-search', 'nature-citation', 'nature-data', 'nature-figure',
  'nature-paper2ppt', 'nature-polishing', 'nature-reader', 'nature-response', 'nature-writing',
]
function nature() {
  const pack = getPack('nature')
  assert.ok(pack, 'The Nature workflow router must ship as a built-in pack')
  return pack
}

test('the default-enabled Nature pack contains a short route for each native workflow', () => {
  const pack = nature()
  assert.equal(pack.source, 'builtin')
  assert.equal(pack.enabled, true)
  assert.equal(pack.cost_class, 'unknown', 'Workflow tool dependencies do not establish a service price')
  assert.equal(pack.boundary.mode, 'guidance-only')
  assert.ok(pack.instructions.length < 2200, 'Route to the nine skills instead of embedding their bodies')
  for (const name of workflows) assert.ok(pack.instructions.includes(name), name)
  assert.match(pack.instructions, /nature-shared.*共享资源.*不是独立技能/)
  const summary = packsSummary().find(row => row.id === 'nature')
  assert.equal(summary.enabled, true)
  assert.equal(summary.guidance.truncated, undefined)
})

test('Nature routes expand for research requests while ordinary requests keep only its catalog entry', () => {
  const pack = nature(), ordinary = packInstructions('明天十点提醒我喝水')
  assert.match(ordinary, /nature=/)
  assert.ok(ordinary.includes(getPack('daily').instructions))
  assert.ok(!ordinary.includes(pack.instructions))
  assert.ok(!ordinary.includes('nature-academic-search'))
  for (const request of ['Nature skills', '论文起草', '文献检索', 'CNS引用', '数据可用性', '代码可用性', '科研绘图', '科学图表', '文献汇报', '学术润色', '论文精读', '双语精读', '审稿回复']) {
    assert.ok(packInstructions(request).includes(pack.instructions), request)
    assert.ok(matchPacks(request, 8).some(row => row.pack.id === 'nature'), request)
  }
})

test('Nature guidance loads summaries before native bodies and only the required resources', () => {
  const pack = nature(), text = pack.instructions
  assert.match(text, /butler_skills.*摘要.*原生\s*skill\(name\).*正文/)
  assert.match(text, /skill_content.*不重复加载/)
  assert.match(text, /manifest.*core.*片段.*\.\.\/nature-shared/)
  assert.match(text, /所需文件/)
  assert.match(text, /不预读整库/)
  assert.match(text, /已启用.*不等于全文常驻.*自动执行/)
  assert.match(text, /正文.*会话历史.*保留/)
  for (const name of ['butler_skills', 'skill', 'butler_tools', 'butler_literature', 'butler_pdf', 'butler_note']) {
    assert.ok(pack.tools.includes(name), name)
  }
})

test('Nature guidance checks actual DSH dependencies and preserves execution, cost and permission uncertainty', () => {
  const pack = nature(), text = pack.instructions
  assert.match(text, /核对.*工具.*依赖.*权限/)
  assert.match(text, /不能假定.*Codex MCP.*Python.*PPTX.*DSH.*可用/)
  assert.match(text, /缺少工具或权限.*未执行.*限制与失败/)
  assert.match(text, /权限.*成本.*预算.*不因\s*skill\s*授予/)
  assert.match(text, /未计价.*不代表免费/)
  assert.match(pack.evidence, /实际.*工具|工具.*实际/)
  assert.match(pack.permissions, /授权|审批/)
})

test('Nature pack enablement and legacy user overrides retain the existing pack semantics', () => {
  const original = nature(), file = vaultPath('packs', 'custom-nature.md')
  try {
    assert.equal(setPackEnabled('nature', false).enabled, false)
    assert.ok(!packInstructions('论文精读').includes(original.instructions))
    assert.equal(setPackEnabled('nature', true).enabled, true)
    writeFileSync(file, '---\nid: nature\ntitle: 自建Nature\ntriggers: 特定科研\n---\nOWNER_NATURE_WORKFLOW\n')
    assert.equal(getPack('nature').source, 'user')
    assert.match(packInstructions('普通请求'), /OWNER_NATURE_WORKFLOW/)
    assert.ok(!packInstructions('普通请求').includes(original.instructions))
  } finally {
    try { unlinkSync(file) } catch {}
    setPackEnabled('nature', true)
  }
})
