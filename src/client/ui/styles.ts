/**
 * Butler stylesheet - the whole visual layer for the `butler-` component family.
 *
 * ## Why a stylesheet and not inline styles
 * `panel.ts` today paints every node with an inline style object. That works for
 * a first draft and stops working as soon as a state has to *recur* (hover,
 * focus, disabled, open) and as soon as the same control appears on ten
 * screens: inline styles cannot express pseudo-classes, cannot be themed by a
 * single media query, and duplicate the same numbers at every call site.
 *
 * This module is the counter-proposal: one static string, injected once as a
 * `<style id="butler-ui-styles">` element, every rule scoped to a `butler-*`
 * class. Nothing is written to `document.body`, no host selector is targeted,
 * and no rule can leak: the sheet only ever matches elements that opted into a
 * butler class.
 *
 * ## Colour policy (enforced by review, stated here so it stays true)
 * * Every painted colour is a host theme token (`var(--dsw-alias-*)` /
 *   `var(--dsw-specific-sidebar-fill)`) or the one butler brand accent.
 * * Derived shades (hover fills, tinted chips, error washes) are produced with
 *   `color-mix()` **over those same tokens** - never with a hand-written
 *   `rgba()`/hex literal, so both themes stay correct by construction. A
 *   browser without `color-mix()` degrades to the un-tinted base state, which is
 *   still themed.
 * * The only literal colour in the file is `--butler-accent: #2E6B66`
 *   (ink-teal), declared on the few elements allowed to use it: icon fills, the
 *   workbench section-title bar, and selected-state markers.
 * * Elevation uses the host's composed `--dsw-shadow-lv*` tokens.
 *
 * ## Structure
 * 0. accent declaration / utilities
 * 1. buttons     2. section     3. card        4. pill / status dot
 * 5. form        6. toolbar     7. empty / error / loading
 * 8. data        9. banner / stat chip        10. tabs
 * 11. table     12. overlay / drawer / modal  13. menu / tooltip
 * 14. notices   15. scrollbar   16. motion     17. responsive
 *
 * @module @dsh-external/dsh-butler/client/ui
 */
import { createElement as h } from 'react'
import type { ReactNode } from 'react'

/** Id of the injected style element; also the idempotency key for re-mounts. */
export const BUTLER_STYLE_ID = 'butler-ui-styles'

/* -------------------------------------------------------------------------- */
/* 0. Brand accent + layout utilities                                          */
/* -------------------------------------------------------------------------- */

/**
 * The stylesheet's single literal colour.
 *
 * Declared on the *consumers* of the accent rather than on `:root`/`body`: the
 * sheet is mounted by panels, unmounted with them, and must never add a
 * document-level declaration to a host it does not own. Every element below
 * both defines and reads the variable on itself, so a nested host subtree can
 * never inherit it either.
 */
const ACCENT_RULE = `
.butler-accent,
.butler-icon--accent,
.butler-section__title,
.butler-tab,
.butler-table__row,
.butler-menu__check,
.butler-empty__icon {
  --butler-accent: #2E6B66;
}
`

/** Token-backed helpers consumers can compose without writing new CSS. */
const UTILITY_RULES = `
/*
 * Optional panel root. Establishes the density baseline (13/20, tabular
 * figures, primary label colour) once for a whole butler subtree instead of
 * repeating it on every block. It inherits; it never sets a font family, so the
 * host's own stack keeps winning.
 */
.butler-root {
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}

.butler-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.butler-num {
  font-variant-numeric: tabular-nums;
}

.butler-muted {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.butler-truncate {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.butler-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.butler-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.butler-grow {
  flex: 1 1 auto;
  min-width: 0;
}

.butler-focus-ring:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

.butler-icon--accent {
  color: var(--butler-accent);
}
`

/* -------------------------------------------------------------------------- */
/* 1. Buttons                                                                  */
/* -------------------------------------------------------------------------- */

