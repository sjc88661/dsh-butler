import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'evidence-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { ensureVault, vaultPath, statePath } = await import('../src/host/vault.ts')
const { validateEvidence } = await import('../src/host/guard.ts')
const evidenceModule = await import('../src/host/evidence-store.ts').catch(() => ({}))
ensureVault()
let sequence = 0
const identity = (taskId = 'task-a', callId = `call-${++sequence}`) => ({ sessionId: 'owner', rootSessionId: 'owner', runId: 'run-a', turn: 1, step: 1, callId, taskId })
function store() {
  assert.equal(typeof evidenceModule.EvidenceStore, 'function', '宿主应提供真实证据登记 API')
  return new evidenceModule.EvidenceStore({ file: statePath(`evidence-${++sequence}.json`) })
}
const file = (name, text = 'Actual artifact text\n') => { const path = vaultPath('uploads', name); writeFileSync(path, text); return path }

test('legacy raw SHA and verified_by cannot promote invented evidence to verified fulltext', () => {
  assert.throws(() => validateEvidence({ source_url: 'https://example.invalid/nonexistent', source_type: 'journal', read_level: 'fulltext', sha256: '0'.repeat(64), verified_by: 'trusted-host' }, 'Asia/Shanghai', ['p99: invented']), /登记|evidenceId|真实|unproven/i)
  const row = validateEvidence({ source_url: 'https://example.invalid', source_type: 'web', read_level: 'abstract', verified_by: 'trusted-host', anchors: ['section: text'] }, 'Asia/Shanghai')
  assert.equal(row.verified_by, 'unverified')
  assert.deepEqual(row.anchors, ['section: text'])
})

test('only registered IDs from the same business task resolve and files are rehashed', () => {
  const evidence = store(), path = file('artifact.txt'), owner = identity()
  assert.throws(() => evidence.resolve(['ev-invented'], owner.taskId), /不存在|unknown|登记/i)
  const id = evidence.registerFile({ path }, owner)
  const [row] = evidence.resolve([id], owner.taskId)
  assert.equal(row.source_url, path)
  assert.match(row.sha256, /^[a-f0-9]{64}$/)
  assert.throws(() => evidence.resolve([id], 'task-b'), /任务|task/i)
  writeFileSync(path, 'Changed after observation')
  assert.throws(() => evidence.resolve([id], owner.taskId), /改变|变更|修改|sha|hash/i)
})

test('observed source anchors survive restart but fulltext cannot come from a search abstract', () => {
  const evidence = store(), owner = identity()
  const [id] = evidence.observe('butler_literature', { ok: true, records: [{ title: 'Actual title', source: 'pubmed', url: 'https://pubmed.ncbi.nlm.nih.gov/123/', abstract: 'Actual abstract content.', read_level: 'fulltext', verified_by: 'model' }] }, owner)
  assert.ok(id)
  const second = new evidenceModule.EvidenceStore({ file: evidence.file })
  const [row] = second.resolve([id], owner.taskId)
  assert.equal(row.read_level, 'abstract')
  assert.ok(row.anchors.length > 0)
  assert.ok(row.anchors.every(anchor => !anchor.startsWith('p')))
  assert.notEqual(row.verified_by, 'model')
  assert.doesNotMatch(readFileSync(evidence.file, 'utf8'), /Actual abstract content\./)
})

test('a successful execution is issued once across replays and distinct execution positions stay separate', () => {
  const evidence = store(), owner = identity('task-a', 'native-call')
  const first = evidence.observe('calendar_create', { ok: true, id: 'event-1', privatePayload: 'do-not-persist' }, owner)
  const replay = evidence.observe('calendar_create', { ok: true, id: 'event-1' }, owner)
  assert.deepEqual(replay, first)
  assert.equal(evidence.listForTask(owner.taskId).length, 1)
  const later = evidence.observe('calendar_create', { ok: true, id: 'event-2' }, { ...owner, step: 2 })
  assert.notDeepEqual(later, first)
  assert.doesNotMatch(readFileSync(evidence.file, 'utf8'), /do-not-persist/)
})

test('task open, overview, failed tools and error results cannot prove their own completion', () => {
  const evidence = store(), owner = identity()
  for (const tool of ['butler_task', 'butler_overview', 'todo_write', 'team_task_update']) assert.deepEqual(evidence.observe(tool, { ok: true }, owner), [])
  assert.deepEqual(evidence.observe('calendar_create', { ok: false, error: 'rejected' }, identity()), [])
  assert.deepEqual(evidence.observe('calendar_create', { ok: true, error: 'failed post gate' }, identity()), [])
  assert.deepEqual(evidence.observe('calendar_create', { ok: true }, { sessionId: 'owner' }), [])
})

