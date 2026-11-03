import test from 'node:test'
import assert from 'node:assert/strict'
import { dedupe, normalizeDoi } from '../src/host/guard.ts'
import { searchLiterature } from '../src/host/literature.ts'

const paper = (title, extra = {}) => ({ title, authors: ['Chen, Lin'], year: 2026, source: 'crossref', ...extra })

test('different strong identifiers survive even with the same author, year, and title', () => {
  const records = [paper('An exact title', { doi: '10.1234/one' }), paper('An exact title', { doi: '10.1234/two' })]
  assert.deepEqual(dedupe(records).map(row => row.doi), ['10.1234/one', '10.1234/two'])
})

test('the same normalized DOI merges every provider locator without changing the original input', () => {
  const records = [paper('A paper', { doi: 'https://doi.org/10.1234/SAME', url: 'https://doi.org/10.1234/same' }),
    paper('A paper.', { source: 'pubmed', doi: '10.1234/same', pmid: '12345', url: 'https://pubmed.ncbi.nlm.nih.gov/12345/' })]
  const before = structuredClone(records), rows = dedupe(records)
  assert.equal(rows.length, 1)
  assert.ok(Array.isArray(rows[0].sources), 'merged records must expose provider provenance')
  assert.deepEqual(rows[0].sources.map(source => [source.source, source.url]), records.map(source => [source.source, source.url]))
  assert.equal(rows[0].pmid, '12345')
  assert.deepEqual(records, before)
})

test('title normalization can merge unidentified copies but author and year alone never delete a different title', () => {
  const rows = dedupe([paper('Ａ study: of Cells'), paper('A study of cells!'), paper('A separate study')])
  assert.equal(rows.length, 2)
  assert.equal(rows[1].title, 'A separate study')
  assert.equal(dedupe([paper('A study', { year: 2025 }), paper('A study', { year: 2026 })]).length, 2)
  assert.equal(dedupe([paper('A study'), paper('A study', { authors: ['Another researcher'] })]).length, 2)
})

test('conflicting arXiv or PMID identifiers are preserved rather than erased by title or a shared DOI', () => {
  assert.equal(dedupe([paper('Same', { source: 'arxiv', url: 'https://arxiv.org/abs/2601.00001v1' }),
    paper('Same', { source: 'arxiv', url: 'https://arxiv.org/abs/2601.00002v1' })]).length, 2)
  assert.equal(dedupe([paper('Same', { doi: '10.1234/shared', arxivId: '2601.00001' }),
    paper('Same', { doi: '10.1234/shared', arxivId: '2601.00002' })]).length, 2)
  assert.equal(dedupe([paper('Same', { pmid: '12345' }), paper('Same', { pmid: '67890' })]).length, 2)
  assert.equal(dedupe([paper('Same', { doi: '10.1234/one' }), paper('Same', { arxivId: '2601.00001' })]).length, 2)
})

test('arXiv revisions merge by article identity and records without usable keys are retained', () => {
  const rows = dedupe([paper('Preprint', { source: 'arxiv', url: 'https://arxiv.org/abs/2601.00001v1' }),
    paper('Preprint revised', { source: 'arxiv', url: 'https://arxiv.org/abs/2601.00001v2' })])
  assert.equal(rows.length, 1)
  assert.ok(Array.isArray(rows[0].sources), 'all arXiv revision locators must survive the merge')
  assert.equal(rows[0].sources.length, 2)
  assert.equal(dedupe([{ authors: ['Chen'], year: 2026 }, { authors: ['Chen'], year: 2026 }]).length, 2)
})

test('three-provider search keeps DOI provenance and explicit arXiv and PMID identifiers', async () => {
  const web = { async fetch({ url }) {
    if (url.startsWith('https://api.crossref.org/')) return { text: JSON.stringify({ message: { items: [
      { title: ['Shared paper'], DOI: '10.1234/shared', URL: 'https://doi.org/10.1234/shared', author: [{ family: 'Chen', given: 'Lin' }], issued: { 'date-parts': [[2026]] } },
      { title: ['Another paper'], DOI: '10.1234/another', URL: 'https://doi.org/10.1234/another', author: [{ family: 'Chen', given: 'Lin' }], issued: { 'date-parts': [[2026]] } },
    ] } }) }
    if (url.includes('export.arxiv.org')) return { text: '<feed><entry><title>Preprint paper</title><name>Chen, Lin</name><id>https://arxiv.org/abs/2601.00001v2</id><published>2026-01-02</published></entry></feed>' }
    if (url.includes('esearch.fcgi')) return { text: JSON.stringify({ esearchresult: { idlist: ['12345'] } }) }
    if (url.includes('esummary.fcgi')) return { text: JSON.stringify({ result: { '12345': { title: 'Shared paper', authors: [{ name: 'Chen, Lin' }], pubdate: '2026', articleids: [{ idtype: 'doi', value: '10.1234/shared' }] } } }) }
    throw new Error(`Unexpected request: ${url}`)
  } }
  const found = await searchLiterature(web, 'test')
  assert.equal(found.records.length, 3)
  assert.equal(found.duplicatesRemoved, 1)
  const shared = found.records.find(row => row.doi === '10.1234/shared')
  assert.equal(shared.source, 'crossref')
  assert.equal(shared.pmid, '12345')
  assert.deepEqual(shared.sources.map(row => row.source), ['crossref', 'pubmed'])
  assert.equal(found.records.find(row => row.source === 'arxiv').arxivId, '2601.00001')
})

