/** Conservative offline PDF reader: unknown structures never receive invented page numbers. */
import { inflateSync } from 'node:zlib'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
export const PDF_PARSER_VERSION = 'pdf-classic-xref-v1'
export interface PdfPage { page: number; text: string; status: 'text' | 'blank' | 'partial' | 'unreadable' }
export interface PdfText {
  pages: PdfPage[]
  textLayer: boolean
  producer?: string
  declaredPages?: number
  limitations: string[]
  pageOrderKnown: boolean
  /** Every physical page was selected, with no unsupported text, font, image or stream. */
  complete: boolean
  selectedPages: number[]
}
export interface PdfReadOptions { pages?: number[] }
type Name = { kind: 'name'; value: string }
type Str = { kind: 'string'; value: string }
type Ref = { kind: 'ref'; object: number; generation: number }
type Word = { kind: 'word'; value: string }
type Value = number | boolean | null | Name | Str | Ref | Word | Dict | Value[]
interface Dict { [key: string]: Value }
const dict = (v: Value | undefined): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v) && !('kind' in v)
const kind = <K extends 'name' | 'string' | 'ref' | 'word'>(v: Value | undefined, k: K): v is Extract<Value, { kind: K }> => typeof v === 'object' && v !== null && !Array.isArray(v) && v['kind'] === k
const named = (v: Value | undefined, name: string): boolean => kind(v, 'name') && v.value === name
const white = /[\x00\t\n\f\r ]/
const delimiter = /[\x00\t\n\f\r ()<>[\]{}/%]/

/** Balanced PDF syntax, rather than regular expressions over stream payloads. */
class Syntax {
  position: number
  readonly raw: string
  private tokens = 0
  constructor(raw: string, start = 0) { this.raw = raw; this.position = start }
  skip(): void {
    while (this.position < this.raw.length) {
      if (white.test(this.raw[this.position])) { this.position += 1; continue }
      if (this.raw[this.position] === '%') { while (this.position < this.raw.length && !/[\r\n]/.test(this.raw[this.position])) this.position += 1; continue }
      break
    }
  }
  read(depth = 0): Value {
    if (depth > 64 || ++this.tokens > 250000) throw new Error('PDF 语法嵌套或对象数量超出安全上限')
    this.skip()
    const ch = this.raw[this.position]
    if (ch === undefined) throw new Error('PDF 对象意外截断')
    if (this.raw.startsWith('<<', this.position)) {
      this.position += 2
      const out: Dict = Object.create(null) as Dict
      while (true) {
        this.skip()
        if (this.raw.startsWith('>>', this.position)) { this.position += 2; return out }
        const key = this.read(depth + 1)
        if (!kind(key, 'name') || Object.hasOwn(out, key.value)) throw new Error('PDF 字典键无效或重复')
        out[key.value] = this.read(depth + 1)
      }
    }
    if (ch === '[') {
      this.position += 1
      const out: Value[] = []
      while (true) { this.skip(); if (this.raw[this.position] === ']') { this.position += 1; return out }; out.push(this.read(depth + 1)) }
    }
    if (ch === '(') {
      this.position += 1
      let out = '', nesting = 1
      while (this.position < this.raw.length) {
        let next = this.raw[this.position++]
        if (next === '\\') {
          next = this.raw[this.position++]
          if (next === '\r') { if (this.raw[this.position] === '\n') this.position += 1; continue }
          if (next === '\n') continue
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
          if (next !== undefined && /[0-7]/.test(next)) {
            let octal = next
            while (octal.length < 3 && /[0-7]/.test(this.raw[this.position] ?? 'x')) octal += this.raw[this.position++]
            out += String.fromCharCode(Number.parseInt(octal, 8) & 255)
          } else out += escapes[next] ?? next ?? ''
        } else if (next === '(') { nesting += 1; out += next }
        else if (next === ')') { if (--nesting === 0) return { kind: 'string', value: out }; out += next }
        else out += next
      }
      throw new Error('PDF 字符串未闭合')
    }
    if (ch === '<') {
      const end = this.raw.indexOf('>', ++this.position)
      if (end < 0) throw new Error('PDF 十六进制字符串未闭合')
      let hex = this.raw.slice(this.position, end).replace(/[\x00\t\n\f\r ]/g, '')
      if (!/^[a-f\d]*$/i.test(hex)) throw new Error('PDF 十六进制字符串无效')
      if (hex.length % 2) hex += '0'
      this.position = end + 1
      return { kind: 'string', value: Buffer.from(hex, 'hex').toString('latin1') }
    }
    if (ch === '/') {
      this.position += 1
      const start = this.position
      while (this.position < this.raw.length && !delimiter.test(this.raw[this.position])) this.position += 1
      return { kind: 'name', value: this.raw.slice(start, this.position).replace(/#([a-f\d]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) }
    }
    const start = this.position
    while (this.position < this.raw.length && !delimiter.test(this.raw[this.position])) this.position += 1
    if (start === this.position) throw new Error(`PDF 无法识别的分隔符 ${ch}`)
    const word = this.raw.slice(start, this.position)
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      const number = Number(word)
      if (Number.isSafeInteger(number) && number >= 0) {
        const ref = /^\s+(\d+)\s+R(?=[\s\]<>/]|$)/.exec(this.raw.slice(this.position))
        if (ref) { this.position += ref[0].length; return { kind: 'ref', object: number, generation: Number(ref[1]) } }
      }
      return number
    }
    if (word === 'true' || word === 'false') return word === 'true'
    if (word === 'null') return null
    return { kind: 'word', value: word }
  }
}

