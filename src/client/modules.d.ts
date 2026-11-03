/**
 * Ambient module declarations for the client half.
 *
 * These live in a SCRIPT file (no top-level import/export) on purpose: inside a
 * module, `declare module 'x'` is an augmentation of an existing module and
 * fails to resolve when `x` cannot be found on disk - which is the case here
 * (`@deepseek-ai/dsh-client-runtime/client` is bundled into the running web
 * shell and has no readable copy anywhere on this machine). In a script it is a
 * plain declaration of a module that exists only at runtime.
 *
 * Reachable only from `tsconfig.client.json`; the host tsconfig excludes
 * `src/client`.
 *
 * @module @dsh-external/dsh-butler/client
 */

/** Stand-in for the client runtime specifier used by type-only imports. */
declare module '@deepseek-ai/dsh-client-runtime/client' {}
