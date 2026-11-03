import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'literature-export-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { registerButlerTools } = await import('../src/host/tools.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { EvidenceStore } = await import('../src/host/evidence-store.ts')
const { getTask } = await import('../src/host/ledger.ts')
const { getPack } = await import('../src/host/packs.ts')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function environment(options = {}) {
  const contexts = new ExecutionContexts({ file: join(home, 'state', `contexts-${randomUUID()}.json`), runFor: id => `run:${id}` })
  const evidence = new EvidenceStore({ file: join(home, 'state', `evidence-${randomUUID()}.json`), identity: () => contexts.current() })
  const registered = new Map(), agent = { id: `export-${randomUUID()}` }
  contexts.bindUser(agent, { id: 'owner', source: { kind: 'user' }, content: [{ type: 'text', text: '把给定题录导出成本地引用文件' }] })
  registerButlerTools({ tools: { register(tool) { registered.set(tool.name, tool); return () => {} } } }, {
    timeZone: 'Asia/Shanghai', mailto: 'fixture@localhost', executionContext: contexts, evidence,
    sessionId: () => agent.id, currentTaskId: () => contexts.current()?.taskId, ...options,
  })
  const execution = (name, args, callId = randomUUID()) => ({ agent, name, callId, arguments: args })
  const call = (name, args, callId) => registered.get(name).execute(args, execution(name, args, callId))
  const exportFile = async (args = {}, callId) => {
    try { return await call('butler_literature', { action: 'export', format: 'ris', slug: `refs-${randomUUID()}`, records: [{ title: 'A supplied title' }], ...args }, callId) }
    catch (error) { if (error.name !== 'ToolArgsError') throw error; return { ok: false, code: 'tool.args', message: error.message } }
  }
  return { contexts, evidence, registered, agent, execution, call, exportFile }
}

// A consumer grammar checks boundaries and fields independently of the exporter.
function readRis(text) {
  const records = []; let current
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([A-Z0-9]{2})  -(?: (.*))?$/.exec(line)
    assert.ok(match, `invalid RIS line: ${line}`)
    const [, tag, value = ''] = match
    if (tag === 'TY') { assert.equal(current, undefined); current = new Map() }
    assert.ok(current, 'field outside a RIS record')
    if (tag === 'ER') { records.push(current); current = undefined }
    else current.set(tag, [...(current.get(tag) ?? []), value])
  }
  assert.equal(current, undefined, 'unterminated RIS record')
  return records
}

// BibTeX counts all structural braces in a braced value, including braces after a backslash.
function readBibtex(text) {
  let index = 0; const entries = []
  const whitespace = () => { while (/\s/.test(text[index] ?? '') && index < text.length) index++ }
  const literal = expected => { assert.equal(text.slice(index, index + expected.length), expected); index += expected.length }
  const word = () => { const value = /^[A-Za-z0-9_:-]+/.exec(text.slice(index))?.[0]; assert.ok(value); index += value.length; return value }
  const value = () => {
    literal('{'); let depth = 1, result = ''
    while (index < text.length) {
      const char = text[index++]
      if (char === '{') depth++
      if (char === '}') { depth--; if (depth === 0) return result }
      result += char
    }
    assert.fail('unterminated BibTeX field')
  }
  while (index < text.length) {
    whitespace(); if (index === text.length) break
    literal('@'); const type = word(); literal('{'); const key = word(); literal(',')
    const fields = new Map()
    for (;;) {
      whitespace(); if (text[index] === '}') { index++; break }
      const field = word(); whitespace(); literal('='); whitespace()
      assert.ok(!fields.has(field)); fields.set(field, value()); whitespace(); literal(',')
    }
    entries.push({ type, key, fields })
  }
  return entries
}

