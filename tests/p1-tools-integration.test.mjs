import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'p1-integration-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { registerButlerTools } = await import('../src/host/tools.ts')
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { EvidenceStore } = await import('../src/host/evidence-store.ts')
const { MemoryService } = await import('../src/host/memory.ts')
const { ReminderOperations } = await import('../src/host/reminder-operations.ts')
const { getTask, listMemos, allPending } = await import('../src/host/ledger.ts')
const { PROFILE_FILE } = await import('../src/host/vault.ts')

function environment(options = {}) {
  const contexts = new ExecutionContexts({ file: join(home, 'state', `contexts-${crypto.randomUUID()}.json`), runFor: id => `run:${id}`, beforeActivate: options.beforeActivate })
  const evidence = new EvidenceStore({ file: join(home, 'state', `evidence-${crypto.randomUUID()}.json`), identity: () => contexts.current() })
  const memory = new MemoryService({ contexts })
  const registered = new Map()
  let creates = 0
  const schedules = [], scheduleRequests = []
  const schedule = { async create(sessionId, request) { creates++; scheduleRequests.push(structuredClone(request)); const row = { id: `schedule-${crypto.randomUUID()}`, sessionId, scheduledAt: '2026-10-16T10:00:00+08:00' }; schedules.push(row); return row },
    async catalog() { return schedules }, async history() { return { records: [{ messageId: 'delivered-real' }] } }, async delete({ id }) { return { id, deleted: true } } }
  const reminderOperations = new ReminderOperations({ file: join(home, 'state', `reminders-${crypto.randomUUID()}.json`), schedule: () => schedule,
    destination: async () => `session-butler-reminder-${crypto.randomUUID()}`, ...options.reminderOptions })
  registerButlerTools({ tools: { register(tool) { registered.set(tool.name, tool); return () => {} } } }, {
    timeZone: 'Asia/Shanghai', mailto: 'test@localhost', sessionId: () => contexts.current()?.sessionId ?? 'unknown', currentTaskId: () => contexts.current()?.taskId,
    executionContext: contexts, evidence, memory, schedule, reminderOperations, ...options,
  })
  const a = { id: `p1-${crypto.randomUUID()}` }
  contexts.bindUser(a, { id: 'human-start', source: { kind: 'user' }, content: [{ type: 'text', text: '先完成本地工作' }] })
  const call = (name, args, callId = crypto.randomUUID()) => registered.get(name).execute(args, { agent: a, callId, name, arguments: args })
  return { contexts, evidence, memory, a, call, registered, reminderOperations, scheduleRequests, get creates() { return creates } }
}

test('the real task tool rejects self-reported evidence and accepts only its registered output', async () => {
  const e = environment(), task = await e.call('butler_task', { action: 'open', title: 'Produce note' })
  const forged = await e.call('butler_task', { action: 'update', id: task.task.id, status: 'done', evidence: [{ source_url: 'https://missing.test/fake', source_type: 'file', read_level: 'fulltext', sha256: '0'.repeat(64), anchors: ['p99: fake'] }] })
  assert.equal(forged.ok, false)
  const note = await e.call('butler_note', { action: 'write', slug: `output-${e.a.id}`, markdown: 'Actual local output' })
  assert.ok(note.evidenceIds?.length, 'actual output exposes evidence IDs')
  const done = await e.call('butler_task', { action: 'update', id: task.task.id, status: 'done', evidenceIds: note.evidenceIds })
  assert.equal(done.ok, true)
  assert.ok(getTask(task.task.id).evidence[0].evidenceId)
  assert.equal(getTask(task.task.id).status, 'done')
})

test('runtime candidates remain unusable until the final native result confirms them', async () => {
  const e = environment({ receiptsByRuntime: true }), task = await e.call('butler_task', { action: 'open', title: 'Final gate required' })
  const args = { action: 'write', slug: `pending-${e.a.id}`, markdown: 'Pending actual output' }
  const exec = { agent: e.a, callId: 'pending-call', name: 'butler_note', arguments: args }
  const note = await e.registered.get('butler_note').execute(args, exec)
  assert.ok(note.evidenceIds?.length)
  assert.throws(() => e.evidence.resolve(note.evidenceIds, task.task.id))
  const identity = e.contexts.receipt(exec, { ok: false, message: 'native post-gate blocked' })
  e.evidence.observe('butler_note', { ok: false }, identity)
  assert.throws(() => e.evidence.resolve(note.evidenceIds, task.task.id))
})

test('model approval fields cannot write the profile; real native question approval closes the memory transaction', async () => {
  const e = environment(), task = await e.call('butler_task', { action: 'open', title: 'Remember only with proof' })
  const text = `偏好-${e.a.id}`
  const saved = await e.call('butler_remember', { text, source: 'user', approved: true })
  assert.equal(saved.wroteProfile, false)
  assert.equal(saved.memo.status, 'proposed')
  assert.ok(saved.proposal?.question)
  const refused = await e.call('butler_approve', { action: 'decide', id: saved.proposal.id, decision: 'approved' })
  assert.equal(refused.ok, false)
  const question = saved.proposal.question
  const exec = { agent: e.a, callId: 'native-question', name: 'ask_user_question', arguments: { questions: [question] } }
  e.contexts.withExecution(exec, () => e.memory.observeToolResult(exec, { value: { answers: [{ id: question.id, selected: ['确认记住'] }] } }))
  assert.equal(listMemos().find(row => row.id === saved.memo.id).status, 'confirmed')
  assert.equal(allPending().find(row => row.id === saved.proposal.id).status, 'approved')
  assert.equal(readFileSync(PROFILE_FILE(), 'utf8').split(text).length - 1, 1)
  assert.equal(getTask(task.task.id).status, 'pending')
})

