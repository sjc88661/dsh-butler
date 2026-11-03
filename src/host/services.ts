/**
 * Late-bound access to the host services the butler borrows.
 *
 * Why this file exists
 * --------------------
 * The first version resolved `web` and `schedule` once, inside `apply()`, and
 * kept whatever it found:
 *
 * ```ts
 * ...(ctx.get('schedule') === undefined ? {} : { schedule: ctx.get('schedule') })
 * ```
 *
 * That is a trap. `ctx.get(name)` returns a service only while its providing
 * fiber is active (`cordis` `_getImpl` → `if (strict && impl.fiber.state !== 2)
 * return`), and it returns only what this fiber was granted through `inject`.
 * So one unlucky activation order — the butler's fiber settling before the
 * schedule fiber reaches its active state — froze `schedule: undefined` into
 * the tool dependencies **for the whole life of the process**. The symptoms
 * were real: `butler_remind { action: 'list' }` reported an empty list with
 * "调度服务不可用" while `schedule` was `[active]` in the loader, and the
 * workbench panel showed `remindersAvailable: false` next to a reminder that
 * had actually been delivered forty-four milliseconds after its time.
 *
 * The fix is to resolve on demand and to keep looking when a lookup fails:
 * {@link Deferred.get} caches only a hit, so a service that appears late (or a
 * fresh instance after a reload) is picked up by the next call. Nothing here
 * spends a model call or touches the network.
 *
 * Two rules for callers:
 *
 * 1. A borrowed service **must** be listed in the plugin's `inject`, otherwise
 *    `ctx.get` will not see it at all and this resolver has nothing to find.
 * 2. Never report "unavailable" as if it were data. Ask {@link Deferred.why}
 *    for the reason and put that in the answer, so a failed lookup can never be
 *    mistaken for an empty result.
 *
 * @module @dsh-external/dsh-butler/host/services
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentsService, ScheduleService, SessionsService, SessionTitleService, SessionQueryService, WebService, WorkspaceRegistryService,
} from './ctx.ts'

/** One late-bound service slot. */
export interface Deferred<T extends object> {
  /** The service if it can be seen right now, otherwise `undefined`. */
  get(): T | undefined
  /** Why the last {@link Deferred.get} returned `undefined`; empty when it hit. */
  why(): string
}

/**
 * Build a late-bound slot for one service name.
 * @param ctx - the plugin's own context.
 * @param name - service key, which must also appear in `inject`.
 * @returns a slot that resolves on every miss and caches a hit.
 */
export function defer<T extends object>(ctx: Context, name: string): Deferred<T> {
  let cached: T | undefined
  let reason = `${name}: 从未解析过`

  const slot: Deferred<T> = {
    get(): T | undefined {
      if (cached !== undefined) return cached
      const direct = (ctx as unknown as Record<string, unknown>)[name]
      if (direct !== undefined && direct !== null) {
        cached = direct as T
        reason = ''
        return cached
      }
      let granted = true
      try {
        const viaGet = (ctx as unknown as { get?(key: string, strict?: boolean): unknown }).get?.(name, false)
        if (viaGet !== undefined && viaGet !== null) {
          cached = viaGet as T
          reason = ''
          return cached
        }
      } catch (error) {
        granted = false
        reason = `${name}: ctx.get 抛错（${error instanceof Error ? error.message : String(error)}）`
      }
      // Only overwrite the message when the strict lookup did not already
      // explain itself: a thrown lookup is the more specific fact.
      if (granted) {
        reason = `ctx 上取不到 ${name}（未激活，或未写进 inject 而未获授权）`
      }
      return undefined
    },
    why(): string {
      return reason
    },
  }
  return slot
}

/** What {@link Services} hands out. */
export interface Services {
  /** DSH web service (`search`/`fetch`), when it can be seen. */
  web: Deferred<WebService>
  /** DSH schedule service (the only service that produces a delivery receipt). */
  schedule: Deferred<ScheduleService>
  /** DSH agent factory: the only route to a session that persists. */
  agents: Deferred<AgentsService>
  /** DSH in-memory session store, used to tell "already live" from "needs a resume". */
  sessions: Deferred<SessionsService>
  /** DSH title fold, used to pin the butler conversation's name. */
  sessionTitle: Deferred<SessionTitleService>
  sessionQuery: Deferred<SessionQueryService>
  workspaceRegistry: Deferred<WorkspaceRegistryService>
  /** Service names that resolved while the last `attach` ran; for diagnostics. */
  resolved(): string[]
}

/**
 * Create the resolver for one plugin instance.
 * @param ctx - the plugin's own context.
 * @returns slots for every borrowed service.
 */
export function createServices(ctx: Context): Services {
  const web = defer<WebService>(ctx, 'web')
  const schedule = defer<ScheduleService>(ctx, 'schedule')
  const agents = defer<AgentsService>(ctx, 'agents')
  const sessions = defer<SessionsService>(ctx, 'sessions')
  const sessionTitle = defer<SessionTitleService>(ctx, 'sessionTitle')
  const sessionQuery = defer<SessionQueryService>(ctx, 'sessionQuery')
  const workspaceRegistry = defer<WorkspaceRegistryService>(ctx, 'workspaceRegistry')
  return {
    web,
    schedule,
    agents,
    sessions,
    sessionTitle,
    sessionQuery,
    workspaceRegistry,
    resolved(): string[] {
      const names: string[] = []
      // Calling get() here is deliberate: it both refreshes the cache and
      // records the reason for a miss, which is what the workbench shows.
      const slots: Array<[string, Deferred<object>]> = [
        ['web', web],
        ['schedule', schedule],
        ['agents', agents],
        ['sessions', sessions],
        ['sessionTitle', sessionTitle],
        ['sessionQuery', sessionQuery],
        ['workspaceRegistry', workspaceRegistry],
      ]
      for (const [name, slot] of slots) {
        if (slot.get() !== undefined) names.push(name)
      }
      return names
    },
  }
}

/** The service fields {@link Services.attach} fills in on a dependency object. */
export interface AttachableDeps {
  web?: WebService
  schedule?: ScheduleService
}

/**
 * Write every resolvable service onto the dependency object of one call.
 *
 * A hit is always written, not only when the field is still empty: the slot
 * keeps looking after a miss, so this is what heals an object that the old
 * one-shot capture had frozen with `undefined` for the life of the process.
 * @param deps - the object the tool bodies read.
 * @param services - the resolver.
 * @returns whether the schedule service is usable for this call.
 */
export function attach(deps: AttachableDeps, services: Services): boolean {
  const web = services.web.get()
  if (web !== undefined) deps.web = web
  const schedule = services.schedule.get()
  if (schedule !== undefined) deps.schedule = schedule
  return deps.schedule !== undefined
}