const BUTTON_RULES = `
.butler-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  margin: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 120ms var(--ds-ease-in-out),
    border-color 120ms var(--ds-ease-in-out),
    color 120ms var(--ds-ease-in-out);
}

.butler-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.butler-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

/* md = 32px control height, the compact default for a 13/20 body. */
.butler-btn--md {
  height: 32px;
  padding: 0 12px;
}

/* sm = 28px, the dense-row size (matches the host's compact button height). */
.butler-btn--sm {
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.butler-btn--block {
  width: 100%;
}

.butler-btn__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
}

.butler-btn__label {
  min-width: 0;
}

/* Secondary: the host's outlined control - layer-1 fill over a hairline. */
.butler-btn--secondary {
  background: var(--dsw-alias-bg-layer-1);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}

.butler-btn--secondary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, var(--dsw-alias-bg-layer-1));
}

.butler-btn--secondary:active:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, var(--dsw-alias-bg-layer-1));
}

/* Ghost: text-only until hovered. */
.butler-btn--ghost {
  color: var(--dsw-alias-label-secondary);
}

.butler-btn--ghost:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
}

.butler-btn--ghost:active:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
}

/*
 * Primary: the brand fill is the theme's own emphasis surface, so the label is
 * the base surface colour - the same contrast pairing the host uses for
 * '--dsw-alias-label-primary-foreground', but expressed only with tokens from
 * the allowed list (brand inverts against bg-base in both themes).
 */
.butler-btn--primary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}

.butler-btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 86%, var(--dsw-alias-bg-base));
}

.butler-btn--primary:active:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 74%, var(--dsw-alias-bg-base));
}

/* Danger: solid destructive fill (ConfirmDialog's confirm action). */
.butler-btn--danger {
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-bg-base);
}

.butler-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 86%, var(--dsw-alias-bg-base));
}

.butler-btn--danger:active:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 74%, var(--dsw-alias-bg-base));
}

/* Icon-only sibling of Button: square, same radii and focus ring. */
.butler-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition:
    background-color 120ms var(--ds-ease-in-out),
    color 120ms var(--ds-ease-in-out);
}

.butler-icon-btn--md {
  width: 32px;
  height: 32px;
}

.butler-icon-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
}

.butler-icon-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

.butler-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.butler-icon-btn[aria-pressed='true'] {
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
}

.butler-icon-btn--secondary {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}

.butler-icon-btn--danger {
  color: var(--dsw-alias-state-error-primary);
}

.butler-icon-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
`

/* -------------------------------------------------------------------------- */
/* 2. Section (grouped block with a title bar and optional disclosure)          */
/* -------------------------------------------------------------------------- */

const SECTION_RULES = `
.butler-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.butler-section__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 22px;
}

.butler-section__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.butler-section__toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

/* The only affordance the disclosure has room for: the chevron brightens. */
.butler-section__toggle:hover .butler-section__chevron {
  color: var(--dsw-alias-label-primary);
}

.butler-section__chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--dsw-alias-label-secondary);
  transition: transform 120ms var(--ds-ease-in-out);
}

.butler-section__chevron[data-open='true'] {
  transform: rotate(90deg);
}

/* 14/22 semibold + the 3px ink-teal bar: the workbench's one brand marker. */
.butler-section__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.butler-section__title::before {
  content: '';
  flex: none;
  width: 3px;
  height: 14px;
  border-radius: 1px;
  background: var(--butler-accent);
}

.butler-section__count {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}

.butler-section__spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.butler-section__hint {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}

.butler-section__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.butler-section__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* A collapsed section keeps its body mounted ('hidden') so local state survives
 * a collapse/expand round trip. The author 'display: flex' above would beat the
 * UA's '[hidden] { display: none }', so the collapsed state restates it. */
.butler-section__body[hidden] {
  display: none;
}
`

/* -------------------------------------------------------------------------- */
/* 3. Card                                                                     */
/* -------------------------------------------------------------------------- */