function texPlain(value) {
  return value.replace(/\\(textbackslash|textasciitilde|textasciicircum|textbraceleft|textbraceright)\{\}|\\([{}%$#_&])/g,
    (_all, named, symbol) => symbol ?? ({ textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textbraceleft: '{', textbraceright: '}' })[named])
}

function literalAuthors(value) {
  const names = []; let index = 0
  while (index < value.length) {
    assert.equal(value[index++], '{'); let depth = 1, name = ''
    while (index < value.length && depth) {
      const char = value[index++]
      if (char === '{') depth++
      if (char === '}') depth--
      if (depth) name += char
    }
    assert.equal(depth, 0); names.push(texPlain(name))
    if (index < value.length) { assert.equal(value.slice(index, index + 5), ' and '); index += 5 }
  }
  return names
}

test('RIS exports offline UTF-8 bibliographic fields, duplicate records and input provenance without mutation', async () => {
  const e = environment(), records = [{ title: '中文细胞研究', authors: ['Chen, Lin', '中华研究组'], year: 2021, venue: '给定期刊',
    doi: '10.1234/Given', arxivId: '2105.02723', pmid: '1234', url: 'https://example.test/paper', abstract: '给定摘要。', source: 'arxiv',
    sources: [{ source: 'crossref', doi: '10.1234/Given', url: 'https://example.test/source' }], verified: 'verified', verificationNote: '之前核对题录。' }]
  records.push(structuredClone(records[0])); const before = structuredClone(records)
  const result = await e.exportFile({ records })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.format, 'ris'); assert.equal(result.recordCount, 2)
  const bytes = readFileSync(result.path), parsed = readRis(bytes.toString('utf8'))
  assert.equal(result.sha256, digest(bytes)); assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0].get('TY'), ['GEN']); assert.deepEqual(parsed[0].get('TI'), ['中文细胞研究'])
  assert.deepEqual(parsed[0].get('AU'), records[0].authors); assert.deepEqual(parsed[0].get('PY'), ['2021'])
  assert.deepEqual(parsed[0].get('T2'), ['给定期刊']); assert.deepEqual(parsed[0].get('DO'), ['10.1234/Given'])
  assert.deepEqual(parsed[0].get('UR'), ['https://example.test/paper']); assert.deepEqual(parsed[0].get('AB'), ['给定摘要。'])
  assert.match(bytes.toString('utf8'), /arXiv.*2105\.02723/i); assert.match(bytes.toString('utf8'), /PMID.*1234/)
  assert.match(bytes.toString('utf8'), /crossref/); assert.match(bytes.toString('utf8'), /https:\/\/example\.test\/source/)
  assert.match(bytes.toString('utf8'), /输入.*verified/); assert.match(bytes.toString('utf8'), /本轮未重新验证.*未读全文/)
  assert.deepEqual(records, before); assert.equal(Object.hasOwn(result, 'records'), false)
  assert.match(result.path, /[\\/]vault[\\/]references[\\/][A-Za-z0-9_-]+\.ris$/)
})

test('BibTeX safely round-trips supplied special characters and literal author names with unique generated keys', async () => {
  const title = '中文 \\ {brace} % $ # _ & ~ ^ @misc{evil,', authors = ['Research and Development', 'Doe, Jane', '组{甲} \\%']
  const e = environment(), result = await e.exportFile({ format: 'bibtex', records: [{ title, authors, year: 2017, venue: '会议 & 会刊', doi: '10.1234/a_b',
    arxivId: '1706.03762', pmid: '9876', url: 'https://example.test/?x=1&y=2', abstract: '中文%摘要', source: 'web', verified: 'conflict', verificationNote: '保留冲突' }, { title, authors }] })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.path, /\.bib$/)
  const parsed = readBibtex(readFileSync(result.path, 'utf8'))
  assert.equal(parsed.length, 2); assert.ok(parsed.every(row => row.type === 'misc'))
  assert.equal(new Set(parsed.map(row => row.key)).size, 2); assert.ok(parsed.every(row => /^[A-Za-z][A-Za-z0-9_-]*$/.test(row.key)))
  assert.equal(texPlain(parsed[0].fields.get('title')), title)
  assert.deepEqual(literalAuthors(parsed[0].fields.get('author')), authors)
  assert.equal(texPlain(parsed[0].fields.get('howpublished')), '会议 & 会刊')
  assert.equal(texPlain(parsed[0].fields.get('doi')), '10.1234/a_b'); assert.equal(parsed[0].fields.get('year'), '2017')
  assert.equal(texPlain(parsed[0].fields.get('url')), 'https://example.test/?x=1&y=2')
  assert.equal(parsed[0].fields.get('eprint'), '1706.03762'); assert.equal(parsed[0].fields.get('pmid'), '9876')
  assert.match(parsed[0].fields.get('note'), /输入.*conflict/); assert.match(parsed[0].fields.get('note'), /本轮未重新验证.*未读全文/)
  assert.equal(parsed[1].fields.has('year'), false); assert.equal(parsed[1].fields.has('howpublished'), false)
})