test('prepared IDs cannot resolve before the final result, and a failed post gate invalidates them', () => {
  const evidence = store(), owner = identity()
  const result = { ok: true, id: 'calendar-event' }
  const ids = evidence.prepare('calendar_create', result, owner)
  assert.equal(ids.length, 1)
  assert.throws(() => evidence.resolve(ids, owner.taskId), /确认|pending|最终|待/i)
  assert.deepEqual(evidence.observe('calendar_create', { ok: false, refused: true }, owner), [])
  assert.throws(() => evidence.resolve(ids, owner.taskId), /拒绝|失败|rejected|无效/i)
  const accepted = identity()
  const pending = evidence.prepare('calendar_create', result, accepted)
  assert.deepEqual(evidence.observe('calendar_create', result, accepted), pending)
  assert.equal(evidence.resolve(pending, accepted.taskId)[0].kind, 'receipt')
})

test('a stored file alone or a content sample does not prove fulltext', () => {
  const evidence = store(), owner = identity(), path = file('reading.txt', 'Introduction\nActual body\nConclusion')
  assert.throws(() => evidence.registerFile({ path, readLevel: 'fulltext', anchors: ['section: invented'] }, owner), /全文|fulltext|返回|读取/i)
  assert.throws(() => evidence.registerFile({ path, readLevel: 'fulltext', returnedText: 'Introduction', anchors: ['section: Introduction'] }, owner), /全文|fulltext|返回|读取/i)
  const id = evidence.registerFile({ path, readLevel: 'fulltext', returnedText: readFileSync(path, 'utf8'), anchors: ['section: Introduction'] }, owner)
  assert.equal(evidence.resolve([id], owner.taskId)[0].read_level, 'fulltext')
})

function pdfBytes() {
  const text = 'THE REAL CONTENT ON PHYSICAL PAGE TWO', stream = `BT /F1 12 Tf (${text}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R >>', '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n', offsets = []
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${index + 1} 0 obj\n${value}\nendobj\n` })
  const start = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

test('PDF fulltext requires the exact returned content of every physical page including blank pages', async () => {
  const { readPdfText } = await import('../src/host/pdf.ts')
  const evidence = store(), path = file('two-physical-pages.pdf', pdfBytes()), parsed = readPdfText(readFileSync(path))
  const owner = identity()
  const [sampleId] = evidence.observe('butler_pdf', { ok: true, storedPath: path, sha256: '0'.repeat(64), fullTextAvailable: true, readLevel: 'fulltext', sample: [{ page: 2, text: parsed.pages[1].text.slice(0, 12) }], anchors: ['p99: forged'] }, owner)
  const [sample] = evidence.resolve([sampleId], owner.taskId)
  assert.equal(sample.read_level, 'abstract')
  assert.notEqual(sample.sha256, '0'.repeat(64))
  assert.ok(sample.anchors.every(anchor => anchor.startsWith('p2:')))
  assert.throws(() => evidence.registerFile({ path, readLevel: 'fulltext', returnedPages: [parsed.pages[1]] }, identity()), /全文|fulltext/)
  const full = evidence.registerFile({ path, readLevel: 'fulltext', returnedPages: parsed.pages }, identity())
  assert.equal(evidence.resolve([full], 'task-a')[0].read_level, 'fulltext')
})

test('a file changed between prepare and the final native result invalidates the prepared ID', () => {
  const evidence = store(), path = file('pending-artifact.txt'), owner = identity(), result = { ok: true, path }
  const ids = evidence.prepare('write_report', result, owner)
  writeFileSync(path, 'Concurrent edit before final result')
  assert.deepEqual(evidence.observe('write_report', result, owner), [])
  assert.throws(() => evidence.resolve(ids, owner.taskId), /拒绝|rejected|失效/)
})

test('plain text does not acquire invented page anchors even when the entire text was returned', () => {
  const evidence = store(), text = 'The actual complete text', path = file('no-pages.txt', text), owner = identity()
  const id = evidence.registerFile({ path, returnedText: text, anchors: ['p99: ', 'p8: The actual complete text'] }, owner)
  assert.ok(evidence.resolve([id], owner.taskId)[0].anchors.every(anchor => !/^p\d+:/.test(anchor)))
})

test('replayed prepare cannot replace the initial file witness after the file changed', () => {
  const evidence = store(), path = file('replayed-pending.txt'), owner = identity(), result = { ok: true, path }
  const ids = evidence.prepare('write_report', result, owner)
  writeFileSync(path, 'Changed before replayed prepare')
  assert.deepEqual(evidence.prepare('write_report', result, owner), ids)
  assert.deepEqual(evidence.observe('write_report', result, owner), [])
})

test('persisted fulltext records without an actual reading proof fail closed', () => {
  const evidence = store(), owner = identity(), path = file('schema-proof.txt', 'Actual complete text')
  const id = evidence.registerFile({ path, returnedText: 'Actual complete text' }, owner)
  const raw = JSON.parse(readFileSync(evidence.file, 'utf8'))
  delete raw.records[id].proof
  delete raw.records[id].contentSha256
  writeFileSync(evidence.file, JSON.stringify(raw))
  assert.throws(() => evidence.resolve([id], owner.taskId), /结构|schema|degraded|损坏/i)
})

