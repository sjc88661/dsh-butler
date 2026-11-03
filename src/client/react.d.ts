/**
 * Type shim for the `react` specifier, mapped here by `tsconfig.client.json`
 * (`paths: { "react": ["./src/client/react.d.ts"] }`).
 *
 * Why a local shim instead of `@types/react`: this machine has no readable
 * React package or type package anywhere on disk -
 * `C:\Users\申俊超\dsh-harness\node_modules` is a self-referential junction
 * chain (ELOOP) and the desktop profile's node_modules ships no react at all.
 * The client bundle resolves `require('react')` at RUNTIME through the web
 * shell's module loader (every shipped client plugin does the same; see
 * `@linxin666/dsh-client-ui-task-board/lib/client.js:7`), so React never has to
 * exist at build time - only the handful of symbols below are used, and they
 * are typed by their documented React 18/19 storage signatures.
 *
 * Scope: this file is only reachable from the client tsconfig (`src/client` is
 * excluded from the host tsconfig), exactly like `env.d.ts`.
 */

/** Anything renderable as a child: text, a nested element, or a filtered list. */
export type ReactNode = unknown

/** Props accepted by {@link createElement}. */
export type ReactProps = Record<string, unknown>

/** The callable form of a function component. */
export type FunctionComponent<P = ReactProps> = (props: P) => ReactNode

/** The value `createElement` returns and the slot registry accepts. */
export interface ReactElement {
  readonly type: unknown
  readonly props: ReactProps
}

/** Setter returned by {@link useState}. */
export type StateSetter<T> = (next: T | ((current: T) => T)) => void

/** Dependency list shared by the effect and memo hooks. */
export type DependencyList = readonly unknown[]

/** React's `createElement`, with the props/children shape this panel uses. */
export function createElement(type: unknown, props?: ReactProps | null, ...children: ReactNode[]): ReactElement

/** Stateful value plus its setter. */
export function useState<T>(initial: T | (() => T)): [T, StateSetter<T>]

/** Effect that runs after paint; `deps` gates re-runs. */
export function useEffect(effect: () => void | (() => void), deps?: DependencyList): void

/** Memoized value recomputed when `deps` change. */
export function useMemo<T>(factory: () => T, deps: DependencyList): T

/** Stable callback identity across renders. */
export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: DependencyList): T

/** Reference holder that survives renders. */
export function useRef<T>(initial: T): { current: T }

/**
 * Subscribe a component to an external store.
 *
 * Used to read the layout's `panelInfo` store: it is a plain snapshot store
 * (`getSnapshot()`), and this is the React hook that turns it into a re-render
 * when the owner switches panels.
 */
export function useSyncExternalStore<T>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T

/** Group type; renders its children without an extra DOM node. */
export const Fragment: unknown