const CARD_RULES = `
.butler-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv1);
}

/* Flat: for cards nested inside another card, where the border is noise. */
.butler-card--flat {
  border-color: var(--dsw-alias-border-l1);
  background: transparent;
  box-shadow: none;
}

.butler-card__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 12px 12px 0;
}

.butler-card__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.butler-card__title {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.butler-card__desc {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.butler-card__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.butler-card__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 8px 12px 12px;
}

.butler-card__body:first-child {
  padding-top: 12px;
}

.butler-card__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
`

/* -------------------------------------------------------------------------- */
/* 4. Pill + status dot                                                        */
/* -------------------------------------------------------------------------- */

const PILL_RULES = `
.butler-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  max-width: 100%;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.butler-pill__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 12px;
  height: 12px;
}

.butler-pill--info {
  color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}

.butler-pill--success {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
}

.butler-pill--warn {
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);
}

.butler-pill--error {
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}

.butler-pill--idle {
  color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary));
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent);
}

.butler-pill--neutral {
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}

/*
 * Status dot. Size comes from the component as an inline custom property
 * (geometry, not colour); the tone supplies 'currentColor', and the halo is the
 * same colour at low alpha - the host's StateDot treatment, rebuilt without its
 * pixel-chase SVG because the butler ledger only needs "steady" states.
 */
.butler-dot {
  position: relative;
  display: inline-block;
  flex: none;
  width: var(--butler-dot-size, 8px);
  height: var(--butler-dot-size, 8px);
  border-radius: 50%;
  background: currentColor;
  color: var(--dsw-alias-label-secondary);
}

.butler-dot--neutral {
  color: var(--dsw-alias-label-secondary);
}

.butler-dot--info {
  color: var(--dsw-alias-brand-primary);
}

.butler-dot--success {
  color: var(--dsw-alias-state-success-primary);
}

.butler-dot--warn {
  color: var(--dsw-alias-state-warn-primary);
}

.butler-dot--error {
  color: var(--dsw-alias-state-error-primary);
}

.butler-dot--idle {
  color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary));
}

/* Pulse ring for "running": a halo that expands and fades once per cycle. */
.butler-dot--pulse::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: butler-dot-pulse 1600ms var(--ds-ease-in-out) infinite;
}

@keyframes butler-dot-pulse {
  0% {
    transform: scale(1);
    opacity: 0.35;
  }

  70% {
    transform: scale(2.4);
    opacity: 0;
  }

  100% {
    transform: scale(2.4);
    opacity: 0;
  }
}
`

/* -------------------------------------------------------------------------- */
/* 5. Form controls                                                            */
/* -------------------------------------------------------------------------- */

const FORM_RULES = `
.butler-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.butler-field__label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.butler-field__required {
  color: var(--dsw-alias-state-error-primary);
}

.butler-field__hint {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.butler-field__error {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

.butler-input,
.butler-textarea,
.butler-select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  padding: 4px 8px;
  transition:
    border-color 120ms var(--ds-ease-in-out),
    background-color 120ms var(--ds-ease-in-out);
}

.butler-input {
  height: 32px;
  padding: 0 8px;
}

.butler-textarea {
  min-height: 64px;
  resize: vertical;
}

.butler-select {
  height: 32px;
  padding: 0 8px;
  cursor: pointer;
}

.butler-input::placeholder,
.butler-textarea::placeholder {
  color: var(--dsw-alias-label-secondary);
}

.butler-input:focus,
.butler-textarea:focus,
.butler-select:focus {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 0;
  border-color: var(--dsw-alias-brand-primary);
}

.butler-input:disabled,
.butler-textarea:disabled,
.butler-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.butler-input[aria-invalid='true'],
.butler-textarea[aria-invalid='true'],
.butler-select[aria-invalid='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}
`

/* -------------------------------------------------------------------------- */
/* 6. Toolbar                                                                  */
/* -------------------------------------------------------------------------- */

const TOOLBAR_RULES = `
.butler-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
  min-height: 32px;
}

.butler-toolbar--end {
  justify-content: flex-end;
}

.butler-toolbar--sticky {
  position: sticky;
  top: 0;
  z-index: 20;
  padding: 8px 0;
  background: var(--dsw-alias-bg-base);
}
`