interface PdfObject { value: Value; stream?: string }
class Document {
  readonly trailer: Dict
  readonly raw: string
  private readonly locations = new Map<string, number>()
  private readonly objects = new Map<string, PdfObject>()
  private readonly loading = new Set<string>()
  constructor(raw: string) {
    this.raw = raw
    const final = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(raw)
    if (!final) throw new Error('找不到有效的 startxref，物理页顺序 unknown')
    let position = Number(final[1]), entries = 0
    if (raw.slice(position, position + 4) !== 'xref') throw new Error('xref/object stream 尚不支持，物理页顺序 unknown')
    position += 4
    while (true) {
      while (white.test(raw[position] ?? 'x')) position += 1
      if (raw.startsWith('trailer', position)) { position += 7; break }
      const section = /^(\d+)\s+(\d+)\s*[\r\n]+/.exec(raw.slice(position))
      if (!section) throw new Error('xref 表结构无效，物理页顺序 unknown')
      position += section[0].length
      const count = Number(section[2]), first = Number(section[1])
      if (!Number.isSafeInteger(count) || (entries += count) > 100000) throw new Error('xref 超出安全上限')
      for (let index = 0; index < count; index += 1) {
        const entry = /^(\d{10}) (\d{5}) ([nf])[^\r\n]*[\r\n]+/.exec(raw.slice(position))
        if (!entry) throw new Error('xref 项无效，物理页顺序 unknown')
        position += entry[0].length
        if (entry[3] === 'n') this.locations.set(`${first + index}:${Number(entry[2])}`, Number(entry[1]))
      }
    }
    const trailer = new Syntax(raw, position).read()
    if (!dict(trailer)) throw new Error('PDF trailer 不是字典')
    if (trailer['Encrypt'] !== undefined && trailer['Encrypt'] !== null) throw new Error('加密 PDF 尚不支持，内容与物理页顺序 unknown')
    if (trailer['Prev'] !== undefined || trailer['XRefStm'] !== undefined) throw new Error('增量/混合 xref 尚不支持，物理页顺序 unknown')
    this.trailer = trailer
  }
  object(ref: Ref): PdfObject {
    const key = `${ref.object}:${ref.generation}`, cached = this.objects.get(key)
    if (cached) return cached
    if (this.loading.has(key)) throw new Error('PDF 对象循环引用')
    const offset = this.locations.get(key)
    if (offset === undefined) throw new Error(`PDF 对象 ${key} 不存在（可能位于不支持的 object stream）`)
    this.loading.add(key)
    try {
      const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(this.raw.slice(offset))
      if (!header || Number(header[1]) !== ref.object || Number(header[2]) !== ref.generation) throw new Error('xref 与对象编号不一致')
      const syntax = new Syntax(this.raw, offset + header[0].length), value = syntax.read()
      syntax.skip()
      let stream: string | undefined
      if (this.raw.startsWith('stream', syntax.position)) {
        const marker = /^stream(?:\r\n|\n|\r)/.exec(this.raw.slice(syntax.position))
        if (!dict(value) || !marker) throw new Error('PDF stream 缺少字典或换行')
        const length = this.deref(value['Length'])
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 64 * 1024 * 1024) throw new Error('PDF stream Length 无效或过大')
        const start = syntax.position + marker[0].length
        if (start + length > this.raw.length) throw new Error('PDF stream 被截断')
        stream = this.raw.slice(start, start + length)
        syntax.position = start + length; syntax.skip()
        if (!this.raw.startsWith('endstream', syntax.position)) throw new Error('PDF stream Length 与边界不匹配')
        syntax.position += 9; syntax.skip()
      }
      if (!this.raw.startsWith('endobj', syntax.position)) throw new Error('PDF 对象未正常终止')
      const out = { value, ...(stream === undefined ? {} : { stream }) }
      this.objects.set(key, out)
      return out
    } finally { this.loading.delete(key) }
  }
  deref(value: Value | undefined): Value | undefined { return kind(value, 'ref') ? this.object(value).value : value }
  dictionary(value: Value | undefined): Dict { const out = this.deref(value); if (!dict(out)) throw new Error('PDF 必需字典无效'); return out }
  content(value: Value): string {
    if (!kind(value, 'ref')) throw new Error('页面 Contents 不是间接 stream 引用')
    const object = this.object(value)
    if (!dict(object.value) || object.stream === undefined) throw new Error('页面 Contents 引用没有 stream')
    const filter = this.deref(object.value['Filter']), params = this.deref(object.value['DecodeParms'])
    if (params !== undefined && params !== null) throw new Error('stream DecodeParms 尚不支持')
    if (filter === undefined || filter === null) return object.stream
    if (!(named(filter, 'FlateDecode') || (Array.isArray(filter) && filter.length === 1 && named(filter[0], 'FlateDecode')))) throw new Error('stream 压缩 Filter 尚不支持')
    return inflateSync(Buffer.from(object.stream, 'latin1'), { maxOutputLength: 32 * 1024 * 1024 }).toString('latin1')
  }
}

