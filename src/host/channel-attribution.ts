/** Local attribution adapter for the existing dsh-lark-channel port. No transport or credentials. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { ChannelIngress, type ChannelBinding, type LarkInbound } from './channel-ingress.ts'
import type { ContextAgent, ContextMessage, ExecutionContextOptions, ExecutionIdentity, OriginUser } from './execution-context.ts'
import { getTask, type Task } from './ledger.ts'
import { statePath } from './vault.ts'
import type { RuntimeControlsSnapshot } from '../shared/workbench.ts'

interface HookContext {
  get?(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const keyFor = (session: string, message: string) => JSON.stringify([session, message])
function refusal(code: string): Error { return new Error(`[${code}] 飞书来源或个人任务绑定未核实；保留记录，未继续执行。`) }

/** Same owner is a local configuration choice, never inferred from sender names or text. */
export function channelContextPolicy(options: {
  file?: string
  localOwnerId?: string
  userFor(identity: ExecutionIdentity): OriginUser | undefined
  taskFor?(id: string): Task | undefined
}): Pick<ExecutionContextOptions, 'resolveUserOrigin' | 'beforeActivate' | 'resolveScheduleOwner'> & { status(): NonNullable<RuntimeControlsSnapshot['channels']> } {
  const file = options.file ?? statePath('channel-ingress.json')
  const ingress = new ChannelIngress({ file, bindings: [] })
  const localOwnerId = nonempty(options.localOwnerId) ? options.localOwnerId : undefined
  const active = () => localOwnerId !== undefined || existsSync(file)
  return {
    resolveScheduleOwner(taskId) { return ingress.ownerForTask(taskId) ?? (options.taskFor ?? getTask)(taskId)?.ownerId },
    resolveUserOrigin(sessionId, message) {
      if (!active()) return {}
      const origin = nonempty(message.id) ? ingress.originFor(sessionId, message.id) : undefined
      if (origin !== undefined) {
        if (localOwnerId === undefined || origin.ownerId !== localOwnerId) throw refusal('CHANNEL_OWNER_UNBOUND')
        return { ownerId: origin.ownerId, channelOrigin: origin }
      }
      // Native session-controller supplies rpcId; direct channel.followup does not.
      // Claimed text and ad-hoc source fields cannot stand in for the saved alias.
      if (nonempty(message.source?.rpcId)) return localOwnerId === undefined ? {} : { ownerId: localOwnerId }
      throw refusal('CHANNEL_ORIGIN_UNVERIFIED')
    },
    beforeActivate(taskId, identity) {
      const task = (options.taskFor ?? getTask)(taskId)
      const savedOwner = ingress.ownerForTask(taskId) ?? task?.ownerId
      if (identity.ownerId === undefined) {
        if (savedOwner !== undefined) throw refusal('TASK_OWNER_UNBOUND')
        return // Existing non-channel tasks retain their pre-P3 behavior.
      }
      if (identity.ownerId !== localOwnerId || (savedOwner !== undefined && savedOwner !== identity.ownerId)) throw refusal('TASK_OWNER_CONFLICT')
      if (identity.scheduleTaskId === taskId && savedOwner === identity.ownerId) return
      const isBirth = task !== undefined && task.sessionId === identity.sessionId && task.originMessageId !== undefined && task.originMessageId === identity.originMessageId
      if (!isBirth) {
        const user = options.userFor(identity)
        const explicit = user?.text.match(/^(?:继续|接续)任务[\s：:]+([^\s，。；,;]+)(?:[\s，。；,;]|$)/u)?.[1]
        if (user?.ownerId !== identity.ownerId || explicit !== taskId) throw refusal('TASK_CONTINUATION_REQUIRES_ID')
        // Legacy ownerless tasks may only be adopted through a trusted local RPC.
        if (savedOwner === undefined && (!user.rpcId || user.channelOrigin !== undefined)) throw refusal('TASK_OWNER_UNVERIFIED')
      }
      ingress.bindTask(taskId, identity.ownerId)
    },
    status() {
      try { return { ...ingress.status(), configuredOwner: localOwnerId !== undefined, enabled: active() } }
      catch { return { active: false, enabled: active(), error: 'CHANNEL_STORAGE_UNAVAILABLE' } }
    },
  }
}