/* -------------------------------------------------------------------------- */
/* 7. Empty / inline error / skeleton / error state / loading                   */
/* -------------------------------------------------------------------------- */

const STATE_RULES = `
.butler-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
  text-align: center;
}

.butler-empty__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--butler-accent);
}

.butler-empty__title {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.butler-empty__desc {
  max-width: 36em;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.butler-empty__action {
  margin-top: 4px;
}

.butler-inline-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

.butler-inline-error__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.butler-inline-error__code {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}

.butler-inline-error__action {
  flex: none;
}

.butler-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.butler-skeleton__line {
  height: 10px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    var(--dsw-alias-bg-layer-2) 0%,
    var(--dsw-alias-bg-overlay) 50%,
    var(--dsw-alias-bg-layer-2) 100%
  );
  background-size: 200% 100%;
  animation: butler-shimmer 1200ms linear infinite;
}

.butler-skeleton__line:last-child {
  width: 60%;
}

.butler-skeleton__line--title {
  width: 40%;
  height: 14px;
}

@keyframes butler-shimmer {
  from {
    background-position: 100% 0;
  }

  to {
    background-position: -100% 0;
  }
}

.butler-error-state {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
}

.butler-error-state__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-state-error-primary);
}

.butler-error-state__message {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.butler-error-state__code {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}

.butler-error-state__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/*
 * "Retained" is the operational promise: the last good snapshot is still on
 * screen, only the refresh failed. Separated by a dashed rule so it reads as
 * stale-but-usable data rather than another error paragraph.
 */
.butler-error-state__retained {
  padding-top: 8px;
  border-top: 1px dashed var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.butler-loading {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.butler-loading__label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
`

/* -------------------------------------------------------------------------- */
/* 8. Key/value + meta + divider                                               */
/* -------------------------------------------------------------------------- */

const DATA_RULES = `
.butler-kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 4px 0;
}

.butler-kv__label {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.butler-kv__value {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  text-align: right;
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.butler-kv--info .butler-kv__value {
  color: var(--dsw-alias-brand-primary);
}

.butler-kv--success .butler-kv__value {
  color: var(--dsw-alias-state-success-primary);
}

.butler-kv--warn .butler-kv__value {
  color: var(--dsw-alias-state-warn-primary);
}

.butler-kv--error .butler-kv__value {
  color: var(--dsw-alias-state-error-primary);
}

.butler-kv--idle .butler-kv__value {
  color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary));
}

.butler-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0;
  min-width: 0;
}

.butler-meta__item {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.butler-meta__label {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.butler-meta__value {
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}

.butler-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 1px;
  margin: 12px 0;
  border: 0;
  padding: 0;
  background: var(--dsw-alias-border-l1);
}

.butler-divider--labeled {
  height: auto;
  background: transparent;
}

.butler-divider__label {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.butler-divider__rule {
  flex: 1 1 auto;
  height: 1px;
  background: var(--dsw-alias-border-l1);
}
`

/* -------------------------------------------------------------------------- */
/* 9. Banner + stat chip                                                       */
/* -------------------------------------------------------------------------- */

const BANNER_RULES = `
.butler-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

.butler-banner__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.butler-banner__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.butler-banner__title {
  font-weight: 600;
}

.butler-banner__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.butler-banner--neutral {
  background: var(--dsw-alias-bg-layer-2);
}

.butler-banner--info {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
}

.butler-banner--info .butler-banner__icon {
  color: var(--dsw-alias-brand-primary);
}

.butler-banner--success {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent);
}

.butler-banner--success .butler-banner__icon {
  color: var(--dsw-alias-state-success-primary);
}

.butler-banner--warn {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}

.butler-banner--warn .butler-banner__icon {
  color: var(--dsw-alias-state-warn-primary);
}

.butler-banner--error {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
}

.butler-banner--error .butler-banner__icon {
  color: var(--dsw-alias-state-error-primary);
}

.butler-banner--idle {
  border-color: var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent);
}

.butler-banner--idle .butler-banner__icon {
  color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary));
}

.butler-stat {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}

.butler-stat__label {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.butler-stat__value {
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.butler-stat--info .butler-stat__value {
  color: var(--dsw-alias-brand-primary);
}

.butler-stat--success .butler-stat__value {
  color: var(--dsw-alias-state-success-primary);
}

.butler-stat--warn .butler-stat__value {
  color: var(--dsw-alias-state-warn-primary);
}

.butler-stat--error .butler-stat__value {
  color: var(--dsw-alias-state-error-primary);
}

.butler-stat--idle .butler-stat__value {
  color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary));
}
`

