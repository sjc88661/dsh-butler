import test from 'node:test'
import assert from 'node:assert/strict'
import { skillEnvironment } from './helpers/native-skill.mjs'
const { installSkillLoading } = await import('../src/host/skill-loading.ts').catch(() => ({}))
const catalogs = decision => decision.messages.filter(message => message.source?.kind === 'skill-catalog')
const text = message => message.content.map(block => block.text ?? '').join('\n')
function environment(options) {
  assert.equal(typeof installSkillLoading, 'function', 'skill summaries must be discovered without injecting the full catalog')
  return skillEnvironment(installSkillLoading, options)
}
const human = (value, id = 'human-1') => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: value }] })
const extra = (name, description = 'Literature search 文献搜索', invocation = { modelInvocable: true, userInvocable: true }) => ({
  name, description, invocation, provider: 'scoped', content: `FULL_${name}`, resourceBase: { kind: 'directory', path: `E:/scoped/${name}` } })

test('unmanaged Zotero skill catalog passes through unchanged and discovery is denied', async () => {
  const e = skillEnvironment(ctx => installSkillLoading(ctx, { appliesTo: agent => agent.id === 'managed' }))
  const a = e.agent('zotero'), result = await e.step(a)
  const native = e.nativeDecisions.at(-1)
  assert.equal(result, native)
  assert.equal(result.messages, native.messages)
  assert.equal(catalogs(result)[0], catalogs(native)[0])
  assert.equal((await e.search(a, { query: '文献' })).ok, false)
  const managed = e.agent('managed'), active = await e.step(managed)
  assert.match(text(catalogs(active)[0]), /butler_skills/)
})

test('the shipped native plugin reproduces the recorded64-summary full injection', async () => {
  const e = skillEnvironment(), a = e.agent(), result = await e.step(a)
  assert.equal(catalogs(result)[0].source.entries.length, 64)
  assert.equal(Buffer.byteLength(text(catalogs(result)[0])), 16089)
  assert.equal(e.gets.length, 0, 'The eager cost is summaries, not full skill bodies')
})

test('new native catalogs retain their identity and digest entries but expose only compact discovery guidance', async () => {
  const e = environment(), a = e.agent(), result = await e.step(a)
  const catalog = catalogs(result)[0], original = catalogs(e.nativeDecisions.at(-1))[0]
  assert.ok(Object.isFrozen(original) && Object.isFrozen(original.content))
  assert.ok(Buffer.byteLength(text(catalog)) < 1000)
  assert.match(text(catalog), /butler_skills/)
  assert.match(text(catalog), /butler_tools.*(?:加载|load).*skill/)
  assert.ok(!text(catalog).includes('humanizer-zh'))
  assert.equal(catalog.id, original.id)
  assert.equal(catalog.source, original.source)
  assert.equal(catalog.source.entries.length, 64)
  assert.equal(e.tools.get('skill', a), e.originalSkill, 'The original native loader must not be shadowed')
})

test('search is bounded, uses native-authorized summaries, and does not load any skill body', async () => {
  const e = environment(), a = e.agent(); a.additions = Array.from({ length: 12 }, (_, i) => extra(`literature-${i}`, 'Literature 文献 ' + 'x'.repeat(500)))
  const result = await e.step(a); e.commit(a, result)
  const found = await e.search(a, { query: '文献', limit: 3 })
  assert.equal(found.ok, true)
  assert.ok(found.matches.length > 0 && found.matches.length <= 3)
  assert.ok(found.matches.every(row => row.description.length <= 160 && !('content' in row) && !('resourceBase' in row)))
  assert.equal(e.gets.length, 0)
})

