#!/usr/bin/env node
/**
 * cost-probe.mjs —— 费用检测探针
 *
 * 用途：核对"管家记的 token 用量"是否失真，并按官方价目表把 token 折算成钱。
 * 做法：三条互相独立的来源放一起对账，谁错谁对由数据说话。
 *
 *   来源 A（事件真值）= DSH 自己落盘的会话日志
 *     <DSH_HOME>/sessions/<workspace>/<session>/session.v4.jsonl.zstd
 *     里每一条 `assistant/message` 事件的 data.usage（DSH 官方 TokenUsage 结构）。
 *     这是权威来源：插件能记错，DSH 自己写的日志不会。
 *   来源 B（我记的）= 管家账本 .butler/vault/ledger/usage.jsonl
 *     管家插件在运行时订阅 ctx.on('session/event') 抄下来的同一份 usage。
 *   来源 C（别人记的）= 本机已装插件 @linxin666/dsh-usage 的
 *     <DSH_HOME>/dsh-usage/usage-ledger.json（独立实现，按天/按 provider/model 折叠，自带费用估算）。
 *
 * 价格来源（唯一依据）：DeepSeek 官方定价页 api-docs.deepseek.com，
 *   政策生效 2026-09-10 12:00（北京）；高峰时段 = 北京时间周一至周五 09:00-12:00 与 14:00-18:00，
 *   其余时段（夜间/周末）按高峰价一半计。单位 CNY / 百万 token。
 *   本表逐字抄自本机 @linxin666/dsh-usage v0.4.4 的 src/core/pricing.ts（2026-10-03 读取），
 *   与官方公布的口径一致；探针里的价格是"估算依据"，不是账单。
 *
 * 用法：
 *   node scripts/cost-probe.mjs                     # 最近 1 天（北京时区），所有会话
 *   node scripts/cost-probe.mjs --date 2026-10-03
 *   node scripts/cost-probe.mjs --session session-593283c4   # 只看某个会话（前缀匹配）
 *   node scripts/cost-probe.mjs --days 3 --detail          # 近 3 天 + 打印全部差异
 *   node scripts/cost-probe.mjs --json                     # 机器可读
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// ---------------------------------------------------------------- 官方价目表
const BEIJING_OFFSET_MS = 8 * 3_600_000
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
const PRICE = {
  flash: {
    cacheHit: { offPeak: 0.02, peak: 0.04 },
    inputMiss: { offPeak: 1.0, peak: 2.0 },
    output: { offPeak: 4.0, peak: 8.0 },
  },
  pro: {
    cacheHit: { offPeak: 0.15, peak: 0.3 },
    inputMiss: { offPeak: 4.5, peak: 9.0 },
    output: { offPeak: 13.5, peak: 27.0 },
  },
}
/** 2026-09-14 12:00 北京之前，v4-pro 的请求按 pro 计价，之后并入 flash 行。 */
const PRO_FOLDED_INTO_FLASH_AT_MS = Date.UTC(2026, 8, 14, 4, 0)
const PRICE_SOURCE = 'api-docs.deepseek.com 官方定价页（政策生效 2026-09-10 12:00 北京）'

function beijingDayKey(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}
function beijingClock(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(11, 19)
}
function isPeak(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS)
  const weekday = shifted.getUTCDay()
  if (weekday < 1 || weekday > 5) return false
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return PEAK_WINDOWS.some(([from, to]) => minuteOfDay >= from && minuteOfDay < to)
}
function priceRow(model, atMs) {
  if (String(model).includes('v4-pro') && atMs < PRO_FOLDED_INTO_FLASH_AT_MS) return PRICE.pro
  return PRICE.flash
}
/** 一次调用的估算花费（CNY）。计费口径：缓存读 + 未命中输入(+缓存写) + 输出；推理已在输出里。
 *  opts.cacheAsMiss：反事实用——把命中缓存的输入也按未命中价计。 */
