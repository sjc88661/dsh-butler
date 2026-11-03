import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfText, pageAnchors } from '../src/host/pdf.ts'
import * as pdfModule from '../src/host/pdf.ts'

// Real classic-xref PDFs; this generator is copied from the diagnostic probe.
function pdf(objects, trailerExtra = '') {
  let body = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach(offset => { body += `${String(offset).padStart(10, '0')} 00000 n \n` })
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
const contentStream = (content, compressed = false) => { const body = compressed ? deflateSync(Buffer.from(content, 'latin1')).toString('latin1') : content; return `<< /Length ${body.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n${body}\nendstream` }
const stream = text => contentStream(`BT /F1 12 Tf 20 80 Td (${text}) Tj ET`)
const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
const page = (contents = '', parent = 2) => `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 200 100] ${contents} /Resources << /Font << /F1 9 0 R >> >> >>`

test('blank first page retains its physical position and the text anchor is p2', () => {
  const parsed = readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page(), page('/Contents 5 0 R'), stream('PHYSICAL PAGE TWO'), 'null', 'null', 'null', font]))
  assert.deepEqual(parsed.pages.map(row => row.page), [1, 2])
  assert.equal(parsed.pages[0].text, '')
  assert.match(parsed.pages[1].text, /PHYSICAL PAGE TWO/)
  assert.match(pageAnchors(parsed)[0], /^p2:/)
  assert.equal(parsed.pageOrderKnown, true)
})

test('multiple content streams on one physical page produce one page', () => {
  const parsed = readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/Contents [4 0 R 5 0 R]'), stream('FIRST STREAM'), stream('SECOND STREAM'), 'null', 'null', 'null', font]))
  assert.equal(parsed.pages.length, 1)
  assert.match(parsed.pages[0].text, /FIRST STREAM[\s\S]*SECOND STREAM/)
  assert.equal(parsed.complete, true)
})

test('nested page tree follows Kids order rather than object or stream order', () => {
  const parsed = readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [6 0 R 3 0 R] /Count 2 >>', page('/Contents 5 0 R'), 'null', stream('SECOND PHYSICAL PAGE'), '<< /Type /Pages /Parent 2 0 R /Kids [7 0 R] /Count 1 >>', page('/Contents 8 0 R', 6), stream('FIRST PHYSICAL PAGE'), font]))
  assert.deepEqual(parsed.pages.map(row => row.text.trim()), ['FIRST PHYSICAL PAGE', 'SECOND PHYSICAL PAGE'])
})

test('selecting later pages returns only those physical pages and cannot claim complete reading', () => {
  const parsed = readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page('/Contents 5 0 R'), page('/Contents 6 0 R'), stream('FIRST'), stream('SECOND'), 'null', 'null', font]), { pages: [2] })
  assert.deepEqual(parsed.pages.map(row => row.page), [2])
  assert.equal(parsed.pages[0].text.trim(), 'SECOND')
  assert.equal(parsed.complete, false)
  assert.deepEqual(parsed.selectedPages, [2])
  assert.throws(() => readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>']), { pages: [0] }), /页|page/i)
})

test('mixed scanned and text pages expose unreadable pages and do not become fulltext', () => {
  const parsed = readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page('/Contents 5 0 R'), '<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources << /XObject << /Im1 7 0 R >> >> >>', stream('READABLE SHORT TEXT'), contentStream('/Im1 Do'), '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Length 1 >>\nstream\nx\nendstream', 'null', font]))
  assert.equal(parsed.pages.length, 2)
  assert.equal(parsed.textLayer, true)
  assert.equal(parsed.pages[1].status, 'unreadable')
  assert.equal(parsed.complete, false)
  assert.match(parsed.limitations.join('\n'), /p2.*OCR|p2.*图片|p2.*图像/i)
})