/* -------------------------------------------------------------------------- */
/* 10. Tabs                                                                    */
/* -------------------------------------------------------------------------- */

const TAB_RULES = `
.butler-tabs {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 16px;
  min-width: 0;
  /* Rail drawn as an inset shadow instead of a border: the active tab's 2px
   * underline then sits inside the strip's own box, so a strip that ever gains
   * overflow cannot clip its own selection marker. */
  box-shadow: inset 0 -1px 0 var(--dsw-alias-border-l2);
}

.butler-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  margin: 0;
  padding: 8px 4px;
  border: 0;
  border-radius: 4px 4px 0 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: color 120ms var(--ds-ease-in-out);
}

.butler-tab:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}

.butler-tab[data-active='true'] {
  color: var(--dsw-alias-label-primary);
}

/* 2px ink-teal underline: the plugin's one selected-state marker on tabs. */
.butler-tab[data-active='true']::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--butler-accent);
}

.butler-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

.butler-tab:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.butler-tab__badge {
  box-sizing: border-box;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.butler-tabpanel {
  min-width: 0;
  padding-top: 12px;
}

.butler-tabpanel:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
`

/* -------------------------------------------------------------------------- */
/* 11. Table                                                                   */
/* -------------------------------------------------------------------------- */

const TABLE_RULES = `
.butler-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}

.butler-table th {
  padding: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}

.butler-table td {
  padding: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  vertical-align: top;
  min-width: 0;
  overflow-wrap: anywhere;
}

.butler-table tbody tr:hover td {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
}

.butler-table td:first-child {
  position: relative;
}

/* Selected row marker: 3px ink-teal bar in the leading cell. */
.butler-table__row[data-selected='true'] td:first-child::before {
  content: '';
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 0;
  width: 3px;
  border-radius: 1px;
  background: var(--butler-accent);
}

.butler-table__cell--num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.butler-table__empty td {
  padding: 24px 8px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
`

/* -------------------------------------------------------------------------- */
/* 12. Overlay / drawer / modal                                                */
/* -------------------------------------------------------------------------- */

const OVERLAY_RULES = `
.butler-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
}

.butler-overlay--right {
  align-items: stretch;
  justify-content: flex-end;
}

.butler-overlay--center {
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/*
 * Mask: the base surface colour at reduced opacity, not a black wash. That way
 * the dimming direction follows the theme (white veil on light, black veil on
 * dark) using a token from the allowed list, instead of a literal rgba that
 * would only be correct in one theme.
 */
.butler-overlay__mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-base);
  opacity: 0.6;
  animation: butler-fade-in 120ms var(--ds-ease-in-out);
}

.butler-drawer {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(400px, 100%);
  max-height: 100%;
  min-width: 0;
  border-left: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px 0 0 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv3);
  animation: butler-slide-in 120ms var(--ds-ease-in-out);
}

.butler-drawer--sm {
  width: min(320px, 100%);
}

.butler-drawer--md {
  width: min(400px, 100%);
}

.butler-drawer--lg {
  width: min(560px, 100%);
}

.butler-drawer__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: none;
  padding: 16px 16px 0;
}

.butler-drawer__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.butler-drawer__title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.butler-drawer__subtitle {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.butler-drawer__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 16px;
  overflow-y: auto;
}

.butler-drawer__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

.butler-modal {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(400px, 100%);
  max-height: 100%;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv3);
  animation: butler-pop-in 120ms var(--ds-ease-in-out);
}

.butler-modal--sm {
  width: min(320px, 100%);
}

.butler-modal--lg {
  width: min(560px, 100%);
}

.butler-modal__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: none;
  padding: 16px 16px 0;
}

.butler-modal__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.butler-modal__title {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.butler-modal__desc {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.butler-modal__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 12px 16px;
  overflow-y: auto;
}

.butler-modal__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  padding: 12px 16px 16px;
}

@keyframes butler-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes butler-slide-in {
  from {
    transform: translateX(16px);
    opacity: 0;
  }

  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes butler-pop-in {
  from {
    transform: translateY(4px) scale(0.99);
    opacity: 0;
  }

  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}
`

