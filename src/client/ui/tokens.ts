/**
 * Butler design tokens - the token layer between the host theme and the
 * `butler-*` component classes.
 *
 * ## Why a token object at all
 * `styles.ts` is the single source of truth for *painting*: every rule there
 * references a host custom property directly. This module exists for the cases
 * CSS cannot express, and for the parts of the system that need a discrete
 * value in TypeScript (a tone name, an icon fill, a programmatic colour, a
 * status mapping). Keeping them here means a later step (task rows, budget
 * charts, canvas/SVG surfaces) never invents its own numbers.
 *
 * ## Colour policy
 * Every colour is a **host theme token reference**; no literal colour is
 * written here or in the stylesheet (the one documented exception is the butler
 * brand accent, exported below and re-declared exactly once in the stylesheet).
 * The allowed host alias list is:
 *
 *   --dsw-alias-bg-base / -bg-layer-1 / -bg-layer-2 / -bg-overlay
 *   --dsw-alias-border-l1 / -border-l2
 *   --dsw-alias-brand-primary
 *   --dsw-alias-label-primary / -label-secondary
 *   --dsw-alias-state-error-primary / -state-idle-primary
 *   --dsw-alias-state-success-primary / -state-warn-primary
 *   --dsw-specific-sidebar-fill
 *
 * `--dsw-alias-state-idle-primary` is *not* present in the host's current
 * design-platform sheet (verified against
 * `packages/client/ui-theme/src/styles/design-platform.css`), so it is read
 * with a token-to-token fallback: the claim still resolves to a theme colour -
 * never a literal - and a host that adds the idle alias starts rendering it
 * without a code change here.
 *
 * @module @dsh-external/dsh-butler/client/ui
 */

/**
 * Brand accent: ink-teal (墨青).
 *
 * The single sanctioned literal colour. It is deliberately *not* a host theme
 * colour, because it is the one place the plugin looks like itself; it is
 * confined to icon fills, the workbench section title bar and selected-state
 * markers (see `styles.ts`).
 */
export const BUTLER_ACCENT = '#2E6B66'

/**
 * Functional tone vocabulary shared by Pill / StatusDot / Banner / StatChip /
 * NoticeRegion. Tones are semantic, not chromatic: a host theme change recolours
 * all of them without touching a component.
 */
export type ButlerTone = 'neutral' | 'info' | 'success' | 'warn' | 'error' | 'idle'

/**
 * The butler task lifecycle, mirroring `TaskStatus` in `src/host/ledger.ts`.
 *
 * Declared structurally (same string literal union, no import) so the design
 * system stays independent of the host ledger while a `TaskStatus` value is
 * still assignable to {@link statusTone} without a cast.
 */
export type ButlerStatus =
  | 'pending'
  | 'running'
  | 'waiting_review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/**
 * Status -> tone.
 *
 * Same semantics as the existing `STATUS_COLOR` table in `src/client/view.ts`
 * (pending dim, running brand, waiting_review warn, done ok, failed error,
 * cancelled idle, interrupted warn) so the two layers cannot drift.
 */
export const BUTLER_STATUS_TONE: Readonly<Record<ButlerStatus, ButlerTone>> = {
  pending: 'neutral',
  running: 'info',
  waiting_review: 'warn',
  done: 'success',
  failed: 'error',
  cancelled: 'idle',
  interrupted: 'warn',
}

/**
 * Resolve the tone for a ledger status.
 * @param status - any butler task status.
 * @returns the shared tone vocabulary member for it.
 */
export function statusTone(status: ButlerStatus): ButlerTone {
  return BUTLER_STATUS_TONE[status]
}

/** Colour roles, each a `var(--dsw-alias-*)` reference (see module docs). */
export const BUTLER_COLORS = {
  bgBase: 'var(--dsw-alias-bg-base)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2)',
  bgOverlay: 'var(--dsw-alias-bg-overlay)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  brand: 'var(--dsw-alias-brand-primary)',
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  error: 'var(--dsw-alias-state-error-primary)',
  idle: 'var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary))',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  sidebarFill: 'var(--dsw-specific-sidebar-fill)',
} as const