function clean(text: string): string { return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim() }
function extract(document: Document, content: string, resources: Value | undefined): { text: string; issues: string[] } {
  const syntax = new Syntax(content), pieces: string[] = [], issues = new Set<string>()
  let operands: Value[] = [], inText = false, font: Dict | undefined
  const show = (value: Value | undefined) => {
    if (!kind(value, 'string')) { issues.add('文本显示运算符参数无效'); return }
    const base = font?.['BaseFont'], encoding = font?.['Encoding']
    if (!font || !named(font['Subtype'], 'Type1') || !kind(base, 'name') || !/^(Helvetica|Courier|Times)(?:-(?:Bold|Oblique|BoldOblique|Roman|Italic|BoldItalic))?$/.test(base.value) || font['ToUnicode'] !== undefined || (encoding !== undefined && !named(encoding, 'WinAnsiEncoding') && !named(encoding, 'StandardEncoding'))) {
      issues.add('字体/编码尚不支持，未把字符编码当作可读文本'); return
    }
    if (!named(encoding, 'WinAnsiEncoding') && /[^\x20-\x7e\t\r\n]/.test(value.value)) { issues.add('StandardEncoding 非 ASCII 字符尚未可靠解码'); return }
    pieces.push(named(encoding, 'WinAnsiEncoding') ? new TextDecoder('windows-1252').decode(Buffer.from(value.value, 'latin1')) : value.value)
  }
  while (true) {
    syntax.skip(); if (syntax.position >= content.length) break
    const token = syntax.read()
    if (!kind(token, 'word')) { operands.push(token); continue }
    const op = token.value
    if (op === 'BT') { inText = true; font = undefined }
    else if (op === 'ET') { inText = false; pieces.push('\n') }
    else if (op === 'Do' || op === 'BI') { issues.add('图片或 Form XObject 未解析；扫描/混合页需要 OCR 或完整 PDF 解析器'); if (op === 'BI') break }
    else if (inText) {
      if (op === 'Tf') {
        const fontName = operands.at(-2)
        try { const resourceDict = document.dictionary(resources), fonts = document.dictionary(resourceDict['Font']); font = kind(fontName, 'name') ? document.dictionary(fonts[fontName.value]) : undefined } catch { font = undefined }
      } else if (op === 'Tj') show(operands.at(-1))
      else if (op === 'TJ') { const array = operands.at(-1); if (!Array.isArray(array)) issues.add('TJ 数组无效'); else for (const item of array) if (typeof item !== 'number') show(item) }
      else if (op === "'" || op === '"') { pieces.push('\n'); show(operands.at(-1)) }
      else if (op === 'Td' || op === 'TD' || op === 'T*') pieces.push('\n')
    }
    operands = []
  }
  if (inText) issues.add('文本对象未正常结束')
  return { text: clean(pieces.join('')), issues: [...issues] }
}