test('Chinese Nature topics discover the precise native workflow without loading bodies', async () => {
  const e = environment(), a = e.agent()
  a.additions = [
    extra('nature-academic-search', 'Search literature and verify citations across sources'),
    extra('nature-citation', 'Find Nature/CNS literature supporting manuscript claims'),
    extra('nature-data', 'Draft Data/Code Availability statements'),
    extra('nature-figure', 'Create scientific figures'),
    extra('nature-paper2ppt', 'Create an academic PPTX from a scientific paper'),
    extra('nature-polishing', 'Polish and translate academic prose'),
    extra('nature-reader', 'Create aligned bilingual paper readers'),
    extra('nature-response', 'Draft responses to peer review'),
    extra('nature-writing', 'Draft scientific manuscript arguments and sections'),
  ]
  e.commit(a, await e.step(a))
  for (const [query, name] of [
    ['文献检索', 'nature-academic-search'], ['引文核验', 'nature-academic-search'],
    ['CNS引用', 'nature-citation'], ['Nature引用', 'nature-citation'],
    ['数据可用性', 'nature-data'], ['代码可用性', 'nature-data'],
    ['科研绘图', 'nature-figure'], ['科学图表', 'nature-figure'],
    ['文献汇报', 'nature-paper2ppt'], ['论文汇报', 'nature-paper2ppt'],
    ['润色', 'nature-polishing'], ['学术翻译', 'nature-polishing'],
    ['论文精读', 'nature-reader'], ['双语精读', 'nature-reader'],
    ['审稿回复', 'nature-response'], ['回复审稿', 'nature-response'],
    ['论文起草', 'nature-writing'], ['论文撰写', 'nature-writing'],
  ]) {
    const found = await e.search(a, { query, limit: 1 })
    assert.equal(found.ok, true, query)
    assert.equal(found.matches[0]?.name, name, query)
  }
  assert.equal(e.gets.length, 0)
  assert.equal(e.tools.get('skill', a), e.originalSkill)
})

test('Nature aliases cannot invent unavailable, user-only or other-scope skills', async () => {
  const e = environment(), a = e.agent('nature-project'), b = e.agent('other-project')
  a.additions = [extra('nature-figure', 'Create scientific figures'),
    extra('nature-polishing', 'Polish academic prose', { modelInvocable: false, userInvocable: true })]
  e.commit(a, await e.step(a)); e.commit(b, await e.step(b))
  assert.equal((await e.search(a, { query: '科研绘图', limit: 1 })).matches[0]?.name, 'nature-figure')
  assert.ok(!(await e.search(b, { query: '科研绘图' })).matches.some(row => row.name.startsWith('nature-')))
  assert.ok(!(await e.search(a, { query: '润色' })).matches.some(row => row.name === 'nature-polishing'))
  a.hidden = new Set(['skill']); e.commit(a, await e.step(a))
  assert.ok(!(await e.search(a, { query: '科研绘图' })).matches.some(row => row.name === 'nature-figure'))
  assert.equal(e.gets.length, 0)
})

test('exact known skill names still load the complete native body and resource base', async () => {
  const e = environment(), a = e.agent(), name = 'humanizer-zh'
  const original = e.definitions.get(name)
  const value = await e.tools.get('skill', a).execute({ name }, { agent: a, signal: new AbortController().signal })
  assert.deepEqual(value, { name, provider: original.provider, resourceBase: original.resourceBase, content: original.content })
  assert.equal(e.gets.at(-1).scope, a)
  assert.equal(e.gets.at(-1).cwd, a.session.header.cwd)
})

test('explicit user slash invocation retains the full native instructions without an extra loader call', async () => {
  const e = environment(), a = e.agent(), result = await e.step(a, [human('/humanizer-zh')])
  const injected = result.messages.find(message => message.source?.kind === 'skill-invocation')
  assert.ok(injected && text(injected).includes('FULL_BODY_humanizer-zh'))
  assert.equal(injected, e.nativeDecisions.at(-1).messages.find(message => message.source?.kind === 'skill-invocation'))
  assert.equal(e.gets.filter(call => call.name === 'humanizer-zh').length, 1)
  assert.ok(Buffer.byteLength(text(catalogs(result)[0])) < 1000)
})

