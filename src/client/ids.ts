/**
 * Shared identifiers between the sidebar row, the main-slot page and the
 * conversation view tab. Kept in one module so the three seats cannot drift.
 *
 * @module @dsh-external/dsh-butler/client
 */

/** Panel id: the sidebar row id, the `main` seat key and the view tab id. */
export const PANEL_ID = 'butler'

/** Row order among the shell's global panel rows (Plugins 0, Schedule 10, Task board 20). */
export const PANEL_ORDER = 30
