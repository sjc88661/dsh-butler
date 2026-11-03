import { join } from 'node:path'
import { commitFiles, readSnapshot } from './store.ts'
import { sha256, statePath } from './vault.ts'

export interface LiteratureScope { sessionId: string; ownerId?: string; taskId?: string }
type ObjectValue = Record<string, unknown>
const object = (x: unknown): x is ObjectValue => x !== null && typeof x === 'object' && !Array.isArray(x)
const validScope = (s: LiteratureScope): boolean => object(s) && typeof s.sessionId === 'string' && s.sessionId.length > 0 && (s.ownerId === undefined || typeof s.ownerId === 'string' && s.ownerId.length > 0) && (s.taskId === undefined || typeof s.taskId === 'string' && s.taskId.length > 0)
const canonicalScope = (s: LiteratureScope): LiteratureScope => ({ sessionId: s.sessionId, ...(s.ownerId === undefined ? {} : { ownerId: s.ownerId }), ...(s.taskId === undefined ? {} : { taskId: s.taskId }) })
const json = (x: unknown): string => JSON.stringify(x)
const hash = (s: string): string => sha256(Buffer.from(s, 'utf8'))
const integer = (n: number | undefined, fallback: number, max?: number): number => {
  if (n === undefined) return fallback
  if (!Number.isSafeInteger(n) || n < 0 || (max !== undefined && n > max)) throw new Error('Invalid pagination parameter')
  return n
}
const clip = (x: unknown, max: number): { value: unknown; clipped: boolean } => {
  if (typeof x !== 'string') return { value: x, clipped: false }
  const chars = Array.from(x); return { value: chars.slice(0, max).join(''), clipped: chars.length > max }
}
function project(row: unknown, index: number): ObjectValue {
  if (!object(row)) return { index, omitted: true }
  const result: ObjectValue = { index }; const clipped: string[] = []
  for (const key of ['title', 'year', 'venue', 'doi', 'pmid', 'arxivId', 'url', 'source', 'verified']) {
    if (row[key] !== undefined) { const part = clip(row[key], 180); result[key] = part.value; if (part.clipped) clipped.push(key) }
  }
  if (Array.isArray(row.authors) && row.authors.length) { const part = clip(row.authors[0], 120); result.firstAuthor = part.value; if (part.clipped) clipped.push('firstAuthor') }
  if (Array.isArray(row.sources)) result.sources = row.sources.slice(0, 10).map(x => object(x) ? x.name ?? x.source : x).filter(x => typeof x === 'string').map(x => clip(x, 60).value)
  if (row.verified === undefined) result.verified = 'retrieved'
  if (typeof row.abstract === 'string') { const part = clip(row.abstract, 240); result.abstractExcerpt = part.value; if (part.clipped) clipped.push('abstract') }
  result.omitted = Object.keys(row).some(k => !['title','year','venue','doi','pmid','arxivId','url','source','verified'].includes(k)) || clipped.length > 0
  if (clipped.length) result.clippedFields = clipped
  return result
}
function metadata(value: ObjectValue): ObjectValue { const { records: _records, resultSet: _resultSet, ...rest } = value; return rest }
function preview(value: ObjectValue, ref: ObjectValue, offset: number, limit: number): ObjectValue {
  const records = value.records as unknown[]; let end = Math.min(records.length, offset + limit)
  const p: ObjectValue = { ok:true, view:'literature-preview', total:records.length, offset, nextOffset:end < records.length ? end : null, records:records.slice(offset,end).map((r,i) => project(r,offset+i)), resultSet:ref, read_level:'Use read for complete record, abstract, or metadata; abstract is not full text.' }
  for (const key of ['query','duplicatesRemoved','verifiedCount','unconfirmedCount','conflictCount']) if (value[key] !== undefined) p[key] = typeof value[key] === 'string' ? clip(value[key],200).value : value[key]
  for (const key of ['providers','limitations']) if (Array.isArray(value[key])) {
    const arr = value[key] as unknown[]; p[`${key}Count`] = arr.length
    if (key === 'providers') p.providerErrorCount = arr.filter(x => object(x) && x.ok === false).length
    p[key] = arr.slice(0, 8).map(x => object(x) ? { name:clip(x.name,60).value, ok:x.ok, ...(x.note === undefined ? {} : {note:clip(x.note,120).value}) } : clip(x,120).value)
  }
  p.conflictCount = typeof value.conflictCount === 'number' ? value.conflictCount : records.filter(x => object(x) && x.verified === 'conflict').length
  boundPreview(p)
  return p
}
function boundPreview(p: ObjectValue): void {
  const rows = p.records as ObjectValue[]
  if (Buffer.byteLength(json(p)) > 12000) {
    for (const row of rows) {
      for (const key of Object.keys(row)) if (typeof row[key] === 'string') row[key] = clip(row[key],40).value
      if (Array.isArray(row.sources)) row.sources = row.sources.slice(0,3).map(x => clip(x,30).value)
      row.omitted = true; row.clippedFields = ['See read for complete record']
    }
    for (const key of ['providers','limitations']) if (Array.isArray(p[key])) p[key] = (p[key] as unknown[]).map(x => object(x) ? {name:clip(x.name,30).value,ok:x.ok} : clip(x,30).value).slice(0,8)
    p.metadataOmitted = true
  }
  while (Buffer.byteLength(json(p)) > 12000 && rows.length > 1) rows.pop()
  const end = (p.offset as number) + rows.length
  p.nextOffset = end < (p.total as number) ? end : null
  if (Buffer.byteLength(json(p)) > 12000) throw new Error('Literature preview exceeds output limit')
}
export class LiteratureResults {
  private root?: string
  constructor(options: { root?: string } = {}) { this.root = options.root }
  private path(id: string): string { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid result id'); return this.root === undefined ? statePath('literature-results', `${id}.json`) : join(this.root, 'literature-results', `${id}.json`) }
  save(value: ObjectValue, scope: LiteratureScope, provenance?: ObjectValue): { id: string; sha256: string; total: number } {
    if (!validScope(scope) || !object(value) || value.ok !== true || !Array.isArray(value.records) || value.records.length > 100) throw new Error('Invalid literature result or scope')
    const payload = { version:1, scope:canonicalScope(scope), value, ...(provenance === undefined ? {} : {provenance}) }
    const content = json(payload); if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Literature result exceeds 4 MB')
    const id = hash(content), path = this.path(id), snapshot = readSnapshot({path,format:'json',fallback:null})
    if (snapshot.value !== null) { if (hash(json(snapshot.value)) !== id) throw new Error('Literature result integrity failure') }
    else commitFiles({kind:'literature.results',targetId:id,writes:[{path,content,format:'json',expectedBefore:null}]})
    return { id, sha256:id, total:value.records.length }
  }
  private load(id: string, scope: LiteratureScope): {value:ObjectValue; provenance?:unknown} {
    if (!validScope(scope)) throw new Error('Invalid scope')
    const saved = readSnapshot<unknown>({path:this.path(id),format:'json',fallback:null}).value
    if (!object(saved) || hash(json(saved)) !== id || saved.version !== 1 || !object(saved.scope) || json(saved.scope) !== json(canonicalScope(scope)) || !object(saved.value) || !Array.isArray(saved.value.records)) throw new Error('Result missing, corrupt, or scope mismatch')
    return saved as {value:ObjectValue; provenance?:unknown}
  }
  page(id: string, scope: LiteratureScope, args: {offset?:number;limit?:number} = {}): ObjectValue {
    const value = this.load(id,scope).value, offset = integer(args.offset,0), limit = integer(args.limit,8,8)
    if (limit === 0) throw new Error('Invalid limit')
    const ref = {id,sha256:id,total:(value.records as unknown[]).length}; return preview(value,ref,offset,limit)
  }
  read(id: string, scope: LiteratureScope, args: {index?:number;field?:'record'|'abstract'|'metadata';offset?:number;limit?:number}): ObjectValue {
    const saved = this.load(id,scope), field = args.field ?? 'record', offset = integer(args.offset,0), limit = integer(args.limit,1500,2000)
    if (!limit || !['record','abstract','metadata'].includes(field)) throw new Error('Invalid read arguments')
    let text: string
    if (field === 'metadata') text = json({ ...metadata(saved.value), ...(saved.provenance === undefined ? {} : {provenance:saved.provenance}) })
    else { const index = integer(args.index,0), records = saved.value.records as unknown[]; if (index >= records.length) throw new Error('Invalid record index'); const row = records[index]; text = field === 'record' ? json(row) : object(row) && typeof row.abstract === 'string' ? row.abstract : '' }
    const chars = Array.from(text); let end = Math.min(chars.length,offset+limit)
    const result = () => ({id,field,...(field === 'metadata' ? {} : {index:args.index ?? 0}),offset,totalChars:chars.length,nextOffset:end < chars.length ? end : null,text:chars.slice(offset,end).join('')})
    while (Buffer.byteLength(json(result())) > 12000 && end > offset) end--
    return result()
  }
}
export function renderLiteratureResult(value: unknown): string {
  if (!object(value) || value.ok !== true || !Array.isArray(value.records) || !object(value.resultSet) || typeof value.resultSet.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultSet.id) || value.resultSet.sha256 !== value.resultSet.id || !Number.isSafeInteger(value.resultSet.total) || (value.resultSet.total as number) < 0) return json(value)
  if (value.view === 'literature-preview') {
    if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || value.total !== value.resultSet.total || value.records.length > 8 || Buffer.byteLength(json(value)) > 12000) throw new Error('Invalid literature preview')
    return json(value)
  }
  const ref = {id:value.resultSet.id,sha256:value.resultSet.sha256,total:value.resultSet.total}
  return json(preview(value,ref,0,8))
}