test('BibTeX preserves unilateral and repeated literal braces in every field without crossing record boundaries', async () => {
  const samples = ['{', '}', '{{{{', '}}}}', '} @misc{forged, title={Injected}, note={forged}', '\\} }{{中文{{ end']
  const records = samples.map(value => ({ title: value, authors: [value, `Research ${value} and literal`], year: 2020,
    venue: value, doi: value, arxivId: value, pmid: value, url: value, abstract: value, source: value,
    sources: [{ source: value, doi: value, arxivId: value, pmid: value, url: value }],
    verified: 'unconfirmed', verificationNote: value }))
  const before = structuredClone(records), result = await environment().exportFile({ format: 'bibtex', records })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.recordCount, samples.length)
  const parsed = readBibtex(readFileSync(result.path, 'utf8'))
  assert.equal(parsed.length, samples.length); assert.equal(new Set(parsed.map(row => row.key)).size, samples.length)
  for (const [index, value] of samples.entries()) {
    const row = parsed[index]
    assert.equal(row.type, 'misc')
    assert.deepEqual([...row.fields.keys()].sort(), ['title', 'author', 'year', 'howpublished', 'doi', 'url', 'abstract', 'eprint', 'pmid', 'source', 'note'].sort())
    for (const field of ['title', 'howpublished', 'doi', 'url', 'abstract', 'eprint', 'pmid', 'source']) assert.equal(texPlain(row.fields.get(field)), value, `${index}:${field}`)
    assert.deepEqual(literalAuthors(row.fields.get('author')), records[index].authors)
    assert.equal(row.fields.get('year'), '2020')
    const note = texPlain(row.fields.get('note'))
    assert.ok(note.includes(`输入核验说明：${value}`)); assert.ok(note.includes(`输入 arXiv ID: ${value}`)); assert.ok(note.includes(`输入 PMID: ${value}`))
    const provenanceStart = note.indexOf('输入来源 sources: ')
    assert.ok(provenanceStart >= 0)
    assert.deepEqual(JSON.parse(note.slice(provenanceStart + '输入来源 sources: '.length)), records[index].sources)
  }
  assert.deepEqual(records, before)
})

test('RIS neutralizes newlines and control characters without injecting extra records', async () => {
  const injected = 'Title\r\nER  -\nTY  - JOUR\u0000\u0085TI  - injected\u2028line\u2029end'
  const result = await environment().exportFile({ records: [{ title: injected, authors: ['A\nAU  - forged'], abstract: 'x\r\nER  -\nTY  - JOUR' }] })
  assert.equal(result.ok, true, JSON.stringify(result))
  const text = readFileSync(result.path, 'utf8'), parsed = readRis(text)
  assert.equal(parsed.length, 1); assert.equal(parsed[0].get('TI').length, 1); assert.equal(parsed[0].get('AU').length, 1)
  assert.equal(/[\u0000\u0085\u2028\u2029]/.test(text), false)
  assert.match(result.limitations.join(' '), /换行|控制/)
})

