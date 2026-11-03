/**
 * `@dsh-external/dsh-butler/extension` — the public entry for bundle authors.
 *
 * This entry is how another DSH bundle talks to the butler: it exports the
 * versioned contract (`schemaVersion: 1`) and its validators, plus the types a
 * host plugin needs to use the runtime service safely. It imports no host code,
 * performs no I/O and, on import, changes nothing in the running butler.
 *
 * Typical use from a sibling bundle:
 *
 * ```ts
 * import type { ButlerExtensionService, PackManifest } from '@dsh-external/dsh-butler/extension'
 *
 * export const inject = ['butlerExtensions']
 *
 * export function apply(ctx) {
 *   const extensions = ctx.get('butlerExtensions', false) as ButlerExtensionService | undefined
 *   if (!extensions) return ctx.logger?.warn?.('[my-pack] 管家扩展服务不可用')
 *   const manifest: PackManifest = { schemaVersion: 1, id: 'my-pack', /* ... *\/ }
 *   ctx.effect(() => extensions.registerPack(manifest), 'my-pack: butler pack')
 * }
 * ```
 *
 * Full field limits, error messages, precedence and lifecycle are documented in
 * `docs/extension-api.md`; `examples/butler-pack-example/` is a runnable bundle.
 *
 * @module @dsh-external/dsh-butler/extension
 */
export {
  BUTLER_EXTENSION_SCHEMA_VERSION,
  BUTLER_EXTENSIONS_SERVICE,
  EXTENSION_LIMITS,
  validateChannelAdapter,
  validatePackManifest,
} from './shared/extension.ts'
export type {
  ButlerChannelAdapter,
  ButlerExtensionList,
  ButlerExtensionService,
  ChannelDestination,
  ChannelLimits,
  ChannelPayload,
  ChannelSendResult,
  ExtensionChannelEntry,
  ExtensionPackEntry,
  PackBudgetDeclaration,
  PackManifest,
  PackManifestValidationOptions,
  ResolvedChannelAdapter,
  ResolvedPackManifest,
} from './shared/extension.ts'
export type { PackCostClass } from './shared/packs.ts'
