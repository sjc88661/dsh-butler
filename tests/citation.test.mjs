/**
 * 引用格式与按页笔记草稿：字段不编造、页码/来源/限制行齐全、转义安全。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
const ts = createRequire(join(checkout, 'package.json'))('typescript')
const sourcePath = join(root, 'src/host/citation.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, console, JSON, Object, Array, String, Number, Date, RegExp, Error }, { filename: sourcePath })
const { citationKey, formatBibtex, formatRis, formatPlainCitation, noteDraft } = module.exports

const full = {
  title: 'Enzyme stability under {harsh} conditions',
  authors: ['Zhang San', 'Li Si'],
  year: 2024,
  journal: 'Journal of Enzyme Science',
  doi: '10.1234/jes.2024.001',
  url: 'https://example.org/paper',
  accessed: '2026-11-07',
}

test('BibTeX uses an article entry with a stable key and escaped braces', () => {
  const bibtex = formatBibtex(full)
  assert.match(bibtex, /^@article\{/)
  assert.match(bibtex, /title = \{Enzyme stability under harsh conditions\}/)
  assert.match(bibtex, /author = \{Zhang San and Li Si\}/)
  assert.match(bibtex, /year = \{2024\}/)
  assert.match(bibtex, /journal = \{Journal of Enzyme Science\}/)
  assert.match(bibtex, /doi = \{10\.1234\/jes\.2024\.001\}/)
  assert.match(bibtex, /urldate = \{2026-11-07\}/)
  assert.equal(citationKey(full), 'San2024Enzyme')
})

test('missing fields are omitted rather than invented', () => {
  const minimal = formatBibtex({ title: 'Only a title' })
  assert.match(minimal, /^@misc\{/)
  assert.match(minimal, /title = \{Only a title\}/)
  assert.doesNotMatch(minimal, /author|year|journal|doi/)
  assert.equal(formatRis({ title: 'Only a title' }).split('\n')[0], 'TY  - GEN')
})

test('RIS carries the common tags and ends with ER', () => {
  const ris = formatRis(full)
  assert.match(ris, /TY  - JOUR/)
  assert.match(ris, /T1  - Enzyme stability under harsh conditions/)
  assert.match(ris, /AU  - Zhang San/)
  assert.match(ris, /AU  - Li Si/)
  assert.match(ris, /PY  - 2024/)
  assert.match(ris, /DO  - 10\.1234\/jes\.2024\.001/)
  assert.match(ris, /ER  - \n$/)
})

test('plain citation joins what exists and skips what does not', () => {
  assert.equal(formatPlainCitation({ title: 'T', year: 2020, doi: '10.1/x' }), 'T (2020) · doi:10.1/x')
  assert.equal(formatPlainCitation({}), '（未命名文献）')
})

test('note draft keeps physical page anchors, provenance and honest limits', () => {
  const draft = noteDraft({
    title: '酶稳定性',
    citation: full,
    pages: [
      { page: 1, text: 'FIRST PHYSICAL PAGE' },
      { page: 4, text: '' },
    ],
    origin: 'https://example.org/paper.pdf',
    storedPath: 'E:/vault/uploads/abcd-paper.pdf',
    sha256: 'abcdef0123456789',
    declaredPages: 4,
    date: '2026-11-07',
  })
  assert.match(draft, /^# 酶稳定性\n/)
  assert.match(draft, /> 引用：Zhang San、Li Si · Enzyme stability under harsh conditions \(2024\)/)
  assert.match(draft, /> 原件：E:\/vault\/uploads\/abcd-paper\.pdf（来源 https:\/\/example\.org\/paper\.pdf）/)
  assert.match(draft, /> SHA256：abcdef0123456789/)
  assert.match(draft, /> 本次读取：2\/4 页/)
  assert.match(draft, /> 摘录日期：2026-11-07/)
  assert.match(draft, /## 引用信息/)
  assert.match(draft, /```bibtex/)
  assert.match(draft, /## p\.1\n\nFIRST PHYSICAL PAGE/)
  assert.match(draft, /## p\.4\n\n（本页文本层为空）/)
  assert.match(draft, /以上为文本层抽取与整理，引用前请核对原文/)
})
