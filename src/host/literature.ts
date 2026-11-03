/**
 * Literature lookup against three deterministic sources.
 *
 * The point of using APIs rather than a web search for this is verifiability:
 * Crossref, arXiv and PubMed answer with structured records that either exist or
 * do not, so the butler can say "this paper exists, here is its DOI" instead of
 * "search results suggested". Anything the three cannot confirm is reported as
 * unconfirmed - and the owner's checklist is explicit that a paper's existence
 * must be checked, not assumed.
 *
 * Every function here returns what the API returned. Nothing is embellished, and
 * a provider failure becomes a note rather than an exception, because "检索失败"
 * is a result the owner asked to see.
 *
 * @module @dsh-external/dsh-butler/host/literature
 */
import type { WebFetchResult, WebService } from './ctx.ts'
import { dedupe, normalizeArxivId, normalizeDoi, type LiteratureSource } from './guard.ts'

/** One literature record, with its provenance. */
export interface LiteratureRecord {
  /** Paper title as the provider spells it. */
  title: string
  /** Author names, provider order, family name first where available. */
  authors: string[]
  /** Publication year, when the provider states one. */
  year?: number
  /** Journal, conference, or repository name. */
  venue?: string
  /** DOI, normalised to lowercase without the resolver prefix. */
  doi?: string
  /** Stable arXiv article id (version suffixes remain in the source URL). */
  arxivId?: string
  /** PubMed identifier. */
  pmid?: string
  /** Canonical link the owner can open. */
  url?: string
  /** Abstract, when the provider supplies one. */
  abstract?: string
  /** Which provider produced the record. */
  source: 'crossref' | 'arxiv' | 'pubmed' | 'web'
  /** All provider locators, including copies merged under the same strong ID. */
  sources?: LiteratureSource[]
  /** Verification verdict, filled by {@link verifyRecords}. */
  verified?: 'verified' | 'unconfirmed' | 'conflict'
  /** What verification actually did. */
  verificationNote?: string
}

/** Outcome of one literature search. */
export interface LiteratureSearchResult {
  /** Unique records, in provider order after deduplication. */
  records: LiteratureRecord[]
  /** How many duplicates were removed. */
  duplicatesRemoved: number
  /** Providers that answered, and those that failed. */
  providers: { name: string; ok: boolean; note?: string }[]
  /** Everything that did not go cleanly. */
  limitations: string[]
}

/**
 * Read the text out of whatever shape `web.fetch` answered with.
 *
 * The running host returns `{ statusCode, body: { kind, content } }`; some
 * harness versions and providers answer a flat `{ text }`. Reading only one of
 * them is how the first build reported "empty response" for every provider
 * while the network was in fact fine.
 *
 * @param response - the fetch result.
 * @returns the body text, or an empty string when there is none.
 */
function bodyText(response: WebFetchResult): string {
  const content = response.body?.content
  if (typeof content === 'string') return content
  const inner = response.body?.text
  if (typeof inner === 'string') return inner
  if (typeof response.text === 'string') return response.text
  if (response.body !== undefined) return JSON.stringify(response.body)
  return ''
}

/** The HTTP status out of either shape, for an honest limitation line. */
function statusOf(response: WebFetchResult): number | undefined {
  return response.statusCode ?? response.status
}