const siciLeft = '10.1002/(SICI)1099-0844(199912)17:4<290::AID-CBF849>3.0.CO;2-P'
const siciRight = '10.1002/(SICI)1099-0844(199912)17:4<291::AID-CBF850>3.0.CO;2-P'

test('SICI DOI punctuation remains part of the strong identifier and distinct articles survive dedupe', () => {
  assert.equal(normalizeDoi(siciLeft), siciLeft.toLowerCase())
  assert.equal(normalizeDoi(siciRight), siciRight.toLowerCase())
  const records = dedupe([paper('Same bibliographic hints', { doi: siciLeft }), paper('Same bibliographic hints', { doi: siciRight })])
  assert.equal(records.length, 2)
})

test('DOI normalization removes explicit wrappers and decodes resolver URL paths exactly once', () => {
  assert.equal(normalizeDoi(` <${siciLeft}> `), siciLeft.toLowerCase())
  assert.equal(normalizeDoi(`(doi:${siciLeft})`), siciLeft.toLowerCase())
  assert.equal(normalizeDoi(`"https://dx.doi.org/${encodeURIComponent(siciLeft)}?utm_source=test#page"`), siciLeft.toLowerCase())
  assert.equal(normalizeDoi('https://doi.org/10.1234/percent%252Fname'), '10.1234/percent%2fname')
  assert.equal(normalizeDoi('10.1234/percent%2Fname'), '10.1234/percent%2fname')
  assert.equal(normalizeDoi('https://doi.org/10.1234/bad%ZZ'), undefined)
  const records = dedupe([paper('SICI', { doi: siciLeft }), paper('SICI', { doi: `https://doi.org/${encodeURIComponent(siciLeft)}`, source: 'pubmed' })])
  assert.equal(records.length, 1)
  assert.equal(records[0].sources.length, 2)
})

test('unwrapped DOI suffix punctuation is preserved instead of guessed to be sentence punctuation', () => {
  for (const suffix of ['end.', 'end,', 'end;', 'term)', 'a(b)', "quoted'part", 'angle<AID>']) {
    assert.equal(normalizeDoi(`10.1234/${suffix}`), `10.1234/${suffix.toLowerCase()}`)
  }
  assert.equal(normalizeDoi('(10.1234/a(b))'), '10.1234/a(b)')
  assert.equal(normalizeDoi('doi: "10.1234/angle<AID>"'), '10.1234/angle<aid>')
})

test('search interleaves providers while preserving each ranking and every record', async () => {
  const ids = ['101','102','103','104']
  const web = { async fetch({url}) {
    if (url.startsWith('https://api.crossref.org/')) return {text:JSON.stringify({message:{items:ids.map((id,i) => ({title:[`Crossref ${i}`],DOI:`10.1234/c${id}`}))}})}
    if (url.includes('export.arxiv.org')) return {text:`<feed>${ids.map((id,i) => `<entry><title>Arxiv ${i}</title><id>https://arxiv.org/abs/2601.00${id}</id><published>2026-01-01</published></entry>`).join('')}</feed>`}
    if (url.includes('esearch.fcgi')) return {text:JSON.stringify({esearchresult:{idlist:ids}})}
    if (url.includes('esummary.fcgi')) return {text:JSON.stringify({result:Object.fromEntries(ids.map((id,i) => [id,{title:`Pubmed ${i}`,authors:[],pubdate:'2026'}]))})}
    throw new Error(url)
  } }
  const result = await searchLiterature(web,'test',{rows:4})
  assert.equal(result.records.length,12); assert.equal(result.duplicatesRemoved,0)
  assert.deepEqual(result.records.slice(0,8).map(x => x.source),['crossref','pubmed','arxiv','crossref','pubmed','arxiv','crossref','pubmed'])
  for (const [source,prefix] of [['crossref','Crossref'],['pubmed','Pubmed'],['arxiv','Arxiv']]) assert.deepEqual(result.records.filter(x => x.source === source).map(x => x.title),[0,1,2,3].map(i => `${prefix} ${i}`))
  assert.deepEqual(new Set(result.records.map(x => x.title)),new Set(['Crossref','Pubmed','Arxiv'].flatMap(p => [0,1,2,3].map(i => `${p} ${i}`))))
})