test('title-only records retain missing fields and disclose the generic type and verification limits', async () => {
  const e = environment()
  for (const format of ['ris', 'bibtex']) {
    const result = await e.exportFile({ format, records: [{ title: 'Only supplied title' }] })
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = readFileSync(result.path, 'utf8')
    assert.doesNotMatch(text, /unknown author|Anonymous|n\.d\./i)
    const limitation = result.limitations.join(' ')
    assert.match(limitation, /作者/); assert.match(limitation, /年份/); assert.match(limitation, /期刊|刊物|venue/)
    assert.match(limitation, /类型|GEN|misc/); assert.match(limitation, /本轮未重新验证.*未读全文/)
    if (format === 'ris') { const row = readRis(text)[0]; assert.equal(row.has('AU'), false); assert.equal(row.has('PY'), false); assert.equal(row.has('T2'), false) }
    else { const row = readBibtex(text)[0]; assert.equal(row.fields.has('author'), false); assert.equal(row.fields.has('year'), false) }
  }
})

test('invalid records, fields, statuses, counts and formats are rejected before creating a file', async () => {
  const e = environment()
  for (const args of [
    { records: [] }, { records: new Array(101).fill({ title: 'too many' }) }, { records: 'not array' },
    { records: [null] }, { records: [{ title: ' ' }] }, { records: [{ title: 42 }] }, { records: [{ title: '\u0000\n' }] },
    { records: [{ title: 'valid' }, { authors: ['No title'] }] }, { records: [{ title: 'valid', authors: 'one' }] },
    { records: [{ title: 'valid', authors: ['one', 2] }] }, { records: [{ title: 'valid', year: '2020' }] },
    { records: [{ title: 'valid', year: 2020.5 }] }, { records: [{ title: 'valid', year: -1 }] },
    { records: [{ title: 'valid', verified: true }] }, { records: [{ title: 'valid', verified: 'fulltext' }] },
    { records: [{ title: 'valid', doi: {} }] }, { records: [{ title: 'valid', sources: 'web' }] },
    { records: [{ title: 'valid', sources: [{ url: 2 }] }] }, { records: [{ title: 'valid', sources: [null] }] },
    { format: 'pdf' }, { format: undefined },
  ]) {
    const slug = `invalid-${randomUUID()}`, result = await e.exportFile({ slug, ...args })
    assert.equal(result.ok, false, JSON.stringify(args)); assert.match(result.code ?? '', /^(literature\.export_|tool\.args)/)
    assert.equal(existsSync(join(home, 'vault', 'references', `${slug}.ris`)), false)
    assert.equal(existsSync(join(home, 'vault', 'references', `${slug}.bib`)), false)
  }
})

test('record count 100 is preserved and bounded field and output byte limits fail closed', async () => {
  const e = environment(), records = Array.from({ length: 100 }, () => ({ title: 'Same title' }))
  const result = await e.exportFile({ records })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(readRis(readFileSync(result.path, 'utf8')).length, 100)
  for (const args of [
    { records: [{ title: 'x'.repeat(8193) }] }, { records: [{ title: 'bounded', abstract: 'x'.repeat(65537) }] },
    { records: [{ title: 'bounded', authors: new Array(201).fill('author') }] },
    { records: [{ title: 'bounded', sources: new Array(21).fill({ source: 'web' }) }] },
    { format: 'bibtex', records: new Array(100).fill({ title: '\\'.repeat(4096) }) },
  ]) {
    const failed = await e.exportFile(args); assert.equal(failed.ok, false); assert.match(failed.code, /^literature\.export_/)
  }
})

test('sparse author and provenance arrays are rejected rather than silently dropping entries', async () => {
  const e = environment()
  for (const field of ['authors', 'sources']) {
    const result = await e.exportFile({ records: [{ title: 'Sparse input', [field]: new Array(1) }] })
    assert.equal(result.ok, false, field); assert.equal(result.code, 'literature.export_record')
  }
})

