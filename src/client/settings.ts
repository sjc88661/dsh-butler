/**
 * 管家设置页（席位：`settings.section`）。
 *
 * 只呈现宿主已经拥有的字段：时区、简报时段、飞书状态、数据目录、保留策略与
 * 备份列表；唯一写操作是"立即备份"（本地快照，不联网）。不在这里改配置：
 * 配置属于 profile 的 Cordis patch，改错会直接影响启动，页面上给的是位置与
 * 当前生效值，而不是一个可能悄悄失败的表单。
 *
 * @module @dsh-external/dsh-butler/client
 */
import { createElement as h, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createBackup, fetchSettings, fetchUsageReport, type SettingsPayload, type UsageReportPayload } from './api.ts'
import { BUTLER_COLORS, BUTLER_SPACE, Button, InlineError, KeyValue, LoadingBlock } from './ui/index.ts'

/** Props the settings seat hands over. */
export interface ButlerSettingsProps {
  ctx?: Context
  /** Close the settings panel (owner-provided by the shell). */
  close?: () => void
}

/** Human format for one byte count. */
function bytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/** Format one brief slot as `08:30 起（补写窗口到 14:00）`. */
function slotLine(slot: SettingsPayload['brief']['slots'][number]): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(slot.hour)}:${pad(slot.minute)} 起（补写窗口到 ${pad(slot.untilHour)}:00）`
}

/**
 * Render the butler settings page.
 * @param props - shell-provided close handler (unused by read-only rows).
 * @returns the settings panel content.
 */
export function ButlerSettings(props: ButlerSettingsProps): unknown {
  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [usage, setUsage] = useState<UsageReportPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastBackup, setLastBackup] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const [nextSettings, nextUsage] = await Promise.all([fetchSettings(), fetchUsageReport(14)])
      setSettings(nextSettings)
      setUsage(nextUsage)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => { void load() }, [])

  const backupNow = (): void => {
    setBusy(true)
    void createBackup().then(result => {
      setLastBackup(result.id)
      return load()
    }, cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => setBusy(false))
  }

  const wrap = (children: unknown[]): unknown => h('div', {
    'data-butler-settings': '',
    style: { display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.md, padding: '4px 0' },
  }, ...children)

  if (settings === null) {
    return wrap([error === null
      ? h(LoadingBlock, { label: '正在读取管家设置…', lines: 4 })
      : h(InlineError, { message: `设置读取失败：${error}`, retry: () => { void load() }, retryLabel: '重试' })])
  }

  const feishu = settings.feishu
  const rows: unknown[] = [
    h('h2', { style: { margin: '0', fontSize: '15px', lineHeight: '22px', color: BUTLER_COLORS.labelPrimary } }, '管家'),
    error === null ? null : h(InlineError, { message: `设置读取失败：${error}`, retry: () => { void load() }, retryLabel: '重试' }),
    h(KeyValue, { label: '时区', value: settings.timeZone }),
    h(KeyValue, { label: '早报', value: slotLine(settings.brief.slots.find(slot => slot.kind === 'morning')!) }),
    h(KeyValue, { label: '晚报', value: slotLine(settings.brief.slots.find(slot => slot.kind === 'evening')!) }),
    h(KeyValue, { label: '飞书提醒', value: feishu.enabled
      ? (feishu.configured
        ? `已启用 · 已发送 ${feishu.sent ?? 0} · 失败 ${feishu.failed ?? 0} · 放弃 ${feishu.gaveUp ?? 0} · 密钥来源 ${feishu.credentialSource === 'credentials' ? 'credentials' : feishu.credentialSource === 'config' ? 'profile 配置' : '未知'}`
        : '已启用但凭据不完整（appSecret 未配置）')
      : '未启用（配置 profile 的 dsh-butler.feishu* 后重载 bundle）' }),
    feishu.lastError === undefined ? null : h(KeyValue, { label: '飞书最近错误', value: feishu.lastError, tone: 'warn' }),
    h(KeyValue, { label: '数据目录', value: settings.data.vaultHome }),
    h(KeyValue, { label: '状态目录', value: settings.data.stateHome }),
    h(KeyValue, { label: '压缩备份保留', value: `最新 ${settings.retention.compaction.keepNewest} 份；超 ${settings.retention.compaction.days} 天或超 ${bytes(settings.retention.compaction.maxBytes)} 删除` }),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: BUTLER_SPACE.sm, flexWrap: 'wrap' } },
      h(Button, { size: 'sm', variant: 'secondary', disabled: busy, onClick: backupNow }, busy ? '备份中…' : '立即备份'),
      lastBackup === null ? null : h('span', { style: { fontSize: '12px', color: BUTLER_COLORS.labelSecondary } }, `已创建 ${lastBackup}`)),
    h(KeyValue, { label: '备份目录', value: settings.data.backupHome }),
    h(KeyValue, { label: '快照保留', value: `最新 ${settings.retention.backupKeep} 份` }),
    h('h3', { style: { margin: `${BUTLER_SPACE.sm} 0 0`, fontSize: '13px', lineHeight: '20px', color: BUTLER_COLORS.labelPrimary } }, '用量与费用（近 14 天）'),
    usage === null ? h('div', { style: { fontSize: '12px', color: BUTLER_COLORS.labelSecondary } }, '用量暂不可读。')
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        h('div', { style: { fontSize: '12px', lineHeight: '18px', color: BUTLER_COLORS.labelPrimary } },
          `${usage.fromDate} → ${usage.toDate}：${usage.totals.calls} 次调用 / ${usage.totals.totalTokens.toLocaleString('en-US')} tokens / 估算 ¥${usage.totals.cost.toFixed(2)} / 未计价 ${usage.coverage.unpriced} / 无用量 ${usage.coverage.missing}`),
        ...usage.daily.slice(-7).map(day => h('div', {
          key: day.date,
          style: { display: 'flex', justifyContent: 'space-between', gap: BUTLER_SPACE.sm, fontSize: '12px', color: BUTLER_COLORS.labelSecondary },
        },
        h('span', {}, day.date),
        h('span', {}, `${day.calls} 次 · ${day.totalTokens.toLocaleString('en-US')} tok · ¥${day.cost.toFixed(2)}${day.unpricedCalls === 0 ? '' : ` · 未计价 ${day.unpricedCalls}`}`))),
        h('p', { style: { margin: '0', fontSize: '12px', lineHeight: '18px', color: BUTLER_COLORS.labelSecondary } }, usage.note)),
    h('div', { style: { fontSize: '12px', color: BUTLER_COLORS.labelSecondary } },
      settings.backups.length === 0 ? '还没有备份。' : `已有 ${settings.backups.length} 份备份：`),
    ...settings.backups.slice(0, 5).map(entry => h('div', {
      key: entry.id,
      style: { display: 'flex', justifyContent: 'space-between', gap: BUTLER_SPACE.sm, fontSize: '12px',
        color: entry.broken === undefined ? BUTLER_COLORS.labelPrimary : BUTLER_COLORS.error, flexWrap: 'wrap' },
    },
    h('span', {}, entry.id),
    h('span', { style: { color: BUTLER_COLORS.labelSecondary } },
      entry.broken === undefined ? `${entry.files ?? '?'} 文件 · ${bytes(entry.bytes)}` : `损坏：${entry.broken}`))),
    h('p', { style: { margin: '0', fontSize: '12px', lineHeight: '18px', color: BUTLER_COLORS.labelSecondary } },
      '配置本身在 profile 的 Cordis patch（id: dsh-butler）里；改完重载 bundle 生效。备份只在本机，不上传。'),
  ]
  return wrap(rows)
}
