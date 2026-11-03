import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
process.env.DSH_BUTLER_HOME = mkdtempSync(join(base, 'literature-tool-pages-'))
process.env.DSH_BUTLER_VAULT = join(process.env.DSH_BUTLER_HOME, 'vault')
const { registerButlerTools } = await import('../src/host/tools.ts')
const tools = new Map(); let owner = 'session-a', requests = 0
const deps = { timeZone: 'Asia/Shanghai', mailto: 'fixture@localhost', sessionId: () => owner, currentTaskId: () => undefined,
  web: { async fetch({ url }) { requests++
    if (url.includes('api.crossref.org')) return { text: JSON.stringify({ message: { items: Array.from({ length: 12 }, (_, i) => ({
      title: [`Actual provider title ${i}`], DOI: `10.1234/paper${i}`, URL: `https://doi.org/10.1234/paper${i}`,
      abstract: '<p>' + 'Full abstract 文献内容 '.repeat(600) + '</p>', author: [{ family: 'Chen', given: 'Lin' }],
    })) } }) }
    if (url.includes('export.arxiv.org')) return { status: 503, text: 'unavailable' }
    return { text: '{"esearchresult":{"idlist":[]}}' }
  } } }
registerButlerTools({ tools: { register(tool) { tools.set(tool.name, tool); return () => {} } } }, deps)

test('registered literature tool exposes bounded previews and scope-checked offline details', async () => {
  const tool = tools.get('butler_literature'), args = { action: 'search', query: 'models', rows: 12 }
  const raw = await tool.execute(args), before = structuredClone(raw)
  assert.equal(raw.ok, true); assert.equal(raw.records.length, 12)
  assert.ok(raw.resultSet?.id)
  const preview = JSON.parse(tool.output.render(args, raw)[0].text)
  assert.equal(preview.total, 12); assert.ok(preview.records.length <= 8)
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 12000)
  assert.deepEqual(raw, before)
  const count = requests; deps.web = undefined
  const page = await tool.execute({ action: 'page', resultSetId: raw.resultSet.id, offset: 8, limit: 4 })
  assert.equal(page.ok, true); assert.equal(page.total, 12); assert.equal(page.records[0].index, 8)
  assert.equal(JSON.parse(tool.output.render({}, page)[0].text).offset, 8)
  const details = await tool.execute({ action: 'read', resultSetId: raw.resultSet.id, index: 0, field: 'abstract', limit: 1000 })
  assert.equal(details.ok, true); assert.ok(details.nextOffset); assert.ok(details.text.includes('Full abstract'))
  assert.equal(requests, count, 'Paging existing records must not repeat provider queries')
  owner = 'session-b'
  assert.equal((await tool.execute({ action: 'page', resultSetId: raw.resultSet.id })).ok, false)
})
