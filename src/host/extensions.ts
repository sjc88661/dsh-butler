/**
 * Runtime registry behind the `butlerExtensions` Cordis service.
 *
 * The public contract lives in `shared/extension.ts` (pure validation); this
 * module owns the two things validation cannot: **identity and lifetime**.
 *
 * - One registry instance is created per butler activation. Registering inside
 *   the same instance twice with the same id is an error; the second call names
 *   the id and the existing source instead of replacing the first registration.
 * - Every registration returns an idempotent disposer. Disposing removes the
 *   pack from `list()`, `listPacks()`, `packsSummary()`, matching and the prompt
 *   instruction section in the same step — there is no cached copy to go stale.
 * - `installButlerExtensions` publishes the registry as the `butlerExtensions`
 *   service and wires its packs into the pack read model. If `ctx.provide` is
 *   unavailable or fails, the installation reports `active: false` with a
 *   reason instead of throwing: the butler must keep working without its
 *   extension surface.
 *
 * Deliberate non-goals: the registry does not call `send`/`isReady`, does not
 * choose destinations, does not read credentials, does not connect anything,
 * and does not grant permissions. Persistence is per-registration lifetime, not
 * a file: a reload starts with an empty registry and the owning plugin's
 * `apply` registers again.
 *
 * @module @dsh-external/dsh-butler/host/extensions
 */
import { PACK_BOUNDARY } from '../shared/packs.ts'
import {
  BUTLER_EXTENSION_SCHEMA_VERSION,
  BUTLER_EXTENSIONS_SERVICE,
  validateChannelAdapter,
  validatePackManifest,
  type ButlerChannelAdapter,
  type ButlerExtensionList,
  type ButlerExtensionService,
  type ExtensionChannelEntry,
  type ExtensionPackEntry,
  type PackManifest,
} from '../shared/extension.ts'
import { BUILTIN_PACK_IDS, setExtensionPackSource } from './packs.ts'

/** The small logger surface the registry uses; the Cordis logger satisfies it. */
export interface ButlerExtensionsLogger {
  info?(format: string, ...args: unknown[]): void
  warn?(format: string, ...args: unknown[]): void
  error?(format: string, ...args: unknown[]): void
}

/** Options for {@link createButlerExtensions} / {@link installButlerExtensions}. */
export interface CreateButlerExtensionsOptions {
  /** Kernel-owned ids extension packs may not reuse; defaults to the shipped list. */
  kernelPackIds?: readonly string[]
  /** Cordis service name override, used by tests against synthetic hosts. */
  serviceName?: string
  logger?: ButlerExtensionsLogger
}

/**
 * The mutable registry handle held by the butler host.
 *
 * Only the `ButlerExtensionService` subset is published to sibling bundles;
 * `dispose()` and `closed` stay host-side so a third party cannot close the
 * registry out from under the owner.
 */
export interface ButlerExtensionsRegistry extends ButlerExtensionService {
  /** Cordis service name this registry publishes under. */
  readonly serviceName: string
  /** True after {@link ButlerExtensionsRegistry.dispose}. */
  readonly closed: boolean
  /** Remove every registration and reject later registrations. Idempotent. */
  dispose(): void
}