/* -------------------------------------------------------------------------- */
/* 13. Menu + tooltip                                                          */
/* -------------------------------------------------------------------------- */

const MENU_RULES = `
.butler-menu-root {
  position: relative;
  display: inline-flex;
  flex: none;
}

.butler-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 1300;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 180px;
  max-width: 320px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
  animation: butler-fade-in 100ms var(--ds-ease-in-out);
}

.butler-menu--end {
  right: 0;
  left: auto;
}

.butler-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  margin: 0;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}

/* Hover is a fill-only affordance; the keyboard-active row also gets the ring.
 * The row is focused programmatically by the arrow-key walk, so ':focus-visible'
 * cannot be relied on alone - hence the data-active twin. */
.butler-menu__item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
}

.butler-menu__item:focus-visible,
.butler-menu__item[data-active='true'] {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}

.butler-menu__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.butler-menu__item--danger {
  color: var(--dsw-alias-state-error-primary);
}

.butler-menu__item--danger .butler-menu__icon {
  color: var(--dsw-alias-state-error-primary);
}

.butler-menu__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--dsw-alias-label-secondary);
}

.butler-menu__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.butler-menu__hint {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}

.butler-menu__check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--butler-accent);
}

.butler-menu__separator {
  height: 1px;
  margin: 4px;
  background: var(--dsw-alias-border-l1);
}

.butler-menu__group {
  padding: 4px 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

/*
 * CSS-only tooltip: the label is the 'data-tip' attribute, shown on hover and
 * on focus-within so a keyboard user reaches it too. It never replaces the
 * accessible name of its trigger (IconButton's 'label' does that).
 */
.butler-tip {
  position: relative;
  display: inline-flex;
  min-width: 0;
}

.butler-tip[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  z-index: 1400;
  box-sizing: border-box;
  width: max-content;
  max-width: 40ch;
  padding: 4px 8px;
  transform: translateX(-50%);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv2);
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-line;
  overflow-wrap: break-word;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 120ms var(--ds-ease-in-out),
    visibility 120ms var(--ds-ease-in-out);
}

.butler-tip[data-tip]:hover::after,
.butler-tip[data-tip]:focus-within::after {
  opacity: 1;
  visibility: visible;
}

.butler-tip[data-side='bottom']::after {
  top: calc(100% + 6px);
  bottom: auto;
}

.butler-tip[data-side='left']::after {
  top: 50%;
  right: calc(100% + 6px);
  bottom: auto;
  left: auto;
  transform: translateY(-50%);
}

.butler-tip[data-side='right']::after {
  top: 50%;
  right: auto;
  bottom: auto;
  left: calc(100% + 6px);
  transform: translateY(-50%);
}
`

/* -------------------------------------------------------------------------- */
/* 14. Notices (aria-live region)                                              */
/* -------------------------------------------------------------------------- */

const NOTICE_RULES = `
.butler-notices {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.butler-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  border-left: 3px solid var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

.butler-notice__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.butler-notice--neutral {
  border-left-color: var(--dsw-alias-label-secondary);
}

.butler-notice--info {
  border-left-color: var(--dsw-alias-brand-primary);
}

.butler-notice--success {
  border-left-color: var(--dsw-alias-state-success-primary);
}

.butler-notice--warn {
  border-left-color: var(--dsw-alias-state-warn-primary);
}

.butler-notice--error {
  border-left-color: var(--dsw-alias-state-error-primary);
}

.butler-notice--idle {
  border-left-color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary));
}
`

