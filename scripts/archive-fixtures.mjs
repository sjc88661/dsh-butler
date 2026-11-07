#!/usr/bin/env node
/**
 * Archive the October-2026 acceptance fixtures as a side index.
 *
 * The 10 月验收 runs left test tasks, reminders and receipts in the real ledger.
 * This script only *reads* the ledger: it matches the fixture ids/titles, copies
 * the matched records as a snapshot under `vault/archive/<batch>/`, and writes
 * `vault/archive/index.json` so the host can hide (never delete) them.
 *
 * Default mode is a read-only dry run: nothing is created, moved or deleted.
 * `--apply` writes the snapshot files and the index; the ledgers stay untouched.
 *
 * Usage:
 *   node scripts/archive-fixtures.mjs [--dry-run] [--apply]
 *     [--batch <id>] [--vault <path>] [--state <path>] [--help]
 *
 * The paths default to the plugin's configured homes (`DSH_BUTLER_VAULT`,
 * `DSH_BUTLER_HOME`/`DSH_HOME`), so with no arguments this inspects this
 * machine's real state - safely, because the default is a dry run.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BATCH = '2026-10-fixtures'
const STRONG_PATTERNS = [
  { token: 'DSH007', reason: '10 月 DSH007 验收批次 fixture' },
  { token: 'DSH008', reason: '10 月 DSH008 验收批次 fixture' },
  { token: 'DSH_LIVE', reason: 'DSH_LIVE 受控真实投递验收 fixture' },
  { token: 'ORIG_LIVE', reason: 'ORIG_LIVE 受控真实投递验收 fixture' },
  { token: 'DSH_SMOKE', reason: 'DSH_SMOKE 隔离冒烟验收 fixture' },
  { token: 'DSH_ACCEPT', reason: 'DSH_ACCEPT 验收 fixture' },
  { token: 'CANCEL_ONLY', reason: 'CANCEL_ONLY 取消路径验收 fixture' },
]
/** Bare `验收` is too weak alone: a real delivery report can say 验收 too. */
const WEAK_TOKEN = '验收'
const FIXTURE_TITLE_PREFIX = /^(?:DSH|管家(?:隔离)?验收|提醒：(?:DSH|管家(?:隔离)?验收)|验收)/i
const FIXTURE_SESSION = /^session-butler(?:007|008|live|recovery|smoke)/i
const LINKED_TASK = 'linked-task'
const FIXTURE_SESSION_MATCH = 'fixture-session'

function parseArgs(argv) {
  const options = { apply: false, dryRun: false, batch: BATCH, vault: undefined, state: undefined, help: false }
  const readValue = (index, flag) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--batch') { options.batch = readValue(index, '--batch'); index += 1 }
    else if (arg.startsWith('--batch=')) options.batch = arg.slice('--batch='.length)
    else if (arg === '--vault') { options.vault = readValue(index, '--vault'); index += 1 }
    else if (arg.startsWith('--vault=')) options.vault = arg.slice('--vault='.length)
    else if (arg === '--state') { options.state = readValue(index, '--state'); index += 1 }
    else if (arg.startsWith('--state=')) options.state = arg.slice('--state='.length)
    else throw new Error(`未知参数：${arg}（--help 查看用法）`)
  }
  if (options.apply && options.dryRun) throw new Error('--apply 与 --dry-run 只能选一个')
  if (options.batch.trim() === '') throw new Error('--batch 不能为空')
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log('用法：node scripts/archive-fixtures.mjs [--dry-run|--apply] [--batch <id>] [--vault <path>] [--state <path>]')
  console.log('默认 dry-run：只读账本并打印匹配结果；--apply 才写 vault/archive/<batch>/ 与 vault/archive/index.json。')
  process.exit(0)
}
// The host modules resolve their homes from the environment at import time, so
// command-line overrides must land before the dynamic imports below.
if (options.vault !== undefined) process.env.DSH_BUTLER_VAULT = resolve(options.vault)
if (options.state !== undefined) process.env.DSH_BUTLER_HOME = resolve(options.state)

const { statePath, vaultPath, writeText } = await import('../src/host/vault.ts')
const { ARCHIVE_INDEX_VERSION } = await import('../src/host/archive.ts')

