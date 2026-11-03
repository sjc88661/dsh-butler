/**
 * The evidence guard: the part of the butler that says no.
 *
 * The owner's checklist asks for claims that are checkable - "区分读过摘要与读过全文",
 * "未获取全文时不声称已读", "搜索失败或来源矛盾时明确说明". A prompt cannot
 * guarantee any of that, because a prompt is advice. These are checks that run
 * inside the tool that would otherwise write the claim, and they refuse the
 * write. The butler can still be wrong about the world; it cannot quietly be
 * wrong about its own receipts.
 *
 * @module @dsh-external/dsh-butler/host/guard
 */

/** A refusal with a reason the model can act on. */
export class GuardRefusal extends Error {
  /** Machine-readable code, stable for tests and for the UI. */
  readonly code: string

  /**
   * @param code - stable code such as `evidence.missing_url`.
   * @param message - what is wrong and what to do instead.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GuardRefusal'
    this.code = code
  }
}

/** Loose shape of an evidence object crossing the tool boundary. */
export interface EvidenceInput {
  source_url?: unknown
  source_type?: unknown
  retrieved_at?: unknown
  verified_by?: unknown
  read_level?: unknown
  sha256?: unknown
  anchors?: unknown
}

const SOURCE_TYPES = ['journal', 'preprint', 'web', 'file', 'book', 'other'] as const
const READ_LEVELS = ['abstract', 'fulltext'] as const

/** Today's date in the given zone, `YYYY-MM-DD`. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/**
 * Validate one evidence record, or refuse.
 *
 * Rules, in order of what actually goes wrong:
 *  1. A claim needs a locator. "Some paper says so" is not a source.
 *  2. `read_level` must be stated and must be one of two values. Absent means
 *     unstated, and unstated is not allowed to become "fulltext" downstream.
 *  3. Raw model fields never prove fulltext: only EvidenceStore can issue
 *     verified records after observing a real result and checking its original.
 *  4. `retrieved_at` is stamped if missing, because "when did you look" is the
 *     first thing that goes stale.
 * @param input - the candidate evidence.
 * @param timeZone - zone used for the retrieval stamp.
 * @param anchors - page/section anchors the caller extracted from the document.
 * @returns the validated evidence.
 * @throws GuardRefusal when the record cannot support its own claim.
 */
export function validateEvidence(
  input: EvidenceInput,
  timeZone: string,
  anchors: string[] = [],
): Required<Pick<EvidenceInput, 'source_url' | 'source_type' | 'retrieved_at' | 'verified_by' | 'read_level'>> & { sha256?: string; anchors: string[] } {
  const url = typeof input.source_url === 'string' ? input.source_url.trim() : ''
  if (url === '') {
    throw new GuardRefusal(
      'evidence.missing_url',
      '证据缺少 source_url：必须给出可打开的出处（DOI 链接、页面 URL 或落盘文件路径），否则这条不能写入。',
    )
  }
  if (!/^(https?:\/\/|doi:|file:|[A-Za-z]:\\|\/)/.test(url)) {
    throw new GuardRefusal(
      'evidence.bad_url',
      `证据的 source_url 不是可定位的地址："${url}"。请给 DOI 链接、http(s) URL，或本机文件的绝对路径。`,
    )
  }

  const type = typeof input.source_type === 'string' ? input.source_type : ''
  if (!(SOURCE_TYPES as readonly string[]).includes(type)) {
    throw new GuardRefusal(
      'evidence.bad_type',
      `source_type 必须是 ${SOURCE_TYPES.join(' / ')} 之一（收到 "${type}"）。`,
    )
  }

  const level = typeof input.read_level === 'string' ? input.read_level : ''
  if (!(READ_LEVELS as readonly string[]).includes(level)) {
    throw new GuardRefusal(
      'evidence.no_read_level',
      'read_level 必须显式声明为 abstract 或 fulltext：读过摘要就说 abstract，别默认成全文。',
    )
  }

  const sha = typeof input.sha256 === 'string' && input.sha256.trim() !== '' ? input.sha256.trim() : undefined
  if (level === 'fulltext') {
    throw new GuardRefusal(
      'evidence.fulltext_unproven',
      '模型填写的 sha256、verified_by 或锚点不能证明读过全文。请先通过真实工具读取并由宿主登记 evidenceId，完成时引用该 ID。',
    )
  }
  if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) {
    throw new GuardRefusal('evidence.bad_sha', `sha256 必须是 64 位小写十六进制（收到 ${sha.length} 位）。`)
  }

