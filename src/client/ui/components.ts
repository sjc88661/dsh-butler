/**
 * Butler base components - the `h()`-callable atom/molecule layer.
 *
 * ## Contract
 * * No JSX: this client compiles against a local `react` type shim
 *   (`src/client/react.d.ts`) that only models `createElement` and a handful of
 *   hooks, so every view function here calls `h()` explicitly.
 * * Explicit props interfaces: a caller sees exactly which knobs exist, and the
 *   interface (not a loose bag) is the compatibility contract for later steps.
 * * Copy is a prop. The plugin ships Chinese product copy, but a design-system
 *   component must not hard-code it: every visible string arrives from the
 *   caller. The exception is the *accessible* default (`'Close'`, `'Loading'`,
 *   `'Notifications'`), which is overridable through a prop because this layer
 *   has no locale service of its own.
 * * No global side effects: no module-level DOM access, no portals (the shim has
 *   no `react-dom`), no `document` writes. Behaviour lives in effects.
 * * No `React.forwardRef`: the shim does not declare it. Components that need a
 *   DOM handle are built from a `ref`-carrying host element internally (Drawer,
 *   Menu) or hand the caller a plain callback where one is genuinely needed.
 *
 * @module @dsh-external/dsh-butler/client/ui
 */
import { createElement as h, useState } from 'react'
import type { ReactNode } from 'react'
import type { ButlerTone } from './tokens.ts'

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/** Button visual families. `secondary` is the neutral default. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** Control heights: `md` 32px (default), `sm` 28px (dense rows). */
export type ControlSize = 'sm' | 'md'