/** Read a UTF-8 file as lines, or nothing when absent. */
function readLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`${path} 读取/解析失败：${error.message}`)
  }
}

/** Match one record against the fixture markers; the first strong marker wins. */
function classifyFixture(text, context = {}) {
  for (const pattern of STRONG_PATTERNS) {
    if (text.includes(pattern.token)) return { matchedBy: pattern.token, reason: pattern.reason }
  }
  if (text.includes(WEAK_TOKEN)) {
    const title = (context.title ?? '').trim(), sessionId = context.sessionId ?? ''
    if (FIXTURE_TITLE_PREFIX.test(title) || FIXTURE_SESSION.test(sessionId)) {
      return { matchedBy: WEAK_TOKEN, reason: '10 月验收批次（标题或来源会话带验收标记）' }
    }
  }
  return undefined
}

const isFixtureSession = (sessionId) => FIXTURE_SESSION.test(sessionId ?? '')

/** Tasks: match on the record's own ids/title/note/session, keep the raw line. */
function scanTasks(path) {
  const matched = []
  for (const line of readLines(path)) {
    let task
    try { task = JSON.parse(line) } catch { continue }
    const text = [task.id, task.title, task.note, task.sessionId, task.rootSessionId, task.runId].filter(value => typeof value === 'string').join('\n')
    const match = classifyFixture(text, { title: task.title, sessionId: task.sessionId })
    if (match === undefined || typeof task.id !== 'string') continue
    matched.push({
      id: task.id,
      title: typeof task.title === 'string' ? task.title : undefined,
      status: typeof task.status === 'string' ? task.status : undefined,
      createdAt: typeof task.createdAt === 'string' ? task.createdAt : undefined,
      ...match,
      line,
    })
  }
  return matched.sort((left, right) => left.id.localeCompare(right.id))
}

/** Receipts: direct markers first, then linkage to archived tasks or fixture sessions. */
function scanReceipts(path, fixtureTaskIds) {
  const matched = []
  for (const line of readLines(path)) {
    let receipt
    try { receipt = JSON.parse(line) } catch { continue }
    const sessionId = receipt.sessionId ?? receipt.rootSessionId
    const text = [receipt.taskId, receipt.sessionId, receipt.rootSessionId, receipt.tool, receipt.summary, receipt.error].filter(value => typeof value === 'string').join('\n')
    let match = classifyFixture(text, { title: receipt.summary, sessionId })
    if (match === undefined && typeof receipt.taskId === 'string' && fixtureTaskIds.has(receipt.taskId)) {
      match = { matchedBy: LINKED_TASK, reason: `回执关联已归档的 10 月验收 fixture 任务 ${receipt.taskId}` }
    }
    if (match === undefined && (isFixtureSession(receipt.sessionId) || isFixtureSession(receipt.rootSessionId))) {
      match = { matchedBy: FIXTURE_SESSION_MATCH, reason: '回执来自 10 月验收 fixture 会话' }
    }
    if (match === undefined) continue
    const key = typeof receipt.callId === 'string' && receipt.callId !== ''
      ? receipt.callId : `${receipt.at ?? 'unknown'}|${receipt.tool ?? 'unknown'}`
    matched.push({
      key,
      at: typeof receipt.at === 'string' ? receipt.at : undefined,
      tool: typeof receipt.tool === 'string' ? receipt.tool : undefined,
      taskId: typeof receipt.taskId === 'string' ? receipt.taskId : undefined,
      ...match,
      line,
    })
  }
  return matched.sort((left, right) => left.key.localeCompare(right.key))
}

/** Reminder operations are the source of native schedule ids. */
function scanReminderOperations(path) {
  const document = readJson(path, { version: 1, operations: {} })
  const operations = document !== null && typeof document === 'object' && typeof document.operations === 'object' && document.operations !== null
    ? document.operations : {}
  const matched = []
  for (const [executionKey, operation] of Object.entries(operations).sort(([left], [right]) => left.localeCompare(right))) {
    if (operation === null || typeof operation !== 'object') continue
    const title = operation.request?.title ?? operation.actualReceipt?.title ?? operation.task?.title
    const sessionId = operation.sourceSessionId ?? operation.identity?.sessionId
    const text = JSON.stringify(operation)
    const match = classifyFixture(text, { title, sessionId })
    if (match === undefined) continue
    const scheduleId = typeof operation.scheduleId === 'string' ? operation.scheduleId
      : typeof operation.actualReceipt?.id === 'string' ? operation.actualReceipt.id : undefined
    matched.push({
      executionKey,
      action: typeof operation.action === 'string' ? operation.action : undefined,
      scheduleId,
      title: typeof title === 'string' ? title : undefined,
      taskId: typeof operation.taskId === 'string' ? operation.taskId : undefined,
      ...match,
      operation,
    })
  }
  return matched
}

