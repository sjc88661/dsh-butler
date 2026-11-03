/** Host-only evidence issuance. Tool arguments must never call this API directly. */
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { executionKey, type ExecutionIdentity } from './execution-context.ts'
import { GuardRefusal } from './guard.ts'
import { pageAnchors, readPdfText, type PdfPage, type PdfText } from './pdf.ts'
import { commitFiles, readSnapshot, readState } from './store.ts'
import { sha256, statePath } from './vault.ts'

export interface RegisteredEvidence {
  evidenceId: string
  taskId: string
  kind: 'file' | 'source' | 'receipt'
  source_url: string
  source_type: 'journal' | 'preprint' | 'web' | 'file' | 'book' | 'other'
  retrieved_at: string
  verified_by: string
  read_level: 'abstract' | 'fulltext'
  sha256?: string
  anchors: string[]
  summary: string
  provenance: EvidenceProvenance
}
/** Enough to find the native receipt without copying tool arguments or output. */
export interface EvidenceProvenance {
  tool: string
  sessionId: string
  rootSessionId?: string
  runId?: string
  originMessageId?: string
  turn?: number
  step?: number
  callId: string
  executionKeyHash: string
  at: string
  timeSource: 'native-receipt' | 'host-observation'
  parserVersion: string
}
export interface EvidenceIdentity extends ExecutionIdentity { at?: string }
export interface EvidenceStoreOptions {
  /** Read saved evidence without replaying pending state transactions. */
  recover?: boolean
  file?: string
  identity?: EvidenceIdentity | (() => EvidenceIdentity | undefined)
}
export interface FileEvidenceInput {
  path: string
  sourceUrl?: string
  sourceType?: RegisteredEvidence['source_type']
  anchors?: string[]
  readLevel?: 'abstract' | 'fulltext'
  returnedText?: string
  returnedPages?: Array<Pick<PdfPage, 'page' | 'text'>>
  /** The parsed pages that were actually included in the tool response. */
  pdf?: PdfText
}
export interface SourceEvidenceInput {
  sourceUrl: string
  sourceType?: RegisteredEvidence['source_type']
  readLevel?: 'abstract'
  anchors?: string[]
  returnedText: string
}
export interface ReceiptEvidenceInput { tool: string; ok: boolean; summary?: string }
type Status = 'pending' | 'confirmed' | 'rejected'
interface Candidate extends Omit<RegisteredEvidence, 'evidenceId' | 'taskId' | 'retrieved_at' | 'verified_by' | 'provenance'> {
  slot: string
  filePath?: string
  contentSha256?: string
  returnedPages?: number[]
  proof?: 'text' | 'pdf'
}
interface Stored extends RegisteredEvidence {
  status: Status
  execution: string
  filePath?: string
  contentSha256?: string
  returnedPages?: number[]
  proof?: 'text' | 'pdf'
}
interface Issuance { tool: string; taskId: string; status: Status; ids: string[] }
interface EvidenceFile { version: 1; records: Record<string, Stored>; executions: Record<string, Issuance> }
const empty = (): EvidenceFile => ({ version: 1, records: {}, executions: {} })
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(nonempty) : []
const digest = (value: unknown): string => sha256(Buffer.from(JSON.stringify(value)))
const sourceTypes = ['journal', 'preprint', 'web', 'file', 'book', 'other'] as const
const completeIdentity = (value: unknown): value is ExecutionIdentity => {
  const row = object(value)
  return row !== undefined && nonempty(row['sessionId']) && nonempty(row['callId'])
    && ['rootSessionId', 'runId', 'originMessageId'].every(key => row[key] === undefined || nonempty(row[key]))
    && ['turn', 'step'].every(key => row[key] === undefined || (Number.isSafeInteger(row[key]) && Number(row[key]) >= 0))
    && executionKey(row as ExecutionIdentity) !== undefined
}
function validProvenance(value: unknown): boolean {
  const row = object(value)
  return completeIdentity(value) && row !== undefined && nonempty(row['tool']) && nonempty(row['parserVersion'])
    && typeof row['at'] === 'string' && Number.isFinite(Date.parse(row['at']))
    && ['native-receipt', 'host-observation'].includes(String(row['timeSource']))
    && row['executionKeyHash'] === digest(executionKey(value))
}
function provenanceFor(tool: string, owner: EvidenceIdentity, candidate: Candidate): EvidenceProvenance {
  const nativeAt = object(owner)?.['at']
  const hasNativeTime = typeof nativeAt === 'string' && Number.isFinite(Date.parse(nativeAt))
  return { tool, sessionId: owner.sessionId!, callId: owner.callId!,
    ...(owner.rootSessionId === undefined ? {} : { rootSessionId: owner.rootSessionId }),
    ...(owner.runId === undefined ? {} : { runId: owner.runId }),
    ...(owner.originMessageId === undefined ? {} : { originMessageId: owner.originMessageId }),
    ...(owner.turn === undefined ? {} : { turn: owner.turn }), ...(owner.step === undefined ? {} : { step: owner.step }),
    executionKeyHash: digest(executionKey(owner)), at: hasNativeTime ? nativeAt : new Date().toISOString(),
    timeSource: hasNativeTime ? 'native-receipt' : 'host-observation',
    parserVersion: candidate.proof === 'pdf' ? 'pdf-classic-xref-v1' : candidate.proof === 'text' ? 'utf8-text-v1'
      : candidate.kind === 'file' ? 'file-sha256-v1' : candidate.kind === 'source' ? 'native-source-v1' : 'native-receipt-v1' }
}
const selfProof = (tool: string): boolean => /^(?:butler_(?:task|overview|pack|approve)$|todo_write$|team_task_|acp_|list_agents$|tool_(?:search|list)|load_skill$)/.test(tool)
const success = (value: unknown): boolean => {
  const row = object(value)
  if (!row || row['ok'] === false || row['success'] === false || row['isError'] === true || row['refused'] === true || row['error']) return false
  const status = row['statusCode'] ?? row['status']
  return row['ok'] === true || row['success'] === true || row['exitCode'] === 0 || row['exit_code'] === 0
    || (typeof status === 'number' && status >= 200 && status < 300) || status === 'success' || status === 'succeeded'
}
function validFile(value: unknown): boolean {
  const file = object(value), records = object(file?.['records']), executions = object(file?.['executions'])
  if (file?.['version'] !== 1 || !records || !executions) return false
  return Object.entries(records).every(([id, value]) => {
    const row = object(value)
    return row?.['evidenceId'] === id && /^ev-[a-f\d]{24}$/.test(id) && nonempty(row['taskId'])
      && ['file', 'source', 'receipt'].includes(String(row['kind'])) && ['pending', 'confirmed', 'rejected'].includes(String(row['status']))
      && nonempty(row['execution']) && nonempty(row['source_url']) && nonempty(row['verified_by']) && /^\d{4}-\d{2}-\d{2}$/.test(String(row['retrieved_at']))
      && sourceTypes.includes(row['source_type'] as typeof sourceTypes[number]) && ['abstract', 'fulltext'].includes(String(row['read_level']))
      && Array.isArray(row['anchors']) && row['anchors'].every(nonempty) && typeof row['summary'] === 'string'
      && validProvenance(row['provenance'])
      && (row['sha256'] === undefined || /^[a-f\d]{64}$/.test(String(row['sha256'])))
      && (row['contentSha256'] === undefined || /^[a-f\d]{64}$/.test(String(row['contentSha256'])))
      && (row['kind'] !== 'file' || (nonempty(row['filePath']) && /^[a-f\d]{64}$/.test(String(row['sha256']))))
      && (row['proof'] === undefined || row['proof'] === 'text' || row['proof'] === 'pdf')
      && (row['proof'] === undefined || (row['kind'] === 'file' && nonempty(row['contentSha256'])))
      && (row['proof'] !== 'pdf' || (Array.isArray(row['returnedPages']) && row['returnedPages'].every(page => Number.isSafeInteger(page) && Number(page) > 0) && new Set(row['returnedPages']).size === row['returnedPages'].length))
      && (row['read_level'] !== 'fulltext' || (row['kind'] === 'file' && row['proof'] !== undefined && row['anchors'].length > 0 && nonempty(row['contentSha256'])))
      && (row['kind'] !== 'source' || (row['read_level'] === 'abstract' && nonempty(row['contentSha256']) && row['filePath'] === undefined && row['proof'] === undefined))
      && (row['kind'] !== 'receipt' || (row['read_level'] === 'abstract' && row['anchors'].length === 0 && row['filePath'] === undefined && row['proof'] === undefined))
      && (row['status'] === 'rejected' || (object(executions[String(row['execution'])])?.['status'] === row['status'] && strings(object(executions[String(row['execution'])])?.['ids']).includes(id)))
  }) && Object.entries(executions).every(([key, value]) => {
    const row = object(value)
    return /^[a-f\d]{64}$/.test(key) && nonempty(row?.['tool']) && nonempty(row?.['taskId'])
      && ['pending', 'confirmed', 'rejected'].includes(String(row?.['status'])) && Array.isArray(row?.['ids'])
      && row['ids'].every(id => nonempty(id) && object(records[id])?.['execution'] === key)
  })
}
function anchorsIn(anchors: string[] | undefined, text: string): string[] {
  return [...new Set((anchors ?? []).filter(anchor => {
    if (!nonempty(anchor) || /^p\d+\s*:/i.test(anchor.trim())) return false
    const fragment = anchor.replace(/^[^:]{1,80}:\s*/, '').trim()
    return fragment.length >= 3 && text.includes(fragment)
  }).map(anchor => anchor.trim().slice(0, 200)))].slice(0, 40)
}
function sourceCandidate(input: SourceEvidenceInput): Candidate {
  if (!/^(?:https?:\/\/|doi:)/.test(input.sourceUrl) || !nonempty(input.returnedText)) throw new GuardRefusal('evidence.source_unproven', '来源必须由实际工具返回可定位 URL 和读取内容。')
  const anchors = anchorsIn(input.anchors, input.returnedText)
  return { kind: 'source', slot: `source:${input.sourceUrl}`, source_url: input.sourceUrl, source_type: input.sourceType ?? 'web', read_level: 'abstract', anchors, summary: '实际工具返回的来源；仅摘要或页面内容', contentSha256: digest(input.returnedText) }
}
function fileCandidate(input: FileEvidenceInput): Candidate {
  if (!isAbsolute(input.path)) throw new GuardRefusal('evidence.file_path', '产物必须是本机绝对路径。')
  const path = resolve(input.path)
  let bytes: Buffer
  try { if (!statSync(path).isFile()) throw new Error('不是普通文件'); bytes = readFileSync(path) } catch { throw new GuardRefusal('evidence.file_missing', '登记的真实产物不存在或无法读取。') }
  let anchors: string[] = [], proof: Candidate['proof'], returnedPages: number[] | undefined, contentSha256: string | undefined, fulltext = false
  if (bytes.subarray(0, 5).toString() === '%PDF-') {
    const actual = readPdfText(bytes), returned = input.returnedPages ?? input.pdf?.pages ?? []
    const accepted = returned.filter(page => Number.isSafeInteger(page.page) && typeof page.text === 'string' && actual.pageOrderKnown && actual.pages.some(real => real.page === page.page && (page.text ? real.text.includes(page.text) : real.status === 'blank')))
      .sort((left, right) => left.page - right.page)
    returnedPages = [...new Set(accepted.map(page => page.page))].sort((a, b) => a - b)
    const view: PdfText = { ...actual, pages: accepted.map(page => ({ page: page.page, text: page.text, status: 'text' })) }
    anchors = pageAnchors(view)
    fulltext = actual.complete && actual.textLayer && accepted.length === actual.pages.length && returnedPages.length === actual.pages.length
      && actual.pages.every(real => accepted.some(page => page.page === real.page && page.text === real.text)) && anchors.length > 0
    contentSha256 = digest(accepted.map(page => [page.page, page.text]))
    proof = actual.pageOrderKnown ? 'pdf' : undefined
  } else if (typeof input.returnedText === 'string') {
    let actual: string
    try { actual = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new GuardRefusal('evidence.text_unknown', '文件不能可靠解码为实际返回的 UTF-8 文本。') }
    if (input.returnedText && !actual.includes(input.returnedText)) throw new GuardRefusal('evidence.text_mismatch', '实际返回的读取内容与原件不符。')
    anchors = anchorsIn(input.anchors, input.returnedText)
    const line = input.returnedText.split(/\r?\n/).map(line => line.trim()).find(line => line.length >= 3)
    if (!anchors.length && line) anchors = [`section: ${line.slice(0, 80)}`]
    fulltext = input.returnedText === actual && actual.trim() !== '' && anchors.length > 0
    contentSha256 = digest(input.returnedText); proof = 'text'
  }
  if (input.readLevel === 'fulltext' && !fulltext) throw new GuardRefusal('evidence.fulltext_unproven', '全文证据必须有原件、真实锚点及已实际返回的完整读取内容；保存文件或抽样不能证明全文。')
  return { kind: 'file', slot: `file:${path}`, source_url: input.sourceUrl ?? path, source_type: input.sourceType ?? 'file', read_level: fulltext ? 'fulltext' : 'abstract', sha256: sha256(bytes), anchors, summary: `真实文件产物：${basename(path)}`, filePath: path,
    ...(proof === undefined ? {} : { proof }), ...(returnedPages === undefined ? {} : { returnedPages }), ...(contentSha256 === undefined ? {} : { contentSha256 }) }
}
function receiptCandidate(tool: string): Candidate {
  return { kind: 'receipt', slot: 'receipt', source_url: `tool:${tool}`, source_type: 'other', read_level: 'abstract', anchors: [], summary: `${tool} 最终成功回执` }
}

