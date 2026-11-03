/**
 * Butler dropdown menu - a trigger button plus an ARIA menu.
 *
 * ## Keyboard model
 * * Trigger: Enter/Space/click toggles; ArrowDown opens on the first item;
 *   ArrowUp opens on the last one.
 * * Menu: ArrowDown/ArrowUp walk the enabled items (separators and headings are
 *   skipped), Home/End jump to the ends, Enter/Space activate the focused item
 *   (native button behaviour), Escape closes and returns focus to the trigger,
 *   Tab closes and lets the browser continue from the trigger.
 * * Pointer dismissal is one document listener that only exists while the menu
 *   is open; it ignores clicks inside the trigger/menu subtree so a second click
 *   on the trigger still goes through React's own toggle.
 *
 * The focused row carries `data-active` and the same fill as `:hover`, because
 * the active row is focused programmatically and `:hover` alone would leave a
 * keyboard user without a cursor.
 *
 * Positioning is absolute inside the trigger wrapper (no portal is available -
 * see `drawer.ts` for why), so a menu opened inside an `overflow: hidden`
 * ancestor is clipped. Mount menus in rows that do not clip.
 *
 * @module @dsh-external/dsh-butler/client/ui
 */
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cx } from './components.ts'
import type { ButtonVariant, ControlSize } from './components.ts'

/** A selectable menu row. */
export interface MenuItemSpec {
  /** Stable id handed back to `onSelect`. */
  id: string
  /** Row label. */
  label: ReactNode
  /** Leading 14px glyph. */
  icon?: ReactNode
  disabled?: boolean
  /** Destructive row: error-coloured text and icon. */
  danger?: boolean
  /** Draws the trailing ink-teal check (single-select menus). */
  checked?: boolean
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string
}

/** A hairline between item groups. */
export interface MenuSeparatorSpec {
  type: 'separator'
  id: string
}

/** A non-interactive heading above a group of rows. */
export interface MenuGroupSpec {
  type: 'label'
  id: string
  /** Heading text. */
  text: string
}

/** One menu entry: a row, a separator, or a group heading. */
export type MenuEntry = MenuItemSpec | MenuSeparatorSpec | MenuGroupSpec

/** Structural key event: enough to read key/modifiers without a React type. */
interface MenuKeyEvent {
  key: string
  shiftKey: boolean
  preventDefault: () => void
}

function isSeparatorEntry(entry: MenuEntry): entry is MenuSeparatorSpec {
  return 'type' in entry && entry.type === 'separator'
}

function isGroupEntry(entry: MenuEntry): entry is MenuGroupSpec {
  return 'type' in entry && entry.type === 'label'
}

function isItemEntry(entry: MenuEntry): entry is MenuItemSpec {
  return !('type' in entry)
}

/** Props of {@link MenuButton}. */
export interface MenuButtonProps {
  /** Trigger content. */
  label: ReactNode
  /** Menu rows, separators and group headings, in display order. */
  items: readonly MenuEntry[]
  /** Called with the chosen row id (never for disabled rows). */
  onSelect: (id: string) => void
  /** Accessible name of the trigger when `label` is not text. */
  ariaLabel?: string
  /** Leading 14px glyph on the trigger. */
  icon?: ReactNode
  /** Trigger visual family; defaults to `secondary`. */
  variant?: ButtonVariant
  /** Trigger height family; defaults to `md`. */
  size?: ControlSize
  /** Opens the card aligned to the trigger's start (default) or end edge. */
  align?: 'start' | 'end'
  disabled?: boolean
  className?: string
}

/**
 * Render a menu trigger with its dropdown.
 * @param props - trigger content, entries and selection handler.
 * @returns the trigger wrapper (and the menu while open).
 */
