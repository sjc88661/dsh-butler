/**
 * Butler notice region - the polite, transient-message strip.
 *
 * ## Why the region is always mounted
 * A live region only announces content that is inserted *after* it exists. If
 * this component returned `null` while there was nothing to say, the first
 * notice would be inserted into a brand-new element and stay silent. So the
 * `<section aria-live="polite">` is rendered unconditionally; emptiness is
 * expressed by having no children.
 *
 * ## Expiry is the caller's job
 * The component renders a list it is handed and owns no timer: an internal
 * timeout would race the caller's own state (a notice cleared on unmount, a
 * second notice arriving while the first is fading) and would make the
 * component impossible to test without fake timers. The caller appends notices
 * and prunes them; this component only decides how many of the newest to show.
 *
 * @module @dsh-external/dsh-butler/client/ui
 */
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { cx } from './components.ts'
import type { ButlerTone } from './tokens.ts'

/** One notice to announce. */
export interface NoticeItem {
  /** Tone drives the left rule colour. */
  tone: ButlerTone
  /** Message text; the caller localises it. */
  text: string
  /** Creation instant (epoch ms or ISO string); used as the list key only. */
  at: number | string
}

/** Props of {@link NoticeRegion}. */
export interface NoticeRegionProps {
  /** Notices in chronological order; only the newest `max` are shown. */
  notices: readonly NoticeItem[]
  /** How many of the newest notices to show; default 3. */
  max?: number
  /** Accessible name of the region; default `'Notifications'`. */
  ariaLabel?: string
  className?: string
}

/**
 * Render the polite live region.
 * @param props - the notice list and the visible cap.
 * @returns the always-mounted `aria-live` section.
 */
export function NoticeRegion(props: NoticeRegionProps): ReactNode {
  const max = props.max === undefined || props.max < 1 ? 3 : Math.floor(props.max)
  const shown = props.notices.length > max
    ? props.notices.slice(props.notices.length - max)
    : props.notices
  return h('section', {
    className: cx('butler-notices', props.className),
    'aria-live': 'polite',
    'aria-atomic': 'false',
    'aria-label': props.ariaLabel ?? 'Notifications',
  }, ...shown.map(notice => h('div', {
    key: `${notice.at}-${notice.text}`,
    className: cx('butler-notice', `butler-notice--${notice.tone}`),
  }, h('span', { className: 'butler-notice__text' }, notice.text))))
}