test('literal backslash sequences are not reported as normalized control characters', async () => {
  const result = await environment().exportFile({ records: [{ title: 'Literal \\new \\relative \\text' }] })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.limitations.some(line => /控制字符/.test(line)), false)
})

test('unsafe and Windows-reserved slugs are refused', async () => {
  const e = environment()
  for (const slug of ['', '../escape', 'a/b', 'a\\b', 'C:escape', '/absolute', 'name.ext', 'CON', 'nul', 'COM1', 'LPT9', 'a ', '中文', 'x'.repeat(81)]) {
    const result = await e.exportFile({ slug }); assert.equal(result.ok, false, slug); assert.equal(result.code, 'literature.export_slug')
  }
})

test('same content is reused without rewriting and a different request cannot overwrite an existing file', async () => {
  const e = environment(), args = { slug: `stable-${randomUUID()}`, records: [{ title: 'Stable output' }] }
  const first = await e.exportFile(args, 'first')
  assert.equal(first.ok, true, JSON.stringify(first))
  const before = statSync(first.path).mtimeMs, original = readFileSync(first.path)
  const again = await e.exportFile(args, 'another-call')
  assert.equal(again.ok, true); assert.equal(again.reused, true); assert.equal(again.sha256, first.sha256)
  assert.equal(statSync(first.path).mtimeMs, before)
  const different = await e.exportFile({ ...args, records: [{ title: 'Changed output' }] })
  assert.equal(different.ok, false); assert.equal(different.code, 'literature.export_conflict'); assert.deepEqual(readFileSync(first.path), original)
})

test('one native call replays unchanged bytes and rejects payload, destination or format swaps', async () => {
  const e = environment(), args = { slug: `replay-${randomUUID()}`, records: [{ title: 'Original' }] }
  const first = await e.exportFile(args, 'replayed-call'); assert.equal(first.ok, true, JSON.stringify(first))
  const before = statSync(first.path).mtimeMs, again = await e.exportFile(args, 'replayed-call')
  assert.equal(again.ok, true); assert.equal(statSync(first.path).mtimeMs, before)
  for (const change of [{ records: [{ title: 'Changed' }] }, { slug: `swapped-${randomUUID()}` }, { format: 'bibtex' }]) {
    const failed = await e.exportFile({ ...args, ...change }, 'replayed-call')
    assert.equal(failed.ok, false); assert.equal(failed.code, 'literature.export_operation_conflict')
  }
  assert.equal(readRis(readFileSync(first.path, 'utf8'))[0].get('TI')[0], 'Original')
})

test('a reuse-only native call is also bound to its first request', async () => {
  const e = environment(), args = { slug: `existing-${randomUUID()}`, records: [{ title: 'Existing same bytes' }] }
  assert.equal((await e.exportFile(args, 'creator')).ok, true)
  assert.equal((await e.exportFile(args, 'reuse-only')).ok, true)
  const slug = `changed-destination-${randomUUID()}`, result = await e.exportFile({ ...args, slug }, 'reuse-only')
  assert.equal(result.ok, false); assert.equal(result.code, 'literature.export_operation_conflict')
  assert.equal(existsSync(join(home, 'vault', 'references', `${slug}.ris`)), false)
})

test('manual edits and deleted native outputs cannot be rewritten by replay', async () => {
  const e = environment(), args = { slug: `manual-${randomUUID()}` }, first = await e.exportFile(args, 'manual-call')
  assert.equal(first.ok, true, JSON.stringify(first)); writeFileSync(first.path, 'OWNER MANUAL CONTENT')
  const replay = await e.exportFile(args, 'manual-call')
  assert.equal(replay.ok, false); assert.equal(readFileSync(first.path, 'utf8'), 'OWNER MANUAL CONTENT')
  assert.equal((await e.exportFile(args)).ok, false)
  unlinkSync(first.path); const deleted = await e.exportFile(args, 'manual-call')
  assert.equal(deleted.ok, false); assert.equal(existsSync(first.path), false)
})