  const retrievedAt = typeof input.retrieved_at === 'string' && input.retrieved_at.trim() !== ''
    ? input.retrieved_at.trim()
    : todayIn(timeZone)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt)) {
    throw new GuardRefusal('evidence.bad_date', `retrieved_at 必须是 YYYY-MM-DD（收到 "${retrievedAt}"）。`)
  }

  const storedAnchors = [...new Set([...anchors, ...(Array.isArray(input.anchors) ? input.anchors : [])])]
    .filter((anchor): anchor is string => typeof anchor === 'string' && anchor.trim() !== '').map(anchor => anchor.trim())

  return {
    source_url: url,
    source_type: type,
    retrieved_at: retrievedAt,
    verified_by: 'unverified',
    read_level: level,
    anchors: storedAnchors,
    ...(sha === undefined ? {} : { sha256: sha }),
  }
}

/** Words that name a time span rather than a moment. */
const VAGUE_TIME_PATTERNS: Array<{ pattern: RegExp; ask: string }> = [
  { pattern: /周末/, ask: '“周末”指周六还是周日？几点？' },
  { pattern: /这周|本周|周内/, ask: '“这周”指哪一天？几点？' },
  { pattern: /下周/, ask: '“下周”指周几？几点？' },
  { pattern: /月底|月末/, ask: '“月底”指哪一天？几点？' },
  { pattern: /过几天|过阵子|回头|晚点|有空/, ask: '具体哪天几点？' },
  { pattern: /早上|上午/, ask: '“早上”指几点？' },
  { pattern: /中午/, ask: '“中午”指几点？' },
  { pattern: /下午/, ask: '“下午”指几点？' },
  { pattern: /晚上|傍晚|夜里|今晚/, ask: '“晚上”指几点？' },
  { pattern: /明天|后天|明天早上/, ask: '具体几点？' },
]

/**
 * Detect a reminder time that is not actually a time.
 *
 * The owner's requirement is explicit: "时间不明确时保持待定并询问", and the
 * worked example is "周末" - a word that names two different days. So a reminder
 * carrying only a vague phrase is refused and the question to ask is returned
 * with it, rather than the butler picking an hour on the owner's behalf.
 * @param text - the user's phrasing.
 * @param resolvedAt - the concrete instant the caller intends to use, if any.
 * @returns undefined when the time is concrete, otherwise the question to ask.
 */
export function clarifyTime(text: string, resolvedAt?: string): string | undefined {
  const hasConcrete = resolvedAt !== undefined && resolvedAt.trim() !== '' && !Number.isNaN(Date.parse(resolvedAt))
  if (hasConcrete) return undefined
  for (const { pattern, ask } of VAGUE_TIME_PATTERNS) {
    if (pattern.test(text)) return ask
  }
  if (text.trim() === '') return '什么时候提醒你？给个具体日期和时间。'
  return undefined
}

/**
 * Normalise a DOI for deduplication: strip the resolver prefix, lowercase.
 * @param doi - raw DOI or DOI URL.
 * @returns the normalised key, or undefined when the input holds no DOI.
 */
