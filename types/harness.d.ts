/**
 * Local type declarations for the harness packages the butler compiles against.
 *
 * Why this file exists: the DSH checkout on this machine
 * (`C:\Users\申俊超\dsh-harness`, whose real files live on `E:`) has its
 * dependency junctions pointing at *themselves* — every stat on
 * `packages/core/tools`, `vendor/cordis`, … fails with `ELOOP`, and the pnpm
 * store under it is equally unreadable. Without these declarations
 * `tsc` cannot resolve a single harness type, so the plugin could not be built
 * at all.
 *
 * The signatures below are transcribed from the checkout's own sources (paths
 * noted per block) and describe only the surface this plugin actually uses.
 * They are intentionally narrow: they still catch a wrong handler shape, an
 * unknown service method, or a bad schema kind, which is what matters here.
 *
 * Rules for editing: keep every comment's source path accurate; widen nothing
 * "just to make it compile" without re-reading the real source; never move
 * runtime logic into this file (it is declarations only, and it is excluded
 * from the emitted bundle).
 */

// ── @deepseek-ai/cordis ─────────────────────────────────────────────────────
// Signatures from `vendor/cordis` (Context surface used by plugins).
declare module '@deepseek-ai/cordis' {
  /** Cordis plugin context. */
  export interface Context {
    /**
     * Resolve a service.
     *
     * `strict` is cordis's own second parameter (`get(name, strict = true)`,
     * read from the injector bundle's `_getImpl`): strict resolution answers
     * only for a provider whose fiber is active AND that this fiber was granted
     * through `inject`; passing `false` is the lenient lookup used for
     * services a plugin borrows opportunistically.
     */
    get(name: string, strict?: boolean): unknown
    /** Register a lifecycle-bound effect; the returned disposer unwinds it. */
    effect(callback: () => (() => void) | void, label?: string): () => void
    /**
     * Subscribe to an event; returns an unsubscribe function.
     *
     * Loosely typed on purpose: this file does not mirror the checkout's event
     * registry, so a listener's own parameter types cannot be checked against
     * the event it names. Each call site reads its arguments defensively instead.
     */
    on(name: string, listener: (...args: any[]) => any, options?: { global?: boolean; prepend?: boolean }): () => void
    /** printf-style logger. */
    logger: {
      info(format: string, ...args: unknown[]): void
      warn(format: string, ...args: unknown[]): void
      error(format: string, ...args: unknown[]): void
      debug?(format: string, ...args: unknown[]): void
    }
  }
}

// Native desktop bundle @deepseek-ai/dsh-agent/lib/index.js:166.
declare module '@deepseek-ai/dsh-agent' {
  export function installModelSelection(context: unknown, selection: {
    readonly current: { provider: string; model: string; reasoningEffort?: string } | undefined
    assembled?: { provider: string; model: string; reasoningEffort?: string }
  }): () => void
}

// ── @deepseek-ai/schemastery ────────────────────────────────────────────────
// Config schemas; the strict schema shape is deliberately left opaque because
// the plugin only ever builds flat objects of string/number fields.
declare module '@deepseek-ai/schemastery' {
  export interface Schema<T> {
    /** Default for the whole schema. */
    default(value: T): Schema<T>
    /** Inclusive lower bound; numbers only in this plugin. */
    min(value: number): Schema<T>
    /** Inclusive upper bound; numbers only in this plugin. */
    max(value: number): Schema<T>
    /** Human-facing description. */
    description(text: string): Schema<T>
  }
  export interface SchemaFactory {
    string(): Schema<string>
    number(): Schema<number>
    boolean(): Schema<boolean>
    object(shape: Record<string, unknown>): Schema<Record<string, unknown>>
    /**
     * Accept arrays whose elements match `inner` (source: schemastery
     * `src/index.ts` line 83-84, vendored 3.x used by the installed host).
     * Used only for the optional trial allowlists.
     */
    array(inner: unknown): Schema<unknown[]>
  }
  const z: SchemaFactory
  export default z
}

// ── @deepseek-ai/dsh-client-runtime/client ──────────────────────────────────
// The module itself is declared in `src/client/env.d.ts` instead of here: the
// `ctx.slots` merge must live inside the BROWSER program (which includes
// `src/client`), while this file is compiled into the host program too, where
// the client Context - and therefore `ctx.slots` - must not exist.
// Sources: `packages/client/runtime/src/client/index.ts:170`,
// `packages/client/runtime/src/client/slots.ts:93`.

// ── @deepseek-ai/dsh-tools ──────────────────────────────────────────────────
// Deliberately NOT declared here.
//
// `defineTool` is a run-time dependency the plugin cannot import: the package
// ships inside the DSH application bundle and resolves from no plugin path
// (see `src/host/tool-spec.ts` for the evidence). The plugin therefore carries
// its own boundary module with the schema types and the `defineTool` it needs.
//
// Declaring the package here as well would give two competing definitions of
// the same tool shape - one ambient (never actually loaded) and one real - and
// the next reader could not tell which one a given file is checked against.
// The single source of truth is `src/host/tool-spec.ts`.