test('one native result can register distinct file artifacts and replay each without duplication', () => {
  const evidence = store(), owner = identity(), first = file('first-artifact.txt'), second = file('second-artifact.txt')
  const firstId = evidence.registerFile({ path: first }, owner)
  const secondId = evidence.registerFile({ path: second }, owner)
  assert.notEqual(firstId, secondId)
  assert.equal(evidence.registerFile({ path: first }, owner), firstId)
  const ids = evidence.observe('write_reports', { ok: true, artifacts: [{ path: first }, { path: second }] }, identity())
  assert.equal(ids.length, 2)
  assert.deepEqual(evidence.resolve(ids, owner.taskId).map(row => row.source_url).sort(), [first, second].sort())
})

test('an unsupported PDF can prove a stored artifact without claiming that any content was read', () => {
  const evidence = store(), owner = identity(), path = file('unknown-structure.pdf', '%PDF-1.5\nnot a supported PDF structure')
  const id = evidence.registerFile({ path }, owner)
  const [row] = evidence.resolve([id], owner.taskId)
  assert.equal(row.read_level, 'abstract')
  assert.deepEqual(row.anchors, [])
})

test('all persistent evidence issuance requires a complete native execution identity', () => {
  const evidence = store(), path = file('identity-required.txt')
  for (const owner of [
    { taskId: 'task-a' },
    { taskId: 'task-a', sessionId: 'owner', callId: 'reused' },
    { taskId: 'task-a', sessionId: 'owner', callId: 'bad-position', turn: -1, step: 0 },
  ]) {
    assert.deepEqual(evidence.prepare('calendar_create', { ok: true }, owner), [])
    assert.deepEqual(evidence.observe('calendar_create', { ok: true }, owner), [])
    assert.throws(() => evidence.registerReceipt({ tool: 'calendar_create', ok: true }, owner), /身份|execution|执行/i)
    assert.throws(() => evidence.registerFile({ path }, owner), /身份|execution|执行/i)
  }
  assert.deepEqual(evidence.listForTask('task-a'), [])
})

test('full PDF pages returned in a different order have one canonical physical-page witness', async () => {
  const { readPdfText } = await import('../src/host/pdf.ts')
  const evidence = store(), path = file('reversed-pages.pdf', pdfBytes()), parsed = readPdfText(readFileSync(path)), owner = identity()
  const returnedPages = [...parsed.pages].reverse()
  const ids = evidence.prepare('butler_pdf', { ok: true, path, returnedPages }, owner)
  assert.deepEqual(evidence.observe('butler_pdf', { ok: true, path, returnedPages: parsed.pages }, owner), ids)
  assert.equal(evidence.resolve(ids, owner.taskId)[0].read_level, 'fulltext')
  const directOwner = identity()
  const direct = evidence.registerFile({ path, returnedPages, readLevel: 'fulltext' }, directOwner)
  assert.equal(evidence.resolve([direct], directOwner.taskId)[0].read_level, 'fulltext')
})

test('public evidence retains minimal receipt provenance and the actual native result timestamp across restart', () => {
  const evidence = store(), owner = { ...identity(), originMessageId: 'native-origin', at: '2026-10-15T03:04:05.678Z' }, path = file('provenance.txt')
  const [id] = evidence.observe('write_report', { ok: true, path, privatePayload: 'never-copy-native-private-payload' }, owner)
  const second = new evidenceModule.EvidenceStore({ file: evidence.file })
  const [row] = second.resolve([id], owner.taskId)
  assert.deepEqual(row.provenance, {
    tool: 'write_report', sessionId: owner.sessionId, rootSessionId: owner.rootSessionId, runId: owner.runId,
    originMessageId: owner.originMessageId, turn: owner.turn, step: owner.step, callId: owner.callId,
    at: owner.at, timeSource: 'native-receipt', parserVersion: 'file-sha256-v1', executionKeyHash: row.provenance?.executionKeyHash,
  })
  assert.match(row.provenance.executionKeyHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(second.listForTask(owner.taskId)[0].provenance, row.provenance)
  const stored = JSON.parse(readFileSync(evidence.file, 'utf8')).records[id]
  assert.deepEqual(stored.provenance, row.provenance)
  assert.doesNotMatch(readFileSync(evidence.file, 'utf8'), /never-copy-native-private-payload/)
})

test('clarification, draft-only and uncertain reminder results cannot sign a successful execution receipt', () => {
  const evidence = store()
  for (const result of [
    { ok: true, needsClarification: true }, { ok: true, draft: { title: 'Pending time' } },
    { ok: true, state: 'uncertain' }, { ok: true, state: 'creating' },
    { ok: true, operation: { state: 'uncertain' } }, { ok: true, operation: { state: 'creating' } },
  ]) {
    const owner = identity()
    assert.deepEqual(evidence.prepare('butler_remind', result, owner), [])
    assert.deepEqual(evidence.observe('butler_remind', result, owner), [])
  }
  const owner = identity()
  const ids = evidence.observe('butler_remind', { ok: true, reminders: [] }, owner)
  assert.equal(evidence.resolve(ids, owner.taskId)[0].kind, 'receipt', 'a real successful query still has its actual query receipt')
})