export function normalizeDoi(doi: string | undefined): string | undefined {
  if (doi === undefined) return undefined
  let value = doi.trim()
  const wrappers: Record<string, string> = { '(': ')', '[': ']', '<': '>', '"': '"', "'": "'", '`': '`' }
  // Only remove explicit outer wrappers. SICI DOIs contain meaningful <>,
  // parentheses and semicolons; even trailing punctuation can belong to an ID.
  for (let depth = 0; depth < 8; depth += 1) {
    const previous = value
    value = value.replace(/^doi:\s*/i, '').trim()
    if (value.length > 1 && wrappers[value[0]] === value.at(-1)) value = value.slice(1, -1).trim()
    if (value === previous) break
  }
  const resolver = /^https?:\/\/(?:dx\.)?doi\.org\//i.exec(value)
  if (resolver) {
    // Decode the resolver's path once; do not URL-normalize an opaque suffix
    // (or decode a raw DOI's literal percent signs).
    try { value = decodeURIComponent(value.slice(resolver[0].length).split(/[?#]/, 1)[0]) } catch { return undefined }
  }
  return /^10\.\d{4,9}\/[^\s\x00-\x1f\x7f]+$/.test(value) ? value.toLowerCase() : undefined
}

/**
 * Normalise a title for deduplication: lowercase, strip punctuation and space.
 * @param title - raw title.
 * @returns the comparison key.
 */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** A provider locator retained when copies of a paper are combined. */
export interface LiteratureSource {
  source?: string
  url?: string
  doi?: string
  arxivId?: string
  pmid?: string
}
interface LiteratureIdentity extends LiteratureSource {
  title?: string
  authors?: string[]
  year?: number
  sources?: LiteratureSource[]
}

/** arXiv versions identify one article; differing article identifiers do not. */
export function normalizeArxivId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const id = value.trim().replace(/^arxiv:/i, '').replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/[?#].*$/, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase()
  return /^(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]*\/\d{7})$/.test(id) ? id : undefined
}

function locators(row: LiteratureIdentity): LiteratureSource[] {
  const own: LiteratureSource = {}
  for (const key of ['source', 'url', 'doi', 'arxivId', 'pmid'] as const) if (row[key] !== undefined) own[key] = row[key]
  return [...new Map([...(row.sources ?? []), ...(Object.keys(own).length ? [own] : [])]
    .map(source => [JSON.stringify(source), { ...source }])).values()]
}

function strongIds(row: LiteratureIdentity): Record<'doi' | 'arxivId' | 'pmid', Set<string>> {
  const ids = { doi: new Set<string>(), arxivId: new Set<string>(), pmid: new Set<string>() }
  for (const source of [row, ...(row.sources ?? [])]) {
    const doi = normalizeDoi(source.doi), urlDoi = /^https?:\/\/(?:dx\.)?doi\.org\//i.test(source.url ?? '') ? normalizeDoi(source.url) : undefined
    const arxiv = normalizeArxivId(source.arxivId), urlArxiv = normalizeArxivId(source.url)
    const pmid = /^\d+$/.test(source.pmid ?? '') ? source.pmid : undefined
    const urlPmid = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)(?:\/|$)/i.exec(source.url ?? '')?.[1]
    for (const value of [doi, urlDoi]) if (value) ids.doi.add(value)
    for (const value of [arxiv, urlArxiv]) if (value) ids.arxivId.add(value)
    for (const value of [pmid, urlPmid]) if (value) ids.pmid.add(value)
  }
  return ids
}

function sameWork(left: LiteratureIdentity, right: LiteratureIdentity): boolean {
  const a = strongIds(left), b = strongIds(right)
  let shared = false, identified = false
  for (const key of ['doi', 'arxivId', 'pmid'] as const) {
    // Conflicting strong identifiers, including conflicts within a single row,
    // are evidence to keep both records, never a reason to delete one by title.
    if (a[key].size > 1 || b[key].size > 1) return false
    if (a[key].size || b[key].size) identified = true
    if (a[key].size && b[key].size) {
      if ([...a[key]][0] !== [...b[key]][0]) return false
      shared = true
    }
  }
  if (identified) return shared
  const title = normalizeTitle(left.title ?? '')
  if (!title || title !== normalizeTitle(right.title ?? '')) return false
  if (left.year !== undefined && right.year !== undefined && left.year !== right.year) return false
  const author = normalizeTitle(left.authors?.[0] ?? ''), otherAuthor = normalizeTitle(right.authors?.[0] ?? '')
  return !author || !otherAuthor || author === otherAuthor
}

/** Strong IDs take precedence; unidentified records require a matching title. */
export function dedupe<T extends LiteratureIdentity>(rows: T[]): T[] {
  const out: T[] = []
  for (const row of rows) {
    const index = out.findIndex(previous => sameWork(previous, row))
    if (index < 0) { out.push({ ...row, sources: locators(row) }); continue }
    const previous = out[index]
    // The first provider remains the primary evidence locator. Other providers
    // and identifiers remain available under sources rather than disappearing.
    const merged = { ...row, ...previous, sources: locators({ ...previous, sources: [...locators(previous), ...locators(row)] }) }
    for (const key of ['doi', 'arxivId', 'pmid', 'url'] as const) if (previous[key] === undefined && row[key] !== undefined) merged[key] = row[key]
    out[index] = merged
  }
  return out
}

/**
 * Refuse a claim that no search actually supported.
 * @param claims - findings the model wants to state.
 * @param toolCalls - tools that produced evidence this turn.
 * @throws GuardRefusal when a claim has no supporting call.
 */
export function requireEvidenceForClaims(claims: string[], toolCalls: string[]): void {
  if (claims.length === 0) return
  if (toolCalls.length > 0) return
  throw new GuardRefusal(
    'claims.without_tools',
    '这一步没有任何工具结果，却要写入结论。先跑检索/核实工具，或者把结论写成"未核实"。',
  )
}

/**
 * Format the mandatory limitations paragraph.
 *
 * The owner's checklist wants failure and contradiction stated, not smoothed
 * over. Making this a required section in the written output means an empty
 * limitations list is a visible defect rather than a silent omission.
 * @param limitations - what did not work or does not agree.
 * @returns the markdown section, or a line saying there were none.
 */
export function limitationsSection(limitations: string[]): string {
  if (limitations.length === 0) return '## 限制与冲突\n\n- 本次没有发现失败或来源冲突。\n'
  return `## 限制与冲突\n\n${limitations.map((line) => `- ${line}`).join('\n')}\n`
}
