/**
 * The sidebar row glyph, drawn only - the shell owns the row box, the label,
 * the tooltip, the active highlight and the collapsed-rail geometry, exactly as
 * it does for the shipped Plugins/Schedule rows and the task board.
 *
 * @module @dsh-external/dsh-butler/client
 */
import { createElement as h } from 'react'
import { PANEL_ID } from './ids.ts'

/**
 * Draw the butler glyph at the size the shell asks for.
 * @param props - the shell's icon share.
 * @param props.size - requested square edge in pixels.
 * @param props.active - whether this panel is selected.
 * @returns the decorative glyph element.
 */
export function ButlerPanelIcon({ size }: { size: number; active: boolean }): unknown {
  return h('svg', {
    // The glyph is the only DOM this plugin owns inside the shell-owned row, so
    // it carries the panel id the L2 skin contract resolves rows through.
    'data-dsh-panel-entry': PANEL_ID,
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.3',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  h('path', { d: 'M3 6.2 8 3l5 3.2v6.3a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8Z' }),
  h('path', { d: 'M6.4 13.3V9.6h3.2v3.7' }))
}
