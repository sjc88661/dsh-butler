import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyRecords } from '../src/host/literature.ts'

const title = 'Attention Is All You Need'
const record = (extra = {}) => ({ title, authors: ['Ashish Vaswani'], source: 'arxiv', arxivId: '1706.03762', ...extra })
const page = ({ id = '1706.03762', title: name = title, doi = '10.48550/arXiv.1706.03762', statusCode = 200 } = {}) => ({
  statusCode, url: 'https://arxiv.org/abs/1706.03762', body: { kind: 'html', content: `<html><head>
    <meta name="citation_title" content="${name}"><meta name="citation_arxiv_id" content="${id}">
    <meta name="citation_doi" content="${doi}"></head><body>Abstract</body></html>` },
})

test('arXiv-issued DOI is verified on the official record without treating Crossref absence as nonexistence', async () => {
  const requests = []
  const web = { async fetch({ url }) { requests.push(url); assert.equal(url, 'https://arxiv.org/abs/1706.03762'); return page() } }
  const input = record({ doi: '10.48550/arXiv.1706.03762', url: 'https://arxiv.org/abs/1706.03762' })
  const original = structuredClone(input), [result] = await verifyRecords(web, [input])
  assert.equal(result.verified, 'verified'); assert.match(result.verificationNote, /arXiv/)
  assert.match(result.verificationNote, /DOI/); assert.equal(requests.length, 1)
  assert.deepEqual(input, original)
})

test('HTML arXiv page with exact identity and decoded citation title verifies without a JSON parser', async () => {
  const [result] = await verifyRecords({ async fetch() { return page({ title: 'Attention Is All You Need' }) } }, [record()])
  assert.equal(result.verified, 'verified')
})

test('title or article identity disagreement remains conflict', async () => {
  for (const response of [page({ title: 'A Completely Different Article' }), page({ id: '2105.02723' })]) {
    const [result] = await verifyRecords({ async fetch() { return response } }, [record()])
    assert.equal(result.verified, 'conflict')
  }
})

test('contradictory arXiv DOI and explicit arXiv identifier cannot be rescued by one passing title', async () => {
  let requests = 0
  const [result] = await verifyRecords({ async fetch() { requests++; return page() } }, [record({ doi: '10.48550/arxiv.2105.02723' })])
  assert.equal(result.verified, 'conflict'); assert.equal(requests, 0)
})

test('DOI and PMID conflicts in source URLs or merged provenance are preserved before lookup', async () => {
  let requests = 0
  const web = { async fetch() { requests++; throw new Error('conflicts must not be hidden by a lookup') } }
  for (const input of [
    record({ doi: '10.1234/a', url: 'https://doi.org/10.1234/b' }),
    record({ pmid: '12345', url: 'https://pubmed.ncbi.nlm.nih.gov/67890/' }),
    record({ sources: [{ source: 'arxiv', arxivId: '2105.02723' }] }),
    record({ doi: '10.1234/a', sources: [{ source: 'crossref', doi: '10.1234/b' }] }),
  ]) assert.equal((await verifyRecords(web, [input]))[0].verified, 'conflict')
  assert.equal(requests, 0)
})

test('HTTP failure, arbitrary arxiv text and redirects outside the official source never verify', async () => {
  for (const response of [page({ statusCode: 503 }), { statusCode: 200, text: 'arxiv is mentioned here' },
    { ...page(), url: 'https://example.test/fake' }]) {
    const [result] = await verifyRecords({ async fetch() { return response } }, [record()])
    assert.equal(result.verified, 'unconfirmed')
  }
})

test('DOI returned by Crossref must match the requested DOI before a matching title can verify', async () => {
  const [result] = await verifyRecords({ async fetch() { return { statusCode: 200, text: JSON.stringify({ message: { DOI: '10.1234/other', title: [title] } }) } } },
    [record({ arxivId: undefined, source: 'crossref', doi: '10.1234/requested' })])
  assert.equal(result.verified, 'conflict')
})

test('a Crossref conflict is retained even when an arXiv identifier separately resolves', async () => {
  const [result] = await verifyRecords({ async fetch({ url }) {
    if (url.includes('crossref')) return { statusCode: 200, text: JSON.stringify({ message: { DOI: '10.1234/test', title: ['A Completely Different Article'] } }) }
    return page({ doi: '10.1234/test' })
  } }, [record({ doi: '10.1234/test' })])
  assert.equal(result.verified, 'conflict')
})

test('arXiv-issued DOI needs the exact DOI link as well as matching title and article identity', async () => {
  const [result] = await verifyRecords({ async fetch() { return page({ doi: '10.1234/other' }) } },
    [record({ doi: '10.48550/arxiv.1706.03762' })])
  assert.equal(result.verified, 'unconfirmed')
})

test('PubMed verifies structured PMID and title and rejects page-name substring proof', async () => {
  const input = { title, authors: [], source: 'pubmed', pmid: '12345' }
  const [verified] = await verifyRecords({ async fetch({ url }) {
    assert.match(url, /esummary\.fcgi\?.*id=12345/)
    return { statusCode: 200, text: JSON.stringify({ result: { '12345': { uid: '12345', title } } }) }
  } }, [input])
  assert.equal(verified.verified, 'verified')
  const [missing] = await verifyRecords({ async fetch() { return { statusCode: 200, text: 'pubmed record found' } } }, [input])
  assert.equal(missing.verified, 'unconfirmed')
})