test('native digest deduplication survives continuation and plugin reload', async () => {
  const e = environment(), a = e.agent(), first = await e.step(a); e.commit(a, first)
  assert.equal(catalogs(await e.step(a)).length, 0)
  e.reload()
  assert.equal(catalogs(await e.step(a)).length, 0)
  assert.ok((await e.search(a, { query: 'humanizer-zh' })).matches.some(row => row.name === 'humanizer-zh'))
})

test('a provider catalog update and a compacted surface each publish one compact replacement', async () => {
  const e = environment(), a = e.agent(); e.commit(a, await e.step(a))
  a.additions = [extra('new-literature')]
  const changed = await e.step(a)
  assert.equal(catalogs(changed).length, 1)
  assert.equal(catalogs(changed)[0].source.entries.length, 65)
  assert.ok(Buffer.byteLength(text(catalogs(changed)[0])) < 1000)
  e.commit(a, changed)
  assert.equal(catalogs(await e.step(a)).length, 0)
  a.session.surface.nodes.length = 0
  const compacted = await e.step(a)
  assert.equal(catalogs(compacted).length, 1)
  assert.ok(Buffer.byteLength(text(catalogs(compacted)[0])) < 1000)
  e.commit(a, compacted)
  assert.equal(catalogs(await e.step(a)).length, 0)
})

test('native skill restrictions and same-name shadows cannot be bypassed through discovery', async () => {
  for (const mode of ['hidden', 'shadow']) {
    const e = environment(), a = e.agent(); e.commit(a, await e.step(a))
    if (mode === 'hidden') a.hidden = new Set(['skill'])
    else a.shadow = { name: 'skill', execute() { throw new Error('another loader') } }
    e.commit(a, await e.step(a))
    const found = await e.search(a, { query: 'humanizer-zh' })
    assert.ok(!found.matches?.some(row => row.name === 'humanizer-zh'))
  }
})

test('discovery requires the same live loader observed at the native step boundary', async () => {
  const e = environment(), a = e.agent(); e.commit(a, await e.step(a))
  a.shadow = { name: 'skill', execute() {} }
  const found = await e.search(a, { query: 'humanizer-zh' })
  assert.ok(!found.matches?.some(row => row.name === 'humanizer-zh'))
})

test('a loader changed during asynchronous metadata lookup cannot leak stale search results', async () => {
  const e = environment(), a = e.agent(); e.commit(a, await e.step(a))
  const snapshot = e.skills.snapshot.bind(e.skills)
  e.skills.snapshot = async lookup => { const value = await snapshot(lookup); a.shadow = { name: 'skill' }; return value }
  const found = await e.search(a, { query: 'humanizer-zh' })
  assert.ok(!found.matches?.some(row => row.name === 'humanizer-zh'))
})

test('a loader changed while the native catalog is being generated cannot inherit its authority', async () => {
  const e = environment(), a = e.agent()
  const snapshot = e.skills.snapshot.bind(e.skills)
  let changed = false
  e.skills.snapshot = async lookup => { const value = await snapshot(lookup); if (!changed) { changed = true; a.shadow = { name: 'skill' } } return value }
  e.commit(a, await e.step(a))
  const found = await e.search(a, { query: 'humanizer-zh' })
  assert.ok(!found.matches?.some(row => row.name === 'humanizer-zh'))
})

test('a hidden or shadowed discovery entry preserves the native catalog and full skill loader', async () => {
  for (const mode of ['hidden', 'shadow']) {
    const e = environment(), a = e.agent()
    if (mode === 'hidden') a.hidden = new Set(['butler_skills'])
    else a.overrides = new Map([['butler_skills', { name: 'butler_skills' }]])
    const result = await e.step(a)
    assert.equal(Buffer.byteLength(text(catalogs(result)[0])), 16089)
    assert.equal(e.tools.get('skill', a), e.originalSkill)
  }
})