/**
 * Tone -> colour reference, for surfaces that must colour programmatically
 * (SVG fills, inline swatches). CSS components use the `butler-*--<tone>`
 * classes instead, so this map is the escape hatch, not the default path.
 */
export const BUTLER_TONE_COLOR: Readonly<Record<ButlerTone, string>> = {
  neutral: BUTLER_COLORS.labelSecondary,
  info: BUTLER_COLORS.brand,
  success: BUTLER_COLORS.success,
  warn: BUTLER_COLORS.warn,
  error: BUTLER_COLORS.error,
  idle: BUTLER_COLORS.idle,
}

/**
 * Type scale, aligned with the host's settings/management pages rather than its
 * marketing surfaces: body 13/20, secondary 12/18, section title 14/22 semibold.
 * `display` exists for the one page heading a panel may need.
 */
export const BUTLER_TYPE = {
  display: '16px',
  displayLine: '24px',
  body: '13px',
  bodyLine: '20px',
  secondary: '12px',
  secondaryLine: '18px',
  title: '14px',
  titleLine: '22px',
  micro: '11px',
  microLine: '16px',
  weightMedium: '500',
  weightSemibold: '600',
} as const

/** Spacing scale: the only gaps the sheet is allowed to use (4/8/12/16/24). */
export const BUTLER_SPACE = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
} as const

/**
 * Radius scale. Controls (buttons, inputs) are 6px, cards 8px, overlays
 * (drawer, modal, menu) 10px - the host's own three-step rhythm.
 */
export const BUTLER_RADIUS = {
  control: '6px',
  card: '8px',
  overlay: '10px',
  pill: '999px',
} as const

/**
 * Elevation. These are the *host's* composed shadow tokens (`--dsw-shadow-lv*`,
 * as used by ui-primitives Modal/Menu/Toast): a shadow is an elevation
 * primitive, not a colour, so it is taken whole from the theme instead of being
 * re-invented from colour tokens.
 */
export const BUTLER_SHADOW = {
  card: 'var(--dsw-shadow-lv1)',
  raised: 'var(--dsw-shadow-lv2)',
  overlay: 'var(--dsw-shadow-lv3)',
} as const

/**
 * Motion. One duration for every state change (120ms) and the host's easing
 * curve; `prefers-reduced-motion: reduce` removes both (see `styles.ts`).
 */
export const BUTLER_MOTION = {
  fast: '120ms',
  ease: 'var(--ds-ease-in-out)',
} as const

/** The complete token surface, in one object for consumers that need a bundle. */
export interface ButlerTokens {
  /** Brand accent literal (see {@link BUTLER_ACCENT}). */
  accent: string
  /** Host colour roles. */
  color: typeof BUTLER_COLORS
  /** Functional tone -> colour reference. */
  tone: typeof BUTLER_TONE_COLOR
  /** Type scale (size + line-height pairs). */
  type: typeof BUTLER_TYPE
  /** Spacing scale. */
  space: typeof BUTLER_SPACE
  /** Radius scale. */
  radius: typeof BUTLER_RADIUS
  /** Host elevation tokens. */
  shadow: typeof BUTLER_SHADOW
  /** Motion duration + easing. */
  motion: typeof BUTLER_MOTION
  /** Ledger status -> tone mapping. */
  status: typeof BUTLER_STATUS_TONE
}

/** Every visual constant the butler UI layer is allowed to use. */
export const BUTLER_TOKENS: ButlerTokens = {
  accent: BUTLER_ACCENT,
  color: BUTLER_COLORS,
  tone: BUTLER_TONE_COLOR,
  type: BUTLER_TYPE,
  space: BUTLER_SPACE,
  radius: BUTLER_RADIUS,
  shadow: BUTLER_SHADOW,
  motion: BUTLER_MOTION,
  status: BUTLER_STATUS_TONE,
}
