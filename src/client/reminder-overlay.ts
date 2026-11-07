/**
 * Frame-wide reminder overlay (seat: `shell.overlay`).
 *
 * The workbench banner only exists while the workbench is mounted. Reminders must
 * be visible from *any* page, so this overlay uses its own small pollable slice
 * (`GET /api/due`) instead of re-reading the whole dashboard. Acknowledgement is
 * stored per occurrence (`id@scheduledAt`) in localStorage, so a dismissed
 * overdue reminder does not nag on every page load, while the next occurrence of
 * a recurring rule surfaces again.
 *
 * @module @dsh-external/dsh-butler/client
 */
import { createElement as h, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { fetchDueReminders, type DueReminder } from './api.ts'
import { openButlerConversation } from './navigate.ts'
import { BUTLER_COLORS, BUTLER_SPACE } from './ui/index.ts'
import { documentHidden, onDocumentVisible } from './visibility.ts'

/** localStorage key holding acknowledged occurrence keys. */
export const DUE_DISMISS_KEY = 'butler:due-dismissed'

/** Stable identity of one occurrence, so a new occurrence is not pre-dismissed. */
export function dueCardKey(record: Pick<DueReminder, 'id' | 'scheduledAt'>): string {
  return `${record.id}@${record.scheduledAt ?? ''}`
}

/** Read acknowledged occurrence keys; unreadable storage means "nothing acknowledged". */
export function readDismissed(): Record<string, true> {
  try {
    const raw = localStorage.getItem(DUE_DISMISS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, true> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) if (value === true) out[key] = true
    return out
  } catch {
    return {}
  }
}

/** Persist acknowledged occurrence keys; storage failures are not fatal. */
export function writeDismissed(value: Record<string, true>): void {
  try { localStorage.setItem(DUE_DISMISS_KEY, JSON.stringify(value)) } catch { /* private mode · quota */ }
}

/** Due reminders minus the acknowledged ones. */
export function visibleDueReminders(due: readonly DueReminder[], dismissed: Record<string, true>): DueReminder[] {
  return due.filter(record => dismissed[dueCardKey(record)] !== true)
}

/** Props passed by the seat registration. */
export interface ReminderOverlayProps {
  ctx: Context
}

const wrapStyle = {
  position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483000,
  display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.sm, maxWidth: '340px',
} as const
const cardStyle = {
  background: BUTLER_COLORS.bgOverlay, color: BUTLER_COLORS.labelPrimary,
  border: `1px solid ${BUTLER_COLORS.warn}`, borderRadius: '10px', padding: `${BUTLER_SPACE.sm} ${BUTLER_SPACE.md}`,
  boxShadow: '0 8px 24px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: BUTLER_SPACE.xs,
} as const

/**
 * Render due reminders above every column; nothing to show renders `null`.
 * @param props - client context for navigation.
 * @returns the overlay element or null.
 */
export function ButlerReminderOverlay(props: ReminderOverlayProps): unknown {
  const [due, setDue] = useState<DueReminder[]>([])
  const [dismissed, setDismissed] = useState<Record<string, true>>(() => readDismissed())
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const poll = (): void => {
      if (documentHidden()) return
      void fetchDueReminders(controller.signal).then(payload => {
        if (disposed) return
        setDue(Array.isArray(payload.due) ? payload.due : [])
        setProblem(payload.available === false ? (payload.reason ?? '提醒暂不可读') : null)
      }, cause => {
        if (disposed) return
        setProblem(cause instanceof Error ? cause.message : String(cause))
      })
    }
    poll()
    const timer = window.setInterval(poll, 60000)
    const cancelVisible = onDocumentVisible(poll)
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); cancelVisible() }
  }, [])

  const shown = visibleDueReminders(due, dismissed).slice(0, 3)
  if (shown.length === 0) return null
  const acknowledge = (record: DueReminder): void => {
    const next = { ...dismissed, [dueCardKey(record)]: true as const }
    setDismissed(next)
    writeDismissed(next)
  }
  return h('div', { 'data-dsh-butler-overlay': '', role: 'status', 'aria-label': `到期提醒 ${shown.length} 条`, style: wrapStyle },
    ...shown.map(record => h('div', { key: dueCardKey(record), style: cardStyle },
      h('div', { style: { fontWeight: 600, fontSize: '13px', lineHeight: '20px', overflowWrap: 'anywhere' } }, `提醒：${record.title}`),
      h('div', { style: { color: BUTLER_COLORS.labelSecondary, fontSize: '12px', lineHeight: '18px' } },
        record.scheduledAt === undefined ? '计划时间未知' : `计划 ${new Date(record.scheduledAt).toLocaleString('zh-CN')}`),
      problem === null ? null : h('div', { style: { color: BUTLER_COLORS.warn, fontSize: '12px' } }, problem),
      h('div', { style: { display: 'flex', gap: BUTLER_SPACE.xs, justifyContent: 'flex-end' } },
        h('button', { type: 'button', className: 'butler-btn butler-btn--ghost butler-btn--sm',
          'aria-label': `知道了：${record.title}`, onClick: () => acknowledge(record) }, '知道了'),
        h('button', { type: 'button', className: 'butler-btn butler-btn--secondary butler-btn--sm',
          onClick: () => { void openButlerConversation(props.ctx) } }, '打开管家')))))
}
