/**
 * `@dsh-external/dsh-butler/client/ui` - the butler visual and component layer.
 *
 * Nothing else in the plugin should hand-write a colour, a radius or a button:
 * import from here. The layer follows the host's theme (every colour is a
 * `--dsw-alias-*` token reference), its management-page density (13/20 body,
 * 12/18 secondary, 14/22 semibold titles), and adds exactly one brand note - the
 * ink-teal accent used for icon fills, the workbench section bar and selected
 * markers.
 *
 * ## Surface
 * | module | exports |
 * | --- | --- |
 * | `tokens.ts`   | `BUTLER_TOKENS`, `BUTLER_ACCENT`, `BUTLER_COLORS`, `BUTLER_TONE_COLOR`, `BUTLER_TYPE`, `BUTLER_SPACE`, `BUTLER_RADIUS`, `BUTLER_SHADOW`, `BUTLER_MOTION`, `BUTLER_STATUS_TONE`, `statusTone`, `ButlerTone`, `ButlerStatus`, `ButlerTokens` |
 * | `styles.ts`   | `ButlerStyles`, `BUTLER_CSS`, `BUTLER_STYLE_ID` |
 * | `components.ts` | `Button`, `IconButton`, `Section`, `Card`, `Pill`, `StatusDot`, `Toolbar`, `EmptyState`, `InlineError`, `Skeleton`, `ErrorState`, `LoadingBlock`, `KeyValue`, `MetaRow`, `Divider`, `Field`, `TextField`, `TextArea`, `Select`, `Banner`, `StatChip`, `DataTable`, `Tooltip`, plus their prop interfaces and `cx` |
 * | `tablist.ts`  | `Tablist`, `TabPanel`, `tabId`, `tabPanelId` |
 * | `drawer.ts`   | `Drawer`, `Modal`, `ConfirmDialog` |
 * | `menu.ts`     | `MenuButton` |
 * | `notice.ts`   | `NoticeRegion` |
 *
 * ## Minimal mounting
 * ```ts
 * import { ButlerStyles, Button, Section } from './ui/index.ts'
 *
 * h('div', { className: 'butler-root' },
 *   h(ButlerStyles),
 *   h(Section, { title: '待办', count: 3 },
 *     h(Button, { variant: 'primary', onClick: () => {} }, '新建')))
 * ```
 *
 * @module @dsh-external/dsh-butler/client/ui
 */

export * from './tokens.ts'
export * from './styles.ts'
export * from './components.ts'
export * from './tablist.ts'
export * from './drawer.ts'
export * from './menu.ts'
export * from './notice.ts'