/** Only the host's actual tool-result boundary should prepare/observe evidence. */
export class EvidenceStore {
  readonly file: string
  private readonly options: EvidenceStoreOptions
  constructor(options: EvidenceStoreOptions = {}) { this.options = options; this.file = options.file ?? statePath('evidence.json'); this.read() }
  private read(): EvidenceFile { return readState(this.file, empty(), validFile, { recover: this.options.recover }) }
  private owner(identity?: EvidenceIdentity): EvidenceIdentity {
    const owner = identity ?? (typeof this.options.identity === 'function' ? this.options.identity() : this.options.identity)
    if (!nonempty(owner?.taskId)) throw new GuardRefusal('evidence.no_task', '真实结果必须关联业务任务，才能登记证据。')
    if (!completeIdentity(owner)) throw new GuardRefusal('evidence.execution_required', '持久证据必须有完整可信的 executionKey 执行身份，不能用随机 ID 补造归因。')
    return owner as EvidenceIdentity
  }
  private publish(tool: string, candidates: Candidate[], owner: EvidenceIdentity, status: Status, registrationSlot?: string): string[] {
    const execution = executionKey(owner)
    if (execution === undefined) throw new GuardRefusal('evidence.execution_required', '证据缺少完整执行身份。')
    const key = digest(registrationSlot === undefined ? execution : [execution, registrationSlot]), taskId = owner.taskId as string
    const snapshot = readSnapshot({ path: this.file, format: 'json', fallback: empty(), validate: validFile })
    const prior = snapshot.value.executions[key]
    if (prior && (prior.taskId !== taskId || prior.tool !== tool)) throw new GuardRefusal('evidence.execution_conflict', '同一完整 executionKey 不能用于其他工具或业务任务。')
    if (!prior && (status === 'rejected' || candidates.length === 0)) return []
    if (prior?.status === 'rejected') return []
    if (prior?.status === 'confirmed' && status !== 'rejected') return [...prior.ids]
    if (prior?.status === 'pending' && status === 'pending') return [...prior.ids]
    const updated = ((state: EvidenceFile) => {
      const previous = state.executions[key]
      if (previous && (previous.taskId !== taskId || previous.tool !== tool)) throw new GuardRefusal('evidence.execution_conflict', '同一完整 executionKey 不能用于其他工具或业务任务。')
      if (previous?.status === 'rejected') return { value: state, result: [] }
      if (previous?.status === 'confirmed' && status !== 'rejected') return { value: state, result: previous.ids }
      if (status === 'rejected' || candidates.length === 0) {
        if (previous) { previous.status = 'rejected'; for (const id of previous.ids) state.records[id].status = 'rejected' }
        return { value: state, result: [] }
      }
      const ids = candidates.map(candidate => `ev-${digest([key, candidate.slot]).slice(0, 24)}`)
      if (previous?.status === 'pending' && status === 'confirmed' && candidates.some((candidate, index) => {
        const old = state.records[ids[index]]
        return old && (old.sha256 !== candidate.sha256 || old.contentSha256 !== candidate.contentSha256)
      })) {
        previous.status = 'rejected'
        for (const id of previous.ids) state.records[id].status = 'rejected'
        return { value: state, result: [] }
      }
      for (const id of previous?.ids ?? []) if (!ids.includes(id)) state.records[id].status = 'rejected'
      for (const [index, candidate] of candidates.entries()) {
        const { slot: _, ...fields } = candidate, id = ids[index], old = state.records[id]
        const provenance = provenanceFor(tool, owner, candidate)
        state.records[id] = { ...fields, evidenceId: id, taskId, status, execution: key, provenance,
          retrieved_at: status === 'confirmed' ? provenance.at.slice(0, 10) : old?.retrieved_at ?? provenance.at.slice(0, 10), verified_by: 'host:tool-result' }
      }
      state.executions[key] = { tool, taskId, status, ids }
      return { value: state, result: ids }
    })(snapshot.value)
    // commitFiles may return an already committed operation before applying CAS.
    // Validate the current bytes' owner as well as the proposed snapshot so a
    // racing replay cannot return another business task's evidence IDs.
    const validatePublication = (value: unknown): boolean => {
      if (!validFile(value)) return false
      const current = (value as EvidenceFile).executions[key]
      if (current && (current.taskId !== taskId || current.tool !== tool)) throw new GuardRefusal('evidence.execution_conflict', '同一完整 executionKey 不能用于其他工具或业务任务。')
      return true
    }
    return commitFiles({ kind: 'evidence.observe', targetId: key, operationId: `evidence:${key}:${status}`, result: updated.result,
      writes: [{ path: this.file, format: 'json', content: `${JSON.stringify(updated.value, null, 2)}\n`, validate: validatePublication, expectedBefore: snapshot.expectedBefore }] })
  }
  private candidates(tool: string, value: unknown): Candidate[] {
    if (selfProof(tool) || !success(value)) return []
    const result = object(value) as Record<string, unknown>, candidates: Candidate[] = []
    if (result['needsClarification'] === true) return []
    const operation = object(result['operation'])
    if (tool === 'butler_remind' && [result['state'], operation?.['state']].some(state => state === 'creating' || state === 'uncertain')) return []
    if (result['draft'] !== undefined) {
      const actual = [result['path'], result['storedPath'], result['sourcePath'], result['id'], result['receiptId'], result['url']].some(nonempty)
        || [result['artifacts'], result['records'], result['results']].some(rows => Array.isArray(rows) && rows.length > 0) || object(operation?.['actualReceipt']) !== undefined
      if (!actual) return []
    }
    if (tool === 'butler_literature' && Array.isArray(result['records'])) {
      for (const value of result['records']) {
        const row = object(value)
        if (!row || row['verified'] === 'conflict' || row['verified'] === 'unconfirmed') continue
        const url = nonempty(row['url']) ? row['url'] : nonempty(row['doi']) ? `https://doi.org/${row['doi']}` : undefined
        const text = [row['title'], row['abstract']].filter(nonempty).join('\n')
        if (url && text) candidates.push(sourceCandidate({ sourceUrl: url, returnedText: text, sourceType: row['source'] === 'arxiv' ? 'preprint' : 'journal', anchors: nonempty(row['title']) ? [`title: ${row['title']}`] : [] }))
      }
      return candidates
    }
    const path = [result['storedPath'], result['sourcePath'], result['path']].find(nonempty)
    const artifactPaths = Array.isArray(result['artifacts']) ? result['artifacts'].flatMap(value => { const row = object(value); return nonempty(row?.['path']) ? [row['path']] : [] }) : []
    if (path || artifactPaths.length) {
      const pages = [result['returnedPages'], result['contentPages'], result['sample'], result['pages']].find(Array.isArray)
      const returnedPages = Array.isArray(pages) ? pages.flatMap(value => { const row = object(value); return typeof row?.['page'] === 'number' && typeof row['text'] === 'string' ? [{ page: row['page'], text: row['text'] }] : [] }) : []
      for (const artifact of [...new Set([...(path ? [path] : []), ...artifactPaths])].slice(0, 40)) {
        try { candidates.push(fileCandidate({ path: artifact, returnedPages: artifact === path ? returnedPages : [], ...(artifact === path && typeof result['body'] === 'string' ? { returnedText: result['body'] } : {}) })) } catch (error) { if (!(error instanceof GuardRefusal)) throw error }
      }
      return candidates
    }
    if (/^(?:web_(?:fetch|search)|fetch_web|search_web)$/.test(tool)) {
      const rows = Array.isArray(result['results']) ? result['results'] : [result]
      for (const value of rows) {
        const row = object(value), body = object(row?.['body'])
        const url = row?.['url'] ?? row?.['source_url'], text = row?.['text'] ?? row?.['content'] ?? row?.['snippet'] ?? body?.['content']
        if (nonempty(url) && nonempty(text)) candidates.push(sourceCandidate({ sourceUrl: url, returnedText: text }))
      }
      return candidates
    }
    return [receiptCandidate(tool)]
  }
  prepare(tool: string, result: unknown, identity?: EvidenceIdentity): string[] {
    let owner: EvidenceIdentity
    try { owner = this.owner(identity) } catch (error) { if (error instanceof GuardRefusal) return []; throw error }
    if (!executionKey(owner)) return []
    return this.publish(tool, this.candidates(tool, result), owner, 'pending')
  }
  observe(tool: string, result: unknown, identity?: EvidenceIdentity): string[] {
    let owner: EvidenceIdentity
    try { owner = this.owner(identity) } catch (error) { if (error instanceof GuardRefusal) return []; throw error }
    return this.publish(tool, this.candidates(tool, result), owner, success(result) ? 'confirmed' : 'rejected')
  }
  registerFile(input: FileEvidenceInput, identity?: EvidenceIdentity): string {
    const candidate = fileCandidate(input)
    return this.publish('host.file', [candidate], this.owner(identity), 'confirmed', candidate.slot)[0]
  }
  registerSource(input: SourceEvidenceInput, identity?: EvidenceIdentity): string {
    const candidate = sourceCandidate(input)
    return this.publish('host.source', [candidate], this.owner(identity), 'confirmed', candidate.slot)[0]
  }
  registerReceipt(input: ReceiptEvidenceInput, identity?: EvidenceIdentity): string {
    if (!input.ok || selfProof(input.tool)) throw new GuardRefusal('evidence.receipt_unproven', '失败或任务状态工具不能证明业务完成。')
    return this.publish(input.tool, [receiptCandidate(input.tool)], this.owner(identity), 'confirmed')[0]
  }
  resolve(ids: string[], taskId: string): RegisteredEvidence[] {
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !nonempty(id))) throw new GuardRefusal('evidence.ids_required', '完成必须引用已登记 evidenceIds。')
    const state = this.read()
    return [...new Set(ids)].map(id => {
      const row = state.records[id]
      if (!row) throw new GuardRefusal('evidence.unknown', `证据 ${id} 不存在或未登记。`)
      if (row.taskId !== taskId) throw new GuardRefusal('evidence.wrong_task', '证据不属于当前业务任务。')
      if (row.status !== 'confirmed') throw new GuardRefusal('evidence.unconfirmed', row.status === 'pending' ? '证据仍待最终工具结果确认（pending）。' : '证据被最终工具结果拒绝，已失效（rejected）。')
      if (row.filePath) {
        let bytes: Buffer
        try { if (!statSync(row.filePath).isFile()) throw new Error('not file'); bytes = readFileSync(row.filePath) } catch { throw new GuardRefusal('evidence.file_missing', '证据文件不存在或无法读取。') }
        if (sha256(bytes) !== row.sha256) throw new GuardRefusal('evidence.file_changed', '证据文件已被修改，SHA256 复验失败。')
        if (row.proof === 'pdf') {
          const parsed = readPdfText(bytes, row.returnedPages?.length ? { pages: row.returnedPages } : {})
          if (!parsed.pageOrderKnown || row.anchors.some(anchor => { const match = /^p(\d+): (.*)$/.exec(anchor); return !match || !parsed.pages.some(page => page.page === Number(match[1]) && page.text.includes(match[2])) })) throw new GuardRefusal('evidence.anchor_changed', 'PDF 的真实物理页锚点无法复验。')
          if (row.read_level === 'fulltext' && (!parsed.complete || !parsed.textLayer || digest(parsed.pages.map(page => [page.page, page.text])) !== row.contentSha256)) throw new GuardRefusal('evidence.fulltext_unproven', 'PDF 全文的读取范围或内容无法复验。')
        } else if (row.proof === 'text') {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (anchorsIn(row.anchors, text).length !== row.anchors.length || (row.read_level === 'fulltext' && digest(text) !== row.contentSha256)) throw new GuardRefusal('evidence.anchor_changed', '文本原件、读取内容或锚点无法复验。')
        }
      }
      return this.project(row)
    })
  }
  private project(row: Stored): RegisteredEvidence {
    const { status: _, execution: __, filePath: ___, contentSha256: ____, returnedPages: _____, proof: ______, ...result } = row
    return structuredClone(result)
  }
  listForTask(taskId: string): RegisteredEvidence[] { return Object.values(this.read().records).filter(row => row.taskId === taskId && row.status === 'confirmed').map(row => this.project(row)) }
}
