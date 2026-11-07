/**
 * 自然语言时间解析测试。
 *
 * 固定参考时刻：2026-11-07T11:34:00+08:00（周六），Asia/Shanghai。
 * 断言用 `timing.local` 的墙上时间，避免测试机时区影响；绝对值只校验关键一条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || join(homedir(), 'dsh-harness'))
const ts = createRequire(join(checkout, 'package.json'))('typescript')
const sourcePath = join(root, 'src/host/time-parse.ts')
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

function load() {
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, require: id => createRequire(import.meta.url)(id), console, Intl, Date, Number, String, Object, Array, Map, Set, RegExp }, { filename: sourcePath })
  return module.exports
}

const { parseReminderTime } = load()
const now = new Date('2026-11-07T03:34:00.000Z') // 11:34 Asia/Shanghai, Saturday
const zone = 'Asia/Shanghai'
const parse = text => parseReminderTime(text, { now, timeZone: zone })
/** Cross-realm plain copy so deepEqual does not compare prototypes from the vm realm. */
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

/** Assert one one-shot wall clock. */
function expectAt(text, date, time, options = {}) {
  const parsed = parse(text)
  assert.ok(parsed.timing, `${text} should resolve, got ${JSON.stringify(parsed.ambiguous)}`)
  assert.equal(parsed.timing.kind, 'at', text)
  assert.deepEqual({ date: parsed.timing.local.date, time: parsed.timing.local.time }, { date, time }, text)
  if (options.confidence !== undefined) assert.equal(parsed.confidence, options.confidence, text)
  if (options.note !== undefined) assert.ok(parsed.notes.some(note => note.includes(options.note)), `${text} notes: ${parsed.notes.join('|')}`)
}

/** Assert an ambiguity with no timing. */
function expectAmbiguous(text, missingText) {
  const parsed = parse(text)
  assert.equal(parsed.timing, undefined, `${text} must not resolve`)
  assert.ok(parsed.ambiguous !== undefined, `${text} needs a reason`)
  if (missingText !== undefined) assert.ok(JSON.stringify(parsed.ambiguous).includes(missingText), `${text}: ${JSON.stringify(parsed.ambiguous)}`)
}

test('day-relative phrases with explicit clocks resolve to wall-clock instants', () => {
  expectAt('今晚8点提醒我吃药', '2026-11-07', '20:00')
  expectAt('明天上午9点半开会', '2026-11-08', '09:30')
  expectAt('后天下午3点', '2026-11-09', '15:00')
  expectAt('大后天早上7点', '2026-11-10', '07:00')
  expectAt('明晚八点', '2026-11-08', '20:00')
})

test('the instant carries the zone offset, not the machine zone', () => {
  const parsed = parse('今晚8点')
  assert.equal(parsed.timing.kind, 'at')
  assert.equal(parsed.timing.at, '2026-11-07T12:00:00.000Z')
})

test('relative durations become afterSeconds', () => {
  assert.deepEqual(plain(parse('20分钟后').timing), { kind: 'after', afterSeconds: 1200 })
  assert.deepEqual(plain(parse('2小时后提醒')), { timing: { kind: 'after', afterSeconds: 7200 }, confidence: 'exact', notes: [] })
  assert.deepEqual(plain(parse('半小时后').timing), { kind: 'after', afterSeconds: 1800 })
  assert.deepEqual(plain(parse('3天后').timing), { kind: 'after', afterSeconds: 259200 })
})

test('daily and weekly recurrences carry the zone and weekdays', () => {
  assert.deepEqual(plain(parse('每天20:00').timing), { kind: 'daily', time: '20:00', time_zone: zone })
  assert.deepEqual(plain(parse('每晚8点提醒我').timing), { kind: 'daily', time: '20:00', time_zone: zone })
  assert.deepEqual(plain(parse('每天早上8点').timing), { kind: 'daily', time: '08:00', time_zone: zone })
  assert.deepEqual(plain(parse('每周一三五 20:00').timing), { kind: 'weekly', time: '20:00', weekdays: [1, 3, 5], time_zone: zone })
  assert.deepEqual(plain(parse('每周三晚上8点').timing), { kind: 'weekly', time: '20:00', weekdays: [3], time_zone: zone })
})

test('weekday phrases take the nearest future occurrence and roll past ones', () => {
  expectAt('周五晚上7点', '2026-11-13', '19:00')
  expectAt('下周一 9点', '2026-11-09', '09:00', { note: undefined })
  expectAt('周六 19点', '2026-11-07', '19:00')
  expectAt('周一 9点', '2026-11-09', '09:00')
})

test('explicit calendar dates are honoured', () => {
  expectAt('11月8日 20:00', '2026-11-08', '20:00')
  expectAt('2026-12-01T08:30', '2026-12-01', '08:30')
  expectAt('25号 晚上8点', '2026-11-25', '20:00')
  expectAt('3号 9点', '2026-12-03', '09:00')
})

test('a clock without a date means the nearest future slot', () => {
  expectAt('12:00', '2026-11-07', '12:00', { confidence: 'defaulted', note: '最近一次' })
  expectAt('10:00', '2026-11-08', '10:00', { confidence: 'defaulted', note: '明天' })
})

test('dayparts default the clock but say so', () => {
  expectAt('明晚', '2026-11-08', '20:00', { confidence: 'defaulted', note: '20:00' })
  expectAt('明天上午', '2026-11-08', '09:00', { confidence: 'defaulted' })
})

test('missing information produces a reason plus what to add', () => {
  expectAmbiguous('明天', '钟点')
  expectAmbiguous('上午', '钟点')
  expectAmbiguous('周六', '钟点')
  expectAmbiguous('提醒我看论文', '日期')
  expectAmbiguous('随便什么时候', '无法确定')
  expectAmbiguous('昨天20:00', '过去')
  expectAmbiguous('上周五 9点', '过去')
  expectAmbiguous('2026-11-01 08:00', '过去')
})

test('月度重复暂不支持时明确说明', () => {
  const parsed = parse('每月8号 9点')
  assert.equal(parsed.timing, undefined)
  assert.ok(JSON.stringify(parsed.ambiguous).includes('每月'))
})
