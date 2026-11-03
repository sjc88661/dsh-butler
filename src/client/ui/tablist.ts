/**
 * Butler tab list - a real WAI-ARIA tablist.
 *
 * ## Why this is not just three buttons in a row
 * A row of buttons that swaps content looks like tabs and is not one: a screen
 * reader announces "button" with no relationship to the panel it changed. This
 * module implements the pattern properly:
 * * `role="tablist"` / `role="tab"` / `role="tabpanel"` with a shared id
 *   convention, so `aria-controls` / `aria-labelledby` resolve;
 * * roving `tabIndex` (selected tab 0, the rest -1) so Tab enters the strip once
 *   and arrows move inside it;
 * * ArrowLeft/ArrowRight (ArrowUp/ArrowDown for a vertical strip), Home and End,
 *   with activation following focus - the host's Plugins section behaves the
 *   same way, and it makes one keypress do what two would;
 * * disabled tabs are skipped by the arrow walk.
 *
 * ## Id convention
 * `butler-tab-<item id>` and `butler-tabpanel-<item id>`, or
 * `<idPrefix>-tab*` when two tab strips are on screen at once. The panel id is
 * the one the brief fixes: `butler-tabpanel-*`.
 *
 * @module @dsh-external/dsh-butler/client/ui
 */
import { createElement as h, useRef } from 'react'
import type { ReactNode } from 'react'
import { cx } from './components.ts'

/** Prefix that yields the documented `butler-tabpanel-*` panel ids by default. */
export const DEFAULT_TAB_ID_PREFIX = 'butler'

/**
 * Id of a tab element.
 * @param itemId - the tab's stable id.
 * @param idPrefix - strip prefix; defaults to `butler`.
 * @returns the DOM id, e.g. `butler-tab-tasks`.
 */
export function tabId(itemId: string, idPrefix: string = DEFAULT_TAB_ID_PREFIX): string {
  return `${idPrefix}-tab-${itemId}`
}

/**
 * Id of the panel controlled by a tab (the documented `butler-tabpanel-*` form).
 * @param itemId - the tab's stable id.
 * @param idPrefix - strip prefix; defaults to `butler`.
 * @returns the DOM id, e.g. `butler-tabpanel-tasks`.
 */
export function tabPanelId(itemId: string, idPrefix: string = DEFAULT_TAB_ID_PREFIX): string {
  return `${idPrefix}-tabpanel-${itemId}`
}

/** One tab of a {@link Tablist}. */
export interface TabItem {
  /** Stable id; feeds both DOM ids. */
  id: string
  /** Visible label. */
  label: ReactNode
  /** Optional count rendered as a trailing badge. */
  badge?: number
  /** Disabled tabs are skipped by the keyboard walk. */
  disabled?: boolean
}

/** Props of {@link Tablist}. */
export interface TablistProps {
  /** Tabs, in display order. */
  items: readonly TabItem[]
  /** Id of the selected tab (controlled). */
  activeId: string
  /** Called with the newly selected id, on click and on keyboard activation. */
  onChange: (id: string) => void
  /** Accessible name of the strip. Required: "tablist" alone is not a name. */
  ariaLabel: string
  /** Prefix for the generated DOM ids; override when two strips coexist. */
  idPrefix?: string
  /** Layout direction; only affects `aria-orientation` and the arrow keys used. */
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

/** Structural key event: enough to read the key, no React event type needed. */
interface TabKeyEvent {
  key: string
  preventDefault: () => void
}

/**
 * Render a keyboard-operable tab strip.
 *
 * Pair each item with a {@link TabPanel} using the same `id` (and the same
 * `idPrefix` when one is passed).
 * @param props - items, selection and change handler.
 * @returns the `role="tablist"` element.
 */
export function Tablist(props: TablistProps): ReactNode {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const prefix = props.idPrefix ?? DEFAULT_TAB_ID_PREFIX
  const enabled: number[] = []
  for (let index = 0; index < props.items.length; index += 1) {
    if (props.items[index]?.disabled !== true) enabled.push(index)
  }

  const handleKeyDown = (index: number) => (event: TabKeyEvent): void => {
    if (enabled.length === 0) return
    const position = enabled.indexOf(index)
    const base = position < 0 ? 0 : position
    let next: number | undefined
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = enabled[(base + 1) % enabled.length]
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = enabled[(base - 1 + enabled.length) % enabled.length]
        break
      case 'Home':
        next = enabled[0]
        break
      case 'End':
        next = enabled[enabled.length - 1]
        break
      default:
        return
    }
    event.preventDefault()
    if (next === undefined) return
    const item = props.items.at(next)
    if (item === undefined) return
    if (item.id !== props.activeId) props.onChange(item.id)
    refs.current[next]?.focus()
  }

  return h('div', {
    className: cx('butler-tabs', props.className),
    role: 'tablist',
    'aria-label': props.ariaLabel,
    'aria-orientation': props.orientation ?? 'horizontal',
  }, ...props.items.map((item, index) => {
    const selected = item.id === props.activeId
    return h('button', {
      key: item.id,
      ref: (element: HTMLButtonElement | null) => { refs.current[index] = element },
      id: tabId(item.id, prefix),
      type: 'button',
      role: 'tab',
      className: 'butler-tab',
      'aria-selected': selected,
      'aria-controls': tabPanelId(item.id, prefix),
      'data-active': selected ? 'true' : undefined,
      tabIndex: selected ? 0 : -1,
      disabled: item.disabled === true,
      onClick: () => { if (item.disabled !== true) props.onChange(item.id) },
      onKeyDown: handleKeyDown(index),
    },
    item.label,
    item.badge === undefined ? null : h('span', { className: 'butler-tab__badge' }, String(item.badge)))
  }))
}

/** Props of {@link TabPanel}. */
export interface TabPanelProps {
  /** The owning tab's id. */
  id: string
  /** Whether this panel is the selected one. */
  active: boolean
  /** Must match the {@link Tablist} it belongs to. */
  idPrefix?: string
  /** Adds `tabIndex=0` for panels whose content holds no focusable element. */
  focusable?: boolean
  className?: string
  children?: ReactNode
}

/**
 * Render the panel controlled by one tab.
 *
 * Every panel is rendered (hidden when inactive) so a panel's local state such
 * as a half-typed form survives a tab switch - the host's settings section does
 * the same.
 * @param props - tab id, active flag and content.
 * @returns the `role="tabpanel"` element.
 */
export function TabPanel(props: TabPanelProps): ReactNode {
  return h('div', {
    id: tabPanelId(props.id, props.idPrefix),
    className: cx('butler-tabpanel', props.className),
    role: 'tabpanel',
    'aria-labelledby': tabId(props.id, props.idPrefix),
    tabIndex: props.focusable === true ? 0 : undefined,
    hidden: !props.active,
  }, props.children)
}
