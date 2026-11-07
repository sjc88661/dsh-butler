import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'api-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { ensureVault, vaultPath, statePath, sha256, writeText } = await import('../src/host/vault.ts')
const { registerButlerApi } = await import('../src/host/api.ts')
const { upsertTask, addReceipt, addUsage, addUsageBatch, listTasks, addMemo, listMemos } = await import('../src/host/ledger.ts')
const { EvidenceStore } = await import('../src/host/evidence-store.ts')
const { TaskBudgets } = await import('../src/host/budget.ts')
const { ReminderOperations } = await import('../src/host/reminder-operations.ts')
const { installRuntimeControls } = await import('../src/host/runtime-controls.ts')
ensureVault()

function api(deps = {}) {
  const routes = new Map()
  const dispose = registerButlerApi({ webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } } }, { timeZone: 'Asia/Shanghai', ...deps })
  async function request(path, method = 'GET', body) {
    const handler = routes.get(path.split('?')[0]); assert.equal(typeof handler, 'function', `Read route is missing: ${path}`)
    const req = Object.assign(new EventEmitter(), { method, url: path }), headers = {}
    let response
    const pending = handler(req, { statusCode: 200, setHeader(name, value) { headers[name] = value }, end(value) { response = { status: this.statusCode, body: value === undefined ? undefined : JSON.parse(value), headers } } })
    if (body !== undefined) {
      const payload = Buffer.from(JSON.stringify(body))
      setImmediate(() => { req.emit('data', payload); req.emit('end') })
    }
    await pending
    return response
  }
  return { request, dispose, routes }
}
const report = (taskId, sessionId = 'same-session') => ({ taskId, sessionId, kind: 'normal', startedAt: 1000,
  requests: 2, tokens: 30, reservedTokens: 40, pending: { pending: 40 }, failures: {},
  limits: { maxRequests: 7, maxTokens: 1000, maxMs: 10000, maxOutputTokens: 50, maxFailures: 2 },
  remaining: { requests: 5, tokens: 930, ms: 8000 }, inFlight: 1 })

test('runtime snapshots expose effective limits and distinguish settled counts from in-flight reservation without mutating a stopped run', () => {
  let now = 1000
  const budgets = new TaskBudgets({ now: () => now, normal: { maxRequests: 7, maxTokens: 1000, maxMs: 10000, maxOutputTokens: 50, maxFailures: 2 } })
  budgets.begin('budget-ui', { humanMessageId: 'source-ui' })
  const first = budgets.admit('budget-ui', 50, 20); budgets.finish(first, 30)
  budgets.admit('budget-ui', 30, 10); now += 2000
  const controls = installRuntimeControls({ on() { return () => {} }, get() {}, logger: {} }, { budgets })
  const snapshot = controls.status()
  assert.equal(snapshot.budgetReports?.length, 1, 'Workbench requires the effective budget, not guessed defaults')
  const entry = snapshot.budgetReports[0]
  assert.deepEqual(entry.limits, { maxRequests: 7, maxTokens: 1000, maxMs: 10000, maxOutputTokens: 50, maxFailures: 2 })
  assert.deepEqual(entry.remaining, { requests: 5, tokens: 930, ms: 8000 })
  assert.equal(entry.tokens, 30); assert.equal(entry.reservedTokens, 40); assert.equal(entry.inFlight, 1)
  budgets.observeTool('budget-ui', 'native-write', false); budgets.observeTool('budget-ui', 'native-write', false)
  const before = budgets.status('budget-ui')
  const stopped = controls.status().budgetReports[0]
  assert.equal(stopped.blocked, '工具 native-write 连续失败 2 次')
  assert.deepEqual(stopped.remaining, { requests: 0, tokens: 0, ms: 0 })
  assert.deepEqual(budgets.status('budget-ui'), before, 'A dashboard read must not restart or clear a stopped budget')
  controls.stop()
})

test('overview surfaces an unavailable control snapshot alongside a readable ledger', async () => {
  const e = api({ runtimeControls() { throw Error('runtime snapshot unavailable') } })
  const response = await e.request('/dsh-butler/api/overview')
  assert.equal(response.status, 200)
  assert.ok(response.body.ledger)
  assert.equal(response.body.runtimeControls.active, false)
  assert.equal(response.body.runtimeControls.blocked, true)
  assert.match(response.body.runtimeControls.error, /runtime snapshot unavailable/)
  e.dispose()
})

test('overview keeps completed tasks and memory health visible, and preserves unreadable memo bytes', async () => {
  const id = `completed-${randomUUID()}`
  upsertTask(id, { title: 'A completed task can still be inspected', status: 'done' })
  const e = api()
  const response = await e.request('/dsh-butler/api/overview')
  assert.equal(response.body.taskHistory.tasks.find(row => row.id === id).status, 'done')
  assert.equal(typeof response.body.memory?.counts?.confirmed, 'number', 'Memory availability must be explicit, not hidden behind proposed cards')
  const file = statePath('memos.json'), original = existsSync(file) ? readFileSync(file) : undefined
  writeFileSync(file, '{broken-memos')
  try {
    const damaged = await e.request('/dsh-butler/api/overview')
    assert.equal(damaged.status, 200)
    assert.equal(damaged.body.memory, undefined)
    assert.match(damaged.body.memoryError, /损坏|degraded|JSON/)
    assert.equal(readFileSync(file, 'utf8'), '{broken-memos')
  } finally { if (original) writeFileSync(file, original); else unlinkSync(file); e.dispose() }
})

