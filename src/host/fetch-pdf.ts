/**
 * 从 URL 抓取 PDF 全文（开放获取场景）。
 *
 * 只做"用户/agent 已经拿到的公开链接"这一件事：不登录、不带 cookie、不绕过
 * 付费墙。落地页面、登录页、非 PDF 内容都会被明确拒绝，而不是存成坏文件再
 * 假装读过。私有/回环地址默认拒绝（避免把内网当文献源）；测试用
 * `DSH_BUTLER_ALLOW_PRIVATE_FETCH=1` 或显式 `allowPrivate` 打开。
 *
 * @module @dsh-external/dsh-butler/host/fetch-pdf
 */

/** Limits are intentionally small: a paper is rarely over 30MB. */
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/** What one successful fetch produced. */
export interface FetchedPdf {
  bytes: Uint8Array
  /** Final URL after redirects. */
  finalUrl: string
  /** Safe file name derived from the URL, always ending in `.pdf`. */
  filename: string
  contentType?: string
}

/** Injectable knobs for tests. */
export interface FetchPdfOptions {
  maxBytes?: number
  timeoutMs?: number
  allowPrivate?: boolean
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/** Whether a hostname points at the local machine or a private network. */
export function privateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }
  return false
}

/** Turn a URL into a safe `*.pdf` file name. */
export function pdfFilename(url: string): string {
  let path = '/'
  try { path = new URL(url).pathname } catch { /* caller validated the URL already */ }
  const last = path.split('/').filter(Boolean).at(-1) ?? 'document.pdf'
  let name = last
  try { name = decodeURIComponent(last) } catch { /* keep the raw segment */ }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  if (name === '' || name === '.' || name === '..') name = 'document.pdf'
  if (!/\.pdf$/i.test(name)) name = `${name}.pdf`
  return name.slice(0, 160)
}

/** Whether the payload looks like a PDF, by content type or magic bytes. */
export function looksLikePdf(bytes: Uint8Array, contentType: string | undefined): boolean {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return true
  return contentType !== undefined && contentType.toLowerCase().includes('application/pdf')
}

/**
 * Fetch one public PDF.
 * @param url - absolute http(s) URL.
 * @param options - limits and test seams.
 * @returns the bytes plus the final URL and a safe file name.
 * @throws Error with a human-readable reason on any refusal/failure.
 */
export async function fetchPdfBytes(url: string, options: FetchPdfOptions = {}): Promise<FetchedPdf> {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('链接不是有效的绝对 URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http/https 链接')
  const allowPrivate = options.allowPrivate === true || process.env.DSH_BUTLER_ALLOW_PRIVATE_FETCH === '1'
  if (!allowPrivate && privateAddress(parsed.hostname)) throw new Error('拒绝访问本机/内网地址；这通常不是公开文献链接')
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const impl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), maxTimeout)
  timer.unref?.()
  try {
    let response: Response
    try {
      response = await impl(parsed.href, { signal: controller.signal, redirect: 'follow', headers: { accept: 'application/pdf,*/*;q=0.5' } })
    } catch (error) {
      throw new Error(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`文件过大（${declared} 字节，上限 ${maxBytes}）`)
    let buffer: ArrayBuffer
    try { buffer = await response.arrayBuffer() } catch (error) {
      throw new Error(`读取响应失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const bytes = new Uint8Array(buffer)
    if (bytes.byteLength > maxBytes) throw new Error(`文件过大（${bytes.byteLength} 字节，上限 ${maxBytes}）`)
    const contentType = response.headers.get('content-type') ?? undefined
    if (!looksLikePdf(bytes, contentType)) {
      throw new Error(`这个链接返回的不是 PDF（${contentType ?? '未知类型'}）；可能是落地页/登录页或付费墙，不会假装拿到全文`)
    }
    return { bytes, finalUrl: response.url === '' ? parsed.href : response.url, filename: pdfFilename(response.url === '' ? parsed.href : response.url), ...(contentType === undefined ? {} : { contentType }) }
  } finally {
    clearTimeout(timer)
  }
}