/** Reminder session bindings: fixture titles/sources, recorded as a snapshot only. */
function scanReminderSessions(path) {
  const document = readJson(path, { version: 1, bindings: {} })
  const bindings = document !== null && typeof document === 'object' && typeof document.bindings === 'object' && document.bindings !== null
    ? document.bindings : {}
  const matched = []
  for (const [key, binding] of Object.entries(bindings).sort(([left], [right]) => left.localeCompare(right))) {
    if (binding === null || typeof binding !== 'object') continue
    const text = JSON.stringify(binding)
    const match = classifyFixture(text, { title: binding.title, sessionId: binding.sourceSessionId })
    if (match === undefined) continue
    matched.push({
      key,
      id: typeof binding.id === 'string' ? binding.id : undefined,
      sourceSessionId: typeof binding.sourceSessionId === 'string' ? binding.sourceSessionId : undefined,
      title: typeof binding.title === 'string' ? binding.title : undefined,
      ...match,
      binding,
    })
  }
  return matched
}

/** The reminders the host can filter by: native schedule id and/or execution key. */
function reminderEntries(operations) {
  return operations.map(entry => ({
    ...(entry.scheduleId === undefined ? {} : { scheduleId: entry.scheduleId }),
    executionKey: entry.executionKey,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    reason: entry.reason,
    matchedBy: entry.matchedBy,
  }))
}

function publicTask(entry) {
  return { id: entry.id, ...(entry.title === undefined ? {} : { title: entry.title }), reason: entry.reason, matchedBy: entry.matchedBy }
}

function publicReceipt(entry) {
  return {
    key: entry.key, ...(entry.at === undefined ? {} : { at: entry.at }),
    ...(entry.tool === undefined ? {} : { tool: entry.tool }), reason: entry.reason, matchedBy: entry.matchedBy,
  }
}

const tasksPath = vaultPath('ledger', 'tasks.jsonl')
const receiptsPath = vaultPath('ledger', 'receipts.jsonl')
const operationsPath = statePath('reminder-operations.json')
const sessionsPath = statePath('reminder-sessions.json')
const tasks = scanTasks(tasksPath)
const fixtureTaskIds = new Set(tasks.map(task => task.id))
const receipts = scanReceipts(receiptsPath, fixtureTaskIds)
const reminderOperations = scanReminderOperations(operationsPath)
const reminders = reminderEntries(reminderOperations)
const reminderSessions = scanReminderSessions(sessionsPath)

const counts = {
  tasks: tasks.length,
  reminders: reminders.length,
  reminderOperations: reminderOperations.length,
  reminderSessions: reminderSessions.length,
  receipts: receipts.length,
}
const batchDirectory = vaultPath('archive', options.batch)
const manifestPath = join(batchDirectory, 'manifest.json')
const indexPath = vaultPath('archive', 'index.json')
const sources = [
  { path: tasksPath, rows: readLines(tasksPath).length },
  { path: receiptsPath, rows: readLines(receiptsPath).length },
  { path: operationsPath, rows: reminderOperations.length },
  { path: sessionsPath, rows: reminderSessions.length },
]