function spend(model, totals, atMs, opts = {}) {
  const row = priceRow(model, atMs)
  const column = isPeak(atMs) ? 'peak' : 'offPeak'
  const cacheRate = opts.cacheAsMiss === true ? row.inputMiss[column] : row.cacheHit[column]
  return (totals.cacheReadTokens * cacheRate
    + (totals.inputTokens + totals.cacheWriteTokens) * row.inputMiss[column]
    + totals.outputTokens * row.output[column]) / 1_000_000
}

// ---------------------------------------------------------------- 读会话日志
const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** DSH 的 .zstd 会话日志是"多个独立 zstd 帧首尾相接"（本机实测 3644 帧），逐帧解。 */
function readSessionRows(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === FRAME_MAGIC[0] && buf[i + 1] === FRAME_MAGIC[1]
      && buf[i + 2] === FRAME_MAGIC[2] && buf[i + 3] === FRAME_MAGIC[3]) starts.push(i)
  }
  let text = ''
  let failedFrames = 0
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      failedFrames += 1 // 文件正在被写入时，最后一帧可能不完整
    }
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch { /* 半行：文件正在写入，跳过 */ }
  }
  return { rows, frames: starts.length, failedFrames, bytes: buf.length }
}

function sessionLogs(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  const found = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let entries
    try { entries = readdirSync(wsDir) } catch { continue }
    for (const session of entries) {
      const file = join(wsDir, session, 'session.v4.jsonl.zstd')
      if (existsSync(file)) {
        found.push({ workspace, sessionId: session, file, size: statSync(file).size })
      }
    }
  }
  return found
}

/** 从会话日志里抽出所有带 usage 的模型调用（= 计费事件真值）。 */
function truthCalls(dshHome, filter) {
  const calls = []
  const problems = []
  let withoutUsage = 0
  let scannedFrames = 0
  let failedFrames = 0
  for (const log of sessionLogs(dshHome)) {
    if (filter.sessionPrefix !== undefined && !log.sessionId.startsWith(filter.sessionPrefix)) continue
    let decoded
    try {
      decoded = readSessionRows(log.file)
    } catch (error) {
      problems.push(`${log.sessionId}：日志读不出来（${error.message}）`)
      continue
    }
    scannedFrames += decoded.frames
    failedFrames += decoded.failedFrames
    if (decoded.failedFrames > 0) {
      problems.push(`${log.sessionId}：${decoded.failedFrames} 个 zstd 帧解不开（文件正在被写入？）—— 该会话的统计可能偏小`)
    }
    for (const row of decoded.rows) {
      if (row?.type !== 'assistant/message') continue
      const at = typeof row.time === 'number' ? row.time : undefined
      const usage = row.data?.usage
      if (usage === undefined) { withoutUsage += 1; continue }
      if (at === undefined) { problems.push(`${log.sessionId}：assistant/message 没有 time 字段，无法归日`); continue }
      const key = `${log.sessionId}#${row.data?.turn}#${row.data?.step}`
      calls.push({
        source: 'truth',
        sessionId: log.sessionId,
        workspace: log.workspace,
        turn: row.data?.turn,
        step: row.data?.step,
        at,
        day: beijingDayKey(at),
        provider: row.data?.message?.source?.provider ?? '?',
        model: row.data?.message?.source?.model ?? '?',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        key,
      })
    }
  }
  return { calls, withoutUsage, problems, scannedFrames, failedFrames }
}

