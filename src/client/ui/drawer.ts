/**
 * Butler overlays - right-hand drawer, centred modal, confirmation dialog.
 *
 * ## Focus and keyboard contract
 * Every overlay here shares one hook ({@link useOverlayFocus}) that implements
 * the parts of the modal-dialog pattern a `role="dialog"` alone does not:
 * * move focus into the dialog on open (or keep an author `autoFocus` field);
 * * trap Tab / Shift+Tab inside the dialog, wrapping at both ends;
 * * close on Escape, in the capture phase so a keyboard Escape reaches the
 *   dialog before any page-level handler treats it as "go back";
 * * restore focus to the element that opened the dialog on close.
 *
 * ## Why no portal
 * The client bundle may only require `react` at runtime; `react-dom` and its
 * `createPortal` are not available and adding the dependency is out of scope.
 * The root therefore renders in place with `position: fixed` and a top-layer
 * `z-index`. A transformed/filtered ancestor can still trap a fixed element in
 * its own box - callers must mount overlays at the panel root, which is the
 * documented usage below.
 *
 * @module @dsh-external/dsh-butler/client/ui
 */
import { createElement as h, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, IconButton, cx } from './components.ts'

/**
 * Focusable descendants, minus the ones removed from the tab order. Written as
 * one selector so the Tab walk and the initial focus cannot disagree.
 */
const FOCUSABLE = 'a[href],area[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])'

/** Mutable ref shaped like the one the hook needs (the shim's `useRef` form). */
interface PanelRef {
  current: HTMLDivElement | null
}

/**
 * Panels of the dialogs currently mounted.
 *
 * Only a module-level registry can tell two stacked dialogs apart (a delete
 * confirmation opened over a detail drawer): the outer one must not also close
 * on the same Escape keypress, nor steal the Tab trap from the inner one.
 */
const OPEN_PANELS = new Set<PanelRef>()

/**
 * Whether this dialog is the innermost open one.
 *
 * Decided by DOM containment, not mount order: React runs effects
 * child-before-parent, so a nested dialog's effect has already registered by the
 * time the outer one registers - mount order would name the *outer* dialog the
 * top one. Containment has no such problem: the nested panel is a descendant of
 * the outer panel.
 * @param panel - the dialog asking.
 * @returns true when no other open dialog is nested inside it.
 */
function isInnermost(panel: PanelRef): boolean {
  const node = panel.current
  if (node === null) return true
  for (const other of OPEN_PANELS) {
    if (other === panel) continue
    const otherNode = other.current
    if (otherNode !== null && otherNode !== node && node.contains(otherNode)) return false
  }
  return true
}

/**
 * Wire a mounted dialog to the document: initial focus, Tab trap, Escape, and
 * focus restoration on close.
 *
 * The escape callback is held in a ref and re-read on every keystroke, so a
 * caller may pass an inline arrow without the effect tearing down and yanking
 * focus back to the top of the dialog on every render.
 * @param open - whether the dialog is mounted.
 * @param panel - ref to the dialog element (`tabIndex=-1`).
 * @param onEscape - close request from the Escape key.
 * @param initialFocus - `first` focuses the first control, `panel` the dialog.
 */
