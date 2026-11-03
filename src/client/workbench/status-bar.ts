/**
 * The workbench status bar: page title, the three page-level metrics and the
 * two page-level actions, plus the non-fatal notices that belong above content.
 *
 * ## Why a plain builder instead of a component
 * The workbench panel is one stateful owner; this file only composes its
 * header from that owner's values. It stays a *plain function* (not an
 * `h(StatusBar, ...)` component) for two reasons:
 * * the header's raw host `<button>` elements stay directly reachable by the
 *   existing fake-tree panel harness (it walks host elements, not components),
 *   so `刷新` keeps its accessible name and click wiring under test;
 * * the butler visual layer is `h()`-callable components, and a builder that
 *   returns host elements keeps this file from duplicating component internals.
 *
 * ## Metric tones
 * The three chips reuse the ledger's {@link statusTone} vocabulary instead of
 * inventing a parallel health vocabulary: a healthy/complete state borrows the
 * `done` tone, a degraded/attention state borrows `waiting_review`, and an
 * unknown state borrows `pending`. A host theme change therefore recolours the
 * chips and the task pills together.
 *
 * @module @dsh-external/dsh-butler/client/workbench
 */
import { createElement as h } from 'react'
import type { Overview } from '../api.ts'
import {
  Banner,
  InlineError,
  StatChip,
  statusTone,
  type ButlerTone,
} from '../ui/index.ts'
import { runtimeView } from '../workbench-model.ts'
import { shortTime } from '../view.ts'

/** One chip projection: the visible value plus the shared tone. */
interface ChipView {
  label: string
  value: string
  tone: ButlerTone
}

/** The runtime snapshot `runtimeView` returns; derived once by the panel. */
export type WorkbenchRuntimeView = ReturnType<typeof runtimeView>

/** Props of {@link workbenchStatusBar}. */
export interface WorkbenchStatusBarProps {
  /** Latest overview, or `null` before the first successful read. */
  overview: Overview | null
  /** Projection of `overview.runtimeControls` (shared with the system zone). */
  controls: WorkbenchRuntimeView
  /** Items currently waiting for the owner (待核对 + 中断 + 待批 + 记忆提案). */
  reviewCount: number
  /** Last overview read failure; the previous snapshot stays on screen. */
  error: string | null
  /** Failure of the "和管家说话" navigation, when it did not open. */
  navProblem: string | null
  /** Re-read the overview (the page's `刷新`). */
  onRefresh: () => void
  /** Open the butler's own conversation. */
  onTalk: () => void
}

/**
 * Build the page header.
 *
 * Copy contract: the title and the two actions are stable product strings
 * (`管家工作台`, `刷新`, `和管家说话`); the metric captions stay short nouns.
 * @param props - overview projection, notices and the two actions.
 * @returns the header element tree (a host `<header>` plus an optional notice row).
 */
export function workbenchStatusBar(props: WorkbenchStatusBarProps): unknown {
  const overview = props.overview
  // Before the first snapshot the chips say what the reader is waiting for; a
  // failed first read must not keep claiming "读取中…" forever.
  const pendingValue = props.error === null ? '读取中…' : '读取失败'
  const runtime: ChipView = overview === null
    ? { label: '运行保护', value: pendingValue, tone: statusTone('pending') }
    : props.controls.state === 'healthy'
      ? { label: '运行保护', value: '正常', tone: statusTone('done') }
      : props.controls.state === 'degraded'
        ? { label: '运行保护', value: '有异常', tone: statusTone('waiting_review') }
        : { label: '运行保护', value: '未知', tone: statusTone('pending') }
  const storage = overview === null
    ? { label: '存储', value: pendingValue, tone: statusTone('pending') }
    : overview.runtimeControls?.storage === undefined
      ? { label: '存储', value: '未知', tone: statusTone('pending') }
      : overview.runtimeControls.storage.degraded
        ? { label: '存储', value: '降级', tone: statusTone('failed') }
        : { label: '存储', value: '正常', tone: statusTone('done') }
  const review: ChipView = overview === null
    ? { label: '待核对', value: pendingValue, tone: statusTone('pending') }
    : props.reviewCount > 0
      ? { label: '待核对', value: `${props.reviewCount} 项`, tone: statusTone('waiting_review') }
      : { label: '待核对', value: '无', tone: statusTone('done') }
  const freshness = overview === null
    ? (props.error === null ? '正在读取…' : '读取失败')
    : `更新于 ${shortTime(overview.generatedAt)} · ${overview.timeZone}`

  const notices: unknown[] = []
  if (props.error !== null && props.overview !== null) {
    notices.push(h(InlineError, {
      key: 'read-error',
      message: `读取失败：${props.error}；已保留上次快照。`,
      retry: props.onRefresh,
      retryLabel: '重试',
    }))
  }
  if (overview?.ledgerError !== undefined) {
    notices.push(h(InlineError, {
      key: 'ledger-error',
      message: `账本不可用，原件已保留：${overview.ledgerError}`,
    }))
  }
  if (overview?.sessionError !== undefined) {
    notices.push(h(InlineError, {
      key: 'session-error',
      message: `管家会话读不到：${overview.sessionError}`,
    }))
  }
  if (props.navProblem !== null) {
    notices.push(h(Banner, { key: 'nav-problem', tone: 'warn', role: 'status' }, props.navProblem))
  }

  const head = h('header', { className: 'butler-surface__head' },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' } },
      h('h2', { className: 'butler-surface__title' }, '管家工作台'),
      h('span', { className: 'butler-surface__sub' }, freshness)),
    h('div', { className: 'butler-row', style: { flex: '0 0 auto' } },
      h(StatChip, { label: runtime.label, value: runtime.value, tone: runtime.tone }),
      h(StatChip, { label: storage.label, value: storage.value, tone: storage.tone }),
      h(StatChip, { label: review.label, value: review.value, tone: review.tone })),
    h('span', { className: 'butler-surface__spacer' }),
    // Host buttons on purpose: see the module note. Classes are the design
    // system's own; only the element is hand-authored so the existing panel
    // harness can keep addressing `刷新` by its accessible name.
    h('button', {
      type: 'button',
      className: 'butler-btn butler-btn--primary butler-btn--sm',
      title: overview?.session === undefined ? '打开和管家的专属对话' : `打开和管家的专属对话（${overview.session.id}）`,
      onClick: props.onTalk,
    }, '和管家说话'),
    h('button', {
      type: 'button',
      className: 'butler-btn butler-btn--secondary butler-btn--sm',
      onClick: props.onRefresh,
    }, '刷新'))

  return h('div', {},
    head,
    notices.length === 0
      ? null
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 16px 0' } }, ...notices))
}