/** Supports classic xref, Pages/Kids order, uncompressed/Flate streams and standard Latin fonts. */
export function readPdfText(bytes: Uint8Array, options: PdfReadOptions = {}): PdfText {
  if (options.pages !== undefined && (!Array.isArray(options.pages) || options.pages.length === 0 || options.pages.some(page => !Number.isSafeInteger(page) || page < 1))) throw new Error('pages 必须是非空的正整数物理页码数组')
  const limitations: string[] = [], raw = Buffer.from(bytes).toString('latin1')
  const unknown = (reason: string): PdfText => ({ pages: [], textLayer: false, limitations: [reason], pageOrderKnown: false, complete: false, selectedPages: [] })
  if (!raw.startsWith('%PDF-')) return unknown('文件头不是 %PDF-，内容和物理页顺序 unknown。')
  try {
    const document = new Document(raw), catalog = document.dictionary(document.trailer['Root'])
    if (!named(catalog['Type'], 'Catalog') || !kind(catalog['Pages'], 'ref')) throw new Error('Catalog/Pages 根引用无效')
    const leaves: Array<{ page: Dict; resources?: Value }> = [], seen = new Set<string>()
    const walk = (ref: Ref, parent?: Ref, inherited?: Value, depth = 0): number => {
      const key = `${ref.object}:${ref.generation}`
      if (depth > 64 || seen.has(key) || seen.size > 100000) throw new Error('Pages 树循环、重复或超出安全上限')
      seen.add(key)
      const page = document.dictionary(ref), resources = page['Resources'] ?? inherited
      if (parent && kind(page['Parent'], 'ref') && (page['Parent'].object !== parent.object || page['Parent'].generation !== parent.generation)) throw new Error('Pages Parent 与 Kids 不一致')
      if (named(page['Type'], 'Page')) { leaves.push({ page, resources }); return 1 }
      if (!named(page['Type'], 'Pages')) throw new Error('Pages 树节点不是 Page/Pages')
      const kids = document.deref(page['Kids'])
      if (!Array.isArray(kids) || kids.some(kid => !kind(kid, 'ref'))) throw new Error('Pages Kids 不是有效引用数组')
      const count = kids.reduce<number>((total, kid) => total + walk(kid as Ref, ref, resources, depth + 1), 0)
      if (page['Count'] !== count) throw new Error('Pages Count 与实际 Kids 叶子数不一致')
      return count
    }
    const declaredPages = walk(catalog['Pages'])
    if (options.pages?.some(page => page > declaredPages)) throw new RangeError(`请求的物理页码超出 ${declaredPages} 页`)
    const selectedPages = options.pages === undefined ? leaves.map((_, index) => index + 1) : [...new Set(options.pages)].sort((a, b) => a - b)
    const pages: PdfPage[] = []
    for (const number of selectedPages) {
      const leaf = leaves[number - 1]
      try {
        const contents = document.deref(leaf.page['Contents'])
        if (contents === undefined || contents === null) { pages.push({ page: number, text: '', status: 'blank' }); continue }
        const refs = Array.isArray(contents) ? contents : [leaf.page['Contents'] as Value]
        const content = refs.map(ref => document.content(ref)).join('\n'), parsed = extract(document, content, leaf.resources)
        if (!parsed.text && content.trim() !== '' && parsed.issues.length === 0) parsed.issues.push('没有可读文本，可能是扫描/图形页；未执行 OCR')
        limitations.push(...parsed.issues.map(issue => `p${number}: ${issue}。`))
        pages.push({ page: number, text: parsed.text, status: parsed.issues.length > 0 ? (parsed.text ? 'partial' : 'unreadable') : (parsed.text ? 'text' : 'blank') })
      } catch (error) {
        pages.push({ page: number, text: '', status: 'unreadable' })
        limitations.push(`p${number}: ${error instanceof Error ? error.message : String(error)}；内容 unknown。`)
      }
    }
    const textLayer = pages.some(page => page.text.length > 0)
    if (!textLayer) limitations.push('所选页没有可靠可读的文本层；未执行 OCR。')
    if (selectedPages.length < declaredPages) limitations.push(`本次只读取 ${selectedPages.join(', ')} 页，未返回其余物理页的内容。`)
    return { pages, textLayer, declaredPages, limitations, pageOrderKnown: true, complete: selectedPages.length === declaredPages && pages.every(page => page.status === 'text' || page.status === 'blank'), selectedPages }
  } catch (error) {
    if (error instanceof RangeError) throw error
    return unknown(`${error instanceof Error ? error.message : String(error)}；不生成页码锚点。`)
  }
}

