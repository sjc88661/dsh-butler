/** Offline, input-only citation files. Persistence uses the common journal and writer fence. */
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { GuardRefusal } from './guard.ts'
import { commitFiles, readCommittedOperation, readSnapshot, type FileWrite, type OperationMetadata } from './store.ts'
import { sha256, statePath, VAULT_HOME } from './vault.ts'

const MAX_INPUT_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const NOT_REVERIFIED = '仅导出输入资料；本轮未重新验证，未读全文。'
const fields = ['title', 'authors', 'year', 'venue', 'doi', 'arxivId', 'pmid', 'url', 'abstract', 'source', 'sources', 'verified', 'verificationNote'] as const
const locatorFields = ['source', 'url', 'doi', 'arxivId', 'pmid'] as const
type Locator = Partial<Record<typeof locatorFields[number], string>>
interface Citation extends Locator {
  title: string
  authors?: string[]
  year?: number
  venue?: string
  abstract?: string
  sources?: Locator[]
  verified?: 'verified' | 'unconfirmed' | 'conflict'
  verificationNote?: string
}

export interface LiteratureExportResult {
  ok: true
  path: string
  sha256: string
  format: 'ris' | 'bibtex'
  recordCount: number
  byteLength: number
  reused: boolean
  limitations: string[]
  artifacts: Array<{ path: string; sha256: string }>
}

function refuse(code: string, message: string): never { throw new GuardRefusal(`literature.export_${code}`, message) }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const textHash = (text: string): string => sha256(Buffer.from(text, 'utf8'))
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()

function stringField(value: unknown, name: string, maxBytes = 4096): string {
  if (typeof value !== 'string' || !clean(value) || /[\ud800-\udfff]/u.test(value)) refuse('record', `${name} 必须是有效的非空 UTF-8 字符串。`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) refuse('size', `${name} 超过 ${maxBytes} UTF-8 字节上限。`)
  return value
}

function locator(value: unknown, name: string): Locator {
  if (!object(value) || Object.keys(value).some(key => !(locatorFields as readonly string[]).includes(key))) refuse('record', `${name} 必须只含 source/url/doi/arxivId/pmid 字符串。`)
  const copy: Locator = {}
  for (const key of locatorFields) if (value[key] !== undefined) copy[key] = stringField(value[key], `${name}.${key}`)
  if (Object.keys(copy).length === 0) refuse('record', `${name} 至少需要一个来源字段。`)
  return copy
}

/** Validate all records; never filter, deduplicate, enrich or mutate the caller's data. */
function citations(value: unknown): Citation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) refuse('records', 'export 需要 1 到 100 条 records；不会静默删除无效条目。')
  const records = Array.from(value, (row, index): Citation => {
    const name = `records[${index}]`
    if (!object(row) || Object.keys(row).some(key => !(fields as readonly string[]).includes(key))) refuse('record', `${name} 结构无效或含不支持的引用字段。`)
    const copy: Citation = { title: stringField(row['title'], `${name}.title`, 8192) }
    for (const key of ['venue', 'doi', 'arxivId', 'pmid', 'url', 'source', 'verificationNote'] as const) {
      if (row[key] !== undefined) copy[key] = stringField(row[key], `${name}.${key}`)
    }
    if (row['abstract'] !== undefined) copy.abstract = stringField(row['abstract'], `${name}.abstract`, 65536)
    if (row['authors'] !== undefined) {
      if (!Array.isArray(row['authors']) || row['authors'].length > 200) refuse('record', `${name}.authors 必须是至多 200 个姓名字符串。`)
      copy.authors = Array.from(row['authors'], (author, number) => stringField(author, `${name}.authors[${number}]`, 2048))
    }
    if (row['year'] !== undefined) {
      const year = row['year']
      if (typeof year !== 'number' || !Number.isSafeInteger(year) || year < 1 || year > 9999) refuse('record', `${name}.year 必须是 1 到 9999 的整数；不会推断年份。`)
      copy.year = year
    }
    if (row['verified'] !== undefined) {
      if (!['verified', 'unconfirmed', 'conflict'].includes(String(row['verified'])) || typeof row['verified'] !== 'string') refuse('record', `${name}.verified 必须是 verified/unconfirmed/conflict。`)
      copy.verified = row['verified'] as Citation['verified']
    }
    if (row['sources'] !== undefined) {
      if (!Array.isArray(row['sources']) || row['sources'].length > 20) refuse('record', `${name}.sources 必须是至多 20 个来源对象。`)
      copy.sources = Array.from(row['sources'], (source, number) => locator(source, `${name}.sources[${number}]`))
    }
    return copy
  })
  if (Buffer.byteLength(JSON.stringify(records), 'utf8') > MAX_INPUT_BYTES) refuse('size', '引用输入合计超过 1 MiB 上限。')
  return records
}