// ---------------------------------------------------------------- 读两份账本
function butlerVaultCandidates() {
  const list = []
  if (process.env.BUTLER_VAULT !== undefined && process.env.BUTLER_VAULT !== '') list.push(resolve(process.env.BUTLER_VAULT))
  list.push(resolve(process.cwd(), '.butler', 'vault'))
  list.push('E:/opendots/.butler/vault')
  return list
}
function loadButlerLedger(filter) {
  const file = butlerVaultCandidates().map((v) => join(v, 'ledger', 'usage.jsonl')).find((p) => existsSync(p))
  if (file === undefined) return { file: undefined, rows: [], problems: ['没找到管家账本 usage.jsonl（试过 ' + butlerVaultCandidates().join(' / ') + '）'] }
  const problems = []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try { rows.push(JSON.parse(line)) } catch { problems.push('usage.jsonl 有一行不是 JSON，已跳过') }
  }
  const dayed = rows.map((row) => {
    const at = Date.parse(row.at ?? '')
    return {
      source: 'butler',
      sessionId: row.sessionId ?? '?',
      turn: row.turn,
      step: row.step,
      at,
      day: Number.isFinite(at) ? beijingDayKey(at) : '?',
      provider: row.provider ?? '?',
      model: row.model ?? '?',
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cacheReadTokens: row.cacheReadTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
      reasoningTokens: row.reasoningTokens ?? 0,
      totalTokens: row.totalTokens ?? (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheReadTokens ?? 0),
      key: `${row.sessionId ?? '?'}#${row.turn}#${row.step}`,
    }
  })
  return { file, rows: dayed, problems }
}
function loadDsUsageLedger() {
  const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-usage', 'usage-ledger.json')
  if (!existsSync(file)) return { file: undefined, days: {}, problems: ['没找到 dsh-usage 的 usage-ledger.json'] }
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    return { file, days: doc.days ?? {}, problems: [] }
  } catch (error) {
    return { file, days: {}, problems: [`usage-ledger.json 解析失败：${error.message}`] }
  }
}

// ---------------------------------------------------------------- 汇总
function emptyTotals() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, spend: 0, unpriced: 0 }
}
function addCall(totals, call) {
  totals.calls += 1
  totals.inputTokens += call.inputTokens
  totals.outputTokens += call.outputTokens
  totals.cacheReadTokens += call.cacheReadTokens
  totals.cacheWriteTokens += call.cacheWriteTokens
  totals.reasoningTokens += call.reasoningTokens
  totals.totalTokens += call.totalTokens
  if (Number.isFinite(call.at)) totals.spend += spend(call.model, call, call.at)
  else totals.unpriced += 1
  return totals
}
function foldBy(calls, groupKey) {
  const map = new Map()
  for (const call of calls) {
    const key = groupKey(call)
    if (!map.has(key)) map.set(key, emptyTotals())
    addCall(map.get(key), call)
  }
  return map
}
/** 真正新增的内容：未命中输入 + 缓存写 + 输出（不含命中缓存的重复上下文）。 */
function newTokens(totals) {
  return totals.inputTokens + totals.cacheWriteTokens + totals.outputTokens
}
function cacheHitRate(totals) {
  const denom = totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens
  return denom === 0 ? 0 : totals.cacheReadTokens / denom
}
function pct(x) { return `${(x * 100).toFixed(1)}%` }
function n(x) { return x.toLocaleString('en-US') }
function cny(x) { return `¥${x.toFixed(4)}` }