test('the real reminder tool replays one creation and exposes genuine history and cancellation state', async () => {
  const e = environment()
  const args = { action: 'create', title: 'One reminder', at: '2026-10-16T10:00:00+08:00' }
  const first = await e.call('butler_remind', args, 'same-reminder')
  const replay = await e.call('butler_remind', args, 'same-reminder')
  assert.equal(first.ok, true)
  assert.equal(replay.ok, true)
  assert.equal(e.creates, 1)
  assert.equal(first.task.id, replay.task.id)
  const history = await e.call('butler_remind', { action: 'history', id: first.reminder.id })
  assert.equal(history.available, true)
  assert.equal(history.records[0].messageId, 'delivered-real')
  const cancelled = await e.call('butler_remind', { action: 'cancel', id: first.reminder.id })
  assert.equal(cancelled.ok, true)
  assert.equal(getTask(first.task.id).status, 'cancelled')
})

test('the reminder tool parses only explicit numeric relative seconds, minutes and hours into a frozen native at', async () => {
  for (const [when, expected] of [['从现在起60秒后', '2026-10-21T03:01:00.000Z'], ['2分钟后', '2026-10-21T03:02:00.000Z'], ['1小时后', '2026-10-21T04:00:00.000Z']]) {
    let clock = '2026-10-21T03:00:00.000Z'
    const e = environment({ reminderOptions: { now: () => clock } })
    const args = { action: 'create', title: 'Relative reminder', when }
    const first = await e.call('butler_remind', args, 'relative-call')
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(e.scheduleRequests[0].at, expected)
    clock = '2026-10-21T05:00:00.000Z'
    const replay = await e.call('butler_remind', args, 'relative-call')
    assert.equal(replay.reminder.id, first.reminder.id)
    assert.equal(e.creates, 1)
  }
  const unresolved = environment()
  const clarification = await unresolved.call('butler_remind', { action: 'create', title: 'Unresolved reminder', when: '找个时间' })
  assert.equal(clarification.needsClarification, true)
  assert.equal(unresolved.creates, 0)
  assert.deepEqual(unresolved.reminderOperations.status(), [])
})

test('a first reminder operation save failure preserves its reason without activating a nonexistent task', async () => {
  let activated = 0
  const e = environment({ receiptsByRuntime: true, reminderOptions: { now: () => 'invalid-host-clock' }, beforeActivate(id) {
    activated++
    if (!getTask(id)) throw Error('TASK_CONTINUATION_REQUIRES_ID would mask the storage failure')
  } })
  const result = await e.call('butler_remind', { action: 'create', title: 'Storage failure', at: '2030-01-01T10:00:00Z' })
  assert.equal(result.ok, false)
  assert.equal(result.state, 'uncertain')
  assert.match(result.reason, /存储|结构|记录/)
  assert.doesNotMatch(JSON.stringify(result), /TASK_CONTINUATION/)
  assert.equal(activated, 0)
  assert.equal(e.creates, 0)
})

function fourPagePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>',
    ...[7, 8, 9, 10].map(id => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${id} 0 R /Resources << /Font << /F1 11 0 R >> >> >>`),
    ...['FIRST', 'SECOND', 'THIRD', 'FOURTH'].map(text => { const stream = `BT /F1 12 Tf (${text} PHYSICAL PAGE) Tj ET`; return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n', offsets = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(body)
}

test('PDF tool exposes later physical pages and upgrades only actual complete returned content', async () => {
  const e = environment(), task = await e.call('butler_task', { action: 'open', title: 'Read actual PDF' })
  const source = join(home, 'four-pages.pdf')
  writeFileSync(source, fourPagePdf())
  const sample = await e.call('butler_pdf', { action: 'ingest', path: source })
  assert.equal(sample.ok, true)
  assert.equal(sample.fullTextAvailable, false)
  assert.equal(sample.readLevel, 'abstract')
  assert.deepEqual(sample.returnedPages.map(page => page.page), [1, 2, 3])
  assert.equal(e.evidence.resolve(sample.evidenceIds, task.task.id)[0].read_level, 'abstract')
  const later = await e.call('butler_pdf', { action: 'read', path: sample.storedPath, pages: [4] })
  assert.deepEqual(later.returnedPages.map(page => page.page), [4])
  assert.match(later.returnedPages[0].text, /FOURTH PHYSICAL PAGE/)
  assert.match(later.anchors[0], /^p4:/)
  assert.equal(later.readLevel, 'abstract')
  const whole = await e.call('butler_pdf', { action: 'read', path: sample.storedPath, fullText: true })
  assert.equal(whole.fullTextAvailable, true)
  assert.equal(e.evidence.resolve(whole.evidenceIds, task.task.id)[0].read_level, 'fulltext')
})

test('an explicit PDF task target owns the actual file and receipt rather than the previously active task', async () => {
  const e = environment()
  const first = await e.call('butler_task', { action: 'open', title: 'Previously active' })
  const target = await e.call('butler_task', { action: 'open', title: 'Explicit PDF target' })
  await e.call('butler_task', { action: 'activate', id: first.task.id })
  const source = join(home, `target-${crypto.randomUUID()}.pdf`)
  writeFileSync(source, fourPagePdf())
  const output = await e.call('butler_pdf', { action: 'read', path: source, taskId: target.task.id, pages: [4] })
  assert.equal(output.ok, true)
  assert.equal(e.evidence.resolve(output.evidenceIds, target.task.id)[0].taskId, target.task.id)
  assert.throws(() => e.evidence.resolve(output.evidenceIds, first.task.id))
})