function useOverlayFocus(open: boolean, panel: PanelRef, onEscape: () => void, initialFocus: 'first' | 'panel'): void {
  const escape = useRef(onEscape)
  useEffect(() => { escape.current = onEscape }, [onEscape])

  useEffect(() => {
    if (!open) return
    OPEN_PANELS.add(panel)
    const node = panel.current
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusables = (): HTMLElement[] => node === null
      ? []
      : Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => element.getClientRects().length > 0)

    // An author `autoFocus` field inside the dialog already owns focus (React
    // focuses it during commit, before this effect runs); stealing it back to
    // the close button would defeat the common "dialog opens on its input".
    const current = document.activeElement
    const owned = node !== null && current !== null && node.contains(current)
    if (!owned) {
      if (initialFocus === 'first') {
        const first = focusables().at(0)
        if (first !== undefined) first.focus()
        else node?.focus()
      } else {
        node?.focus()
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // A dialog stacked on top of this one owns Escape and Tab.
      if (!isInnermost(panel)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        escape.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        node?.focus()
        return
      }
      const first = items.at(0)
      const last = items.at(-1)
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      // Focus escaped the dialog (a caller moved it, or the focused control was
      // removed): pull it back to the nearest edge instead of leaking to the page.
      const inside = node !== null && active !== null && node.contains(active)
      if (!inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault()
        last.focus()
        return
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      OPEN_PANELS.delete(panel)
      document.removeEventListener('keydown', onKeyDown, true)
      restore?.focus()
    }
  }, [open, initialFocus, panel])
}

/** Accessible close glyph; no icon package is available to the client bundle. */
const CLOSE_GLYPH = h('span', { 'aria-hidden': 'true', style: { fontSize: '16px', lineHeight: '1' } }, '\u00D7')

/* -------------------------------------------------------------------------- */
/* Drawer                                                                      */
/* -------------------------------------------------------------------------- */

/** Props of {@link Drawer}. */
export interface DrawerProps {
  /** Whether the drawer is mounted. */
  open: boolean
  /** Close request: Escape, the close button, or a mask click. */
  onClose: () => void
  /** Dialog heading (also its accessible name). */
  title: ReactNode
  /** Supporting line under the heading. */
  subtitle?: ReactNode
  /** Width family: 320 / 400 / 560 px. */
  size?: 'sm' | 'md' | 'lg'
  /** Sticky action row at the bottom. */
  footer?: ReactNode
  /** Accessible name of the close button; default `'Close'`. */
  closeLabel?: string
  /** Panel DOM id; override when two drawers can be open at once. */
  id?: string
  className?: string
  children?: ReactNode
}

/**
 * Render a right-hand slide-in drawer.
 *
 * Mount it at the panel root (see the module note on portals). It renders
 * nothing while closed, so its content - including any polling inside it -
 * only exists while the drawer is open.
 * @param props - open state, heading, size and content.
 * @returns the overlay tree, or `null` when closed.
 */
export function Drawer(props: DrawerProps): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null)
  useOverlayFocus(props.open, panel, props.onClose, 'first')
  if (!props.open) return null
  const baseId = props.id ?? 'butler-drawer'
  const titleId = `${baseId}-title`
  return h('div', { className: 'butler-overlay butler-overlay--right' },
    h('div', { className: 'butler-overlay__mask', 'aria-hidden': 'true', onClick: props.onClose }),
    h('div', {
      ref: (element: HTMLDivElement | null) => { panel.current = element },
      id: baseId,
      className: cx('butler-drawer', `butler-drawer--${props.size ?? 'md'}`, props.className),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabIndex: -1,
    },
    h('header', { className: 'butler-drawer__head' },
      h('div', { className: 'butler-drawer__heading' },
        h('h2', { className: 'butler-drawer__title', id: titleId }, props.title),
        props.subtitle == null ? null : h('p', { className: 'butler-drawer__subtitle' }, props.subtitle)),
      h(IconButton, { icon: CLOSE_GLYPH, label: props.closeLabel ?? 'Close', onClick: props.onClose })),
    h('div', { className: 'butler-drawer__body butler-scroll' }, props.children),
    props.footer == null ? null : h('footer', { className: 'butler-drawer__footer' }, props.footer)))
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                       */
/* -------------------------------------------------------------------------- */

/** Props of {@link Modal}. */
export interface ModalProps {
  open: boolean
  onClose: () => void
  /** Dialog heading (also its accessible name). */
  title: ReactNode
  /** Supporting sentence under the heading. */
  description?: ReactNode
  /** Width family: 320 (default 400) / 560 px. */
  size?: 'sm' | 'lg'
  /** Sticky action row at the bottom. */
  footer?: ReactNode
  /** Accessible name of the close button; default `'Close'`. */
  closeLabel?: string
  /** Panel DOM id; override when two modals can be open at once. */
  id?: string
  className?: string
  children?: ReactNode
}