test('hiding discovery after a compact catalog restores full summaries once, including after reload', async () => {
  const e = environment(), a = e.agent(); e.commit(a, await e.step(a))
  a.hidden = new Set(['butler_skills'])
  e.reload()
  const fallback = await e.step(a)
  assert.equal(catalogs(fallback).length, 1)
  assert.equal(catalogs(fallback)[0].source.entries.length, 64)
  assert.ok(text(catalogs(fallback)[0]).includes('humanizer-zh'))
  assert.ok(Buffer.byteLength(text(catalogs(fallback)[0])) > 14000)
  e.commit(a, fallback)
  assert.equal(catalogs(await e.step(a)).length, 0)
  e.reload()
  assert.equal(catalogs(await e.step(a)).length, 0)
})

test('cwd scope and native invocation policy govern both discovery and loading', async () => {
  const e = environment(), a = e.agent('project'), b = e.agent('other')
  a.additions = [extra('project-literature', 'Project only 文献'), extra('user-only', 'User only', { modelInvocable: false, userInvocable: true })]
  e.commit(a, await e.step(a)); e.commit(b, await e.step(b))
  assert.ok((await e.search(a, { query: 'project-literature' })).matches.some(row => row.name === 'project-literature'))
  assert.ok(!(await e.search(b, { query: 'project-literature' })).matches.some(row => row.name === 'project-literature'))
  assert.ok(!(await e.search(a, { query: 'user-only' })).matches.some(row => row.name === 'user-only'))
  await assert.rejects(e.originalSkill.execute({ name: 'user-only' }, { agent: a, signal: new AbortController().signal }), /not available/)
  assert.ok((await e.step(a, [human('/user-only')])).messages.some(message => message.source?.name === 'user-only' && text(message).includes('FULL_user-only')))
})

test('reminders and their children keep the existing skill execution boundary', async () => {
  const e = environment(), root = e.agent('session-butler-reminder-abc'), child = e.agent('reminder-child', root)
  for (const a of [root, child]) {
    const result = await e.step(a); e.commit(a, result)
    assert.ok(Buffer.byteLength(text(catalogs(result)[0])) < 1000)
    assert.ok(!text(catalogs(result)[0]).includes('butler_skills'))
    const found = await e.search(a, { query: 'humanizer-zh' })
    assert.ok(!found.matches?.length)
  }
})

test('rejected steps remain rejected and invalid search arguments never expand the catalog', async () => {
  const e = environment(), a = e.agent()
  assert.equal((await e.step(a, [], true)).kind, 'reject')
  assert.equal((await e.search(a, { query: '', limit: 1 })).ok, false)
  assert.equal((await e.search(a, { query: 'literature', limit: 9 })).ok, false)
})

test('incomplete native discovery does not invent a complete replacement or load bodies', async () => {
  const e = environment(), a = e.agent(); a.complete = false
  assert.equal(catalogs(await e.step(a)).length, 0)
  const found = await e.search(a, { query: 'humanizer-zh' })
  assert.ok(!found.matches?.length)
  assert.equal(e.gets.length, 0)
})

test('if the discovery registration fails, native capabilities and their original catalog remain available', async () => {
  const e = environment({ failRegistration: true }), a = e.agent()
  const result = await e.step(a)
  assert.equal(Buffer.byteLength(text(catalogs(result)[0])), 16089)
  assert.equal(e.tools.get('skill', a), e.originalSkill)
  assert.equal(e.loading.status().registered, false)
})

test('registration failure after a hot reload restores a previously compact catalog', async () => {
  const options = { failRegistration: false }, e = environment(options), a = e.agent()
  e.commit(a, await e.step(a))
  options.failRegistration = true
  e.reload()
  const result = await e.step(a)
  assert.equal(e.loading.status().registered, false)
  assert.ok(catalogs(result).length === 1 && text(catalogs(result)[0]).includes('humanizer-zh'))
})
