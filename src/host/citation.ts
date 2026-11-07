/**
 * 文献引用与"按页笔记"草稿。
 *
 * 目标是把"读全文"变成可回溯的笔记：每一段都标着 PDF 物理页，来源行带
 * DOI/URL 与原件路径；引用导出提供 BibTeX/RIS 两种最常见格式。这里只做格式
 * 转换，不判断文献质量，也不替代人工核对（页码以 PDF 物理页为准）。
 *
 * @module @dsh-external/dsh-butler/host/citation
 */

/** 一篇文献的元数据；字段都可缺省，缺了什么就不编造什么。 */
export interface PaperCitation {
  title?: string
  authors?: string[]
  year?: string | number
  journal?: string
  doi?: string
  url?: string
  /** YYYY-MM-DD; the day the reader extracted the note. */
  accessed?: string
}

/** 一页被读到的内容。 */
export interface CitedPage {
  page: number
  text: string
  status?: string
}

/** 生成笔记草稿的输入。 */
export interface NoteDraftInput {
  title: string
  citation?: PaperCitation
  pages: CitedPage[]
  /** Original path or URL the text came from. */
  origin: string
  sha256?: string
  /** Saved original path, when the host stored a copy. */
  storedPath?: string
  /** Total declared pages, to state how much was actually read. */
  declaredPages?: number
  /** YYYY-MM-DD in the owner's zone; defaults to today. */
  date?: string
}

/** Escape a BibTeX field value. */
function bib(value: string): string {
  return value.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim()
}

/** Build a stable-ish citation key from author/year/title. */
export function citationKey(citation: PaperCitation, fallback = 'paper'): string {
  const firstAuthor = citation.authors?.find(author => author.trim() !== '')?.trim().split(/[\s,]+/).at(-1) ?? ''
  const year = citation.year === undefined ? '' : String(citation.year).replace(/\D/g, '')
  const titleWord = (citation.title ?? '').replace(/[^A-Za-z\u4e00-\u9fa5]/g, ' ').trim().split(/\s+/)[0] ?? ''
  const key = `${firstAuthor || fallback}${year}${titleWord}`.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '')
  return key === '' ? fallback : key.slice(0, 40)
}

/**
 * Format one BibTeX entry.
 * @param citation - known metadata; missing fields are omitted, never invented.
 * @returns a `@article`/`@misc` entry (article when a journal exists).
 */
export function formatBibtex(citation: PaperCitation): string {
  const key = citationKey(citation)
  const kind = citation.journal === undefined || citation.journal.trim() === '' ? 'misc' : 'article'
  const fields: Array<[string, string]> = []
  if (citation.title !== undefined && citation.title.trim() !== '') fields.push(['title', bib(citation.title)])
  if (citation.authors !== undefined && citation.authors.length > 0) fields.push(['author', citation.authors.map(bib).filter(Boolean).join(' and ')])
  if (citation.year !== undefined) fields.push(['year', String(citation.year).replace(/\D/g, '')])
  if (citation.journal !== undefined && citation.journal.trim() !== '') fields.push(['journal', bib(citation.journal)])
  if (citation.doi !== undefined && citation.doi.trim() !== '') fields.push(['doi', bib(citation.doi)])
  if (citation.url !== undefined && citation.url.trim() !== '') fields.push(['url', bib(citation.url)])
  if (citation.accessed !== undefined && citation.accessed.trim() !== '') fields.push(['urldate', bib(citation.accessed)])
  return `@${kind}{${key},\n${fields.map(([name, value]) => `  ${name} = {${value}}`).join(',\n')}\n}\n`
}