/**
 * Render a centred modal dialog over the surface mask.
 * @param props - open state, heading, size and content.
 * @returns the overlay tree, or `null` when closed.
 */
export function Modal(props: ModalProps): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null)
  useOverlayFocus(props.open, panel, props.onClose, 'first')
  if (!props.open) return null
  const baseId = props.id ?? 'butler-modal'
  const titleId = `${baseId}-title`
  return h('div', { className: 'butler-overlay butler-overlay--center' },
    h('div', { className: 'butler-overlay__mask', 'aria-hidden': 'true', onClick: props.onClose }),
    h('div', {
      ref: (element: HTMLDivElement | null) => { panel.current = element },
      id: baseId,
      className: cx('butler-modal', props.size === 'sm' && 'butler-modal--sm', props.size === 'lg' && 'butler-modal--lg', props.className),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabIndex: -1,
    },
    h('header', { className: 'butler-modal__head' },
      h('div', { className: 'butler-modal__heading' },
        h('h2', { className: 'butler-modal__title', id: titleId }, props.title),
        props.description == null ? null : h('p', { className: 'butler-modal__desc' }, props.description)),
      h(IconButton, { icon: CLOSE_GLYPH, label: props.closeLabel ?? 'Close', onClick: props.onClose })),
    props.children == null ? null : h('div', { className: 'butler-modal__body butler-scroll' }, props.children),
    props.footer == null ? null : h('footer', { className: 'butler-modal__footer' }, props.footer)))
}

/* -------------------------------------------------------------------------- */
/* ConfirmDialog                                                               */
/* -------------------------------------------------------------------------- */

/** Props of {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  open: boolean
  /** Question being confirmed. */
  title: string
  /** Consequence sentence; also the dialog's description. */
  description?: ReactNode
  /** Extra body content, e.g. a list of affected items. */
  children?: ReactNode
  /** Confirm button label (an action verb, not "OK"). */
  confirmLabel: string
  /** Cancel button label; default `'Cancel'`. */
  cancelLabel?: string
  /** Destructive styling; also the reason Cancel gets the initial focus. */
  danger?: boolean
  /** Marks both actions disabled and busy while the confirmed work runs. */
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Render a confirmation dialog.
 *
 * `role="alertdialog"`: the dialog interrupts a flow and names one decision, so
 * a screen reader should read the whole prompt rather than the title only. The
 * cancel action is first in the DOM, which makes it the initial focus - the
 * safe default for a destructive confirmation - and Escape cancels.
 * @param props - prompt, action labels and pending state.
 * @returns the overlay tree, or `null` when closed.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null)
  useOverlayFocus(props.open, panel, props.onCancel, 'first')
  if (!props.open) return null
  const baseId = 'butler-confirm'
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`
  const hasDescription = props.description != null
  return h('div', { className: 'butler-overlay butler-overlay--center' },
    h('div', { className: 'butler-overlay__mask', 'aria-hidden': 'true', onClick: props.onCancel }),
    h('div', {
      ref: (element: HTMLDivElement | null) => { panel.current = element },
      id: baseId,
      className: 'butler-modal butler-modal--sm',
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'aria-describedby': hasDescription ? descId : undefined,
      tabIndex: -1,
    },
    h('div', { className: 'butler-modal__head' },
      h('div', { className: 'butler-modal__heading' },
        h('h2', { className: 'butler-modal__title', id: titleId }, props.title),
        hasDescription ? h('p', { className: 'butler-modal__desc', id: descId }, props.description) : null)),
    props.children == null ? null : h('div', { className: 'butler-modal__body butler-scroll' }, props.children),
    h('footer', { className: 'butler-modal__footer' },
      h(Button, { variant: 'secondary', size: 'md', disabled: props.pending === true, onClick: props.onCancel }, props.cancelLabel ?? 'Cancel'),
      h(Button, { variant: props.danger === true ? 'danger' : 'primary', size: 'md', busy: props.pending === true, onClick: props.onConfirm }, props.confirmLabel))))
}