export function pageAnchors(text: PdfText, limit = 40): string[] {
  if (!text.pageOrderKnown || !Number.isSafeInteger(limit) || limit < 1) return []
  return text.pages.flatMap(page => {
    if (page.status === 'unreadable' || page.status === 'blank') return []
    const line = page.text.split('\n').map(entry => entry.trim()).find(entry => entry.length >= 3)
    return line === undefined ? [] : [`p${page.page}: ${line.slice(0, 80)}`]
  }).slice(0, limit)
}

const PDF_MAX_BYTES = 64 * 1024 * 1024
const CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024
const CACHE_MAX_BYTES = 64 * 1024 * 1024
const CACHE_MAX_ENTRIES = 32
const cacheHash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

/** The byte limit applies to the descriptor even if an editor grows the file. */
function boundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error(`文件不是普通文件或超过 ${limit} 字节上限`)
    const bytes = Buffer.alloc(Math.min(limit, stat.size) + 1)
    let offset = 0, count = 0
    do { count = readSync(fd, bytes, offset, bytes.length - offset, null); offset += count } while (count && offset < bytes.length)
    if (offset > stat.size || offset > limit) throw new Error('读取时文件增长；请在文件稳定后重试')
    return bytes.subarray(0, offset)
  } finally { closeSync(fd) }
}

export function readPdfFile(path: string): Uint8Array { return boundedFile(path, PDF_MAX_BYTES) }

export interface PdfCacheInfo {
  hit: boolean
  path: string | null
  sourceSha256: string
  parserVersion: string
  warnings: string[]
}
export interface CachedPdfText extends PdfText { cache: PdfCacheInfo }
interface CacheEntry {
  version: 1
  parserVersion: string
  sourceSha256: string
  selection: number[] | null
  payloadSha256: string
  payload: PdfText
  integrityMac: string
}
const cacheRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integrityMac = (value: Pick<CacheEntry, 'version' | 'parserVersion' | 'sourceSha256' | 'selection' | 'payloadSha256'>, key: Uint8Array): string =>
  createHmac('sha256', key).update(JSON.stringify([value.version, value.parserVersion, value.sourceSha256, value.selection, value.payloadSha256])).digest('hex')