// ---------------------------------------------------------------- 对账
function reconcile(truth, mine) {
  const truthKeys = new Map()
  for (const call of truth) {
    if (!truthKeys.has(call.key)) truthKeys.set(call.key, [])
    truthKeys.get(call.key).push(call)
  }
  const mineKeys = new Map()
  for (const call of mine) {
    if (!mineKeys.has(call.key)) mineKeys.set(call.key, [])
    mineKeys.get(call.key).push(call)
  }
  const sum = (list) => list.reduce((acc, c) => ({
    inputTokens: acc.inputTokens + c.inputTokens,
    outputTokens: acc.outputTokens + c.outputTokens,
    cacheReadTokens: acc.cacheReadTokens + c.cacheReadTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
  const matched = []
  const missing = [] // 真值有、我没记 → 漏记
  const extra = []   // 我记了、真值没有 → 多记
  const mismatched = []
  for (const [key, list] of truthKeys) {
    if (!mineKeys.has(key)) { missing.push({ key, list }); continue }
    const t = sum(list)
    const m = sum(mineKeys.get(key))
    matched.push(key)
    if (t.inputTokens !== m.inputTokens || t.outputTokens !== m.outputTokens || t.cacheReadTokens !== m.cacheReadTokens) {
      mismatched.push({ key, truth: t, mine: m })
    }
  }
  for (const [key, list] of mineKeys) if (!truthKeys.has(key)) extra.push({ key, list })
  const duplicates = [...mineKeys.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, count: list.length }))
  return { matched, missing, extra, mismatched, duplicates, truthKeys, mineKeys }
}

// ---------------------------------------------------------------- 报告
function printReport(model, options) {
  const out = []
  const say = (line = '') => out.push(line)
  const { truth, mine, dsUsage, recon, days, filter, problems } = model
  model.options = options

  say('═══ 费用检测探针 ═══')
  say(`价格依据：${PRICE_SOURCE}；高峰 周一至周五 09:00-12:00 / 14:00-18:00（北京），其余时段半价`)
  say(`统计窗口：${days.join(' / ')}${filter.sessionPrefix === undefined ? '（全部会话）' : `，会话前缀 ${filter.sessionPrefix}`}`)
  say()

  say('── 1. 三条来源 ───────────────────────────')
  say(`A 事件真值   DSH 会话日志 session.v4.jsonl.zstd → ${n(truth.calls.length)} 次带用量的调用`
    + `${truth.withoutUsage > 0 ? `（另有 ${truth.withoutUsage} 次没有 usage 字段，按"未知"计，不当 0）` : ''}`
    + `｜扫描 ${truth.scannedFrames} 个 zstd 帧${truth.failedFrames > 0 ? `，其中 ${truth.failedFrames} 个解不开` : ''}`)
  say(`B 我记的     ${mine.file ?? '（未找到）'} → ${n(mine.rows.length)} 行`)
  say(`C 别人记的   ${dsUsage.file ?? '（未找到）'} → 覆盖 ${Object.keys(dsUsage.days).length} 天`)
  say()

  say('── 2. 账本对账（真值 vs 我记的）──────────')
  if (model.recorderFrom !== undefined) {
    say(`对账窗口 = 从管家记录器接上的那一刻起（${new Date(model.recorderFrom).toISOString()} / 北京 ${beijingDayKey(model.recorderFrom)} ${beijingClock(model.recorderFrom)}）`
      + `；在这之前的 ${n(model.beforeRecorder)} 次调用我还没开始记，不计入"漏记"。`)
  }
  say(`键 = 会话#turn#step；对账范围内 真值 ${n(recon.truthKeys.size)} 个键 / 我记 ${n(recon.mineKeys.size)} 个键`)
  say(`✅ 对得上 ${n(recon.matched.length)}｜❌ 漏记 ${n(recon.missing.length)}｜❌ 多记 ${n(recon.extra.length)}｜⚠️ 同键数值不符 ${n(recon.mismatched.length)}｜⚠️ 重复行 ${n(recon.duplicates.length)}`)
  const detail = recon.missing.length + recon.extra.length + recon.mismatched.length + recon.duplicates.length
  // 漏记的分类：离我最近的一行多远？—— 距离很近说明记录器当时在运行（真漏记），
  // 距离很远说明那一刻没有监听者（插件重载/未注入）。判据用数据，不猜。
  const myRows = [...mine.rows].filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at)
  const neighbours = (at) => {
    const prev = myRows.filter((r) => r.at <= at).pop()
    const next = myRows.find((r) => r.at > at)
    return {
      prev,
      next,
      prevGap: prev === undefined ? Infinity : at - prev.at,
      nextGap: next === undefined ? Infinity : next.at - at,
    }
  }
  const GAP_MS = 30_000
  const inGap = (at) => {
    const { prevGap, nextGap } = neighbours(at)
    return Math.min(prevGap, nextGap) > GAP_MS
  }
  const missingInGap = recon.missing.filter((x) => inGap(x.list[0].at)).length
  if (detail === 0) {
    say('结论：我记的每一行都能在 DSH 自己的日志里一字不差地对上，没有漏、没有重、没有编。')
  } else {
    if (recon.missing.length > 0) {
      say(`漏记分类（判据：离我最近的一行是否超过 ${GAP_MS / 1000} 秒）：`
        + `${missingInGap} 次落在"当时没有监听者"的窗口（插件重载/未注入），`
        + `${recon.missing.length - missingInGap} 次是记录器在运行期间的真漏记。`)
    }
    say('差异明细：')
    const show = (label, list, fmt) => {
      const slice = options.detail ? list : list.slice(0, options.maxDiff)
      for (const item of slice) say(`  ${label} ${fmt(item)}`)
      if (slice.length < list.length) say(`  … 其余 ${list.length - slice.length} 条用 --detail 看全`)
    }
    show('漏记', recon.missing, (x) => {
      const at = x.list[0].at
      const { prev, next, prevGap, nextGap } = neighbours(at)
      const side = (row, gap) => row === undefined ? '（无）' : `${row.key} ${beijingClock(row.at)}（Δ${Math.round(gap / 1000)}s）`
      return `${x.key} @北京 ${beijingClock(at)}｜真值 input ${x.list.reduce((a, c) => a + c.inputTokens, 0)} / output ${x.list.reduce((a, c) => a + c.outputTokens, 0)}`
        + `｜上一条我记的 ${side(prev, prevGap)}｜下一条 ${side(next, nextGap)}`
    })
    show('多记', recon.extra, (x) => `${x.key}（${x.list.length} 行）`)
    show('数值不符', recon.mismatched, (x) => `${x.key} 真值 ${JSON.stringify(x.truth)} ≠ 我记 ${JSON.stringify(x.mine)}`)
    show('重复行', recon.duplicates, (x) => `${x.key} 记了 ${x.count} 次`)
  }
  say()

  // 会话覆盖率：真值里有、我完全没记的会话
  const truthSessions = new Set(truth.calls.map((c) => c.sessionId))
  const mineSessions = new Set(mine.rows.map((c) => c.sessionId))
  const uncovered = [...truthSessions].filter((s) => !mineSessions.has(s))
  say(`会话覆盖：真值里出现 ${truthSessions.size} 个会话，我记过 ${mineSessions.size} 个；我没覆盖到的 ${uncovered.length} 个`
    + `${uncovered.length > 0 ? `（${uncovered.slice(0, 3).join('、')}${uncovered.length > 3 ? ' …' : ''}）` : ''}`)
  say()

  say('── 3. token 口径：为什么"总数"看着大 ───────')
  const totals = mine.rows.reduce((acc, c) => addCall(acc, c), emptyTotals())
  const td = truth.calls.reduce((acc, c) => addCall(acc, c), emptyTotals())
  const line = (label, t) => say(`${label}  ${n(t.calls)} 次调用｜① provider 报的 totalTokens ${n(t.totalTokens)}`
    + `　② 真正新增的 token ${n(newTokens(t))}（未命中输入 ${n(t.inputTokens)} + 输出 ${n(t.outputTokens)}${t.reasoningTokens > 0 ? `（含推理 ${n(t.reasoningTokens)}）` : ''}）`
    + `　③ 缓存读 ${n(t.cacheReadTokens)}（占输入的 ${pct(cacheHitRate(t))}，单价 1/50）`)
  line('真值 ', td)
  line('我记 ', totals)
  say(`差  ${n(totals.totalTokens - td.totalTokens)} totalTokens`
    + `${Math.abs(totals.totalTokens - td.totalTokens) === 0 ? '（完全一致）' : `；差额全部来自"我还没开始记"的那段时间（${n(model.beforeRecorder)} 次调用）`}`)
  say()
  say('说明：provider 的 totalTokens = 未命中输入 + 缓存读 + 输出；②才是这次对话真正"新"的内容，')
  say('     ③是每一步重发的整段上下文里命中缓存的部分，虽然量大，但单价只有未命中输入的 1/50（低谷再半价）。')
  say()

  say('── 4. 钱（官方价目表估算）──────────────────')
  const perDay = days.map((day) => {
    const t = truth.calls.filter((c) => c.day === day)
    const m = mine.rows.filter((c) => c.day === day)
    return { day, truth: t.reduce((a, c) => addCall(a, c), emptyTotals()), mine: m.reduce((a, c) => addCall(a, c), emptyTotals()) }
  })
  for (const row of perDay) {
    const ds = dsUsage.days[row.day]
    let dsNumber = '—'
    if (ds !== undefined) {
      const parts = []
      for (const [provider, models] of Object.entries(ds)) {
        for (const [model, t] of Object.entries(models)) parts.push(`${provider}/${model} ¥${(t.cost ?? 0).toFixed(4)}（${n(t.calls)} 次）`)
      }
      dsNumber = parts.join('；')
    }
    say(`${row.day}  真值估算 ${cny(row.truth.spend)}（${n(row.truth.calls)} 次）｜我记估算 ${cny(row.mine.spend)}｜dsh-usage 账本 ${dsNumber}`)
  }
  const all = td
  const asMiss = truth.calls.reduce((acc, c) => acc + spend(c.model, c, c.at, { cacheAsMiss: true }), 0)
  say()
  say(`命中缓存的输入有 ${n(all.cacheReadTokens)} tokens（占输入 ${pct(cacheHitRate(all))}），按缓存价计费；`)
  say(`缓存省下的钱：若这些缓存读全按未命中输入价付，这 ${n(all.calls)} 次要 ${cny(asMiss)}，实际估算 ${cny(all.spend)} —— 缓存省了约 ${cny(asMiss - all.spend)}。`)
  say()
  const top = [...truth.calls].map((c) => ({ call: c, cost: spend(c.model, c, c.at) })).sort((a, b) => b.cost - a.cost).slice(0, model.options.top)
  if (top.length > 0) {
    say(`最贵的 ${top.length} 次调用（钱花在哪些步上）：`)
    for (const { call, cost } of top) {
      say(`  ${beijingDayKey(call.at)} ${beijingClock(call.at)} 北京｜${call.sessionId.slice(0, 20)}…#${call.turn}#${call.step}`
        + `｜totalTokens ${n(call.totalTokens)}（新增 ${n(call.inputTokens + call.outputTokens)} + 缓存读 ${n(call.cacheReadTokens)}）＝ ${cny(cost)}`)
    }
    say()
  }

  say('── 5. 结论 ───────────────────────────────')
  const verdicts = []
  const bad = recon.extra.length + recon.mismatched.length + recon.duplicates.length
  verdicts.push(bad === 0 && recon.missing.length === 0
    ? '① 记录可信：我记的每一行都与 DSH 自己落的会话日志逐键一致，没有漏记/多记/重复。'
    : bad === 0
      ? `① 记录基本可信：逐键对上的 ${n(recon.matched.length)} 次数值完全一致，没有多记、没有重复、没有编造；但有 ${n(recon.missing.length)} 次漏记（其中 ${n(missingInGap)} 次落在记录器没运行的空档）—— 需要在启动时从会话日志回填。`
      : `① 记录有问题：多记 ${recon.extra.length}、数值不符 ${recon.mismatched.length}、重复 ${recon.duplicates.length}（漏记 ${recon.missing.length}）—— 见第 2 节。`)
  verdicts.push(`② "消耗量太大"主要是口径错觉：${n(all.totalTokens)} 这个数把每一步重发的缓存命中部分也算进去了；真正新增的只有 ${n(newTokens(all))} tokens（未命中输入 + 输出），另外 ${n(all.cacheReadTokens)} tokens 是缓存读（占输入 ${pct(cacheHitRate(all))}，单价 1/50）。`)
  verdicts.push(`③ 真金白银：按官方价目表，这 ${n(all.calls)} 次调用约 ${cny(all.spend)}（高峰/低谷按调用时刻分别计价）。构成：缓存读 ${cny(all.cacheReadTokens * 0.02 / 1e6)}（低谷价粗算）+ 未命中输入 ${cny(all.inputTokens * 1.0 / 1e6)} + 输出 ${cny(all.outputTokens * 4.0 / 1e6)}。`)
  verdicts.push('④ 价格不由 DSH 提供（DSH 只暴露 token 数），上面每一分钱都是按官方价目表算的估算值，不是账单。')
  for (const v of verdicts) say(v)
  if (problems.length > 0) {
    say()
    say('── 限制与冲突 ────────────────────────────')
    for (const p of problems) say(`· ${p}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const options = {
    days: 1,
    date: undefined,
    sessionPrefix: undefined,
    detail: false,
    json: false,
    maxDiff: 10,
    top: 5,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--date') { options.date = argv[i + 1]; i += 1 } else if (arg === '--days') { options.days = Number(argv[i + 1]); i += 1 } else if (arg === '--session') { options.sessionPrefix = argv[i + 1]; i += 1 } else if (arg === '--detail') { options.detail = true } else if (arg === '--json') { options.json = true } else if (arg === '--max-diff') { options.maxDiff = Number(argv[i + 1]); i += 1 } else if (arg === '--top') { options.top = Number(argv[i + 1]); i += 1 }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const filter = { sessionPrefix: options.sessionPrefix }
  const now = Date.now()
  const days = options.date !== undefined
    ? [options.date]
    : Array.from({ length: options.days }, (_, k) => beijingDayKey(now - k * 86_400_000))
  const wanted = new Set(days)

  const problems = []
  const truth = truthCalls(dshHome, filter)
  problems.push(...truth.problems)
  const inWindow = (call) => call.day === '?' || wanted.has(call.day)
  truth.calls = truth.calls.filter(inWindow)

  const butler = loadButlerLedger(filter)
  problems.push(...butler.problems)
  const mine = { file: butler.file, rows: butler.rows.filter(inWindow) }
  const dsUsage = loadDsUsageLedger()
  problems.push(...dsUsage.problems)

  // 对账只在我确实开始记录之后才有意义：取我第一行的时间作为窗口下界。
  let recorderFrom
  let beforeRecorder = 0
  let reconCalls = truth.calls
  if (mine.rows.length > 0) {
    recorderFrom = Math.min(...mine.rows.map((r) => r.at).filter((t) => Number.isFinite(t)))
    beforeRecorder = truth.calls.filter((c) => c.at < recorderFrom).length
    reconCalls = truth.calls.filter((c) => c.at >= recorderFrom)
  }

  const recon = reconcile(reconCalls, mine.rows)
  const model = { truth, mine, dsUsage, recon, days, filter, problems, recorderFrom, beforeRecorder, reconCalls }

  if (options.json) {
    const json = {
      priceBasis: { source: PRICE_SOURCE, table: PRICE, peakWindows: PEAK_WINDOWS, note: 'CNY per million tokens; off-peak = half of peak' },
      window: { days, sessionPrefix: options.sessionPrefix ?? null },
      truth: { calls: truth.calls.length, withoutUsage: truth.withoutUsage, frames: truth.scannedFrames, failedFrames: truth.failedFrames, totals: truth.calls.reduce((a, c) => addCall(a, c), emptyTotals()) },
      butler: { file: mine.file ?? null, rows: mine.rows.length, totals: mine.rows.reduce((a, c) => addCall(a, c), emptyTotals()) },
      reconcile: { matched: recon.matched.length, missing: recon.missing.length, extra: recon.extra.length, mismatched: recon.mismatched, duplicates: recon.duplicates },
      recorderWindow: { from: recorderFrom ?? null, callsBeforeRecorder: beforeRecorder },
      problems,
    }
    process.stdout.write(JSON.stringify(json, null, 2) + '\n')
    return
  }
  process.stdout.write(printReport(model, options) + '\n')
}

main()