test('export refuses linked artifact paths and a references junction escaping the configured vault', async t => {
  const e = environment(), directory = join(home, 'vault', 'references'), outside = join(home, 'outside')
  mkdirSync(directory, { recursive: true }); mkdirSync(outside, { recursive: true })
  const sentinel = join(outside, 'sentinel.ris'); writeFileSync(sentinel, 'OUTSIDE')
  const slug = `symlink-${randomUUID()}`, link = join(directory, `${slug}.ris`)
  // Windows file symlinks may need an unavailable OS privilege; still exercise a real artifact-path junction.
  let fileLink = true
  try { symlinkSync(sentinel, link, 'file') } catch (error) {
    if (error.code !== 'EPERM') throw error
    fileLink = false; symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    t.diagnostic('File symlink privilege unavailable; an actual .ris artifact-path junction exercises the link guard.')
  }
  try {
    // Node can classify Windows junctions as links or directories depending on
    // the host. Verify the actual target as well as the export refusal below.
    const linkStat = lstatSync(link)
    assert.ok(fileLink ? linkStat.isSymbolicLink() : linkStat.isSymbolicLink() || linkStat.isDirectory())
    assert.equal(realpathSync.native(link), realpathSync.native(fileLink ? sentinel : outside))
    const result = await e.exportFile({ slug }); assert.equal(result.ok, false); assert.equal(result.code, 'literature.export_path')
    assert.equal(readFileSync(sentinel, 'utf8'), 'OUTSIDE')
  } finally { if (fileLink) unlinkSync(link); else rmdirSync(link) }
  const renamed = `${directory}-preserved`; const { renameSync } = await import('node:fs')
  renameSync(directory, renamed)
  try {
    symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await e.exportFile({ slug: 'escaped' }); assert.equal(result.ok, false); assert.equal(result.code, 'literature.export_path')
    assert.equal(existsSync(join(outside, 'escaped.ris')), false)
  } finally {
    try { lstatSync(directory); try { unlinkSync(directory) } catch { rmdirSync(directory) } } catch (error) { if (error.code !== 'ENOENT') throw error }
    renameSync(renamed, directory)
  }
})

test('a held existing journal writer blocks an export without creating its artifact', async () => {
  const e = environment({ receiptsByRuntime: true }), lock = join(home, 'state', 'store-operations.jsonl.lock'), token = randomUUID()
  mkdirSync(lock); writeFileSync(join(lock, `owner-${token}.json`), JSON.stringify({ version: 1, pid: process.pid, token, time: new Date().toISOString() }))
  const slug = `blocked-${randomUUID()}`
  try {
    await assert.rejects(() => e.exportFile({ slug }), error => error.code === 'STORAGE_BUSY')
    assert.equal(existsSync(join(home, 'vault', 'references', `${slug}.ris`)), false)
  } finally { unlinkSync(join(lock, `owner-${token}.json`)); rmdirSync(lock) }
})

