import { createElement as h } from 'react'
import type { TaskStatus } from './api.ts'

export const T = {
  bg: 'var(--dsw-alias-bg-layer-1, #1b1b1f)', bg2: 'var(--dsw-alias-bg-layer-2, #232329)',
  border: 'var(--dsw-alias-border-l1, #33333c)', border2: 'var(--dsw-alias-border-l2, #44444f)',
  text: 'var(--dsw-alias-label-primary, #f2f2f5)', dim: 'var(--dsw-alias-label-secondary, #a0a0ab)',
  brand: 'var(--dsw-alias-brand-primary, #6d8bff)', ok: 'var(--dsw-alias-state-success-primary, #4fb477)',
  warn: 'var(--dsw-alias-state-warn-primary, #e0a44a)', err: 'var(--dsw-alias-state-error-primary, #e06a6a)', idle: 'var(--dsw-alias-state-idle-primary, #8b8b96)',
}
export const STATUS_LABEL: Record<TaskStatus, string> = { pending: '待办', running: '进行中', waiting_review: '待你点头', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '重启打断' }
export const STATUS_COLOR: Record<TaskStatus, string> = { pending: T.dim, running: T.brand, waiting_review: T.warn, done: T.ok, failed: T.err, cancelled: T.idle, interrupted: T.warn }
export const buttonStyle = { fontSize: '12px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', color: T.text, background: T.bg2, border: `1px solid ${T.border2}` }

export function shortTime(iso: string | undefined): string {
  if (!iso) return '未知'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
export function shortDuration(ms: number | undefined): string {
  if (ms === undefined) return '未知'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)}分` : `${(ms / 1000).toFixed(1)}s`
}
export function shortNumber(n: number | undefined): string { return n === undefined ? '未知' : n.toLocaleString('zh-CN') }
export function emptyLine(text: string): unknown { return h('div', { style: { color: T.dim, fontSize: '12px', padding: '6px 0', wordBreak: 'break-word' } }, text) }
export function section(title: string, count: number | undefined, children: unknown): unknown {
  return h('section', { style: { background: T.bg, border: `1px solid ${T.border}`, borderRadius: '8px', padding: '10px 12px', minWidth: '0' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', fontSize: '12px', color: T.dim } },
      h('span', { style: { color: T.text, fontWeight: '600' } }, title), count === undefined ? null : h('span', {}, String(count))), children)
}