function notes(record: Citation): string[] {
  const provenance = record.sources?.map(source => Object.fromEntries(Object.entries(source).map(([key, value]) => [key, clean(value)])))
  return [`输入核验状态：${record.verified ?? '未提供'}；${NOT_REVERIFIED}`,
    ...(record.verificationNote ? [`输入核验说明：${clean(record.verificationNote)}`] : []),
    ...(record.arxivId ? [`输入 arXiv ID: ${clean(record.arxivId)}`] : []),
    ...(record.pmid ? [`输入 PMID: ${clean(record.pmid)}`] : []),
    ...(provenance?.length ? [`输入来源 sources: ${JSON.stringify(provenance)}`] : [])]
}

function ris(records: Citation[]): string {
  return records.map(record => {
    const lines: string[] = []
    const add = (tag: string, value: string | undefined) => { if (value !== undefined) lines.push(`${tag}  - ${clean(value)}`) }
    add('TY', 'GEN'); add('TI', record.title)
    for (const author of record.authors ?? []) add('AU', author)
    add('PY', record.year?.toString()); add('T2', record.venue); add('DO', record.doi)
    add('UR', record.url); add('AB', record.abstract); add('DB', record.source)
    for (const note of notes(record)) add('N1', note)
    lines.push('ER  -')
    return lines.join('\n')
  }).join('\n\n') + '\n'
}

/** Escape in one pass so inserted TeX commands cannot be escaped a second time. */
function bibEscape(value: string): string {
  // BibTeX still counts braces after a backslash; commands with balanced {} preserve literal braces safely.
  const escapes: Record<string, string> = { '\\': '\\textbackslash{}', '{': '\\textbraceleft{}', '}': '\\textbraceright{}', '%': '\\%', '$': '\\$', '#': '\\#',
    '_': '\\_', '&': '\\&', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }
  return clean(value).replace(/[\\{}%$#_&~^]/g, char => escapes[char] as string)
}

function bibtex(records: Citation[]): string {
  return records.map((record, index) => {
    const key = `ref_${String(index + 1).padStart(3, '0')}_${textHash(record.title).slice(0, 10)}`
    const lines = [`@misc{${key},`]
    const add = (field: string, value: string | undefined) => { if (value !== undefined) lines.push(`  ${field} = {${bibEscape(value)}},`) }
    add('title', record.title)
    // Each supplied name is one literal name; commas and "and" are not guessed into name parts.
    if (record.authors?.length) lines.push(`  author = {${record.authors.map(author => `{${bibEscape(author)}}`).join(' and ')}},`)
    add('year', record.year?.toString()); add('howpublished', record.venue); add('doi', record.doi)
    add('url', record.url); add('abstract', record.abstract); add('eprint', record.arxivId); add('pmid', record.pmid); add('source', record.source)
    add('note', notes(record).join(' ')); lines.push('}')
    return lines.join('\n')
  }).join('\n\n') + '\n'
}

function limitations(records: Citation[]): string[] {
  const result = [NOT_REVERIFIED, '输入未提供文献类型；RIS 使用 GEN，BibTeX 使用 @misc，不推断同行评审或发表类型。']
  for (const [index, record] of records.entries()) {
    const missing = [!record.authors?.length ? '作者' : '', record.year === undefined ? '年份' : '', !record.venue ? '刊物/venue' : '',
      !record.doi ? 'DOI' : '', !record.arxivId ? 'arXiv ID' : '', !record.pmid ? 'PMID' : '', !record.url ? 'URL' : '', !record.abstract ? '摘要' : '',
      !record.source ? 'source' : '', !record.sources?.length ? 'sources' : '', !record.verified ? '输入核验状态' : '', !record.verificationNote ? '输入核验说明' : ''].filter(Boolean)
    if (missing.length) result.push(`第 ${index + 1} 条缺少：${missing.join('、')}；保留缺项，不补造。`)
  }
  const hasControl = (value: unknown): boolean => typeof value === 'string' ? /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
    : Array.isArray(value) ? value.some(hasControl) : object(value) && Object.values(value).some(hasControl)
  if (records.some(hasControl)) {
    result.push('输出把字段中的换行和控制字符转为空格，防止注入引用记录；原输入未改动。')
  }
  return result
}

function safeSlug(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value)) {
    refuse('slug', 'slug 需要 1 到 80 个 ASCII 字母、数字、下划线或短横线，不能使用路径或 Windows 保留设备名。')
  }
  return value
}