/** Format one RIS entry (TY/J1/T1/AU/PY/DO/UR). */
export function formatRis(citation: PaperCitation): string {
  const lines: string[] = [citation.journal === undefined || citation.journal.trim() === '' ? 'TY  - GEN' : 'TY  - JOUR']
  if (citation.title !== undefined && citation.title.trim() !== '') lines.push(`T1  - ${bib(citation.title)}`)
  for (const author of citation.authors ?? []) if (author.trim() !== '') lines.push(`AU  - ${bib(author)}`)
  if (citation.year !== undefined) lines.push(`PY  - ${String(citation.year).replace(/\D/g, '')}`)
  if (citation.journal !== undefined && citation.journal.trim() !== '') lines.push(`JO  - ${bib(citation.journal)}`)
  if (citation.doi !== undefined && citation.doi.trim() !== '') lines.push(`DO  - ${bib(citation.doi)}`)
  if (citation.url !== undefined && citation.url.trim() !== '') lines.push(`UR  - ${bib(citation.url)}`)
  if (citation.accessed !== undefined && citation.accessed.trim() !== '') lines.push(`Y2  - ${bib(citation.accessed)}`)
  lines.push('ER  - ')
  return `${lines.join('\n')}\n`
}

/** One-line human citation, used at the top of the note. */
export function formatPlainCitation(citation: PaperCitation): string {
  const parts: string[] = []
  if (citation.authors !== undefined && citation.authors.length > 0) parts.push(citation.authors.join('、'))
  const year = citation.year === undefined ? '' : `(${citation.year})`
  const title = citation.title === undefined ? '（未命名文献）' : bib(citation.title)
  parts.push(`${title}${year === '' ? '' : ` ${year}`}`)
  if (citation.journal !== undefined && citation.journal.trim() !== '') parts.push(bib(citation.journal))
  if (citation.doi !== undefined && citation.doi.trim() !== '') parts.push(`doi:${citation.doi}`)
  if (citation.url !== undefined && citation.url.trim() !== '') parts.push(citation.url)
  return parts.join(' · ')
}

/** The date a draft was made, for provenance lines. */
function draftDate(input: NoteDraftInput): string {
  if (input.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) return input.date
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Build a page-anchored markdown note draft.
 *
 * The agent can hand this to `butler_note write` unchanged (or refine the prose);
 * every excerpt keeps its physical page number, and the header keeps the original
 * path/URL, hash and how much of the document was actually read.
 * @param input - citation, pages actually read and provenance.
 * @returns markdown with a citation header, per-page sections and honest limits.
 */
export function noteDraft(input: NoteDraftInput): string {
  const lines: string[] = [`# ${input.title.trim() === '' ? '文献笔记' : input.title.trim()}`, '']
  if (input.citation !== undefined) lines.push(`> 引用：${formatPlainCitation(input.citation)}`, '')
  const originLine = input.storedPath === undefined ? `> 原件：${input.origin}` : `> 原件：${input.storedPath}（来源 ${input.origin}）`
  lines.push(originLine)
  if (input.sha256 !== undefined) lines.push(`> SHA256：${input.sha256}`)
  const read = input.pages.length
  const declared = input.declaredPages === undefined ? read : input.declaredPages
  lines.push(`> 本次读取：${read}/${declared} 页（页码为 PDF 物理页；图表/公式可能不在文本层）`)
  lines.push(`> 摘录日期：${draftDate(input)}`, '')
  if (input.citation?.doi !== undefined || input.citation?.url !== undefined) {
    lines.push('## 引用信息', '')
    if (input.citation.doi !== undefined) lines.push(`- DOI：${input.citation.doi}`)
    if (input.citation.url !== undefined) lines.push(`- 链接：${input.citation.url}`)
    lines.push('', '```bibtex', formatBibtex(input.citation).trimEnd(), '```', '')
  }
  for (const page of input.pages) {
    lines.push(`## p.${page.page}`, '')
    const text = page.text.trim()
    lines.push(text === '' ? '（本页文本层为空）' : text, '')
  }
  lines.push('---', '> 以上为文本层抽取与整理，引用前请核对原文；页码以 PDF 物理页为准。', '')
  return lines.join('\n')
}