/* -------------------------------------------------------------------------- */
/* 15. Scrollbar skin (class-scoped, never on body/html)                        */
/* -------------------------------------------------------------------------- */

const SCROLLBAR_RULES = `
/* Copied from the host's ui-theme scrollbar contract: the standard properties
 * silence the WebKit pseudo-elements, so the two paths are gated apart. */
.butler-scroll {
  overflow: auto;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent) transparent;
}

.butler-scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.butler-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.butler-scroll::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent);
}

.butler-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-label-secondary);
}

.butler-scroll::-webkit-scrollbar-corner {
  background: transparent;
}
`

/* -------------------------------------------------------------------------- */
/* 16. Motion preferences                                                      */
/* -------------------------------------------------------------------------- */

const MOTION_RULES = `
@media (prefers-reduced-motion: reduce) {
  .butler-btn,
  .butler-icon-btn,
  .butler-tab,
  .butler-input,
  .butler-textarea,
  .butler-select,
  .butler-section__chevron,
  .butler-menu,
  .butler-menu__item,
  .butler-overlay__mask,
  .butler-drawer,
  .butler-modal,
  .butler-notice,
  .butler-tip[data-tip]::after {
    transition: none;
    animation: none;
  }

  .butler-dot--pulse::after,
  .butler-skeleton__line {
    animation: none;
  }

  /* No shimmer loop: a flat bar still communicates "placeholder". */
  .butler-skeleton__line {
    background: var(--dsw-alias-bg-layer-2);
  }
}
`

/* -------------------------------------------------------------------------- */
/* 17. Narrow viewports                                                        */
/* -------------------------------------------------------------------------- */

const RESPONSIVE_RULES = `
@media (max-width: 640px) {
  .butler-drawer--sm,
  .butler-drawer--md,
  .butler-drawer--lg {
    width: 100%;
    border-radius: 0;
  }

  .butler-overlay--center {
    padding: 12px;
  }

  .butler-modal--sm,
  .butler-modal--lg {
    width: 100%;
  }
}
`

/**
 * The complete butler stylesheet.
 *
 * Kept as one exported string (rather than assembled from the sections at
 * runtime) so a reviewer can read the cascade top to bottom and so the exact
 * bytes injected are greppable in the built bundle.
 */
export const BUTLER_CSS: string = [
  ACCENT_RULE,
  UTILITY_RULES,
  BUTTON_RULES,
  SECTION_RULES,
  CARD_RULES,
  PILL_RULES,
  FORM_RULES,
  TOOLBAR_RULES,
  STATE_RULES,
  DATA_RULES,
  BANNER_RULES,
  TAB_RULES,
  TABLE_RULES,
  OVERLAY_RULES,
  MENU_RULES,
  NOTICE_RULES,
  SCROLLBAR_RULES,
  MOTION_RULES,
  RESPONSIVE_RULES,
].join('\n')

/** Props of {@link ButlerStyles}; the component is intentionally prop-free. */
export type ButlerStylesProps = Record<string, never>

/**
 * Inject the butler stylesheet.
 *
 * Renders exactly one `<style id="butler-ui-styles">` element. React owns the
 * element, so unmounting the panel removes the sheet with it - there is no
 * module-level DOM access, no `document.head` append, and no cleanup path that
 * can be forgotten. Two panels mounted at once produce two identical style
 * elements under the same id; the cascade is idempotent, so that is harmless
 * (and the alternative - a module-level singleton - would leak past the last
 * unmount).
 *
 * Mount it once per butler surface, above the components:
 *
 * ```ts
 * h('div', null, h(ButlerStyles), h(Button, { variant: 'primary' }, '保存'))
 * ```
 *
 * @returns the style element.
 */
export function ButlerStyles(_props?: ButlerStylesProps): ReactNode {
  return h('style', {
    id: BUTLER_STYLE_ID,
    dangerouslySetInnerHTML: { __html: BUTLER_CSS },
  })
}