/**
 * Wrap the actual normalized `message` subscription supplied to installBridge.
 * Existing authorization, commands, routing, permissions and rendering stay in that bridge.
 * Native inserted events are notifications; the awaited pre-step gate is authoritative.
 */
export function adaptLarkChannelPort<T extends object>(ctx: HookContext, port: T, options: {
  accountId: string
  bindings: ChannelBinding[]
  file?: string
}): { port: T; status(): ReturnType<ChannelIngress['status']>; stop(): void } {
  if (!nonempty(options.accountId)) throw refusal('CHANNEL_ACCOUNT_REQUIRED')
  const ingress = new ChannelIngress({ file: options.file ?? statePath('channel-ingress.json'), bindings: options.bindings })
  const scopes = new AsyncLocalStorage<{ error?: unknown }>()
  const failedInputs = new Map<string, unknown>()
  const subscriptions = new Set<() => void>()
  let stopped = false
  const disposers = [ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: ContextAgent; message: ContextMessage }) => {
    if (stopped || scopes.getStore() === undefined) return
    const sessionId = agent.session?.id ?? agent.id
    try { ingress.associate(sessionId, message) }
    catch (error) {
      scopes.getStore()!.error = error
      if (nonempty(message.id)) failedInputs.set(keyFor(sessionId, message.id), error)
      // Native notification errors are swallowed; pre-step below also fences it.
    }
  }, { prepend: true, global: true }), ctx.on('agent/pre-step', async ({ agent, messages }: { agent: ContextAgent; messages: ContextMessage[] }, next: () => unknown) => {
    if (stopped) return next()
    const sessionId = agent.session?.id ?? agent.id
    const registry = ctx.get?.('agents', false) as { list?(): ContextAgent[]; isOwnedBy?(id: string, owner: ContextAgent): boolean } | undefined
    if (registry?.list?.().some(owner => registry.isOwnedBy?.(agent.id, owner))) return next()
    for (const message of messages) {
      if (message.source?.kind !== 'user') continue
      if (!nonempty(message.id)) return { kind: 'reject' }
      if (failedInputs.has(keyFor(sessionId, message.id))) return { kind: 'reject' }
      // Child prompts are not human channel input and keep the native ownership rules.
      if (nonempty(message.source.rpcId)) continue
      try { if (ingress.originFor(sessionId, message.id) === undefined) return { kind: 'reject' } }
      catch { return { kind: 'reject' } }
    }
    return next()
  }, { prepend: true, global: true })]
  const wrapped = new Proxy(port, { get(target, property) {
    const value = Reflect.get(target, property, target)
    if (property !== 'on') return typeof value === 'function' ? value.bind(target) : value
    if (typeof value !== 'function') throw refusal('CHANNEL_PORT_UNAVAILABLE')
    return (event: string, handler: (...args: any[]) => unknown) => {
      if (stopped) throw refusal('CHANNEL_ADAPTER_STOPPED')
      const callback = event !== 'message' ? handler : async (message: LarkInbound) => {
        if (stopped) return
        return ingress.receive(options.accountId, message, () => scopes.run({}, async () => {
          await handler(message)
          const error = scopes.getStore()?.error
          if (error !== undefined) throw error
        }))
      }
      const unsubscribe = value.call(target, event, callback) as () => void
      let released = false
      const release = () => { if (released) return; released = true; subscriptions.delete(release); unsubscribe() }
      subscriptions.add(release)
      return release
    }
  } })
  return { port: wrapped, status: () => ingress.status(), stop() {
    if (stopped) return
    stopped = true
    for (const release of [...subscriptions]) release()
    for (const dispose of disposers.reverse()) dispose()
    failedInputs.clear()
  } }
}
