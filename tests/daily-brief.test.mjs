/**
 * 每日简报：纯组合 + 触发窗口 + 幂等写 daily。
 *
 * 每个测试文件独立进程，所以先隔离 vault 再动态导入模块。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'daily-brief-'))
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
process.env.DSH_BUTLER_HOME = join(root, 'state')

const brief = await import('../src/host/brief.ts')
const { dailyFile, vaultPath, writeText } = await import('../src/host/vault.ts')
const ledger = await import('../src/host/ledger.ts')

after(() => {
  assert.ok(realpathSync(root).startsWith(realpathSync(base) + sep))
  rmSync(root, { recursive: true, force: true })
})

const zone = 'Asia/Shanghai'
/** Today at one local wall-clock time (the machine runs in Asia/Shanghai). */
function at(hour, minute = 0, dayOffset = 0) {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, minute, 0, 0)
  return date
}

/** One task fixture. */
const task = (id, title, status, extra = {}) => ({ id, title, status, ...extra })

test('morning brief reports due today, overdue and waiting, and suggests next steps', () => {
  const composed = brief.composeBrief('morning', {
    now: at(9), timeZone: zone,
    tasks: [
      task('a', '今天交报告', 'pending', { dueAt: at(17).toISOString() }),
      task('b', '逾期实验', 'running', { dueAt: at(10, 0, -2).toISOString() }),
      task('c', '等你确认', 'waiting_review', { updatedAt: at(8).toISOString() }),
      task('d', '已完成', 'done', { updatedAt: at(8).toISOString() }),
    ],
    reminders: [{ title: '提醒喝水', scheduledAt: at(15).toISOString(), status: 'active' }],
  })
  assert.equal(composed.kind, 'morning')
  assert.equal(composed.counts.dueToday, 1)
  assert.equal(composed.counts.overdue, 1)
  assert.equal(composed.counts.waiting, 1)
  assert.equal(composed.counts.reminders, 1)
  assert.match(composed.markdown, /## 管家早报 08:30/)
  assert.match(composed.markdown, /今天到期：1 项 — 「今天交报告」/)
  assert.match(composed.markdown, /已逾期：1 项 — 「逾期实验」/)
  assert.match(composed.markdown, /等你决定：1 项 — 「等你确认」/)
  assert.match(composed.markdown, /建议：.*逾期/)
  assert.doesNotMatch(composed.markdown, /已完成/)
})

test('evening brief reports done today, unfinished and due tomorrow', () => {
  const composed = brief.composeBrief('evening', {
    now: at(21, 35), timeZone: zone,
    tasks: [
      task('a', '今天完成的事', 'done', { updatedAt: at(16).toISOString() }),
      task('b', '没做完的事', 'pending', { dueAt: at(18).toISOString() }),
      task('c', '明天到期', 'pending', { dueAt: at(10, 0, 1).toISOString() }),
    ],
    reminders: [],
  })
  assert.equal(composed.kind, 'evening')
  assert.equal(composed.counts.doneToday, 1)
  assert.equal(composed.counts.open, 2)
  assert.equal(composed.counts.dueTomorrow, 1)
  assert.match(composed.markdown, /## 管家晚报 21:30/)
  assert.match(composed.markdown, /今天完成：1 项 — 「今天完成的事」/)
  assert.match(composed.markdown, /明天到期：1 项 — 「明天到期」/)
})

test('slot windows decide when a brief is due and a late start catches up', () => {
  assert.equal(brief.briefDue('morning', at(8, 29), zone), false)
  assert.equal(brief.briefDue('morning', at(8, 30), zone), true)
  assert.equal(brief.briefDue('morning', at(12, 59), zone), true)
  assert.equal(brief.briefDue('morning', at(13, 0), zone), true)
  assert.equal(brief.briefDue('morning', at(13, 59), zone), true)
  assert.equal(brief.briefDue('morning', at(14, 0), zone), false)
  assert.equal(brief.briefDue('evening', at(21, 29), zone), false)
  assert.equal(brief.briefDue('evening', at(21, 30), zone), true)
  assert.equal(brief.briefDue('evening', at(23, 59), zone), true)
})

test('one tick writes the due brief once into the daily page', async () => {
  const written = await brief.runDailyBriefOnce({
    timeZone: zone,
    now: () => at(9),
    collect: () => ({ tasks: [task('a', '今天要交', 'pending', { dueAt: at(17).toISOString() })], reminders: [] }),
  })
  assert.deepEqual(written.written, ['morning'])
  const file = dailyFile(zone)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /## 管家早报 08:30/)
  assert.match(text, /「今天要交」/)

  const replay = await brief.runDailyBriefOnce({
    timeZone: zone,
    now: () => at(10),
    collect: () => ({ tasks: [], reminders: [] }),
  })
  assert.deepEqual(replay.written, [])
  assert.ok(replay.skipped.some(row => row.kind === 'morning' && row.reason === 'already-written'))
  assert.equal(readFileSync(file, 'utf8').split('## 管家早报 08:30').length - 1, 1)
})

test('outside the window nothing is written', async () => {
  const before = readdirSync(join(process.env.DSH_BUTLER_VAULT, 'daily')).sort()
  const result = await brief.runDailyBriefOnce({
    timeZone: zone,
    now: () => at(3),
    collect: () => { throw new Error('must not be called outside the window') },
  })
  assert.deepEqual(result.written, [])
  assert.equal(result.skipped.filter(row => row.reason === 'not-due').length, 2)
  assert.deepEqual(readdirSync(join(process.env.DSH_BUTLER_VAULT, 'daily')).sort(), before)
})

test('collectBriefSource projects native catalog rows and tolerates an absent scheduler', async () => {
  const withSchedule = await brief.collectBriefSource({ catalog: async () => [
    { title: '喝水', scheduledAt: at(15).toISOString(), status: 'active' },
    { scheduledAt: at(16).toISOString() },
  ] })
  assert.equal(withSchedule.reminders.length, 2)
  assert.equal(withSchedule.reminders[0].title, '喝水')
  assert.equal(withSchedule.reminders[1].title, '（未命名提醒）')

  const withoutSchedule = await brief.collectBriefSource(undefined)
  assert.deepEqual(withoutSchedule.reminders, [])
  assert.ok(Array.isArray(withoutSchedule.tasks))
})

test('collectBriefSource hides archived fixture tasks from the owner brief', async () => {
  ledger.upsertTask('task-fixture-archive', { title: 'DSH007 验收 fixture', status: 'pending' })
  ledger.upsertTask('task-real-one', { title: '真实任务', status: 'pending' })
  writeText(vaultPath('archive', 'index.json'), JSON.stringify({
    version: 1,
    batches: [{ batchId: 'test', tasks: [{ id: 'task-fixture-archive', reason: 'test', matchedBy: 'DSH007' }], reminders: [], receipts: [] }],
  }))
  const source = await brief.collectBriefSource(undefined)
  assert.ok(source.tasks.some(row => row.id === 'task-real-one'))
  assert.ok(!source.tasks.some(row => row.id === 'task-fixture-archive'))
})