/** Ask a provider over HTTP and parse JSON, converting failure into a note. */
async function getJson(
  web: WebService,
  url: string,
  provider: string,
  limitations: string[],
): Promise<unknown | undefined> {
  try {
    const response = await web.fetch({ url })
    const status = statusOf(response)
    if (status !== undefined && (status < 200 || status >= 300)) {
      limitations.push(`${provider} 返回 HTTP ${status}。`)
      return undefined
    }
    const text = bodyText(response)
    if (text.trim() === '') {
      limitations.push(`${provider} 返回了空响应（HTTP ${String(statusOf(response) ?? '?')}）。`)
      return undefined
    }
    return JSON.parse(text) as unknown
  } catch (error) {
    limitations.push(`${provider} 请求失败：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Narrow an unknown to a record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Narrow an unknown to an array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Read a string field, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Crossref date-parts → year. */
function crossrefYear(value: unknown): number | undefined {
  const parts = asRecord(value)?.['date-parts']
  const first = asArray(parts)[0]
  const year = asArray(first)[0]
  return typeof year === 'number' ? year : undefined
}

/** Strip the JATS/HTML tags Crossref puts inside abstracts. */
function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Query Crossref.
 * @param web - the web service.
 * @param query - topic or title text.
 * @param rows - how many records to ask for.
 * @param limitations - collector for anything that went wrong.
 * @param mailto - contact address, which puts the caller in Crossref's polite pool.
 * @returns records, or an empty array on failure.
 */
async function searchCrossref(
  web: WebService,
  query: string,
  rows: number,
  limitations: string[],
  mailto: string,
): Promise<LiteratureRecord[]> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,issued,container-title,abstract,URL,type&mailto=${encodeURIComponent(mailto)}`
  const payload = await getJson(web, url, 'Crossref', limitations)
  const items = asArray(asRecord(asRecord(payload)?.['message'])?.['items'])
  const records: LiteratureRecord[] = []
  for (const item of items) {
    const row = asRecord(item)
    if (row === undefined) continue
    const title = str(asArray(row['title'])[0])
    if (title === undefined) continue
    const authors = asArray(row['author']).flatMap((entry) => {
      const author = asRecord(entry)
      if (author === undefined) return []
      const family = str(author['family'])
      const given = str(author['given'])
      if (family !== undefined && given !== undefined) return [`${family}, ${given}`]
      const name = str(author['name'])
      return name === undefined ? [] : [name]
    })
    const doi = normalizeDoi(str(row['DOI']))
    const abstract = str(row['abstract'])
    records.push({
      title,
      authors,
      ...crossrefYear(row['issued']) === undefined ? {} : { year: crossrefYear(row['issued']) as number },
      ...str(asArray(row['container-title'])[0]) === undefined ? {} : { venue: str(asArray(row['container-title'])[0]) as string },
      ...doi === undefined ? {} : { doi },
      ...str(row['URL']) === undefined ? {} : { url: str(row['URL']) as string },
      ...abstract === undefined ? {} : { abstract: stripTags(abstract) },
      source: 'crossref',
    })
  }
  return records
}

/**
 * Query arXiv's Atom API.
 * @param web - the web service.
 * @param query - topic or title text.
 * @param rows - how many records to ask for.
 * @param limitations - collector for anything that went wrong.
 * @returns records, or an empty array on failure.
 */
async function searchArxiv(
  web: WebService,
  query: string,
  rows: number,
  limitations: string[],
): Promise<LiteratureRecord[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${rows}`
  let xml = ''
  try {
    const response = await web.fetch({ url })
    xml = bodyText(response)
  } catch (error) {
    limitations.push(`arXiv 请求失败：${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const entries = xml.split('<entry>').slice(1)
  if (entries.length === 0) limitations.push('arXiv 没有返回条目（可能没命中，也可能查询语法被拒）。')
  const records: LiteratureRecord[] = []
  for (const entry of entries) {
    const body = entry.split('</entry>')[0] ?? ''
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1]?.replace(/\s+/g, ' ').trim()
    if (title === undefined || title === '') continue
    const authors = [...body.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((match) => match[1]?.trim() ?? '')
    const idRaw = /<id>([\s\S]*?)<\/id>/.exec(body)?.[1]?.trim()
    const doiRaw = /<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/.exec(body)?.[1]?.trim()
    const doi = normalizeDoi(doiRaw)
    const published = /<published>(\d{4})/.exec(body)?.[1]
    const abstract = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.replace(/\s+/g, ' ').trim()
    const arxivId = normalizeArxivId(idRaw)
    records.push({
      title,
      authors,
      ...published === undefined ? {} : { year: Number(published) },
      venue: 'arXiv',
      ...doi === undefined ? {} : { doi },
      ...arxivId === undefined ? {} : { arxivId },
      ...idRaw === undefined ? {} : { url: idRaw },
      ...abstract === undefined ? {} : { abstract },
      source: 'arxiv',
      ...arxivId === undefined ? {} : { verificationNote: `arXiv:${arxivId}` },
    })
  }
  return records
}

/**
 * Query PubMed through E-utilities (search, then summary).
 * @param web - the web service.
 * @param query - topic or title text.
 * @param rows - how many records to ask for.
 * @param limitations - collector for anything that went wrong.
 * @returns records, or an empty array on failure.
 */
async function searchPubmed(
  web: WebService,
  query: string,
  rows: number,
  limitations: string[],
): Promise<LiteratureRecord[]> {
  const search = await getJson(
    web,
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${rows}&term=${encodeURIComponent(query)}`,
    'PubMed esearch',
    limitations,
  )
  const ids = asArray(asRecord(asRecord(search)?.['esearchresult'])?.['idlist']).filter(
    (id): id is string => typeof id === 'string',
  )
  if (ids.length === 0) {
    limitations.push('PubMed 没有命中条目。')
    return []
  }
  const summary = await getJson(
    web,
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`,
    'PubMed esummary',
    limitations,
  )
  const result = asRecord(asRecord(summary)?.['result'])
  if (result === undefined) return []
  const records: LiteratureRecord[] = []
  for (const id of ids) {
    const row = asRecord(result[id])
    if (row === undefined) continue
    const title = str(row['title'])
    if (title === undefined) continue
    const authors = asArray(row['authors']).flatMap((entry) => {
      const name = str(asRecord(entry)?.['name'])
      return name === undefined ? [] : [name]
    })
    const doi = normalizeDoi(
      asArray(row['articleids']).flatMap((entry) => {
        const articleId = asRecord(entry)
        return articleId?.['idtype'] === 'doi' ? [str(articleId['value'])] : []
      }).find((value) => value !== undefined),
    )
    const year = /^(\d{4})/.exec(str(row['pubdate']) ?? '')?.[1]
    records.push({
      title,
      authors,
      ...year === undefined ? {} : { year: Number(year) },
      venue: str(row['fulljournalname']) ?? str(row['source']),
      ...doi === undefined ? {} : { doi },
      pmid: id,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      source: 'pubmed',
    })
  }
  return records
}

/**
 * Search all three providers and deduplicate.
 * @param web - the web service.
 * @param query - topic, title, or author text.
 * @param options - result count and polite-pool contact.
 * @returns unique records plus an honest account of what each provider did.
 */
export async function searchLiterature(
  web: WebService,
  query: string,
  options: { rows?: number; mailto?: string } = {},
): Promise<LiteratureSearchResult> {
  const rows = options.rows ?? 8
  const mailto = options.mailto ?? 'butler@localhost'
  const limitations: string[] = []
  const providers: LiteratureSearchResult['providers'] = []

  const [crossref, arxiv, pubmed] = await Promise.all([
    searchCrossref(web, query, rows, limitations, mailto)
      .then((records) => {
        providers.push({
          name: 'Crossref',
          ok: records.length > 0,
          ...records.length === 0 ? { note: '没有命中或请求失败' } : {},
        })
        return records
      }),
    searchArxiv(web, query, rows, limitations)
      .then((records) => {
        providers.push({
          name: 'arXiv',
          ok: records.length > 0,
          ...records.length === 0 ? { note: '没有命中或请求失败' } : {},
        })
        return records
      }),
    searchPubmed(web, query, rows, limitations)
      .then((records) => {
        providers.push({
          name: 'PubMed',
          ok: records.length > 0,
          ...records.length === 0 ? { note: '没有命中或请求失败' } : {},
        })
        return records
      }),
  ])

  const all = [...crossref, ...arxiv, ...pubmed]
  const unique = dedupe(all)
  // Interleave provider rankings without changing records or their provenance.
  const order = ['crossref', 'pubmed', 'arxiv', 'web'] as const
  const buckets = order.map(source => unique.filter(record => record.source === source))
  const records: LiteratureRecord[] = []
  for (let rank = 0; buckets.some(bucket => rank < bucket.length); rank++) {
    for (const bucket of buckets) if (rank < bucket.length) records.push(bucket[rank]!)
  }
  records.push(...unique.filter(record => !order.some(source => source === record.source)))
  if (all.length === 0) {
    limitations.push('三个文献库都没有返回结果：可能确实没有匹配，也可能是网络或接口被限制。结论请按"未检索到"报告，不要说成"不存在"。')
  }
  return { records, duplicatesRemoved: all.length - records.length, providers, limitations }
}

type VerificationCheck = { state: 'verified' | 'unconfirmed' | 'conflict'; note: string }

/** Decode citation attributes, without treating the document as executable HTML. */
function citationText(text: string): string {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()] as string
    const code = entity.slice(2, -1), number = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity
  }).replace(/\s+/g, ' ').trim()
}