/** A private cache witness, separate from editable JSON and never a source of business evidence. */
function integrityKey(cacheDir: string, create = false): Buffer | undefined {
  const path = join(cacheDir, '.integrity-key-v1')
  assertCachePath(path)
  const read = () => { const key = boundedFile(path, 32); if (key.length !== 32) throw new Error('PDF 缓存完整性凭据损坏，停用缓存'); return key }
  try { return read() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (!create) return undefined
  }
  const key = randomBytes(32)
  let fd: number
  try { fd = openSync(path, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return read()
    throw error
  }
  try { writeFileSync(fd, key); fsyncSync(fd) } finally { closeSync(fd) }
  return key
}

/** Check cached structure and recompute reading flags; anchors are never cached. */
function checkedCache(value: unknown, sourceSha256: string, selection: number[] | null, key: Uint8Array): PdfText | undefined {
  if (!cacheRecord(value) || value.version !== 1 || value.parserVersion !== PDF_PARSER_VERSION || value.sourceSha256 !== sourceSha256
    || JSON.stringify(value.selection) !== JSON.stringify(selection) || !cacheRecord(value.payload)
    || value.payloadSha256 !== cacheHash(JSON.stringify(value.payload))
    || value.integrityMac !== integrityMac(value as unknown as CacheEntry, key)) return undefined
  const payload = value.payload
  if (typeof payload.pageOrderKnown !== 'boolean' || !Array.isArray(payload.pages) || !Array.isArray(payload.selectedPages)
    || !Array.isArray(payload.limitations) || payload.limitations.length > 100000 || payload.limitations.some(row => typeof row !== 'string')) return undefined
  if (!payload.pageOrderKnown) {
    if (payload.pages.length || payload.selectedPages.length || !payload.limitations.length) return undefined
    return { pages: [], selectedPages: [], textLayer: false, pageOrderKnown: false, complete: false, limitations: payload.limitations as string[] }
  }
  if (!Number.isSafeInteger(payload.declaredPages) || (payload.declaredPages as number) < 0 || (payload.declaredPages as number) > 100000) return undefined
  const declaredPages = payload.declaredPages as number
  const selected = selection ?? Array.from({ length: declaredPages }, (_, index) => index + 1)
  if (selected.some(page => page > declaredPages)) return undefined
  if (JSON.stringify(payload.selectedPages) !== JSON.stringify(selected) || payload.pages.length !== selected.length) return undefined
  let total = 0
  const pages: PdfPage[] = []
  for (const [index, page] of payload.pages.entries()) {
    if (!cacheRecord(page) || page.page !== selected[index] || typeof page.text !== 'string'
      || !['text', 'blank', 'partial', 'unreadable'].includes(String(page.status))) return undefined
    const status = page.status as PdfPage['status']
    if (((status === 'blank' || status === 'unreadable') && page.text !== '') || ((status === 'text' || status === 'partial') && page.text === '')) return undefined
    total += Buffer.byteLength(page.text, 'utf8')
    if (total > CACHE_MAX_ENTRY_BYTES) return undefined
    pages.push({ page: page.page as number, text: page.text, status })
  }
  return { pages, declaredPages, selectedPages: selected, limitations: payload.limitations as string[], pageOrderKnown: true,
    textLayer: pages.some(page => page.text.length > 0), complete: pages.length === declaredPages && pages.every(page => page.status === 'text' || page.status === 'blank') }
}

/** Derived files only: enforce entry/byte limits without touching unrelated files. */
function pruneCache(cacheDir: string, reserveBytes: number, keep?: string): void {
  const directory = opendirSync(cacheDir), entries: Array<{ path: string; bytes: number; modified: number }> = []
  let inspected = 0
  try {
    for (;;) {
      const entry = directory.readSync()
      if (!entry) break
      if (++inspected > 512) throw new Error('缓存目录超过 512 个条目，暂停新增缓存')
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
      const path = join(cacheDir, entry.name), stat = statSync(path)
      if (path !== keep) entries.push({ path, bytes: stat.size, modified: stat.mtimeMs })
    }
  } finally { directory.closeSync() }
  entries.sort((a, b) => a.modified - b.modified)
  let total = entries.reduce((sum, entry) => sum + entry.bytes, reserveBytes)
  let count = entries.length + (reserveBytes > 0 ? 1 : 0)
  for (const entry of entries) {
    if (count <= CACHE_MAX_ENTRIES && total <= CACHE_MAX_BYTES) break
    try { unlinkSync(entry.path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    count -= 1; total -= entry.bytes
  }
}

/** An optional cache must not follow a junction to modify some other directory. */
function assertCachePath(path: string): void {
  let ancestor = resolve(path)
  for (;;) {
    const parent = dirname(ancestor)
    let exists = false
    try {
      lstatSync(ancestor)
      exists = true
      // Windows 的 junction 不被 lstat 报告为符号链接，realpathSync 也不会解析它；
      // 只有 realpathSync.native 给出重解析后的真实路径。普通目录/文件满足
      // native(ancestor) === native(parent)/basename，落到别处即视为链接/junction。
      if (parent !== ancestor) {
        const physical = realpathSync.native(ancestor), expected = join(realpathSync.native(parent), basename(ancestor))
        if (physical.toLowerCase() !== expected.toLowerCase()) throw new Error('缓存路径含符号链接/junction，已停用缓存')
      }
    } catch (error) {
      // 缺失的路径段继续向上找最近的已存在祖先；已存在却无法解析（悬空 junction）
      // 必须 fail closed，不能让缓存穿透到未知目标。
      if (!exists && (error as NodeJS.ErrnoException).code === 'ENOENT') { /* missing segment */ }
      else throw error
    }
    if (parent === ancestor) break
    ancestor = parent
  }
}

function writeCache(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(temporary, 'wx')
  try {
    try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

/** Optional persistent text cache; failures never change the original parser's verdict. */
export function readPdfTextCached(bytes: Uint8Array, options: PdfReadOptions & { cacheDir: string }): CachedPdfText {
  if (bytes.byteLength > PDF_MAX_BYTES) throw new Error(`PDF 超过 ${PDF_MAX_BYTES} 字节读取上限`)
  if (options.pages !== undefined && (!Array.isArray(options.pages) || options.pages.length === 0 || options.pages.length > 100000 || options.pages.some(page => !Number.isSafeInteger(page) || page < 1))) throw new Error('pages 必须是有限的正整数物理页码数组')
  const sourceSha256 = cacheHash(bytes), selection = options.pages ? [...new Set(options.pages)].sort((a, b) => a - b) : null
  const key = cacheHash(JSON.stringify([sourceSha256, PDF_PARSER_VERSION, selection])), path = join(options.cacheDir, `${key}.json`)
  const warnings: string[] = []
  const cache: PdfCacheInfo = { hit: false, path: null, sourceSha256, parserVersion: PDF_PARSER_VERSION, warnings }
  try {
    assertCachePath(path)
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(boundedFile(path, CACHE_MAX_ENTRY_BYTES))) as unknown
    const key = integrityKey(options.cacheDir)
    const parsed = key ? checkedCache(value, sourceSha256, selection, key) : undefined
    if (parsed) return { ...parsed, cache: { ...cache, hit: true, path } }
    warnings.push('PDF 缓存的原件/版本/范围/校验不符，已从原件重解析。')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`PDF 缓存不可用，已从原件重解析：${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = readPdfText(bytes, selection ? { pages: selection } : {})
  // Cache serialization has a strict text/metadata bound before JSON allocation.
  const characters = parsed.pages.reduce((sum, page) => sum + page.text.length, 0) + parsed.limitations.reduce((sum, line) => sum + line.length, 0)
  if (characters > CACHE_MAX_ENTRY_BYTES / 6 || parsed.pages.length > 10000) {
    warnings.push('解析文本超过单条缓存上限，本次仅返回原件解析结果。')
    return { ...parsed, cache }
  }
  try {
    assertCachePath(path)
    mkdirSync(options.cacheDir, { recursive: true })
    const key = integrityKey(options.cacheDir, true) as Buffer
    const payload = { version: 1 as const, parserVersion: PDF_PARSER_VERSION, sourceSha256, selection, payloadSha256: cacheHash(JSON.stringify(parsed)), payload: parsed }
    const entry: CacheEntry = { ...payload, integrityMac: integrityMac(payload, key) }
    const content = `${JSON.stringify(entry)}\n`, length = Buffer.byteLength(content)
    if (length > CACHE_MAX_ENTRY_BYTES) { warnings.push('解析结果超过单条缓存上限，未落盘。'); return { ...parsed, cache } }
    pruneCache(options.cacheDir, length, path)
    writeCache(path, content)
    cache.path = path
  } catch (error) { warnings.push(`PDF 缓存未能落盘：${error instanceof Error ? error.message : String(error)}`) }
  return { ...parsed, cache }
}