export function MenuButton(props: MenuButtonProps): ReactNode {
  const root = useRef<HTMLSpanElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const focusOnOpen = useRef<'first' | 'last'>('first')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  /** Indices of the rows a keyboard user can land on. */
  const selectable: number[] = []
  for (let index = 0; index < props.items.length; index += 1) {
    const entry = props.items[index]
    if (entry !== undefined && isItemEntry(entry) && entry.disabled !== true) selectable.push(index)
  }

  const focusRow = (index: number | undefined): void => {
    if (index === undefined) return
    setActiveIndex(index)
    itemRefs.current[index]?.focus()
  }

  const move = (direction: 1 | -1): void => {
    if (selectable.length === 0) return
    const position = selectable.indexOf(activeIndex)
    const base = position < 0 ? (direction === 1 ? -1 : 0) : position
    focusRow(selectable.at((base + direction + selectable.length) % selectable.length))
  }

  const close = (restoreFocus: boolean): void => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }

  // Focus the requested edge row after the menu has committed. Runs on open
  // only: re-focusing on every render would fight the arrow-key walk.
  useEffect(() => {
    if (!open) return
    const edge = focusOnOpen.current === 'last' ? selectable.at(-1) : selectable.at(0)
    focusRow(edge)
    // Intentionally keyed on `open` only: `selectable` is derived from
    // props.items, and re-running on every render would yank focus back to the
    // edge row mid-walk.
  }, [open])

  // Outside-click dismissal: one document listener, alive only while open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && root.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open])

  // Escape at the document level (capture) so a focused input inside the menu
  // cannot swallow it, and so the page's own Escape handling never sees it.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open])

  const openMenu = (edge: 'first' | 'last'): void => {
    if (props.disabled === true) return
    focusOnOpen.current = edge
    setOpen(true)
  }

  const choose = (id: string): void => {
    close(true)
    props.onSelect(id)
  }

  const onMenuKeyDown = (event: MenuKeyEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        focusRow(selectable.at(0))
        break
      case 'End':
        event.preventDefault()
        focusRow(selectable.at(-1))
        break
      case 'Tab':
        // Do not preventDefault: closing first means the browser's Tab walk
        // continues from the trigger instead of from an unmounted item.
        close(true)
        break
      default:
        break
    }
  }

  const renderEntry = (entry: MenuEntry, index: number): ReactNode => {
    if (isSeparatorEntry(entry)) {
      return h('div', { key: entry.id, className: 'butler-menu__separator', role: 'separator' })
    }
    if (isGroupEntry(entry)) {
      return h('div', { key: entry.id, className: 'butler-menu__group', role: 'presentation' }, entry.text)
    }
    return h('button', {
      key: entry.id,
      ref: (element: HTMLButtonElement | null) => { itemRefs.current[index] = element },
      type: 'button',
      role: 'menuitem',
      className: cx('butler-menu__item', entry.danger === true && 'butler-menu__item--danger'),
      'data-active': index === activeIndex ? 'true' : undefined,
      tabIndex: -1,
      disabled: entry.disabled === true,
      onClick: () => { if (entry.disabled !== true) choose(entry.id) },
    },
    entry.icon == null ? null : h('span', { className: 'butler-menu__icon', 'aria-hidden': 'true' }, entry.icon),
    h('span', { className: 'butler-menu__label' }, entry.label),
    entry.hint === undefined ? null : h('span', { className: 'butler-menu__hint' }, entry.hint),
    entry.checked === true ? h('span', { className: 'butler-menu__check', 'aria-hidden': 'true' }, '\u2713') : null)
  }

  return h('span', { ref: (element: HTMLSpanElement | null) => { root.current = element }, className: cx('butler-menu-root', props.className) },
    h('button', {
      ref: (element: HTMLButtonElement | null) => { trigger.current = element },
      type: 'button',
      className: cx('butler-btn', `butler-btn--${props.variant ?? 'secondary'}`, `butler-btn--${props.size ?? 'md'}`),
      disabled: props.disabled === true,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-label': props.ariaLabel,
      onClick: () => { if (open) setOpen(false); else openMenu('first') },
      onKeyDown: (event: MenuKeyEvent) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          openMenu('first')
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          openMenu('last')
        }
      },
    },
    props.icon == null ? null : h('span', { className: 'butler-btn__icon', 'aria-hidden': 'true' }, props.icon),
    h('span', { className: 'butler-btn__label' }, props.label)),
    open
      ? h('div', {
        className: cx('butler-menu', props.align === 'end' && 'butler-menu--end'),
        role: 'menu',
        'aria-label': props.ariaLabel ?? 'Menu',
        onKeyDown: onMenuKeyDown,
      }, ...props.items.map((entry, index) => renderEntry(entry, index)))
      : null)
}