test('task detail joins only exact task identities and reads history using the persisted destination, preserving unknown usage', async () => {
  const id = `detail-${randomUUID()}`, other = `other-${randomUUID()}`, run = `run-${randomUUID()}`
  const task = upsertTask(id, { title: 'Read the actual result', runId: run, sessionId: 'same-session', status: 'pending', kind: 'reminder',
    reminder: { executionKey: 'owned-operation', requestDigest: 'owned-request', scheduleId: 'owned-rule', destinationSessionId: 'session-butler-reminder-owned',
      confirmedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', creationState: 'committed', deliveryState: 'scheduled' } })
  upsertTask(other, { title: 'Other task in the same session', sessionId: 'same-session', runId: 'other-run' })
  const artifact = vaultPath('notes', `${id}.md`); writeFileSync(artifact, 'A real file from this task.')
  const evidence = new EvidenceStore()
  const evidenceId = evidence.registerFile({ path: artifact }, { sessionId: 'same-session', taskId: id, runId: run, callId: `file-${id}` })
  addReceipt({ taskId: id, sessionId: 'same-session', runId: run, callId: 'mine', tool: 'write', ok: true, artifacts: [{ path: artifact, sha256: sha256(readFileSync(artifact)) }] })
  addReceipt({ taskId: other, sessionId: 'same-session', runId: 'other-run', callId: 'not-mine', tool: 'send_email', ok: false, error: 'Other task failure' })
  addUsage({ taskId: id, sessionId: 'same-session', runId: run, turn: 1, step: 1, eventSeq: 101, inputTokens: 20, outputTokens: 10, totalTokens: 30, provider: 'unpriced', model: 'unpriced' })
  addUsage({ taskId: id, sessionId: 'same-session', runId: run, turn: 1, step: 2, eventSeq: 102, usageState: 'unknown' })
  addUsage({ taskId: other, sessionId: 'same-session', runId: 'other-run', turn: 1, step: 3, eventSeq: 103, inputTokens: 500, outputTokens: 100, totalTokens: 600 })
  const historyCalls = []
  const e = api({ runtimeControls: () => ({ active: true, taskBudgets: [], budgetReports: [report(run), report('other-run')] }),
    schedule: { catalog: () => [], history: async request => { historyCalls.push(request); return { records: [{ scheduledAt: '2026-10-15T10:00:00Z', deliveredAt: '2026-10-15T10:00:01Z', messageId: 'native-delivery' }] } } } })
  const response = await e.request(`/dsh-butler/api/task?id=${encodeURIComponent(id)}&sessionId=foreign&scheduleId=foreign`)
  assert.equal(response.status, 200)
  const detail = response.body
  assert.equal(detail.task.id, task.id)
  assert.deepEqual(detail.receipts.map(row => row.callId), ['mine'])
  assert.deepEqual(detail.evidence.map(row => row.evidenceId), [evidenceId])
  assert.equal(detail.artifacts[0].path, artifact)
  assert.equal(detail.usage.calls, 2); assert.equal(detail.usage.totalTokens, 30); assert.equal(detail.usage.withoutUsage, 1)
  assert.equal(detail.usage.pricedCalls, 0); assert.equal(detail.usageRecords.length, 2)
  assert.deepEqual(detail.budgets.map(row => row.taskId), [run], 'Business task ID and execution budget ID must not be interchanged')
  assert.deepEqual(historyCalls, [{ id: 'owned-rule', limit: 20 }])
  assert.equal(detail.reminder.history.available, true)
  assert.equal(detail.reminder.history.deliveryState, 'delivered')
  assert.equal(detail.reminder.history.records[0].messageId, 'native-delivery')
  assert.equal(detail.task.status, 'pending', 'Read-only history does not rewrite business completion')
  assert.equal(response.headers['cache-control'], 'no-store')
  e.dispose()
})

test('unavailable native history and damaged evidence remain visibly unknown without erasing the task or original bytes', async () => {
  const id = `degraded-${randomUUID()}`
  upsertTask(id, { title: 'A task remains readable', kind: 'reminder', reminder: { executionKey: id, requestDigest: id, scheduleId: 'native-rule', destinationSessionId: 'session-butler-reminder-degraded',
    confirmedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', creationState: 'committed', deliveryState: 'delivered' } })
  const file = statePath('evidence.json'), original = readFileSync(file)
  writeFileSync(file, '{damaged-evidence')
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  try {
    const e = api({ schedule: { catalog: () => [], history: async () => { throw Error('native history offline') } } })
    const response = await e.request(`/dsh-butler/api/task?id=${id}`)
    assert.equal(response.status, 200)
    assert.equal(response.body.task.id, id)
    assert.equal(response.body.evidenceAvailable, false)
    assert.equal(response.body.evidence, undefined, 'Unreadable evidence is not an invented empty list')
    assert.match(response.body.evidenceError, /损坏|degraded|JSON/)
    assert.equal(response.body.reminder.history.available, false)
    assert.equal(response.body.reminder.history.deliveryState, 'unknown')
    assert.match(response.body.reminder.history.reason, /native history offline/)
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), digest)
    e.dispose()
  } finally { writeFileSync(file, original) }
})

test('reminder read APIs expose external platform receipts without private destination identities or writes', async () => {
  const id = `outbound-${randomUUID()}`, at = '2026-10-21T03:00:00Z'
  const destination = { provider: 'lark', ownerId: 'private-owner', accountId: 'private-account', chatId: 'private-chat', senderId: 'private-sender' }
  const link = { executionKey: id, requestDigest: id, scheduleId: 'owned-outbound-rule', destinationSessionId: 'session-butler-reminder-outbound', confirmedAt: at,
    timeZone: 'Asia/Shanghai', creationState: 'committed', deliveryState: 'delivered', outboundDestination: destination }
  const task = upsertTask(id, { title: 'External receipt is separate', kind: 'reminder', reminder: link })
  const channelOrigin = { ...destination, messageId: 'platform-origin', nativeMessageId: 'native-origin', sessionId: 'source' }
  addReceipt({ taskId: id, runId: 'private-origin-run', channelOrigin, ownerId: destination.ownerId, tool: 'read', ok: true })
  addUsage({ taskId: id, runId: 'private-origin-run', channelOrigin, ownerId: destination.ownerId, sessionId: 'source', eventSeq: 1, totalTokens: 30 })
  const operation = { action: 'create', executionKey: id, taskId: id, state: 'committed', scheduleId: link.scheduleId, destinationSessionId: link.destinationSessionId,
    identity: { sessionId: 'source', callId: id, ownerId: destination.ownerId, channelOrigin: { ...destination, provider: 'lark' } }, sourceSessionId: 'source', requestDigest: id,
    timeZone: 'Asia/Shanghai', createdAt: at, updatedAt: at, task, outboundDestination: destination,
    actualReceipt: { id: link.scheduleId }, lastDelivery: { messageId: 'inbox-only', deliveredAt: at },
    outbound: [{ key: 'outbound-record', executionKey: id, taskId: id, scheduleId: link.scheduleId, sessionId: link.destinationSessionId, ownerId: destination.ownerId,
      destination, occurrenceMessageId: 'inbox-only', assistantEventSeq: 16, turnEndEventSeq: 18, state: 'delivered', createdAt: at, updatedAt: '2026-10-21T03:00:02Z',
      queuedText: 'PRIVATE_OUTBOUND_BODY', reason: 'private-chat PRIVATE_OUTBOUND_BODY failed',
      audit: [{ at, kind: 'send-failed', destination }, { at, kind: 'reconcile-verified', queuedText: 'PRIVATE_OUTBOUND_BODY' }],
      receipt: { messageId: 'platform-only', chunkIds: ['platform-only'], chatId: destination.chatId } }] }
  const original = JSON.stringify(operation), before = readFileSync(vaultPath('ledger', 'tasks.jsonl'))
  const e = api({ reminderOperations: () => [operation], runtimeControls: () => ({ active: true, reminderOperations: [operation] }),
    schedule: { catalog: () => [], history: () => ({ records: [{ messageId: 'inbox-only', deliveredAt: at }] }) } })
  try {
    const detail = (await e.request(`/dsh-butler/api/task?id=${id}`)).body
    assert.equal(detail.reminder.history.records[0].messageId, 'inbox-only')
    assert.ok(Array.isArray(detail.reminder.outbound), 'Task reminders need a separate external receipt projection')
    assert.equal(detail.reminder.outbound[0].receipt.messageId, 'platform-only')
    assert.equal(detail.reminder.outbound[0].updatedAt, '2026-10-21T03:00:02Z')
    assert.equal(detail.reminder.outbound[0].provider, 'lark')
    assert.deepEqual(detail.reminder.outbound[0].failure, { kind: 'send-failed', at })
    assert.deepEqual(detail.reminder.outbound[0].audit, [{ at, kind: 'send-failed' }, { at, kind: 'reconcile-verified' }])
    const history = (await e.request(historyUrl('reminderOperations', id))).body
    const overview = (await e.request('/dsh-butler/api/overview')).body
    const receipts = (await e.request(historyUrl('receipts', id))).body
    const usage = (await e.request(historyUrl('usageRecords', id))).body
    for (const payload of [detail, history, overview, receipts, usage]) assert.ok(!/private-(owner|account|chat|sender)|PRIVATE_OUTBOUND_BODY/.test(JSON.stringify(payload)), 'Private transport identities and outbound bodies do not belong in workbench read responses')
    assert.equal(JSON.stringify(operation), original)
    assert.deepEqual(readFileSync(vaultPath('ledger', 'tasks.jsonl')), before)
  } finally { e.dispose() }
})

test('one business task shows budgets for its recorded runs without inheriting another task in the same session', async () => {
  const id = `multi-run-${randomUUID()}`, origin = `origin-${randomUUID()}`, delivery = `delivery-${randomUUID()}`, resumed = `resumed-${randomUUID()}`
  upsertTask(id, { title: 'Work continued across native runs', runId: origin, sessionId: 'shared-session' })
  addReceipt({ taskId: id, sessionId: 'shared-session', runId: resumed, callId: `resume-${id}`, tool: 'read', ok: true })
  addUsage({ taskId: id, sessionId: 'isolated-reminder-session', runId: delivery, turn: 1, step: 1, eventSeq: 201, usageState: 'unknown' })
  const e = api({ runtimeControls: () => ({ active: true, taskBudgets: [], budgetReports: [report(origin), report(resumed), report(delivery, 'isolated-reminder-session'), report('foreign-run', 'shared-session')] }) })
  const response = await e.request(`/dsh-butler/api/task?id=${id}`)
  assert.equal(response.status, 200)
  assert.deepEqual(new Set(response.body.budgets.map(row => row.taskId)), new Set([origin, resumed, delivery]), 'Run membership must come from task identity in recorded work, never shared session alone')
  e.dispose()
})

test('task endpoint rejects writes, missing and unknown IDs without changing the task ledger', async () => {
  const e = api(), file = vaultPath('ledger', 'tasks.jsonl'), before = readFileSync(file)
  assert.equal((await e.request('/dsh-butler/api/task?id=unknown', 'POST')).status, 405)
  assert.equal((await e.request('/dsh-butler/api/task')).status, 400)
  assert.equal((await e.request('/dsh-butler/api/task?id=unknown')).status, 404)
  assert.deepEqual(readFileSync(file), before)
  e.dispose(); assert.equal(e.routes.size, 0)
})

function fixtureBytes(directory = home) {
  const files = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(files, fixtureBytes(path))
    else files[path] = readFileSync(path).toString('base64')
  }
  return files
}
function historyUrl(kind, taskId, query = '') {
  return `/dsh-butler/api/history?kind=${kind}${taskId === undefined ? '' : `&taskId=${encodeURIComponent(taskId)}`}${query}`
}
function historyBudget(taskId, current = false) {
  const { limits, remaining, inFlight, ...state } = report(taskId)
  return { ...state, current }
}

async function artifactViews(id, expectedCount) {
  const e = api()
  try {
    const before = fixtureBytes(), detail = await e.request(`/dsh-butler/api/task?id=${encodeURIComponent(id)}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.artifactCount, expectedCount)
    assert.equal(detail.body.artifacts.length, expectedCount)
    const first = await e.request(historyUrl('artifacts', id, '&limit=1'))
    assert.equal(first.status, 200); assert.equal(first.body.total, expectedCount)
    const items = [...first.body.items]
    let page = first
    while (page.body.nextOffset !== undefined) {
      page = await e.request(historyUrl('artifacts', id, `&limit=1&offset=${page.body.nextOffset}&revision=${first.body.revision}`))
      assert.equal(page.status, 200); assert.equal(page.body.total, expectedCount)
      assert.equal(page.body.revision, first.body.revision)
      items.push(...page.body.items)
    }
    const ordered = rows => [...rows].sort((a, b) => JSON.stringify([a.path, a.reference, a.sha256]).localeCompare(JSON.stringify([b.path, b.reference, b.sha256])))
    assert.deepEqual(ordered(items), ordered(detail.body.artifacts), 'Detail and paginated history must expose the same artifacts')
    assert.deepEqual((await e.request(historyUrl('artifacts', id, '&limit=1'))).body, first.body)
    assert.deepEqual(fixtureBytes(), before, 'Artifact projection must preserve every saved byte')
    return detail.body
  } finally { e.dispose() }
}

for (const evidenceFirst of [false, true]) test(`artifact projections merge an unhashed receipt with file evidence recorded ${evidenceFirst ? 'before' : 'after'} it`, async () => {
  const id = `artifact-single-${randomUUID()}`, path = vaultPath('notes', `${id}.md`), content = 'One actual artifact.'
  upsertTask(id, { title: 'Native receipt and evidence describe one file' })
  writeFileSync(path, content)
  const evidence = new EvidenceStore()
  let evidenceId
  const saveEvidence = () => { evidenceId = evidence.registerFile({ path }, { taskId: id, runId: id, sessionId: 'artifact-session', callId: id }) }
  if (evidenceFirst) saveEvidence()
  addReceipt({ taskId: id, tool: 'write', ok: true, artifacts: [{ path }] })
  if (!evidenceFirst) saveEvidence()
  const detail = await artifactViews(id, 1)
  assert.equal(detail.evidenceCount, 1)
  assert.deepEqual(detail.artifacts, [{ path, kind: 'file', evidenceId, sha256: sha256(Buffer.from(content)) }])
})

test('artifact projections count two unhashed receipt files with their evidence before pagination', async () => {
  const id = `artifact-pair-${randomUUID()}`, evidence = new EvidenceStore()
  upsertTask(id, { title: 'Two actual files have two artifacts' })
  const paths = ['first', 'second'].map(name => vaultPath('notes', `${id}-${name}.md`))
  for (const path of paths) writeFileSync(path, `Actual file ${path}`)
  addReceipt({ taskId: id, tool: 'write', ok: true, artifacts: paths.map(path => ({ path })) })
  for (const path of paths) evidence.registerFile({ path }, { taskId: id, runId: id, sessionId: 'artifact-session', callId: path })
  const detail = await artifactViews(id, 2)
  assert.equal(detail.evidenceCount, 2)
  assert.deepEqual(detail.artifacts.map(row => row.path).sort(), [...paths].sort())
  assert.ok(detail.artifacts.every(row => row.sha256 && row.evidenceId))
})

test('artifact projections merge native RIS and BIB file references with saved path evidence', async () => {
  const id = `artifact-native-${randomUUID()}`, evidence = new EvidenceStore(), expected = []
  upsertTask(id, { title: 'Native literature receipts and saved evidence describe two files' })
  for (const [extension, content] of [['ris', 'TY  - JOUR\nTI  - Actual reference\nER  -\n'], ['bib', '@article{actual,title={Actual reference}}\n']]) {
    const path = vaultPath('notes', `${id}.${extension}`)
    writeFileSync(path, content)
    addReceipt({ taskId: id, tool: 'butler_literature', ok: true, artifacts: [{ kind: 'file', reference: path }] })
    const evidenceId = evidence.registerFile({ path }, { taskId: id, runId: id, sessionId: 'native-artifact-session', callId: extension })
    expected.push({ kind: 'file', reference: path, path, sha256: sha256(Buffer.from(content)), evidenceId })
  }
  const detail = await artifactViews(id, 2)
  assert.equal(detail.evidenceCount, 2)
  assert.deepEqual(detail.artifacts, expected, 'Each native reference must retain the matching saved SHA256, evidence ID, and path')
  assert.ok(detail.receipts.every(row => row.artifacts.every(artifact => artifact.kind === 'file' && artifact.reference && artifact.path === undefined && artifact.sha256 === undefined)))
})

test('artifact projections keep generic references separate from explicit local files', async () => {
  for (const kind of [undefined, 'source']) {
    const id = `artifact-generic-${randomUUID()}`, path = 'E:\\fixture\\references\\actual.ris', hash = 'a'.repeat(64)
    upsertTask(id, { title: 'Only an explicit file reference names a local file' })
    const file = { kind: 'file', path, sha256: hash }, generic = { reference: path, sha256: hash, ...(kind === undefined ? {} : { kind }) }
    addReceipt({ taskId: id, tool: 'write', ok: true, artifacts: [file, generic, { kind: 'file', reference: path, sha256: hash }] })
    const detail = await artifactViews(id, 2)
    assert.deepEqual(detail.artifacts, [{ ...file, reference: path }, generic])
  }
})

for (const unhashedFirst of [false, true]) test(`artifact projections preserve both saved hashes with an unhashed receipt ${unhashedFirst ? 'first' : 'last'}`, async () => {
  const id = `artifact-revisions-${randomUUID()}`, path = vaultPath('notes', `${id}.md`), evidence = new EvidenceStore(), revisions = []
  upsertTask(id, { title: 'Historical artifact revisions remain visible' })
  for (const content of ['Earlier file revision.', 'Later file revision.']) {
    writeFileSync(path, content)
    revisions.push({ sha256: sha256(Buffer.from(content)), evidenceId: evidence.registerFile({ path }, { taskId: id, runId: id, sessionId: 'artifact-session', callId: content }) })
  }
  const known = revisions.map(row => ({ path, sha256: row.sha256 })), unhashed = [{ path }, { path, sha256: '' }]
  addReceipt({ taskId: id, tool: 'write', ok: true, artifacts: unhashedFirst ? [...unhashed, ...known] : [...known, ...unhashed] })
  const detail = await artifactViews(id, 2)
  assert.equal(detail.evidenceCount, 2, 'Neither historical evidence record may disappear')
  assert.deepEqual(detail.artifacts.map(({ sha256, evidenceId }) => ({ sha256, evidenceId })).sort((a, b) => a.sha256.localeCompare(b.sha256)),
    [...revisions].sort((a, b) => a.sha256.localeCompare(b.sha256)))
})

test('artifact projections keep exact paths and independent references separate despite matching hashes', async () => {
  const id = `artifact-locations-${randomUUID()}`, hash = 'a'.repeat(64)
  upsertTask(id, { title: 'Location identity is exact and does not normalize the filesystem' })
  const artifacts = [
    { path: 'E:/fixture/one/report.md', sha256: hash }, { path: 'E:/fixture/two/report.md', sha256: hash },
    { path: 'E:/Fixture/one/report.md', sha256: hash }, { path: 'E:\\fixture\\one\\report.md', sha256: hash },
    { reference: 'artifact:one', sha256: hash }, { reference: 'artifact:two', sha256: hash },
    { reference: 'E:/fixture/one/report.md', sha256: hash },
  ]
  addReceipt({ taskId: id, tool: 'write', ok: true, artifacts })
  const detail = await artifactViews(id, artifacts.length)
  assert.deepEqual(detail.artifacts, artifacts)
})

test('artifact projections preserve global first-seen order for interleaved revisions', async () => {
  const id = `artifact-order-${randomUUID()}`, a = 'E:/fixture/a.md', b = 'E:/fixture/b.md'
  upsertTask(id, { title: 'Interleaved revisions retain their first-seen positions' })
  const first = { path: a, sha256: 'a'.repeat(64) }, second = { path: b, sha256: 'b'.repeat(64) }, third = { path: a, sha256: 'c'.repeat(64) }
  addReceipt({ taskId: id, tool: 'write', ok: true, artifacts: [
    { path: b, kind: 'native-file' }, first, second, third, { ...first, kind: 'known-file' },
  ] })
  const detail = await artifactViews(id, 3)
  assert.deepEqual(detail.artifacts, [{ ...first, kind: 'known-file' }, { ...second, kind: 'native-file' }, third],
    'Absorbing an unhashed entry and updating metadata must not regroup or move surviving revisions')
})

test('task history covers more than 50 tasks with stable tied ordering and read-only revision paging', async () => {
  const tied = '2026-10-20T00:00:00.000Z'
  const existing = listTasks()
  const extra = Array.from({ length: 57 }, (_, i) => ({ id: `page-task-${String(i).padStart(3, '0')}`, title: 'A recorded task', status: 'done', createdAt: tied, updatedAt: tied }))
  writeFileSync(vaultPath('ledger', 'tasks.jsonl'), [...existing, ...extra].map(row => JSON.stringify(row)).join('\n') + '\n')
  const e = api({ session() { throw Error('History must not create a session') }, runtimeControls() { throw Error('Unrelated controls must not be queried') } })
  try {
    const before = fixtureBytes(), first = await e.request(historyUrl('tasks'))
    assert.equal(first.status, 200)
    assert.equal(first.body.kind, 'tasks'); assert.equal(first.body.limit, 50)
    assert.match(first.body.revision, /^[a-f0-9]{64}$/)
    const expected = [...existing, ...extra].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(row => row.id)
    assert.equal(first.body.total, expected.length); assert.equal(first.body.nextOffset, 50)
    const second = await e.request(historyUrl('tasks', undefined, `&offset=50&revision=${first.body.revision}`))
    assert.equal(second.status, 200); assert.equal(second.body.nextOffset, undefined)
    assert.deepEqual([...first.body.items, ...second.body.items].map(row => row.id), expected)
    assert.deepEqual((await e.request(historyUrl('tasks'))).body, first.body, 'Generated time must not make revisions or page content drift')
    assert.deepEqual(fixtureBytes(), before)
    writeFileSync(vaultPath('ledger', 'tasks.jsonl'), [...existing, ...extra, { ...extra[0], id: 'changed-page-task' }].map(row => JSON.stringify(row)).join('\n') + '\n')
    const changed = await e.request(historyUrl('tasks', undefined, `&offset=50&revision=${first.body.revision}`))
    assert.equal(changed.status, 409)
    assert.deepEqual(changed.body, { ok: false, code: 'HISTORY_CHANGED', error: '历史已变化，请刷新后重新翻页' })
  } finally { e.dispose() }
})

test('history validates pagination and scope before source access and rejects unknown tasks', async () => {
  const e = api()
  try {
    const invalid = ['kind=unknown', 'kind=tasks&offset=-1', 'kind=tasks&offset=1.5', 'kind=tasks&offset=1e2',
      'kind=tasks&offset=1', 'kind=tasks&limit=0', 'kind=tasks&limit=101', 'kind=tasks&limit=1.5',
      'kind=tasks&offset=', 'kind=tasks&limit=', 'kind=tasks&revision=bad', 'kind=receipts', 'kind=recentReceipts&taskId=forbidden',
      'kind=usageRecords&taskId=', `kind=evidence&taskId=${'a'.repeat(257)}`, 'kind=tasks&kind=budgets']
    for (const query of invalid) assert.equal((await e.request(`/dsh-butler/api/history?${query}`)).status, 400, query)
    assert.equal((await e.request('/dsh-butler/api/history')).status, 400)
    assert.equal((await e.request(historyUrl('tasks'), 'POST')).status, 405)
    assert.equal((await e.request(historyUrl('receipts', 'unknown-history-task'))).status, 404)
  } finally { e.dispose() }
})

test('full task history paginates exact collections after association and artifact deduplication, preserving all summaries', async () => {
  const id = `large-${randomUUID()}`, other = `foreign-${randomUUID()}`, same = 'same-large-session', tied = '2026-10-20T00:00:00.000Z'
  upsertTask(id, { title: 'More than one history page', sessionId: same, runId: 'large-origin', kind: 'reminder' })
  upsertTask(other, { title: 'Same session is not identity', sessionId: same, runId: 'foreign-large-run' })
  const evidence = new EvidenceStore(), rows = [], budgetRows = [historyBudget('large-origin'), historyBudget('foreign-large-run', true)]
  for (let i = 0; i < 105; i++) {
    const runId = `large-run-${String(i).padStart(3, '0')}`
    addReceipt({ taskId: id, runId, sessionId: same, callId: `large-call-${i}`, at: tied, tool: 'read', ok: true,
      artifacts: [{ path: `E:/fixture/${i}.txt`, sha256: 'a'.repeat(64) }, { path: 'E:/fixture/shared.txt', sha256: 'b'.repeat(64) }] })
    rows.push({ taskId: id, runId, sessionId: same, eventSeq: 1000 + i, at: tied, inputTokens: 2, outputTokens: 1, totalTokens: 3 })
    evidence.registerReceipt({ tool: 'read', ok: true, summary: `receipt-${i}` }, { taskId: id, sessionId: same, runId, callId: `evidence-${i}`, at: tied })
    budgetRows.push(historyBudget(runId))
  }
  addReceipt({ taskId: other, runId: 'foreign-large-run', sessionId: same, at: tied, tool: 'foreign', ok: false, artifacts: [{ path: 'foreign.txt' }] })
  addReceipt({ at: tied, tool: 'legacy-unassigned-history', ok: true })
  rows.push({ taskId: other, runId: 'foreign-large-run', sessionId: same, eventSeq: 3000, at: tied, totalTokens: 9999 })
  addUsageBatch(rows)
  evidence.registerReceipt({ tool: 'foreign', ok: true }, { taskId: other, sessionId: same, runId: 'foreign-large-run', callId: 'foreign-large-evidence' })
  let nativeQueries = 0, operationQueries = 0
  const e = api({ budgetHistory: () => budgetRows, runtimeControls: () => ({ active: true, budgetReports: [report('large-origin'), report('foreign-large-run')] }),
    reminderOperations: () => { operationQueries++; return [] },
    schedule: { catalog: () => [], history: () => { nativeQueries++; throw Error('Unrelated native history must not be queried') } } })
  try {
    const before = fixtureBytes()
    for (const [kind, total] of [['receipts', 105], ['usageRecords', 105], ['evidence', 105], ['artifacts', 106], ['taskBudgets', 106]]) {
      const first = await e.request(historyUrl(kind, id)), second = await e.request(historyUrl(kind, id, `&offset=100&revision=${first.body.revision}`))
      assert.equal(first.status, 200, kind); assert.equal(second.status, 200, kind)
      assert.equal(first.body.total, total, kind); assert.equal(first.body.items.length, 100, kind)
      assert.equal(second.body.items.length, total - 100, kind); assert.equal(second.body.nextOffset, undefined)
      const all = [...first.body.items, ...second.body.items]
      if (kind === 'artifacts') assert.equal(new Set(all.map(row => row.path)).size, 106)
      else if (kind === 'taskBudgets') assert.ok(all.every(row => row.taskId.startsWith('large-')))
      else assert.ok(all.every(row => row.taskId === id), kind)
    }
    const recent = await e.request(historyUrl('recentReceipts'))
    assert.equal(recent.status, 200, 'Global saved receipts must include rows without a task ID')
    assert.equal(recent.body.limit, 100); assert.ok(recent.body.total > 100)
    const recentNext = await e.request(historyUrl('recentReceipts', undefined, `&offset=100&revision=${recent.body.revision}`))
    assert.equal(recentNext.status, 200)
    const legacy = [...recent.body.items, ...recentNext.body.items].find(row => row.tool === 'legacy-unassigned-history')
    assert.ok(legacy); assert.equal(legacy.taskId, undefined, 'Legacy receipts must not acquire guessed task membership')
    assert.equal(nativeQueries, 0); assert.equal(operationQueries, 0, 'Unrelated pages must not read reminder operations')
    const detail = await e.request(`/dsh-butler/api/task?id=${id}`)
    assert.equal(detail.body.receiptCount, 105); assert.equal(detail.body.evidenceCount, 105); assert.equal(detail.body.artifactCount, 106)
    assert.equal(detail.body.usageRecordCount, 105); assert.equal(detail.body.usage.calls, 105); assert.equal(detail.body.usage.totalTokens, 315)
    assert.equal(detail.body.budgetHistory.length, 106, 'Association must include run IDs beyond the first collection page')
    assert.deepEqual(detail.body.budgets.map(row => row.taskId), ['large-origin'])
    assert.deepEqual(fixtureBytes(), before)
  } finally { e.dispose() }
})

test('saved global budgets page every recorded run without invented policy or runtime countdown revisions', async () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ ...historyBudget(`history-budget-${i}`, i === 13), startedAt: 1000 }))
  const e = api({ budgetHistory: () => rows, runtimeControls() { throw Error('Saved history does not need current reports') } })
  try {
    const first = await e.request(historyUrl('budgets'))
    assert.equal(first.status, 200); assert.equal(first.body.total, 14); assert.equal(first.body.limit, 12)
    assert.ok(first.body.items.every(row => row.limits === undefined && row.remaining === undefined))
    const second = await e.request(historyUrl('budgets', undefined, `&offset=12&revision=${first.body.revision}`))
    assert.equal(second.status, 200); assert.equal(second.body.items.length, 2)
    assert.deepEqual((await e.request(historyUrl('budgets'))).body, first.body)
    rows[0].tokens++
    assert.equal((await e.request(historyUrl('budgets', undefined, `&offset=12&revision=${first.body.revision}`))).status, 409)
  } finally { e.dispose() }
})

test('local reminder operations stay readable when controls fail and missing operations are explicit', async () => {
  const id = `operation-${randomUUID()}`, other = `operation-other-${randomUUID()}`
  upsertTask(id, { title: 'Local operation is independent', kind: 'reminder' })
  const operation = { action: 'cancel', taskId: id, executionKey: 'cancel-operation', identity: { sessionId: 'source', callId: 'cancel' }, requestDigest: 'a'.repeat(64),
    state: 'uncertain', sourceSessionId: 'source', timeZone: 'Asia/Shanghai', scheduleId: 'native-rule', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
    reason: 'Awaiting native confirmation', actualReceipt: { id: 'native-rule', deleted: false } }
  const e = api({ runtimeControls() { throw Error('controls offline') }, reminderOperations: () => [operation, { ...operation, taskId: other, executionKey: 'foreign-operation' }] })
  try {
    const detail = await e.request(`/dsh-butler/api/task?id=${id}`)
    assert.equal(detail.status, 200); assert.equal(detail.body.reminderOperationsAvailable, true)
    assert.deepEqual(detail.body.reminderOperations, [operation]); assert.match(detail.body.controlsError, /controls offline/)
    const page = await e.request(historyUrl('reminderOperations', id))
    assert.equal(page.status, 200); assert.deepEqual(page.body.items, [operation])
  } finally { e.dispose() }
  for (const deps of [{}, { reminderOperations() { throw Error('operation source unreadable') } }]) {
    const unavailable = api(deps)
    try {
      const detail = await unavailable.request(`/dsh-butler/api/task?id=${id}`)
      assert.equal(detail.status, 200); assert.equal(detail.body.reminderOperationsAvailable, false)
      assert.equal(typeof detail.body.reminderOperationsError, 'string')
      const page = await unavailable.request(historyUrl('reminderOperations', id))
      assert.equal(page.status, 503); assert.equal(page.body.ok, false); assert.equal(page.body.items, undefined)
    } finally { unavailable.dispose() }
  }
  const fallback = api({ runtimeControls: () => ({ active: true, reminderOperations: [operation] }) })
  try { assert.deepEqual((await fallback.request(historyUrl('reminderOperations', id))).body.items, [operation]) }
  finally { fallback.dispose() }
})

test('history source failures are explicit and preserve damaged fixture bytes', async () => {
  const id = `bad-history-${randomUUID()}`
  upsertTask(id, { title: 'Source damage is not empty history', runId: 'damaged-budget-run' })
  const e = api({ budgetHistory() { throw Error('budget source unavailable') } })
  try {
    for (const [kind, file, damage] of [['tasks', vaultPath('ledger', 'tasks.jsonl'), '{damaged-task'],
      ['recentReceipts', vaultPath('ledger', 'receipts.jsonl'), '{damaged-global-receipt'],
      ['receipts', vaultPath('ledger', 'receipts.jsonl'), '{damaged-receipt'],
      ['usageRecords', vaultPath('ledger', 'usage.jsonl'), '{damaged-usage'],
      ['evidence', statePath('evidence.json'), '{damaged-evidence'],
      ['artifacts', statePath('evidence.json'), '{damaged-artifact-evidence']]) {
      const original = readFileSync(file)
      writeFileSync(file, damage)
      try {
        const before = fixtureBytes(), response = await e.request(historyUrl(kind, ['tasks', 'recentReceipts'].includes(kind) ? undefined : id))
        assert.equal(response.status, 503, kind); assert.equal(response.body.ok, false); assert.equal(response.body.items, undefined)
        assert.deepEqual(fixtureBytes(), before, kind)
      } finally { writeFileSync(file, original) }
    }
    for (const kind of ['budgets', 'taskBudgets']) assert.equal((await e.request(historyUrl(kind, kind === 'budgets' ? undefined : id))).status, 503)
    const detail = await e.request(`/dsh-butler/api/task?id=${id}`)
    assert.equal(detail.body.budgetHistory, undefined); assert.match(detail.body.budgetHistoryError, /budget source unavailable/)
  } finally { e.dispose() }
})

test('history reads never replay a pending WAL transaction or rewrite saved sources', async () => {
  const id = `pending-wal-${randomUUID()}`
  upsertTask(id, { title: 'Saved before recovery', runId: 'pending-wal-run' })
  const operations = new ReminderOperations({ file: statePath('history-operations.json'), schedule: () => undefined, destination: async () => 'unused' })
  const tasks = vaultPath('ledger', 'tasks.jsonl'), journal = statePath('store-operations.jsonl')
  const saved = readFileSync(tasks), journalBefore = readFileSync(journal)
  const content = saved.toString('utf8').split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line)
    return JSON.stringify(row.id === id ? { ...row, title: 'This recovery must not run during a dashboard read' } : row)
  }).join('\n') + '\n'
  const prepared = { version: 1, phase: 'prepared', operationId: `pending-${randomUUID()}`, targetId: id, kind: 'task.upsert', time: '2026-10-20T00:00:00Z',
    writes: [{ path: tasks, format: 'jsonl', content, beforeSha256: sha256(saved), afterSha256: sha256(Buffer.from(content)) }] }
  writeFileSync(journal, journalBefore.toString('utf8') + JSON.stringify(prepared) + '\n')
  const e = api({ budgetHistory: () => [historyBudget('pending-wal-run')], reminderOperations: () => operations.status({ recover: false }) })
  try {
    const before = fixtureBytes()
    for (const kind of ['tasks', 'budgets', 'recentReceipts', 'receipts', 'usageRecords', 'evidence', 'artifacts', 'taskBudgets', 'reminderOperations']) {
      const response = await e.request(historyUrl(kind, ['tasks', 'budgets', 'recentReceipts'].includes(kind) ? undefined : id))
      assert.ok([200, 503].includes(response.status), `${kind}: return saved rows or explicit unavailable`)
      assert.deepEqual(fixtureBytes(), before, `${kind} must not invoke WAL recovery`)
    }
    const detail = await e.request(`/dsh-butler/api/task?id=${id}`)
    assert.equal(detail.body.task.title, 'Saved before recovery')
    assert.deepEqual(fixtureBytes(), before, 'Task preview reads have the same no-recovery guarantee')
  } finally { writeFileSync(journal, journalBefore); e.dispose() }
})

test('overview polling preserves a prepared WAL and every saved byte across ledger and confirmed-memory reads', async () => {
  const id = `overview-wal-${randomUUID()}`
  upsertTask(id, { title: 'Saved overview task' })
  const tasks = vaultPath('ledger', 'tasks.jsonl'), memos = statePath('memos.json'), journal = statePath('store-operations.jsonl')
  const saved = readFileSync(tasks), savedMemos = existsSync(memos) ? readFileSync(memos) : undefined, journalBefore = readFileSync(journal)
  writeFileSync(memos, JSON.stringify([{ id: 'overview-confirmed-memo', text: 'Saved confirmed memo', source: 'user', status: 'confirmed', createdAt: '2026-10-20T00:00:00Z' }]))
  const content = saved.toString('utf8').split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line)
    return JSON.stringify(row.id === id ? { ...row, title: 'Overview must not recover this prepared write' } : row)
  }).join('\n') + '\n'
  const prepared = { version: 1, phase: 'prepared', operationId: `overview-pending-${randomUUID()}`, targetId: id, kind: 'task.upsert', time: '2026-10-20T00:00:00Z',
    writes: [{ path: tasks, format: 'jsonl', content, beforeSha256: sha256(saved), afterSha256: sha256(Buffer.from(content)) }] }
  writeFileSync(journal, journalBefore.toString('utf8') + JSON.stringify(prepared) + '\n')
  const e = api()
  try {
    const before = fixtureBytes(), response = await e.request('/dsh-butler/api/overview')
    assert.equal(response.status, 200)
    assert.equal(response.body.memory.entries[0].id, 'overview-confirmed-memo', 'Confirmed memory projection must be traversed during this read')
    assert.equal(response.body.taskHistory.tasks.find(row => row.id === id).title, 'Saved overview task', 'Overview must use saved task rows')
    assert.deepEqual(fixtureBytes(), before, 'Polling overview must not replay any prepared transaction or write a recovery commit')
  } finally { writeFileSync(tasks, saved); if (savedMemos) writeFileSync(memos, savedMemos); else unlinkSync(memos); writeFileSync(journal, journalBefore); e.dispose() }
})

test('task action route records done/postpone/cancel on the local ledger and refuses bad input', async () => {
  const doneId = `action-done-${randomUUID()}`
  upsertTask(doneId, { title: 'One-click done', status: 'pending' })
  const e = api()
  try {
    const done = await e.request('/dsh-butler/api/action', 'POST', { action: 'task-done', id: doneId })
    assert.equal(done.status, 200)
    assert.equal(done.body.ok, true)
    assert.equal(done.body.task.status, 'done')
    const history = await e.request('/dsh-butler/api/history?kind=tasks')
    assert.equal(history.body.items.find(row => row.id === doneId).status, 'done')

    const postponeId = `action-postpone-${randomUUID()}`
    upsertTask(postponeId, { title: 'One-click postpone', status: 'pending', dueAt: '2026-01-01T00:00:00.000Z' })
    const dueAt = '2030-01-02T03:04:00.000Z'
    const postponed = await e.request('/dsh-butler/api/action', 'POST', { action: 'task-postpone', id: postponeId, dueAt })
    assert.equal(postponed.body.task.status, 'pending')
    assert.equal(postponed.body.task.dueAt, dueAt)

    const cancelId = `action-cancel-${randomUUID()}`
    upsertTask(cancelId, { title: 'One-click cancel', status: 'waiting_review' })
    const cancelled = await e.request('/dsh-butler/api/action', 'POST', { action: 'task-cancel', id: cancelId, note: '用户取消' })
    assert.equal(cancelled.body.task.status, 'cancelled')

    assert.equal((await e.request('/dsh-butler/api/action', 'POST', { action: 'task-explode', id: doneId })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/action', 'POST', { action: 'task-done', id: 'missing-task' })).status, 404)
    assert.equal((await e.request('/dsh-butler/api/action', 'GET')).status, 405)
    assert.equal((await e.request('/dsh-butler/api/action', 'POST', { action: 'task-done' })).status, 400)
  } finally { e.dispose() }
})

test('task action route refuses archived fixtures instead of rewriting the archive', async () => {
  const archivedId = `action-archived-${randomUUID()}`
  upsertTask(archivedId, { title: 'Archived fixture', status: 'pending' })
  const index = vaultPath('archive', 'index.json')
  mkdirSync(dirname(index), { recursive: true })
  const previous = existsSync(index) ? readFileSync(index) : undefined
  const batches = previous === undefined ? [] : JSON.parse(previous).batches ?? []
  writeFileSync(index, JSON.stringify({ version: 1, batches: [...batches, { batchId: `test-${randomUUID()}`,
    tasks: [{ id: archivedId, reason: 'test fixture', matchedBy: 'DSH007' }], reminders: [], receipts: [] }] }))
  const e = api()
  try {
    const refused = await e.request('/dsh-butler/api/action', 'POST', { action: 'task-done', id: archivedId })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error, /归档/)
  } finally {
    if (previous === undefined) unlinkSync(index); else writeFileSync(index, previous)
    e.dispose()
  }
})

test('due reminder slice returns only active overdue rules and reports scheduler availability', async () => {
  const now = Date.now()
  const catalog = [
    { id: 'due-overdue', title: '吃药', kind: 'at', scheduledAt: new Date(now - 60000).toISOString(), status: 'active', target: { kind: 'session', sessionId: 's' } },
    { id: 'due-future', title: '未来的提醒', kind: 'at', scheduledAt: new Date(now + 3600000).toISOString(), status: 'active', target: { kind: 'session', sessionId: 's' } },
    { id: 'due-ended', title: '已结束', scheduledAt: new Date(now - 60000).toISOString(), status: 'ended' },
    { id: 'due-paused', title: '暂停', scheduledAt: new Date(now - 60000).toISOString(), status: 'paused' },
  ]
  const schedule = { catalog: async () => catalog, history: async () => ({ id: 'x', records: [] }) }
  const e = api({ schedule })
  try {
    const response = await e.request('/dsh-butler/api/due')
    assert.equal(response.status, 200)
    assert.equal(response.body.available, true)
    assert.deepEqual(response.body.due.map(row => row.id), ['due-overdue'])
    assert.equal(response.body.count, 1)
  } finally { e.dispose() }
  const unavailable = api()
  try {
    const response = await unavailable.request('/dsh-butler/api/due')
    assert.equal(response.status, 200)
    assert.equal(response.body.available, false)
    assert.deepEqual(response.body.due, [])
    assert.match(response.body.reason, /调度服务不可用/)
  } finally { unavailable.dispose() }
})

test('reminder action route snoozes one-shot rules, refuses recurring edits and reports missing rules', async () => {
  const edits = []
  const row = { id: 'rem-one-shot', kind: 'at', title: '吃药', prompt: '吃药', scheduledAt: '2026-11-07T04:00:00.000Z',
    status: 'active', updatedAt: '2026-11-07T04:00:00.000Z', target: { kind: 'session', sessionId: 's' } }
  const schedule = {
    catalog: async () => [row, { ...row, id: 'rem-daily', kind: 'daily', daily: { time: '20:00', time_zone: 'Asia/Shanghai' } }],
    history: async () => ({ id: 'x', records: [] }),
    edit: async request => {
      edits.push(request)
      if (request.action === 'delete') return { id: request.id, deleted: true }
      return { ...row, id: request.id, updatedAt: '2026-11-07T05:00:00.000Z', ...(request.patch.timing === undefined ? {} : { kind: 'at' }) }
    },
  }
  const e = api({ schedule })
  try {
    const before = Date.now()
    const snoozed = await e.request('/dsh-butler/api/reminder-action', 'POST', { action: 'snooze', id: 'rem-one-shot', minutes: 10 })
    assert.equal(snoozed.status, 200)
    assert.equal(snoozed.body.ok, true)
    const edit = edits[0]
    assert.equal(edit.action, 'update')
    assert.equal(edit.patch.timing.kind, 'at')
    const when = Date.parse(edit.patch.timing.at)
    assert.ok(when >= before + 9 * 60000 && when <= Date.now() + 11 * 60000, 'snooze lands ~10 minutes ahead')
    assert.equal(edit.expectedUpdatedAt, row.updatedAt)

    const recurring = await e.request('/dsh-butler/api/reminder-action', 'POST', { action: 'snooze', id: 'rem-daily' })
    assert.equal(recurring.status, 409)
    assert.match(recurring.body.error, /重复提醒/)

    const completed = await e.request('/dsh-butler/api/reminder-action', 'POST', { action: 'complete', id: 'rem-one-shot' })
    assert.equal(completed.status, 200)
    assert.equal(edits.at(-1).action, 'delete')

    assert.equal((await e.request('/dsh-butler/api/reminder-action', 'POST', { action: 'snooze', id: 'missing-rule' })).status, 404)
    assert.equal((await e.request('/dsh-butler/api/reminder-action', 'POST', { action: 'explode', id: 'rem-one-shot' })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/reminder-action', 'GET')).status, 405)
  } finally { e.dispose() }

  const noEdit = api({ schedule: { catalog: async () => [row], history: async () => ({ id: 'x', records: [] }) } })
  try {
    assert.equal((await noEdit.request('/dsh-butler/api/reminder-action', 'POST', { action: 'complete', id: 'rem-one-shot' })).status, 503)
  } finally { noEdit.dispose() }
})

test('overview exposes feishu reminder status only when the host provides it', async () => {
  const e = api({ feishu: () => ({ enabled: true, configured: true, sent: 2, failed: 0, gaveUp: 0 }) })
  try {
    const response = await e.request('/dsh-butler/api/overview')
    assert.deepEqual(response.body.feishu, { enabled: true, configured: true, sent: 2, failed: 0, gaveUp: 0 })
  } finally { e.dispose() }
  const absent = api()
  try {
    assert.equal((await absent.request('/dsh-butler/api/overview')).body.feishu, undefined)
  } finally { absent.dispose() }
})

test('memo action route confirms/rejects proposed memories once with audit and clear refusals', async () => {
  const confirmId = `memo-confirm-${randomUUID()}`
  addMemo({ id: confirmId, text: '偏好中文交流', source: 'butler' })
  const rejectId = `memo-reject-${randomUUID()}`
  addMemo({ id: rejectId, text: '每天喝咖啡', source: 'butler' })
  const e = api()
  try {
    const confirmed = await e.request('/dsh-butler/api/memo-action', 'POST', { action: 'confirm', id: confirmId })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.memo.status, 'confirmed')
    assert.equal(listMemos().find(memo => memo.id === confirmId).status, 'confirmed')

    const rejected = await e.request('/dsh-butler/api/memo-action', 'POST', { action: 'reject', id: rejectId })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.memo.status, 'rejected')

    assert.equal((await e.request('/dsh-butler/api/memo-action', 'POST', { action: 'confirm', id: confirmId })).status, 409)
    assert.equal((await e.request('/dsh-butler/api/memo-action', 'POST', { action: 'confirm', id: 'missing-memo' })).status, 404)
    assert.equal((await e.request('/dsh-butler/api/memo-action', 'POST', { action: 'explode', id: confirmId })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/memo-action', 'GET')).status, 405)
  } finally { e.dispose() }
})

test('search route returns grouped read-only hits and validates the query', async () => {
  writeText(vaultPath('notes', 'api-search.md'), '# API Search\n\nenzyme stability text')
  upsertTask('api-search-task', { title: 'API enzyme task', status: 'pending' })
  addMemo({ id: 'api-search-memo', text: 'enzyme preference', source: 'butler' })
  const e = api()
  try {
    const response = await e.request('/dsh-butler/api/search?q=enzyme')
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.query, 'enzyme')
    assert.ok(response.body.notes.some(hit => hit.id === 'api-search'))
    assert.ok(response.body.tasks.some(hit => hit.id === 'api-search-task'))
    assert.ok(response.body.memory.some(hit => hit.id === 'api-search-memo'))
    assert.equal((await e.request('/dsh-butler/api/search')).status, 400)
    assert.equal((await e.request(`/dsh-butler/api/search?q=${'a'.repeat(201)}`)).status, 400)
    assert.equal((await e.request('/dsh-butler/api/search?q=enzyme', 'POST')).status, 405)
  } finally { e.dispose() }
})

test('capture route records one pending task and validates input', async () => {
  const e = api()
  try {
    const before = listTasks().length
    const created = await e.request('/dsh-butler/api/capture', 'POST', { title: '买试剂', note: '酶活实验用' })
    assert.equal(created.status, 200)
    assert.equal(created.body.ok, true)
    assert.equal(created.body.task.status, 'pending')
    assert.equal(listTasks().length, before + 1)
    assert.equal(listTasks().find(task => task.id === created.body.task.id).note, '酶活实验用')
    assert.equal((await e.request('/dsh-butler/api/capture', 'POST', { title: '   ' })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/capture', 'POST', { title: 'x'.repeat(201) })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/capture', 'GET')).status, 405)
  } finally { e.dispose() }
})

test('backup routes create, list and guard restore', async () => {
  const e = api()
  try {
    const created = await e.request('/dsh-butler/api/backup', 'POST')
    assert.equal(created.status, 200)
    assert.equal(created.body.ok, true)
    assert.match(created.body.id, /^butler-backup-/)
    assert.ok(created.body.files > 0)
    const listed = await e.request('/dsh-butler/api/backup')
    assert.ok(listed.body.backups.some(backup => backup.id === created.body.id))
    assert.equal((await e.request('/dsh-butler/api/backup', 'PUT')).status, 405)
    assert.equal((await e.request('/dsh-butler/api/restore', 'POST', { id: created.body.id })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/restore', 'POST', { id: 'bad id', confirm: 'RESTORE' })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/restore', 'POST', { id: 'butler-backup-19990101T000000', confirm: 'RESTORE' })).status, 404)
    assert.equal((await e.request('/dsh-butler/api/restore', 'GET')).status, 405)
  } finally { e.dispose() }
})

test('settings route reports effective values, data locations, retention and backups', async () => {
  const e = api({ feishu: () => ({ enabled: true, configured: true, sent: 2 }) })
  try {
    const response = await e.request('/dsh-butler/api/settings')
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.timeZone, 'Asia/Shanghai')
    assert.equal(response.body.brief.slots.length, 2)
    assert.deepEqual(response.body.brief.slots.map(slot => slot.kind), ['morning', 'evening'])
    assert.equal(response.body.brief.slots[0].hour, 8)
    assert.equal(response.body.brief.slots[0].minute, 30)
    assert.equal(response.body.brief.slots[1].hour, 21)
    assert.equal(response.body.brief.slots[1].minute, 30)
    assert.deepEqual(response.body.feishu, { enabled: true, configured: true, sent: 2 })
    assert.match(response.body.data.vaultHome, /vault$/)
    assert.match(response.body.data.backupHome, /backups$/)
    assert.equal(response.body.retention.compaction.days, 7)
    assert.equal(response.body.retention.compaction.maxBytes, 64 * 1024 * 1024)
    assert.equal(response.body.retention.backupKeep, 5)
    assert.ok(Array.isArray(response.body.backups))
    assert.equal((await e.request('/dsh-butler/api/settings', 'POST')).status, 405)
  } finally { e.dispose() }
})

test('usage report route rolls up daily rows with explicit cost coverage', async () => {
  addUsage({ at: '2026-11-07T03:00:00.000Z', callId: `usage-api-${randomUUID()}`, inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.01 })
  const e = api()
  try {
    const response = await e.request('/dsh-butler/api/usage-report?days=7')
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.days, 7)
    assert.equal(response.body.daily.length, 7)
    assert.equal(typeof response.body.totals.calls, 'number')
    assert.deepEqual(Object.keys(response.body.coverage).sort(), ['missing', 'priced', 'unpriced'])
    assert.match(response.body.note, /估算/)
    const clamped = await e.request('/dsh-butler/api/usage-report?days=999')
    assert.equal(clamped.body.days, 90)
    assert.equal((await e.request('/dsh-butler/api/usage-report', 'POST')).status, 405)
  } finally { e.dispose() }
})

test('feishu credential route writes to the credential store without echoing the secret', async () => {
  const calls = []
  let stored
  const status = () => ({ configured: stored !== undefined, writable: true, ...(stored === undefined ? {} : { source: 'store' }) })
  const e = api({ feishuCredential: {
    describe: async () => status(),
    set: async secret => { calls.push(['set', secret]); stored = secret; return status() },
    unset: async () => { calls.push(['unset']); stored = undefined; return status() },
  } })
  try {
    const saved = await e.request('/dsh-butler/api/feishu-credential', 'POST', { action: 'set', confirm: 'SET', appSecret: 'super-secret-value' })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ok, true)
    assert.deepEqual(saved.body.credential, { configured: true, writable: true, source: 'store' })
    assert.deepEqual(calls, [['set', 'super-secret-value']])
    assert.doesNotMatch(JSON.stringify(saved.body), /super-secret-value/)

    assert.equal((await e.request('/dsh-butler/api/feishu-credential', 'POST', { action: 'set', confirm: 'NO', appSecret: 'super-secret-value' })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/feishu-credential', 'POST', { action: 'set', confirm: 'SET', appSecret: 'short' })).status, 400)
    assert.equal((await e.request('/dsh-butler/api/feishu-credential', 'POST', { action: 'explode' })).status, 400)
    const removed = await e.request('/dsh-butler/api/feishu-credential', 'POST', { action: 'unset', confirm: 'UNSET' })
    assert.equal(removed.status, 200)
    assert.deepEqual(removed.body.credential, { configured: false, writable: true })
    assert.equal((await e.request('/dsh-butler/api/feishu-credential', 'GET')).status, 405)
  } finally { e.dispose() }
  const unsupported = api()
  try {
    assert.equal((await unsupported.request('/dsh-butler/api/feishu-credential', 'POST', { action: 'set', confirm: 'SET', appSecret: 'super-secret-value' })).status, 503)
  } finally { unsupported.dispose() }
})