function inside(root: string, path: string): boolean {
  const tail = relative(root, path)
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`))
}

/** The export namespace is narrower than the store's combined vault/state roots. */
function assertExportPath(path: string): void {
  const root = resolve(VAULT_HOME), directory = join(root, 'references')
  if (!inside(root, path) || resolve(path) === root) refuse('path', '引用文件必须位于配置 vault 的 references 目录。')
  for (const [candidate, isDirectory] of [[directory, true], [path, false]] as const) {
    let stat
    try { stat = lstatSync(candidate) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    // Windows junction 的 lstat 不是符号链接，只有 realpathSync.native 会解析它；
    // 用普通 realpathSync 会把 references junction 当成 vault 内的普通目录。
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) || !inside(realpathSync.native(root), realpathSync.native(candidate))) {
      refuse('path', 'references 目录或引用文件含符号链接/junction 或越过配置 vault 边界；未写入。')
    }
    if (!isDirectory && stat.size > MAX_OUTPUT_BYTES) refuse('size', '已有引用文件超过 2 MiB；保留文件，不覆盖。')
  }
}

/** Export actual files without web/model calls; original files and native-call identities are immutable. */
export function exportLiterature(input: { format?: unknown; slug?: unknown; records?: unknown }, operation: OperationMetadata = {}): LiteratureExportResult {
  if (input.format !== 'ris' && input.format !== 'bibtex') refuse('format', 'format 需要 ris 或 bibtex。')
  const format = input.format, slug = safeSlug(input.slug), records = citations(input.records)
  const content = format === 'ris' ? ris(records) : bibtex(records), byteLength = Buffer.byteLength(content, 'utf8')
  if (byteLength > MAX_OUTPUT_BYTES) refuse('size', '引用文件超过 2 MiB 输出上限；未截断或写入。')
  const path = resolve(VAULT_HOME, 'references', `${slug}.${format === 'ris' ? 'ris' : 'bib'}`), hash = textHash(content)
  const requestSha256 = textHash(JSON.stringify({ format, slug, records }))
  assertExportPath(path)
  const previous = operation.operationId === undefined ? undefined : readCommittedOperation(operation.operationId)
  if (previous) {
    const saved = previous.result
    if (previous.kind !== 'literature.export' || previous.targetId !== path || !object(saved) || saved['version'] !== 1
      || saved['requestSha256'] !== requestSha256 || !object(saved['result']) || saved['result']['path'] !== path
      || saved['result']['sha256'] !== hash || saved['result']['format'] !== format || saved['result']['recordCount'] !== records.length) {
      refuse('operation_conflict', '同一原生调用已绑定其他导出请求；不能更换 records、format 或 slug，原产物保留。')
    }
  }
  const current = readSnapshot<string>({ path, format: 'text', fallback: '' })
  assertExportPath(path)
  if ((previous && current.expectedBefore === null) || (current.expectedBefore !== null && current.expectedBefore !== hash)) {
    refuse('conflict', '引用文件已存在且内容不同、被手改或原生重放的文件已删除；保留当前文件，拒绝覆盖或重建。')
  }
  const result: LiteratureExportResult = { ok: true, path, sha256: hash, format, recordCount: records.length, byteLength,
    reused: current.expectedBefore !== null, limitations: limitations(records), artifacts: [{ path, sha256: hash }] }
  if (previous) return result
  if (current.expectedBefore !== null && operation.operationId === undefined) return result
  const operationId = operation.operationId ?? randomUUID()
  // A reuse-only call still needs a durable request binding, while leaving the citation file untouched.
  // This small per-operation receipt uses the existing journal, transaction and cross-process writer lock.
  const receiptPath = statePath('literature-exports', `${textHash(operationId)}.json`)
  const receipt = { version: 1, requestSha256, path, sha256: hash, format, recordCount: records.length }
  const writes: FileWrite[] = current.expectedBefore === null ? [{ path, content, expectedBefore: null, validate: () => { assertExportPath(path); return true } }] : []
  writes.push({ path: receiptPath, content: JSON.stringify(receipt) + '\n', format: 'json', expectedBefore: null,
    validate: () => {
      assertExportPath(path)
      if (current.expectedBefore !== null && readSnapshot<string>({ path, format: 'text', fallback: '' }, { recover: false }).expectedBefore !== hash) refuse('conflict', '复用前引用文件已改变；未改写引用文件。')
      return true
    } })
  const committed = commitFiles({ ...operation, operationId, kind: 'literature.export', targetId: path, writes, result: { version: 1, requestSha256, result } })
  // commitFiles may have observed a concurrently committed replay; never report a swapped result.
  if (committed.requestSha256 !== requestSha256) refuse('operation_conflict', '同一调用已提交不同的导出请求。')
  assertExportPath(path)
  if (readSnapshot<string>({ path, format: 'text', fallback: '' }).expectedBefore !== hash) refuse('conflict', '导出后实际文件 SHA256 不匹配；不能报告成功。')
  return committed.result
}