/**
 * Join class names, dropping every empty/false entry.
 *
 * This replaces `clsx` on purpose: the client bundle may only require `react`
 * at runtime, so a class-name dependency is not available.
 * @param parts - class names or falsy values.
 * @returns the joined `className` string.
 */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  let out = ''
  for (const part of parts) {
    if (typeof part !== 'string' || part === '') continue
    out = out === '' ? part : `${out} ${part}`
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Button / IconButton                                                         */
/* -------------------------------------------------------------------------- */

/** Props of {@link Button}. */
export interface ButtonProps {
  /** Visual family; defaults to `secondary` so a bare button reads as neutral. */
  variant?: ButtonVariant
  /** Height family; defaults to `md`. */
  size?: ControlSize
  /** Leading glyph (14px slot). */
  icon?: ReactNode
  /** Trailing glyph, e.g. a chevron or a count. */
  trailing?: ReactNode
  /** Native disabled state. */
  disabled?: boolean
  /** Busy state: the button is disabled and marked `aria-busy`. */
  busy?: boolean
  /** Stretch to the container width. */
  block?: boolean
  /** Submit buttons are the only reason to change this. */
  type?: 'button' | 'submit' | 'reset'
  /** Native tooltip text. */
  title?: string
  /** Accessible name when the label is an icon or otherwise ambiguous. */
  ariaLabel?: string
  /** Click handler; the event object is deliberately not exposed. */
  onClick?: () => void
  className?: string
  children?: ReactNode
}

/**
 * Render a token-styled button.
 * @param props - visual family, size and click handler.
 * @returns the `<button>` element.
 */
export function Button(props: ButtonProps): ReactNode {
  const variant = props.variant ?? 'secondary'
  const size = props.size ?? 'md'
  return h('button', {
    type: props.type ?? 'button',
    className: cx('butler-btn', `butler-btn--${variant}`, `butler-btn--${size}`, props.block === true && 'butler-btn--block', props.className),
    disabled: props.disabled === true || props.busy === true,
    title: props.title,
    'aria-label': props.ariaLabel,
    'aria-busy': props.busy === true ? 'true' : undefined,
    onClick: props.onClick,
  },
  props.icon == null ? null : h('span', { className: 'butler-btn__icon', 'aria-hidden': 'true' }, props.icon),
  props.children == null ? null : h('span', { className: 'butler-btn__label' }, props.children),
  props.trailing == null ? null : h('span', { className: 'butler-btn__icon', 'aria-hidden': 'true' }, props.trailing))
}

/** Props of {@link IconButton}. */
export interface IconButtonProps {
  /** The icon glyph. */
  icon: ReactNode
  /** Accessible name. Required: an icon-only control has no other name. */
  label: string
  size?: ControlSize
  /** `ghost` (default) is borderless until hovered. */
  variant?: 'ghost' | 'secondary' | 'danger'
  disabled?: boolean
  /** Renders `aria-pressed`, for toggle buttons. */
  pressed?: boolean
  /** Native tooltip text; defaults to the accessible label. */
  title?: string
  onClick?: () => void
  className?: string
}

/**
 * Render a square icon-only button.
 * @param props - icon, accessible label and variant.
 * @returns the `<button>` element.
 */
export function IconButton(props: IconButtonProps): ReactNode {
  return h('button', {
    type: 'button',
    className: cx('butler-icon-btn', props.size === 'md' && 'butler-icon-btn--md', props.variant === 'secondary' && 'butler-icon-btn--secondary', props.variant === 'danger' && 'butler-icon-btn--danger', props.className),
    disabled: props.disabled === true,
    title: props.title ?? props.label,
    'aria-label': props.label,
    'aria-pressed': props.pressed === undefined ? undefined : props.pressed,
    onClick: props.onClick,
  }, props.icon)
}

/* -------------------------------------------------------------------------- */
/* Section                                                                     */
/* -------------------------------------------------------------------------- */

/** Props of {@link Section}. */
export interface SectionProps {
  /** Section title; rendered as a heading with the ink-teal bar. */
  title: ReactNode
  /** Item count shown right after the title. */
  count?: number
  /** Right-aligned controls (buttons) after the count. */
  actions?: ReactNode
  /** Right-aligned text before the actions, e.g. a freshness stamp. */
  hint?: ReactNode
  /** Turn the title row into a disclosure button. */
  collapsible?: boolean
  /** Uncontrolled initial state (default `true`). Ignored when `open` is set. */
  defaultOpen?: boolean
  /** Controlled expanded state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Heading level: `2` (default) for a page region, `3` for a nested group. */
  headingLevel?: 2 | 3 | 4
  /** Body id; makes the disclosure's `aria-controls` point somewhere real. */
  bodyId?: string
  className?: string
  bodyClassName?: string
  children?: ReactNode
}

/**
 * Render a titled section: the workbench's primary grouping primitive.
 *
 * The body stays mounted while collapsed (`hidden`) so a section's local state
 * - scroll position, an open editor - survives a collapse/expand round trip.
 * @param props - title, optional count/actions and disclosure behaviour.
 * @returns the `<section>` element.
 */
export function Section(props: SectionProps): ReactNode {
  const controlled = props.open !== undefined
  const [internalOpen, setInternalOpen] = useState(props.defaultOpen !== false)
  const expanded = props.open ?? internalOpen
  const collapsible = props.collapsible === true
  const toggle = (): void => {
    const next = !expanded
    if (!controlled) setInternalOpen(next)
    props.onOpenChange?.(next)
  }
  const heading = h(
    props.headingLevel === 3 ? 'h3' : props.headingLevel === 4 ? 'h4' : 'h2',
    { className: 'butler-section__title' },
    props.title,
  )
  return h('section', { className: cx('butler-section', props.className) },
    h('header', { className: 'butler-section__head' },
      collapsible
        ? h('button', { type: 'button', className: 'butler-section__toggle', 'aria-expanded': expanded, 'aria-controls': props.bodyId, onClick: toggle },
          h('span', { className: 'butler-section__chevron', 'data-open': expanded ? 'true' : 'false', 'aria-hidden': 'true' }, '\u203A'),
          heading)
        : heading,
      props.count === undefined ? null : h('span', { className: 'butler-section__count' }, String(props.count)),
      h('span', { className: 'butler-section__spacer' }),
      props.hint == null ? null : h('span', { className: 'butler-section__hint' }, props.hint),
      props.actions == null ? null : h('span', { className: 'butler-section__actions' }, props.actions)),
    h('div', {
      id: props.bodyId,
      className: cx('butler-section__body', props.bodyClassName),
      hidden: collapsible && !expanded,
    }, props.children))
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

/** Props of {@link Card}. */
export interface CardProps {
  /** Card heading (rendered as `h3` when present). */
  title?: ReactNode
  /** Supporting sentence under the title. */
  description?: ReactNode
  /** Right-aligned controls in the head row. */
  actions?: ReactNode
  /** Footer row, separated by a hairline. */
  footer?: ReactNode
  /** Drops the border/shadow for a card nested inside another card. */
  flat?: boolean
  className?: string
  bodyClassName?: string
  children?: ReactNode
}

/**
 * Render a content card.
 * @param props - optional head/footer and body content.
 * @returns the card element.
 */
export function Card(props: CardProps): ReactNode {
  const hasHead = props.title != null || props.description != null || props.actions != null
  return h('div', { className: cx('butler-card', props.flat === true && 'butler-card--flat', props.className) },
    hasHead
      ? h('div', { className: 'butler-card__head' },
        h('div', { className: 'butler-card__heading' },
          props.title == null ? null : h('h3', { className: 'butler-card__title' }, props.title),
          props.description == null ? null : h('p', { className: 'butler-card__desc' }, props.description)),
        props.actions == null ? null : h('div', { className: 'butler-card__actions' }, props.actions))
      : null,
    props.children == null ? null : h('div', { className: cx('butler-card__body', props.bodyClassName) }, props.children),
    props.footer == null ? null : h('div', { className: 'butler-card__footer' }, props.footer))
}

/* -------------------------------------------------------------------------- */
/* Pill / StatusDot                                                            */
/* -------------------------------------------------------------------------- */

/** Props of {@link Pill}. */
export interface PillProps {
  /** Semantic tone; defaults to `neutral`. */
  tone?: ButlerTone
  /** Leading 12px glyph. */
  icon?: ReactNode
  /** Native tooltip text, for a truncated label. */
  title?: string
  className?: string
  children?: ReactNode
}

/**
 * Render a small status chip.
 * @param props - tone and label content.
 * @returns the pill element.
 */
export function Pill(props: PillProps): ReactNode {
  return h('span', { className: cx('butler-pill', `butler-pill--${props.tone ?? 'neutral'}`, props.className), title: props.title },
    props.icon == null ? null : h('span', { className: 'butler-pill__icon', 'aria-hidden': 'true' }, props.icon),
    props.children)
}

/** Props of {@link StatusDot}. */
export interface StatusDotProps {
  tone: ButlerTone
  /** Diameter in px; defaults to 8 (10 for a page-level indicator). */
  size?: number
  /** When given, the dot is exposed as an image with this accessible name. */
  label?: string
  /** Adds the expanding halo used for "running". */
  pulse?: boolean
  className?: string
}

/**
 * Render a tone-coloured status dot.
 *
 * Decorative by default (`aria-hidden`), because a dot alone never conveys the
 * state to a screen reader - callers pair it with text or pass `label`.
 * @param props - tone, size and optional accessible label.
 * @returns the dot element.
 */
export function StatusDot(props: StatusDotProps): ReactNode {
  const labelled = props.label !== undefined
  return h('span', {
    className: cx('butler-dot', `butler-dot--${props.tone}`, props.pulse === true && 'butler-dot--pulse', props.className),
    style: { '--butler-dot-size': `${props.size ?? 8}px` },
    role: labelled ? 'img' : undefined,
    'aria-label': props.label,
    'aria-hidden': labelled ? undefined : 'true',
  })
}

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                     */
/* -------------------------------------------------------------------------- */

/** Props of {@link Toolbar}. */
export interface ToolbarProps {
  /** `start` (default) or `end` alignment. */
  align?: 'start' | 'end'
  /** Pins the row to the top of its scroll container with a base-colour wash. */
  sticky?: boolean
  /** Accessible name; turns the toolbar into a labelled `toolbar` landmark. */
  ariaLabel?: string
  className?: string
  children?: ReactNode
}

/**
 * Render a horizontal action row.
 * @param props - alignment, stickiness and content.
 * @returns the toolbar element.
 */
export function Toolbar(props: ToolbarProps): ReactNode {
  return h('div', {
    className: cx('butler-toolbar', props.align === 'end' && 'butler-toolbar--end', props.sticky === true && 'butler-toolbar--sticky', props.className),
    role: props.ariaLabel === undefined ? undefined : 'toolbar',
    'aria-label': props.ariaLabel,
  }, props.children)
}

/* -------------------------------------------------------------------------- */
/* Empty / inline error / skeleton / error state / loading                     */
/* -------------------------------------------------------------------------- */

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  /** What is empty; the only required line. */
  title: string
  /** Why it is empty and what would fill it. */
  description?: string
  /** Primary action (usually a Button). */
  action?: ReactNode
  /** 28px glyph, coloured with the butler accent. */
  icon?: ReactNode
  className?: string
}

/**
 * Render the "nothing here yet" block.
 * @param props - title, description and optional action.
 * @returns the empty-state element.
 */
export function EmptyState(props: EmptyStateProps): ReactNode {
  return h('div', { className: cx('butler-empty', props.className) },
    props.icon == null ? null : h('span', { className: 'butler-empty__icon', 'aria-hidden': 'true' }, props.icon),
    h('p', { className: 'butler-empty__title' }, props.title),
    props.description == null ? null : h('p', { className: 'butler-empty__desc' }, props.description),
    props.action == null ? null : h('div', { className: 'butler-empty__action' }, props.action))
}

/** Props of {@link InlineError}. */
export interface InlineErrorProps {
  /** The failure sentence; already user-facing copy. */
  message: string
  /** Retry handler; when given a retry button is appended. */
  retry?: () => void
  /** Label of the retry button (default `'Retry'`). */
  retryLabel?: string
  /** Stable code shown next to the message, e.g. `HTTP 500`. */
  code?: string
  className?: string
}

/**
 * Render an inline failure strip (`role="alert"`, announced on appearance).
 * @param props - message, optional code and retry handler.
 * @returns the error strip.
 */
export function InlineError(props: InlineErrorProps): ReactNode {
  return h('div', { className: cx('butler-inline-error', props.className), role: 'alert' },
    h('span', { className: 'butler-inline-error__text' }, props.message),
    props.code == null ? null : h('span', { className: 'butler-inline-error__code' }, props.code),
    props.retry == null
      ? null
      : h('span', { className: 'butler-inline-error__action' },
        h(Button, { variant: 'ghost', size: 'sm', onClick: props.retry }, props.retryLabel ?? 'Retry')))
}

/** Props of {@link Skeleton}. */
export interface SkeletonProps {
  /** Line count; defaults to 3. The last line is shortened. */
  lines?: number
  /** Adds a taller leading line that reads as a title. */
  title?: boolean
  /** When given, exposes a live status with this accessible name. */
  label?: string
  className?: string
}

/**
 * Render a loading placeholder.
 *
 * Decorative by default: a skeleton that also announces would duplicate the
 * status message its owner already renders. Pass `label` to make it the
 * announcement.
 * @param props - geometry and optional accessible label.
 * @returns the skeleton element.
 */
export function Skeleton(props: SkeletonProps): ReactNode {
  const count = props.lines === undefined || props.lines < 1 ? 3 : Math.floor(props.lines)
  const bars: ReactNode[] = []
  if (props.title === true) bars.push(h('div', { key: 'title', className: 'butler-skeleton__line butler-skeleton__line--title' }))
  for (let index = 0; index < count; index += 1) {
    bars.push(h('div', { key: `line-${index}`, className: 'butler-skeleton__line' }))
  }
  return h('div', {
    className: cx('butler-skeleton', props.className),
    role: props.label === undefined ? undefined : 'status',
    'aria-label': props.label,
    'aria-hidden': props.label === undefined ? 'true' : undefined,
  }, ...bars)
}

/** Props of {@link ErrorState}. */
export interface ErrorStateProps {
  /** Summary line; the only required text. */
  title: string
  /** The detail (what failed, what to try). */
  message?: string
  /** Retry handler; renders a primary retry button. */
  retry?: () => void
  /** Label of the retry button (default `'Retry'`). */
  retryLabel?: string
  /** Stable diagnostic code shown under the message. */
  code?: string
  /**
   * Truthful "what you still have": copy or a node stating that the last
   * successful snapshot remains on screen.
   */
  retained?: ReactNode
  className?: string
}

/**
 * Render a full block failure with recovery affordances.
 * @param props - message, retry handler and retained-data note.
 * @returns the error block.
 */
export function ErrorState(props: ErrorStateProps): ReactNode {
  return h('div', { className: cx('butler-error-state', props.className), role: 'alert' },
    h('p', { className: 'butler-error-state__title' }, props.title),
    props.message == null ? null : h('p', { className: 'butler-error-state__message' }, props.message),
    props.code == null ? null : h('p', { className: 'butler-error-state__code' }, props.code),
    props.retry == null && props.retained == null
      ? null
      : h('div', { className: 'butler-error-state__actions' },
        props.retry == null ? null : h(Button, { variant: 'primary', size: 'sm', onClick: props.retry }, props.retryLabel ?? 'Retry')),
    props.retained == null ? null : h('div', { className: 'butler-error-state__retained' }, props.retained))
}

/** Props of {@link LoadingBlock}. */
export interface LoadingBlockProps {
  /** Visible status text; also the live-region announcement. */
  label: string
  /** Skeleton line count under the label; `0` renders no skeleton. */
  lines?: number
  className?: string
}

/**
 * Render a labelled loading block (skeleton + `role="status"`).
 * @param props - status text and skeleton geometry.
 * @returns the loading block.
 */
export function LoadingBlock(props: LoadingBlockProps): ReactNode {
  const lines = props.lines ?? 3
  return h('div', { className: cx('butler-loading', props.className) },
    h('span', { className: 'butler-loading__label', role: 'status' }, props.label),
    lines > 0 ? h(Skeleton, { lines }) : null)
}

/* -------------------------------------------------------------------------- */
/* Key/value + meta + divider                                                  */
/* -------------------------------------------------------------------------- */

/** Props of {@link KeyValue}. */
export interface KeyValueProps {
  /** Field name, left column. */
  label: string
  /** Field value, right column (numbers already formatted by the caller). */
  value: ReactNode
  /** Colours the value, e.g. `error` for a failed probe. */
  tone?: ButlerTone
  className?: string
}

/**
 * Render one label/value row.
 * @param props - label, value and optional tone.
 * @returns the row element.
 */
export function KeyValue(props: KeyValueProps): ReactNode {
  return h('div', { className: cx('butler-kv', `butler-kv--${props.tone ?? 'neutral'}`, props.className) },
    h('span', { className: 'butler-kv__label' }, props.label),
    h('span', { className: 'butler-kv__value' }, props.value))
}

/** One entry of a {@link MetaRow}. */
export interface MetaItem {
  /** Field name. */
  label: string
  /** Field value. */
  value: ReactNode
  /** Colours the value. */
  tone?: ButlerTone
}

/** Props of {@link MetaRow}. */
export interface MetaRowProps {
  /** Inline label/value pairs. */
  items: readonly MetaItem[]
  className?: string
}

/**
 * Render a `<dl>` of compact label/value pairs that wraps on narrow widths.
 * @param props - the pairs to render.
 * @returns the meta list.
 */
export function MetaRow(props: MetaRowProps): ReactNode {
  return h('dl', { className: cx('butler-meta', props.className) },
    ...props.items.map((item, index) => h('div', { key: `${index}-${item.label}`, className: 'butler-meta__item' },
      h('dt', { className: 'butler-meta__label' }, item.label),
      h('dd', { className: cx('butler-meta__value', `butler-kv--${item.tone ?? 'neutral'}`) }, item.value))))
}

/** Props of {@link Divider}. */
export interface DividerProps {
  /** Optional centred label; without it the divider is a plain `<hr>`. */
  label?: string
  className?: string
}

/**
 * Render a horizontal separator.
 * @param props - optional label.
 * @returns the separator element.
 */
export function Divider(props: DividerProps): ReactNode {
  if (props.label === undefined) return h('hr', { className: cx('butler-divider', props.className) })
  return h('div', { className: cx('butler-divider', 'butler-divider--labeled', props.className), role: 'separator', 'aria-orientation': 'horizontal' },
    h('span', { className: 'butler-divider__rule' }),
    h('span', { className: 'butler-divider__label' }, props.label),
    h('span', { className: 'butler-divider__rule' }))
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                               */
/* -------------------------------------------------------------------------- */

/** Props of {@link Field}. */
export interface FieldProps {
  /** Visible label, rendered inside the wrapping `<label>`. */
  label: string
  /** Guidance under the control. */
  hint?: string
  /** Failure under the control; also pass `invalid` to the control itself. */
  error?: string
  /** Shows the required marker. */
  required?: boolean
  /** The control (TextField / TextArea / Select, or a custom one). */
  children?: ReactNode
  className?: string
}

/**
 * Render a labelled form field.
 *
 * The control is a *descendant* of the `<label>`, which gives implicit label
 * association without any id plumbing (the shim has no `useId`). The wrapper
 * therefore contains phrasing content only - spans, not divs - so the markup
 * stays valid.
 * @param props - label, hint, error and the control.
 * @returns the field element.
 */
export function Field(props: FieldProps): ReactNode {
  return h('label', { className: cx('butler-field', props.className) },
    h('span', { className: 'butler-field__label' },
      props.label,
      props.required === true ? h('span', { className: 'butler-field__required', 'aria-hidden': 'true' }, ' *') : null),
    props.children,
    props.hint == null ? null : h('span', { className: 'butler-field__hint' }, props.hint),
    props.error == null ? null : h('span', { className: 'butler-field__error' }, props.error))
}

/** Props of {@link TextField}. */
export interface TextFieldProps {
  /** Controlled value; omit together with `onChange` for an uncontrolled input. */
  value?: string
  placeholder?: string
  /** Receives the next *value*, not the DOM event. */
  onChange?: (value: string) => void
  /** Enter key, for search boxes. */
  onEnter?: () => void
  type?: 'text' | 'search' | 'password' | 'number' | 'url'
  disabled?: boolean
  readOnly?: boolean
  /** Sets `aria-invalid`; pair with `Field.error`. */
  invalid?: boolean
  /** Accessible name when no `Field` wrapper is used. */
  ariaLabel?: string
  name?: string
  /** Focus on mount (dialog-first-field use). */
  autoFocus?: boolean
  className?: string
}

/** Minimal structural event shapes: enough typing without a React event type. */
interface ValueChangeEvent {
  currentTarget: { value: string }
}

/** Minimal structural key event for the Enter shortcut. */
interface EnterKeyEvent {
  key: string
  preventDefault: () => void
}

/**
 * Render a single-line text input.
 * @param props - value, change handler and validation flags.
 * @returns the `<input>` element.
 */
export function TextField(props: TextFieldProps): ReactNode {
  return h('input', {
    className: cx('butler-input', props.className),
    type: props.type ?? 'text',
    value: props.value,
    placeholder: props.placeholder,
    disabled: props.disabled === true,
    readOnly: props.readOnly === true,
    name: props.name,
    autoFocus: props.autoFocus === true,
    'aria-label': props.ariaLabel,
    'aria-invalid': props.invalid === true ? 'true' : undefined,
    onChange: props.onChange === undefined
      ? undefined
      : (event: ValueChangeEvent) => { props.onChange?.(event.currentTarget.value) },
    onKeyDown: props.onEnter === undefined
      ? undefined
      : (event: EnterKeyEvent) => { if (event.key === 'Enter') { event.preventDefault(); props.onEnter?.() } },
  })
}

/** Props of {@link TextArea}. */
export interface TextAreaProps {
  value?: string
  placeholder?: string
  onChange?: (value: string) => void
  /** Visible row count; defaults to 3. */
  rows?: number
  disabled?: boolean
  readOnly?: boolean
  invalid?: boolean
  ariaLabel?: string
  name?: string
  className?: string
}

/**
 * Render a multi-line text input.
 * @param props - value, change handler and row count.
 * @returns the `<textarea>` element.
 */
export function TextArea(props: TextAreaProps): ReactNode {
  return h('textarea', {
    className: cx('butler-textarea', props.className),
    value: props.value,
    placeholder: props.placeholder,
    rows: props.rows ?? 3,
    disabled: props.disabled === true,
    readOnly: props.readOnly === true,
    name: props.name,
    'aria-label': props.ariaLabel,
    'aria-invalid': props.invalid === true ? 'true' : undefined,
    onChange: props.onChange === undefined
      ? undefined
      : (event: ValueChangeEvent) => { props.onChange?.(event.currentTarget.value) },
  })
}

/** One option of a {@link Select}. */
export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/** Props of {@link Select}. */
export interface SelectProps {
  value?: string
  /** Options, in display order. */
  options: readonly SelectOption[]
  /** Leading option; rendered disabled so it cannot be re-picked by accident. */
  placeholder?: string
  onChange?: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  ariaLabel?: string
  name?: string
  className?: string
}

/**
 * Render a native `<select>` (the host's own look is kept - no custom popup).
 * @param props - options and current value.
 * @returns the select element.
 */
export function Select(props: SelectProps): ReactNode {
  return h('select', {
    className: cx('butler-select', props.className),
    value: props.value,
    disabled: props.disabled === true,
    name: props.name,
    'aria-label': props.ariaLabel,
    'aria-invalid': props.invalid === true ? 'true' : undefined,
    onChange: props.onChange === undefined
      ? undefined
      : (event: ValueChangeEvent) => { props.onChange?.(event.currentTarget.value) },
  },
  props.placeholder === undefined
    ? null
    : h('option', { value: '', disabled: true }, props.placeholder),
  ...props.options.map(option => h('option', { key: option.value, value: option.value, disabled: option.disabled === true }, option.label)))
}

/* -------------------------------------------------------------------------- */
/* Banner / StatChip                                                           */
/* -------------------------------------------------------------------------- */

/** Props of {@link Banner}. */
export interface BannerProps {
  /** Semantic tone; defaults to `neutral`. */
  tone?: ButlerTone
  /** Bold lead line above the body text. */
  title?: ReactNode
  /** Leading 14px glyph. */
  icon?: ReactNode
  /** Trailing actions. */
  actions?: ReactNode
  /**
   * Live-region role. Defaults to `alert` for `error` (assertive) and `status`
   * for everything else; pass `note` for a static advisory.
   */
  role?: 'alert' | 'status' | 'note'
  className?: string
  children?: ReactNode
}

/**
 * Render an inline advisory strip.
 * @param props - tone, optional title/icon/actions and content.
 * @returns the banner element.
 */
export function Banner(props: BannerProps): ReactNode {
  const tone = props.tone ?? 'neutral'
  return h('div', {
    className: cx('butler-banner', `butler-banner--${tone}`, props.className),
    role: props.role ?? (tone === 'error' ? 'alert' : 'status'),
  },
  props.icon == null ? null : h('span', { className: 'butler-banner__icon', 'aria-hidden': 'true' }, props.icon),
  h('div', { className: 'butler-banner__body' },
    props.title == null ? null : h('span', { className: 'butler-banner__title' }, props.title),
    props.children),
  props.actions == null ? null : h('div', { className: 'butler-banner__actions' }, props.actions))
}

/** Props of {@link StatChip}. */
export interface StatChipProps {
  /** What the number measures. */
  label: string
  /** The formatted value (callers format; this layer does not localise). */
  value: ReactNode
  /** Colours the value. */
  tone?: ButlerTone
  className?: string
}

/**
 * Render one compact metric: caption over a tabular number.
 * @param props - label and value.
 * @returns the stat element.
 */
export function StatChip(props: StatChipProps): ReactNode {
  return h('div', { className: cx('butler-stat', `butler-stat--${props.tone ?? 'neutral'}`, props.className) },
    h('span', { className: 'butler-stat__label' }, props.label),
    h('span', { className: 'butler-stat__value' }, props.value))
}

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

/** One column of a {@link DataTable}. */
export interface DataTableColumn {
  /** Key into `DataTableRow.cells`. */
  key: string
  /** Column header. */
  label: ReactNode
  /** Right-aligns the column and enables tabular figures. */
  numeric?: boolean
  /** CSS width, e.g. `'120px'` or `'30%'`. */
  width?: string
}

/** One row of a {@link DataTable}. */
export interface DataTableRow {
  /** Stable identity (React key and selection marker). */
  id: string
  /** Cell contents by column key; missing keys render empty cells. */
  cells: Readonly<Record<string, ReactNode>>
  /** Draws the ink-teal leading marker. */
  selected?: boolean
}

/** Props of {@link DataTable}. */
export interface DataTableProps {
  columns: readonly DataTableColumn[]
  rows: readonly DataTableRow[]
  /** Rendered in a full-width cell when `rows` is empty. */
  empty?: ReactNode
  /** Accessible table name (screen-reader only). */
  caption?: string
  className?: string
}

/**
 * Render a dense data table.
 *
 * Rows are intentionally *not* clickable: a `<tr>` is not a control, and faking
 * one with `role="button"` breaks table semantics. Put an action in a cell.
 * @param props - columns, rows and the empty placeholder.
 * @returns the table element.
 */
export function DataTable(props: DataTableProps): ReactNode {
  const columnCount = props.columns.length === 0 ? 1 : props.columns.length
  return h('table', { className: cx('butler-table', props.className) },
    props.caption === undefined ? null : h('caption', { className: 'butler-sr-only' }, props.caption),
    h('thead', null,
      h('tr', null, ...props.columns.map(column => h('th', {
        key: column.key,
        scope: 'col',
        className: column.numeric === true ? 'butler-table__cell--num' : undefined,
        style: column.width === undefined ? undefined : { width: column.width },
      }, column.label)))),
    h('tbody', null,
      props.rows.length === 0
        ? h('tr', { className: 'butler-table__empty' }, h('td', { colSpan: columnCount }, props.empty ?? ''))
        : props.rows.map(row => h('tr', {
          key: row.id,
          className: 'butler-table__row',
          'data-selected': row.selected === true ? 'true' : undefined,
        }, ...props.columns.map(column => h('td', {
          key: column.key,
          className: column.numeric === true ? 'butler-table__cell--num' : undefined,
        }, row.cells[column.key]))))))
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

/** Props of {@link Tooltip}. */
export interface TooltipProps {
  /** Text shown in the bubble. */
  label: string
  /** Bubble side; defaults to `top`. */
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
  children?: ReactNode
}

/**
 * Render a CSS-only tooltip around its trigger.
 *
 * This is a *visual* aid, not an accessible name: the trigger keeps its own
 * label (see {@link IconButton.label}). Screen readers already have the trigger
 * text, and a bubble read twice is worse than a bubble not read at all.
 * @param props - label and placement.
 * @returns the wrapper element.
 */
export function Tooltip(props: TooltipProps): ReactNode {
  return h('span', {
    className: cx('butler-tip', props.className),
    'data-tip': props.label,
    'data-side': props.side ?? 'top',
  }, props.children)
}