test('native final tools/result confirms only real export file evidence for the current task', async () => {
  const e = environment({ receiptsByRuntime: true }), opened = await e.call('butler_task', { action: 'open', title: '导出引用文件', kind: 'research' })
  const args = { action: 'export', format: 'ris', slug: `native-${randomUUID()}`, records: [{ title: 'Input says verified', url: 'https://example.test/paper', verified: 'verified' }] }
  const exec = e.execution('butler_literature', args, 'final-export'), output = await e.registered.get('butler_literature').execute(args, exec)
  assert.equal(output.ok, true, JSON.stringify(output)); assert.ok(output.evidenceIds?.length)
  assert.equal(output.evidenceState, 'pending-final-result'); assert.equal(Object.hasOwn(output, 'records'), false)
  assert.throws(() => e.evidence.resolve(output.evidenceIds, opened.task.id), /pending/)
  const premature = await e.call('butler_task', { action: 'update', id: opened.task.id, status: 'done', evidenceIds: output.evidenceIds })
  assert.equal(premature.ok, false)
  const identity = e.contexts.receipt(exec, output)
  e.evidence.observe('butler_literature', output, identity)
  const rows = e.evidence.resolve(output.evidenceIds, opened.task.id)
  assert.equal(rows.length, 1); assert.equal(rows[0].source_type, 'file'); assert.equal(rows[0].source_url, output.path)
  assert.equal(rows[0].sha256, digest(readFileSync(output.path))); assert.equal(rows[0].read_level, 'abstract')
  assert.equal(e.evidence.listForTask(opened.task.id).some(row => row.source_type === 'journal' || row.read_level === 'fulltext'), false)
  const done = await e.call('butler_task', { action: 'update', id: opened.task.id, status: 'done', evidenceIds: output.evidenceIds })
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(getTask(opened.task.id).status, 'done')
  const other = await e.call('butler_task', { action: 'open', title: '另一任务', kind: 'research' })
  const borrowed = await e.call('butler_task', { action: 'update', id: other.task.id, status: 'done', evidenceIds: output.evidenceIds })
  assert.equal(borrowed.ok, false); assert.throws(() => e.evidence.resolve(output.evidenceIds, other.task.id), /不属于/)
})

test('a rejected final native result leaves the created file without usable task evidence', async () => {
  const e = environment({ receiptsByRuntime: true }), opened = await e.call('butler_task', { action: 'open', title: '等待原生结果' })
  const args = { action: 'export', format: 'bibtex', slug: `rejected-${randomUUID()}`, records: [{ title: 'Physical file' }] }
  const exec = e.execution('butler_literature', args), output = await e.registered.get('butler_literature').execute(args, exec)
  assert.equal(output.ok, true, JSON.stringify(output)); assert.ok(existsSync(output.path))
  const identity = e.contexts.receipt(exec, { ok: false, message: 'native final gate refused' })
  e.evidence.observe('butler_literature', { ok: false }, identity)
  assert.throws(() => e.evidence.resolve(output.evidenceIds, opened.task.id), /失效|rejected/)
})

test('both official cached records can be exported offline without changing their prior verification data', async () => {
  const fixture = JSON.parse(readFileSync('E:/opendots/diagnostics/p3-aux-usage-20261021/native-research-recheck.json', 'utf8'))
  const records = fixture.results, before = structuredClone(records); assert.equal(records.length, 2)
  const e = environment({ web: { fetch() { assert.fail('export must never fetch') } } })
  for (const format of ['ris', 'bibtex']) {
    const result = await e.exportFile({ format, records }); assert.equal(result.ok, true, JSON.stringify(result))
    const text = readFileSync(result.path, 'utf8'), parsed = format === 'ris' ? readRis(text) : readBibtex(text)
    assert.equal(parsed.length, 2); assert.match(text, /1706\.03762/); assert.match(text, /2105\.02723/)
    assert.match(text, /本轮未重新验证.*未读全文/); assert.deepEqual(records, before)
  }
})

test('tool schema and research pack explain the local export API and retain PDF and OCR boundaries', () => {
  const e = environment(), schema = e.registered.get('butler_literature').parameters.properties, pack = getPack('research')
  assert.ok(schema.action.enum.includes('export')); assert.deepEqual(schema.format.enum, ['ris', 'bibtex']); assert.ok(schema.slug)
  assert.match(pack.instructions, /export.*format.*ris.*bibtex/s); assert.match(pack.instructions, /slug.*records/s)
  assert.match(pack.instructions, /本轮未重新验证.*未读全文/); assert.match(pack.instructions, /evidenceIds/)
  assert.match(pack.instructions, /不会自动下载/); assert.match(pack.instructions, /OCR/)
})