/** Build a registry with no host dependencies (handy for tests and embedding). */
export function createButlerExtensions(options: CreateButlerExtensionsOptions = {}): ButlerExtensionsRegistry {
  const serviceName = options.serviceName ?? BUTLER_EXTENSIONS_SERVICE
  const kernelPackIds = options.kernelPackIds ?? BUILTIN_PACK_IDS
  const logger = options.logger
  const packs = new Map<string, ExtensionPackEntry>()
  const channels = new Map<string, ExtensionChannelEntry>()
  let closed = false

  const guardOpen = (kind: string): void => {
    if (closed) {
      throw new Error(`管家扩展：${kind}注册表已关闭，不能再注册；请使用当前激活插件实例上的 butlerExtensions 服务。`)
    }
  }

  const registerPack = (manifest: PackManifest): (() => void) => {
    guardOpen('能力包')
    const resolved = validatePackManifest(manifest, { kernelPackIds })
    const existing = packs.get(resolved.id)
    if (existing !== undefined) {
      throw new Error(`管家扩展：能力包 id "${resolved.id}" 已在本注册表注册（已有来源：${existing.source}），不能重复注册；先调用上一次注册返回的 disposer 释放它。`)
    }
    const entry: ExtensionPackEntry = Object.freeze({
      ...resolved,
      triggers: Object.freeze([...resolved.triggers]),
      tools: Object.freeze([...resolved.tools]),
      budget: Object.freeze({ ...resolved.budget }),
      source: 'extension' as const,
      enabled: true as const,
      boundary: PACK_BOUNDARY,
    })
    packs.set(entry.id, entry)
    logger?.info?.('[dsh-butler] 扩展能力包已注册：%s（%s）', entry.id, entry.title)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      // A newer registration under the same id (only possible after dispose +
      // register) must not be removed by the stale disposer.
      if (packs.get(entry.id) === entry) {
        packs.delete(entry.id)
        logger?.info?.('[dsh-butler] 扩展能力包已注销：%s', entry.id)
      }
    }
  }

  const registerChannel = (adapter: ButlerChannelAdapter): (() => void) => {
    guardOpen('通道')
    const resolved = validateChannelAdapter(adapter)
    const existing = channels.get(resolved.id)
    if (existing !== undefined) {
      throw new Error(`管家扩展：通道 id "${resolved.id}" 已在本注册表注册（已有来源：${existing.source}），不能重复注册；先调用上一次注册返回的 disposer 释放它。`)
    }
    const entry: ExtensionChannelEntry = Object.freeze({ ...resolved, source: 'extension' as const })
    channels.set(entry.id, entry)
    logger?.info?.('[dsh-butler] 扩展通道已注册：%s（%s）', entry.id, entry.title)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (channels.get(entry.id) === entry) {
        channels.delete(entry.id)
        logger?.info?.('[dsh-butler] 扩展通道已注销：%s', entry.id)
      }
    }
  }

  const list = (): ButlerExtensionList => Object.freeze({
    packs: Object.freeze([...packs.values()]) as readonly ExtensionPackEntry[],
    channels: Object.freeze([...channels.values()]) as readonly ExtensionChannelEntry[],
  })

  const dispose = (): void => {
    if (closed) return
    closed = true
    const packCount = packs.size
    const channelCount = channels.size
    packs.clear()
    channels.clear()
    if (packCount + channelCount > 0) {
      logger?.info?.('[dsh-butler] 对外扩展注册已清空：%d 个能力包、%d 个通道', packCount, channelCount)
    }
  }

  return {
    schemaVersion: BUTLER_EXTENSION_SCHEMA_VERSION,
    serviceName,
    get closed(): boolean {
      return closed
    },
    registerPack,
    registerChannel,
    list,
    dispose,
  }
}

/**
 * Minimal host context {@link installButlerExtensions} needs.
 *
 * The real Cordis context satisfies this; `provide` is optional on purpose so a
 * synthetic host (or an older Cordis build) degrades to `active: false` instead
 * of breaking activation.
 */
export interface ButlerExtensionsHostContext {
  provide?(name: string, value: unknown): () => void
  logger?: ButlerExtensionsLogger
}

/** Handle returned by {@link installButlerExtensions}. */
export interface ButlerExtensionsInstallation {
  /** Mutable registry, host-side only. */
  readonly registry: ButlerExtensionsRegistry
  /** The exact object published as `ctx.butlerExtensions` (or would be, when inactive). */
  readonly api: ButlerExtensionService
  /** Cordis service name. */
  readonly serviceName: string
  /** True when the service was published and pack registration is wired. */
  readonly active: boolean
  /** Why publication was skipped, when `active` is false. */
  readonly problem?: string
  /** Unwind the service and the pack read-model hook. Idempotent. */
  stop(): void
}

/**
 * Create the registry, publish it as `butlerExtensions`, and wire its packs
 * into `listPacks()` / `packsSummary()` / `getPack()` / `packInstructions()`.
 *
 * The caller owns lifecycle: register `installation.stop` inside `ctx.effect`
 * so unloading the butler clears both the service and the pack read-model hook.
 * @param ctx - host context surface (provide + logger).
 * @param options - kernel ids, service name, logger.
 * @returns the installation, active or with an explicit reason.
 */
export function installButlerExtensions(ctx: ButlerExtensionsHostContext, options: CreateButlerExtensionsOptions = {}): ButlerExtensionsInstallation {
  const registry = createButlerExtensions(options)
  const serviceName = registry.serviceName
  const api: ButlerExtensionService = Object.freeze({
    schemaVersion: BUTLER_EXTENSION_SCHEMA_VERSION,
    registerPack: registry.registerPack,
    registerChannel: registry.registerChannel,
    list: registry.list,
  })
  let disposeService: (() => void) | undefined
  let disposePackSource: (() => void) | undefined
  const stop = (): void => {
    try { disposeService?.() } catch { /* A dead provider must not block shutdown. */ }
    disposeService = undefined
    try { disposePackSource?.() } catch { /* A detached read model must not block shutdown. */ }
    disposePackSource = undefined
    registry.dispose()
  }
  if (typeof ctx.provide !== 'function') {
    const problem = '宿主上下文不支持 ctx.provide，butlerExtensions 服务未发布；扩展包/通道注册不可用（管家其余功能不受影响）。'
    ctx.logger?.warn?.('[dsh-butler] %s', problem)
    return { registry, api, serviceName, active: false, problem, stop }
  }
  try {
    disposeService = ctx.provide(serviceName, api)
  } catch (error) {
    const problem = `发布 butlerExtensions 服务失败：${error instanceof Error ? error.message : String(error)}`
    registry.dispose()
    return { registry, api, serviceName, active: false, problem, stop }
  }
  disposePackSource = setExtensionPackSource(() => registry.list().packs)
  return { registry, api, serviceName, active: true, stop }
}