test('compressed streams and text operators extract text without including unrelated literal strings', () => {
  const content = 'BT /F1 12 Tf (Alpha) Tj 0 -10 Td [(Beta) 10 (Gamma)] TJ ET /Tag (NOT VISIBLE METADATA) DP'
  const parsed = readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/Contents 4 0 R'), contentStream(content, true), 'null', 'null', 'null', 'null', font]))
  assert.match(parsed.pages[0].text, /Alpha[\s\S]*BetaGamma/)
  assert.doesNotMatch(parsed.pages[0].text, /NOT VISIBLE/)
})

test('unsupported page trees, object streams, encryption and fonts report unknown instead of fabricated anchors', () => {
  for (const bytes of [
    pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [99 0 R] /Count 1 >>', stream('THIS IS NOT A PHYSICAL PAGE')]),
    pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /ObjStm /N 1 /First 2 /Length 1 >>\nstream\nx\nendstream']),
    pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'], '/Encrypt 3 0 R'),
  ]) {
    const parsed = readPdfText(bytes)
    assert.equal(parsed.pageOrderKnown, false)
    assert.equal(parsed.complete, false)
    assert.deepEqual(pageAnchors(parsed), [])
    assert.ok(parsed.limitations.length > 0)
  }
  const customFont = readPdfText(pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/Contents 4 0 R'), stream('ENCODED DATA'), 'null', 'null', 'null', 'null', '<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H >>']))
  assert.equal(customFont.complete, false)
  assert.deepEqual(pageAnchors(customFont), [])
  assert.match(customFont.limitations.join('\n'), /字体|font|编码/i)
})

const cacheBase = resolve('tests/.tmp')
mkdirSync(cacheBase, { recursive: true })
const newCache = () => mkdtempSync(join(cacheBase, 'pdf-cache-'))
const readablePdf = text => pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/Contents 4 0 R'), stream(text), 'null', 'null', 'null', 'null', font])
function cached(bytes, options) {
  assert.equal(typeof pdfModule.readPdfTextCached, 'function', 'PDF text should have a persistent source-hash/parser-version cache')
  return pdfModule.readPdfTextCached(bytes, options)
}

test('PDF parsing cache survives restart and repeated reads reuse the same checked text file', () => {
  const cacheDir = newCache(), bytes = readablePdf('CACHE PERSISTENCE'), source = join(cacheDir, 'original.pdf')
  writeFileSync(source, bytes)
  const first = cached(bytes, { cacheDir })
  assert.equal(first.cache.hit, false)
  const cacheBytes = readFileSync(first.cache.path)
  const second = cached(bytes, { cacheDir })
  assert.equal(second.cache.hit, true)
  assert.deepEqual(second.pages, first.pages)
  assert.deepEqual(readFileSync(first.cache.path), cacheBytes)
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
    const {readPdfTextCached}=await import(${JSON.stringify(pathToFileURL(resolve('src/host/pdf.ts')).href)});
    const result=readPdfTextCached(readFileSync(${JSON.stringify(source)}),{cacheDir:${JSON.stringify(cacheDir)}});
    assert.equal(result.cache.hit,true);assert.match(result.pages[0].text,/CACHE PERSISTENCE/);
  `], { encoding: 'utf8', windowsHide: true })
  assert.equal(restarted.status, 0, restarted.stderr)
})

test('original byte changes and parser version mismatches invalidate PDF cache entries', () => {
  const cacheDir = newCache(), first = cached(readablePdf('OLD CONTENT'), { cacheDir })
  const next = cached(readablePdf('NEW CONTENT'), { cacheDir })
  assert.equal(next.cache.hit, false)
  assert.notEqual(first.cache.path, next.cache.path)
  assert.match(next.pages[0].text, /NEW CONTENT/)
  const saved = JSON.parse(readFileSync(next.cache.path, 'utf8'))
  saved.parserVersion = 'obsolete-parser'
  writeFileSync(next.cache.path, JSON.stringify(saved))
  const reparsed = cached(readablePdf('NEW CONTENT'), { cacheDir })
  assert.equal(reparsed.cache.hit, false)
  assert.equal(reparsed.cache.parserVersion, pdfModule.PDF_PARSER_VERSION)
  assert.match(reparsed.pages[0].text, /NEW CONTENT/)
})

test('corrupt or altered cached text falls back to the original without invented anchors', () => {
  const cacheDir = newCache(), bytes = readablePdf('TRUE PAGE TEXT'), first = cached(bytes, { cacheDir })
  writeFileSync(first.cache.path, '{torn')
  const repaired = cached(bytes, { cacheDir })
  assert.equal(repaired.cache.hit, false)
  assert.match(pageAnchors(repaired)[0], /^p1: TRUE PAGE TEXT$/)
  const saved = JSON.parse(readFileSync(repaired.cache.path, 'utf8'))
  saved.payload.pages[0].text = 'FORGED CACHE TEXT'
  writeFileSync(repaired.cache.path, JSON.stringify(saved))
  const checked = cached(bytes, { cacheDir })
  assert.equal(checked.cache.hit, false)
  assert.match(pageAnchors(checked)[0], /^p1: TRUE PAGE TEXT$/)
})

test('cached reading flags cannot promote a scan or partial range into fulltext', () => {
  const cacheDir = newCache(), bytes = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page('/Contents 5 0 R'), page('/Contents 6 0 R'), stream('TEXT PAGE'), contentStream('/Im1 Do'), 'null', 'null', font])
  const first = cached(bytes, { cacheDir })
  const saved = JSON.parse(readFileSync(first.cache.path, 'utf8'))
  saved.payload.complete = true
  saved.payload.textLayer = true
  saved.payloadSha256 = createHash('sha256').update(JSON.stringify(saved.payload)).digest('hex')
  writeFileSync(first.cache.path, JSON.stringify(saved))
  const checked = cached(bytes, { cacheDir })
  assert.equal(checked.complete, false)
  assert.equal(checked.pages[1].status, 'unreadable')
  assert.deepEqual(pageAnchors(checked), ['p1: TEXT PAGE'])
  const partial = cached(bytes, { cacheDir, pages: [1] })
  assert.equal(partial.complete, false)
  assert.deepEqual(partial.selectedPages, [1])
  assert.notEqual(partial.cache.path, first.cache.path)
  assert.equal(cached(bytes, { cacheDir, pages: [1] }).cache.hit, true)
})

test('PDF cache eviction is bounded and cache I/O failure remains a readable source result', () => {
  const cacheDir = newCache()
  for (let index = 0; index < 35; index++) cached(readablePdf(`DOCUMENT ${index}`), { cacheDir })
  assert.ok(readdirSync(cacheDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length <= 32)
  const unavailable = join(cacheDir, 'not-a-directory')
  writeFileSync(unavailable, 'preserve this unrelated file')
  const result = cached(readablePdf('READ WITHOUT CACHE'), { cacheDir: unavailable })
  assert.equal(result.cache.hit, false)
  assert.match(result.pages[0].text, /READ WITHOUT CACHE/)
  assert.ok(result.cache.warnings.length > 0)
  assert.equal(readFileSync(unavailable, 'utf8'), 'preserve this unrelated file')
})

test('the actual PDF tool exposes cache reuse while preserving physical selection and read level', () => {
  const home = newCache(), source = join(home, 'source.pdf')
  writeFileSync(source, pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page(), page('/Contents 5 0 R'), stream('PHYSICAL PAGE TWO'), 'null', 'null', 'null', font]))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {registerButlerTools}=await import(${JSON.stringify(pathToFileURL(resolve('src/host/tools.ts')).href)});const tools=new Map();
    registerButlerTools({tools:{register(tool){tools.set(tool.name,tool);return()=>{}}}},
      {timeZone:'UTC',mailto:'test@localhost',receiptsByRuntime:true,sessionId:()=> 'isolated',currentTaskId:()=>undefined});
    const args={action:'read',path:${JSON.stringify(source)},pages:[2]};const first=await tools.get('butler_pdf').execute(args);
    const second=await tools.get('butler_pdf').execute(args);assert.equal(first.ok,true);assert.equal(first.cache?.hit,false);assert.equal(second.cache?.hit,true);
    assert.deepEqual(second.returnedPages.map(row=>row.page),[2]);assert.match(second.anchors[0],/^p2:/);assert.equal(second.readLevel,'abstract');assert.equal(second.fullTextAvailable,false);
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_BUTLER_HOME: join(home, 'state'), DSH_BUTLER_VAULT: join(home, 'vault') } })
  assert.equal(result.status, 0, result.stderr)
})

test('a cache cannot make an out-of-range selected page become complete by changing its declared count', () => {
  const cacheDir = newCache(), bytes = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page(), page('/Contents 5 0 R'), stream('REAL SECOND PAGE'), 'null', 'null', 'null', font])
  const first = cached(bytes, { cacheDir, pages: [2] }), saved = JSON.parse(readFileSync(first.cache.path, 'utf8'))
  saved.payload.declaredPages = 1
  saved.payloadSha256 = createHash('sha256').update(JSON.stringify(saved.payload)).digest('hex')
  writeFileSync(first.cache.path, JSON.stringify(saved))
  const checked = cached(bytes, { cacheDir, pages: [2] })
  assert.equal(checked.cache.hit, false)
  assert.equal(checked.declaredPages, 2)
  assert.equal(checked.complete, false)
  assert.deepEqual(pageAnchors(checked), ['p2: REAL SECOND PAGE'])
})

test('a cache directory junction is refused without reading, writing, or pruning its external target', () => {
  const home = newCache(), external = join(home, 'external'), link = join(home, 'cache-link')
  mkdirSync(external)
  symlinkSync(external, link, 'junction')
  const result = cached(readablePdf('KEEP SOURCE READABLE'), { cacheDir: link })
  assert.equal(result.cache.hit, false)
  assert.match(result.pages[0].text, /KEEP SOURCE READABLE/)
  assert.ok(result.cache.warnings.length > 0)
  assert.deepEqual(readdirSync(external), [])
})

test('rewriting cached text and status with a recalculated payload checksum cannot turn a scan into readable text', () => {
  const cacheDir = newCache(), bytes = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page('/Contents 4 0 R'), contentStream('/Im1 Do'), 'null', 'null', 'null', 'null', font])
  const first = cached(bytes, { cacheDir }), saved = JSON.parse(readFileSync(first.cache.path, 'utf8'))
  saved.payload.pages[0] = { page: 1, text: 'FORGED OCR TEXT', status: 'text' }
  saved.payload.limitations = []
  saved.payload.complete = true
  saved.payload.textLayer = true
  saved.payloadSha256 = createHash('sha256').update(JSON.stringify(saved.payload)).digest('hex')
  writeFileSync(first.cache.path, JSON.stringify(saved))
  const checked = cached(bytes, { cacheDir })
  assert.equal(checked.cache.hit, false)
  assert.equal(checked.complete, false)
  assert.equal(checked.textLayer, false)
  assert.equal(checked.pages[0].status, 'unreadable')
  assert.deepEqual(pageAnchors(checked), [])
})

test('a missing or damaged local integrity key causes a safe cache miss without changing source reading', () => {
  const cacheDir = newCache(), bytes = readablePdf('SOURCE STILL READABLE'), first = cached(bytes, { cacheDir })
  const keyPath = join(cacheDir, '.integrity-key-v1'), keyHex = readFileSync(keyPath).toString('hex')
  assert.equal(JSON.stringify(first.cache).includes(keyHex), false)
  rmSync(keyPath)
  const missing = cached(bytes, { cacheDir })
  assert.equal(missing.cache.hit, false)
  assert.match(missing.pages[0].text, /SOURCE STILL READABLE/)
  assert.equal(cached(bytes, { cacheDir }).cache.hit, true)
  writeFileSync(keyPath, 'damaged')
  const damaged = cached(bytes, { cacheDir })
  assert.equal(damaged.cache.hit, false)
  assert.match(damaged.pages[0].text, /SOURCE STILL READABLE/)
  assert.ok(damaged.cache.warnings.length > 0)
})

export { pdf, stream, contentStream, page, font }
