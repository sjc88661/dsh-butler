import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = mkdtempSync(join(process.cwd(), 'tests/.tmp/lit-results-'))
process.env.DSH_BUTLER_HOME = home
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { LiteratureResults, renderLiteratureResult } = await import('../src/host/literature-results.ts')
const scope = { sessionId: 's', ownerId: 'o', taskId: 't' }
const value = { ok: true, query: '题目', records: Array.from({length: 62}, (_, i) => ({ title: `Title ${i}`, authors: ['张三'], abstract: '文😀'.repeat(3000), verified: i === 1 ? 'conflict' : 'verified' })), providers: [{name:'p',ok:false,note:'failed'}], limitations:['failed'], conflictCount:1 }
test('durable scoped paging, integrity, and bounded preview', () => {
  const original = structuredClone(value), store = new LiteratureResults({root: home}), ref = store.save(value, scope)
  const reload = new LiteratureResults({root: home}); let offset = 0, titles = []
  while (offset !== null) { const page = reload.page(ref.id, scope, {offset}); titles.push(...page.records.map(x => x.title)); offset = page.nextOffset }
  assert.deepEqual(titles, value.records.map(x => x.title))
  let text = '', next = 0; while (next !== null) { const part = reload.read(ref.id, scope, {index:1,field:'abstract',offset:next}); text += part.text; next = part.nextOffset }
  assert.equal(text, value.records[1].abstract)
  assert.throws(() => reload.page(ref.id, {...scope,taskId:'other'})); assert.throws(() => reload.page('../x',scope)); assert.throws(() => reload.page(ref.id,scope,{offset:0.5}))
  const rendered = renderLiteratureResult({...value,resultSet:ref}); assert.ok(Buffer.byteLength(rendered) <= 12000); assert.equal(renderLiteratureResult({...value,resultSet:ref}),rendered); assert.deepEqual(value,original)
  const preview = JSON.parse(rendered); assert.equal(preview.conflictCount,1); assert.equal(preview.providers[0].ok,false)
  const second = reload.page(ref.id, scope, {offset:8}); assert.equal(second.total,62); assert.equal(second.records[0].index,8)
  assert.equal(renderLiteratureResult(second),JSON.stringify(second))
  assert.throws(() => reload.page(ref.id,{...scope,ownerId:''}))
  assert.throws(() => store.save({...value,records:Array(101).fill(value.records[0])},scope))
  const path = join(home, 'literature-results', `${ref.id}.json`); const saved = JSON.parse(readFileSync(path)); saved.value.query = 'tampered'; writeFileSync(path, JSON.stringify(saved)); assert.throws(() => reload.page(ref.id,scope))
})

test('large multibyte fields stay bounded without skipping records', () => {
  const store = new LiteratureResults({root:home})
  const records = Array.from({length:17}, (_,i) => ({title:'题😀'.repeat(5000), authors:['名'.repeat(5000)], sources:Array(12).fill({name:'源'.repeat(1000)}), abstract:'摘😀'.repeat(8000), ...(i === 9 ? {verified:'conflict'} : {})}))
  const ref = store.save({ok:true,records,providers:[{name:'failed',ok:false,note:'错'.repeat(1000)}]},scope)
  let offset = 0; const indexes = []
  while (offset !== null) { const p = store.page(ref.id,scope,{offset}); assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 12000); assert.equal(renderLiteratureResult(p),JSON.stringify(p)); assert.equal(p.conflictCount,1); assert.equal(p.providers[0].ok,false); indexes.push(...p.records.map(x => x.index)); offset = p.nextOffset }
  assert.deepEqual(indexes,records.map((_,i) => i))
  const chunks = []; let next = 0
  while (next !== null) { const part = store.read(ref.id,scope,{index:0,field:'abstract',offset:next}); chunks.push(part.text); next = part.nextOffset }
  assert.equal(chunks.join(''),records[0].abstract)
})

