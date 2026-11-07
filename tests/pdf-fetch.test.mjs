/**
 * fetch-pdf：公开 PDF 抓取的边界（大小/超时/内容类型/内网拒绝）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
const ts = createRequire(join(checkout, 'package.json'))('typescript')
const sourcePath = join(root, 'src/host/fetch-pdf.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, require: () => ({}), process, console, URL, Uint8Array, ArrayBuffer, Number, String, RegExp, Error, Promise, setTimeout, clearTimeout, fetch, AbortController }, { filename: sourcePath })
const { fetchPdfBytes, privateAddress, pdfFilename, looksLikePdf } = module.exports

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
let server
let base

test.before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/paper.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length })
      response.end(PDF)
    } else if (request.url === '/landing') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>sign in</html>')
    } else if (request.url === '/magic-only.pdf') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(PDF)
    } else if (request.url === '/redirect.pdf') {
      response.writeHead(302, { location: '/paper.pdf' })
      response.end()
    } else if (request.url === '/huge.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(10 * 1024 * 1024) })
      response.end(PDF)
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(() => { server?.close?.() })

test('private and loopback hosts are refused unless explicitly allowed', async () => {
  assert.equal(privateAddress('127.0.0.1'), true)
  assert.equal(privateAddress('10.1.2.3'), true)
  assert.equal(privateAddress('192.168.1.1'), true)
  assert.equal(privateAddress('172.20.0.1'), true)
  assert.equal(privateAddress('169.254.1.1'), true)
  assert.equal(privateAddress('example.org'), false)
  await assert.rejects(fetchPdfBytes(`${base}/paper.pdf`), /本机|内网/)
  const fetched = await fetchPdfBytes(`${base}/paper.pdf`, { allowPrivate: true })
  assert.equal(fetched.bytes.byteLength, PDF.length)
  assert.equal(fetched.filename, 'paper.pdf')
})

test('only http(s) URLs are accepted', async () => {
  await assert.rejects(fetchPdfBytes('file:///etc/passwd'), /http/)
  await assert.rejects(fetchPdfBytes('not a url'), /URL/)
})

test('a real PDF downloads with final URL and safe name; a landing page is refused', async () => {
  const fetched = await fetchPdfBytes(`${base}/paper.pdf`, { allowPrivate: true })
  assert.equal(fetched.contentType, 'application/pdf')
  assert.equal(fetched.finalUrl, `${base}/paper.pdf`)

  const redirect = await fetchPdfBytes(`${base}/redirect.pdf`, { allowPrivate: true })
  assert.equal(redirect.finalUrl, `${base}/paper.pdf`)

  await assert.rejects(fetchPdfBytes(`${base}/landing`, { allowPrivate: true }), /不是 PDF/)
  await assert.rejects(fetchPdfBytes(`${base}/missing`, { allowPrivate: true }), /HTTP 404/)
})

test('magic-byte PDFs are accepted without a PDF content type and the size cap is enforced', async () => {
  const magic = await fetchPdfBytes(`${base}/magic-only.pdf`, { allowPrivate: true })
  assert.equal(magic.bytes.byteLength, PDF.length)
  await assert.rejects(fetchPdfBytes(`${base}/paper.pdf`, { allowPrivate: true, maxBytes: 10 }), /过大/)
  await assert.rejects(fetchPdfBytes(`${base}/huge.pdf`, { allowPrivate: true, maxBytes: 1024 }), /过大/)

  // Long/unsafe URL segments become a bounded *.pdf name.
  assert.equal(pdfFilename('https://example.org/x/paper%20one'), 'paper one.pdf')
  assert.equal(pdfFilename('https://example.org/'), 'document.pdf')
  assert.ok(pdfFilename(`https://example.org/${'a'.repeat(400)}`).length <= 160)
  assert.equal(looksLikePdf(new Uint8Array([]), 'application/pdf'), true)
  assert.equal(looksLikePdf(Buffer.from('hello'), 'text/html'), false)
})