/** arXiv is an HTML record, not JSON; check citation metadata against the requested identity. */
async function verifyArxiv(web: WebService, id: string, title: string): Promise<{ check: VerificationCheck; dois: Set<string> }> {
  const url = `https://arxiv.org/abs/${id}`, dois = new Set<string>()
  const unknown = (note: string) => ({ check: { state: 'unconfirmed' as const, note }, dois })
  try {
    const response = await web.fetch({ url }), status = statusOf(response)
    if (status !== undefined && (status < 200 || status >= 300)) return unknown(`arXiv:${id} 返回 HTTP ${status}，未确认。`)
    if (response.url && !/^https:\/\/arxiv\.org\/abs\//i.test(response.url)) return unknown('arXiv 返回了官方题录以外的地址，未确认。')
    const html = bodyText(response), metadata = new Map<string, string>()
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
      const attributes = new Map([...tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
        .map(match => [match[1]?.toLowerCase() ?? '', citationText(match[3] ?? '')]))
      const name = attributes.get('name')?.toLowerCase(), content = attributes.get('content')
      if (name && content) metadata.set(name, content)
    }
    const returnedId = normalizeArxivId(metadata.get('citation_arxiv_id'))
    const returnedTitle = metadata.get('citation_title')
    if (!returnedId || !returnedTitle) return unknown(`arXiv:${id} 缺少可核对的题录标识或标题，未确认；页面可访问不等于题录已核实。`)
    const similarity = titleSimilarity(returnedTitle, title)
    if (returnedId !== id || similarity < 0.8) return { check: { state: 'conflict',
      note: `arXiv 返回 ${returnedId}「${returnedTitle}」，与请求标识或标题不一致（相似度 ${similarity.toFixed(2)}）。` }, dois }
    const citationDoi = normalizeDoi(metadata.get('citation_doi'))
    if (citationDoi) dois.add(citationDoi)
    for (const link of html.matchAll(/\bhref\s*=\s*(["'])(https?:\/\/(?:dx\.)?doi\.org\/[^"']+)\1/gi)) {
      const doi = normalizeDoi(citationText(link[2] ?? '')); if (doi) dois.add(doi)
    }
    return { check: { state: 'verified', note: `arXiv:${id} 官方题录确认标识和标题一致（相似度 ${similarity.toFixed(2)}）；本次核对题录，未读全文。` }, dois }
  } catch (error) { return unknown(`arXiv:${id} 核实失败：${error instanceof Error ? error.message : String(error)}`) }
}

/**
 * Verify that a record exists, by checking its strong identifiers and title.
 *
 * A DOI that resolves through Crossref, or an arXiv/PubMed id that answers, is
 * existence evidence. A record whose provider disagrees with the claim gets
 * `conflict`; one nothing would confirm gets `unconfirmed`. The owner asked for
 * exactly this distinction, so it is a field, not a sentence in a summary.
 * @param web - the web service.
 * @param records - records to check.
 * @param mailto - polite-pool contact.
 * @returns the same records with `verified` and `verificationNote` filled in.
 */
export async function verifyRecords(
  web: WebService,
  records: LiteratureRecord[],
  mailto = 'butler@localhost',
): Promise<LiteratureRecord[]> {
  const out: LiteratureRecord[] = []
  for (const record of records) {
    const dois = new Set<string>(), ids = new Set<string>(), pmids = new Set<string>()
    for (const locator of [record, ...(record.sources ?? [])]) {
      const directDoi = normalizeDoi(locator.doi)
      const urlDoi = /^https?:\/\/(?:dx\.)?doi\.org\//i.test(locator.url ?? '') ? normalizeDoi(locator.url) : undefined
      for (const candidate of [directDoi, urlDoi]) if (candidate) {
        dois.add(candidate)
        if (candidate.startsWith('10.48550/arxiv.')) {
          const id = normalizeArxivId(candidate.slice('10.48550/arxiv.'.length)); if (id) ids.add(id)
        }
      }
      for (const id of [normalizeArxivId(locator.arxivId), normalizeArxivId(locator.url)]) if (id) ids.add(id)
      const directPmid = /^\d+$/.test(locator.pmid ?? '') ? locator.pmid : undefined
      const urlPmid = /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)(?:\/|$)/i.exec(locator.url ?? '')?.[1]
      for (const pmid of [directPmid, urlPmid]) if (pmid) pmids.add(pmid)
    }
    if (dois.size > 1 || ids.size > 1 || pmids.size > 1) {
      out.push({ ...record, verified: 'conflict', verificationNote: 'DOI、arXiv、PMID 标识或来源地址存在同类标识冲突，保留冲突，核对后再引用。' })
      continue
    }
    const doi = [...dois][0]
    const doiArxiv = doi?.startsWith('10.48550/arxiv.') ? normalizeArxivId(doi.slice('10.48550/arxiv.'.length)) : undefined
    const checks: VerificationCheck[] = [], arxivId = [...ids][0]
    let doiCheck: VerificationCheck | undefined
    // arXiv-issued DOIs are registered via DataCite. Its own official record
    // can prove the DOI link; querying Crossref for these creates false misses.
    if (doi !== undefined && doiArxiv === undefined) {
      const payload = await getJson(
        web,
        `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`,
        'Crossref 核实',
        [],
      )
      const message = asRecord(asRecord(payload)?.['message'])
      if (message === undefined) {
        doiCheck = { state: 'unconfirmed', note: `DOI ${doi} 未从 Crossref 确认（不代表论文不存在）。` }
      } else {
        const confirmedTitle = str(asArray(message['title'])[0]), returnedDoi = normalizeDoi(str(message['DOI']))
        const similarity = titleSimilarity(confirmedTitle ?? '', record.title)
        doiCheck = !returnedDoi || !confirmedTitle ? { state: 'unconfirmed', note: 'Crossref 缺少返回 DOI 或标题，未确认。' }
          : returnedDoi !== doi || similarity < 0.8
            ? { state: 'conflict', note: `Crossref 返回 DOI ${returnedDoi}「${confirmedTitle}」，与请求标识或标题不一致（相似度 ${similarity.toFixed(2)}）。` }
            : { state: 'verified', note: `Crossref 确认 DOI ${doi} 与标题一致（相似度 ${similarity.toFixed(2)}）。${/\.s\d{3}$/i.test(doi) ? '这是补充材料页，不是正文。' : ''}` }
      }
    }
    if (arxivId) {
      const arxiv = await verifyArxiv(web, arxivId, record.title)
      checks.push(arxiv.check)
      if (doi && doiCheck?.state !== 'conflict' && arxiv.check.state === 'verified' && arxiv.dois.has(doi)) {
        doiCheck = { state: 'verified', note: `${doiCheck ? doiCheck.note + ' ' : ''}arXiv 官方题录提供匹配 DOI ${doi}。` }
      } else if (doiArxiv) doiCheck = { state: 'unconfirmed', note: `arXiv-issued DOI ${doi} 尚无匹配的官方题录链接回执。` }
    }
    if (doiCheck) checks.push(doiCheck)
    const pmid = [...pmids][0]
    if (pmid) {
      const payload = await getJson(web, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}`, 'PubMed 核实', [])
      const item = asRecord(asRecord(asRecord(payload)?.['result'])?.[pmid])
      const name = str(item?.['title']), uid = str(item?.['uid'])
      checks.push(!name || !uid ? { state: 'unconfirmed', note: `PMID ${pmid} 缺少可核对的 PubMed 标识或标题。` }
        : { state: uid === pmid && titleSimilarity(name, record.title) >= 0.8 ? 'verified' : 'conflict', note: `PubMed 返回 PMID ${uid}「${name}」，已核对标识与标题。` })
    }
    out.push({ ...record, verified: checks.some(check => check.state === 'conflict') ? 'conflict'
      : checks.length > 0 && checks.every(check => check.state === 'verified') ? 'verified' : 'unconfirmed',
      verificationNote: checks.map(check => check.note).join(' ') || '没有可核实的标识符（DOI/arXiv/PMID），只能按检索结果原样保留。' })
  }
  return out
}

/**
 * Cheap title similarity: token overlap after normalisation.
 * @param a - one title.
 * @param b - another title.
 * @returns overlap ratio in `[0, 1]`.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokens = (text: string): Set<string> =>
    new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((token) => token.length > 2))
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / Math.max(left.size, right.size)
}