const report = {
  mode: options.apply ? 'apply' : 'dry-run',
  batch: options.batch,
  homes: { vault: vaultPath(), state: statePath() },
  patterns: [...STRONG_PATTERNS.map(pattern => pattern.token), WEAK_TOKEN],
  sources: sources.map(source => ({ path: source.path, exists: existsSync(source.path), rows: source.rows })),
  counts,
  tasks: tasks.map(publicTask),
  reminders,
  reminderOperations: reminderOperations.map(entry => ({
    executionKey: entry.executionKey, ...(entry.scheduleId === undefined ? {} : { scheduleId: entry.scheduleId }),
    ...(entry.action === undefined ? {} : { action: entry.action }), ...(entry.title === undefined ? {} : { title: entry.title }),
    reason: entry.reason, matchedBy: entry.matchedBy,
  })),
  reminderSessions: reminderSessions.map(entry => ({
    ...(entry.id === undefined ? {} : { id: entry.id }), ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.sourceSessionId === undefined ? {} : { sourceSessionId: entry.sourceSessionId }),
    reason: entry.reason, matchedBy: entry.matchedBy,
  })),
  receipts: receipts.map(publicReceipt),
}

if (!options.apply) {
  console.log(JSON.stringify({ ...report, written: [] }, null, 2))
  process.exit(0)
}

// --apply: snapshot matched records first, then publish the index. Ledger files
// are never opened for writing anywhere in this script.
const written = []
const put = (path, content) => { writeText(path, content); written.push(path) }
const now = new Date().toISOString()
const createdAt = now
put(manifestPath, `${JSON.stringify({
  version: 1,
  batchId: options.batch,
  createdAt,
  reason: '10 月（2026-10）验收 fixture 归档快照；账本未删除、未改写',
  source: { vault: vaultPath(), state: statePath() },
  patterns: [...STRONG_PATTERNS, { token: WEAK_TOKEN, reason: '仅在标题/来源会话带验收标记时生效，避免误伤真实交付记录' }],
  matchedByOverview: { linkedTask: LINKED_TASK, fixtureSession: FIXTURE_SESSION_MATCH },
  counts,
  tasks: report.tasks,
  reminders: report.reminders,
  reminderOperations: report.reminderOperations,
  reminderSessions: report.reminderSessions,
  receipts: report.receipts,
}, null, 2)}\n`)
put(join(batchDirectory, 'tasks.jsonl'), tasks.length === 0 ? '' : `${tasks.map(task => task.line).join('\n')}\n`)
put(join(batchDirectory, 'receipts.jsonl'), receipts.length === 0 ? '' : `${receipts.map(receipt => receipt.line).join('\n')}\n`)
put(join(batchDirectory, 'reminder-operations.json'), `${JSON.stringify({
  version: 1,
  operations: Object.fromEntries(reminderOperations.map(entry => [entry.executionKey, entry.operation])),
}, null, 2)}\n`)
put(join(batchDirectory, 'reminder-sessions.json'), `${JSON.stringify({
  version: 1,
  bindings: Object.fromEntries(reminderSessions.map(entry => [entry.key, entry.binding])),
}, null, 2)}\n`)
put(join(batchDirectory, 'README.md'), [
  `# 归档批次 ${options.batch}`,
  '',
  `- 生成时间：${createdAt}`,
  `- 来源：${sources.map(source => source.path).join('、')}`,
  `- 账本：未删除、未改写；本目录只是匹配记录的原始快照。`,
  '- 工作台可读 `vault/archive/index.json` 隐藏这些 id，而不是删除账本行。',
  '- 真要删除账本行是另一件需要人工确认的事，本脚本不做。',
  '',
].join('\n'))

// Merge the previous index: other batches stay archived, this batch is replaced
// so repeated --apply runs are idempotent.
let previousBatches = []
try {
  const previous = JSON.parse(readFileSync(indexPath, 'utf8'))
  if (previous !== null && typeof previous === 'object' && Array.isArray(previous.batches)) previousBatches = previous.batches
} catch { /* a damaged index is replaced by this batch; the snapshot files remain */ }
const batch = {
  batchId: options.batch,
  createdAt,
  manifest: `${options.batch}/manifest.json`,
  counts,
  tasks: report.tasks,
  reminders: report.reminders,
  receipts: report.receipts,
}
const batches = [batch, ...previousBatches.filter(entry => entry === null || typeof entry !== 'object' || entry.batchId !== options.batch)]
put(indexPath, `${JSON.stringify({ version: ARCHIVE_INDEX_VERSION, updatedAt: now, batches }, null, 2)}\n`)

console.log(JSON.stringify({ ...report, written }, null, 2))
