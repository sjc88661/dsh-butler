/** Host composition for an existing Lark port. No SDK, credentials, connection or scheduler is created here. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { adaptLarkChannelPort } from './channel-attribution.ts'
import type { ChannelBinding } from './channel-ingress.ts'
import type { ExecutionIdentity, OriginUser } from './execution-context.ts'
import { validReminderDestination, type ButlerReminderDelivery, type ReminderDeliveryIdentity, type ReminderDestination, type ReminderExternalReceipt } from './reminder-delivery.ts'
import { commitState, readState } from './store.ts'
import { statePath } from './vault.ts'

export interface LarkButlerContext {
  get?(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void
}

/** The host retains createPort/installBridge/connect and connection ownership. */
export interface LarkButlerPort {
  on(event: string, listener: (...args: any[]) => unknown): () => void
  connect(...args: any[]): Promise<unknown>
  getConnectionStatus(): { state?: string } | undefined
  send(chatId: string, content: { text: string }): Promise<unknown>
}

/** Normalize an actual SDK read response in the host. text must be the complete, unmodified body. */
export interface LarkReadMessage {
  messageId: string
  chatId: string
  type: string
  text: string
}

export interface LarkButlerIntegrationOptions {
  /** Default false. Disabled composition does not inspect the port or other options. */
  enabled?: boolean
  accountId?: string
  ownerId?: string
  /** The main butler plugin's explicit channelOwnerId, required to equal ownerId. */
  channelOwnerId?: string
  bindings?: readonly ChannelBinding[]
  file?: string
  receiptFile?: string
  /** Host policy only, called after exact native user provenance is checked. No callback means no delivery service. */
  authorize?(identity: Readonly<ExecutionIdentity>, user: Readonly<OriginUser>): ReminderDestination | undefined | Promise<ReminderDestination | undefined>
  /** Optional structured read-only lookup by a previously saved real SDK receipt ID. */
  readMessage?(messageId: string): Promise<LarkReadMessage | undefined>
}

interface ReceiptRow {
  key: string
  identity: ReminderDeliveryIdentity
  destination: ReminderDestination
  receipt: ReminderExternalReceipt
}
interface ReceiptFile { version: 1; receipts: Record<string, ReceiptRow> }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const receiptKey = (identity: ReminderDeliveryIdentity): string => sha256(JSON.stringify([identity.scheduleId, identity.occurrenceMessageId]))
const emptyReceipts = (): ReceiptFile => ({ version: 1, receipts: {} })
const fail = (code: string): Error => new Error(`LARK_INTEGRATION_${code}`)
const identityFields = ['scheduleId', 'occurrenceMessageId', 'taskId', 'sessionId', 'ownerId', 'turn', 'assistantEventSeq', 'textSha256', 'assistantMessageId']

function validIdentity(value: unknown): value is ReminderDeliveryIdentity {
  return object(value) && ['scheduleId', 'occurrenceMessageId', 'taskId', 'sessionId', 'ownerId'].every(key => id(value[key]))
    && ['turn', 'assistantEventSeq'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && typeof value.textSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.textSha256)
    && (value.assistantMessageId === undefined || id(value.assistantMessageId))
    && Object.keys(value).every(key => identityFields.includes(key))
}

function platformReceipt(value: unknown): ReminderExternalReceipt | undefined {
  if (!object(value) || !id(value.messageId) || (value.chunkIds !== undefined
    && (!Array.isArray(value.chunkIds) || value.chunkIds.length === 0 || !value.chunkIds.every(id)))) return
  return { messageId: value.messageId, ...(value.chunkIds === undefined ? {} : { chunkIds: [...value.chunkIds as string[]] }) }
}

function validReceipts(value: unknown): boolean {
  return object(value) && value.version === 1 && object(value.receipts) && Object.keys(value).every(key => key === 'version' || key === 'receipts')
    && Object.entries(value.receipts).every(([key, row]) => object(row) && row.key === key && validIdentity(row.identity)
      && key === receiptKey(row.identity) && validReminderDestination(row.destination) && row.destination.ownerId === row.identity.ownerId
      && platformReceipt(row.receipt) !== undefined && isDeepStrictEqual(platformReceipt(row.receipt), row.receipt)
      && Object.keys(row).every(field => ['key', 'identity', 'destination', 'receipt'].includes(field)))
}

/** Return delivery for the host to publish as butlerReminderDelivery; this factory installs no service. */
export function createLarkButlerIntegration<T extends LarkButlerPort>(ctx: LarkButlerContext, original: T, options: LarkButlerIntegrationOptions = {}) {
  let stopped = false
  if (options.enabled !== true) return {
    port: original, delivery: undefined as ButlerReminderDelivery | undefined,
    status: () => ({ enabled: false, stopped, deliveryEnabled: false, connected: false }),
    stop() { stopped = true },
  }
  const { accountId, ownerId, channelOwnerId, authorize, readMessage } = options
  if (!id(accountId) || !id(ownerId) || channelOwnerId !== ownerId || !Array.isArray(options.bindings)) throw fail('INVALID_CONFIGURATION')
  const bindings: ChannelBinding[] = options.bindings.map(binding => {
    if (!object(binding) || !['accountId', 'ownerId', 'senderId', 'chatId'].every(key => id(binding[key]))
      || binding.accountId !== accountId || binding.ownerId !== ownerId
      || Object.keys(binding).some(key => !['accountId', 'ownerId', 'senderId', 'chatId'].includes(key))) throw fail('INVALID_BINDING')
    return { accountId: binding.accountId, ownerId: binding.ownerId, senderId: binding.senderId as string, chatId: binding.chatId as string }
  })
  if (new Set(bindings.map(binding => JSON.stringify([binding.accountId, binding.chatId]))).size !== bindings.length) throw fail('AMBIGUOUS_BINDING')
  if (authorize !== undefined && typeof authorize !== 'function') throw fail('INVALID_AUTHORIZATION')
  if (readMessage !== undefined && typeof readMessage !== 'function') throw fail('INVALID_LOOKUP')
  const receiptFile = options.receiptFile ?? statePath('lark-reminder-receipts.json')
  const bound = (destination: unknown): destination is ReminderDestination => validReminderDestination(destination)
    && bindings.some(binding => isDeepStrictEqual(destination, { provider: 'lark', ...binding }))
  const connected = (): boolean => {
    if (stopped) return false
    try { return original.getConnectionStatus()?.state === 'connected' } catch { return false }
  }
  const listeners = new Set<() => void>()
  const notify = (): void => {
    if (!connected()) return
    for (const listener of [...listeners]) { try { listener() } catch {} }
  }
  const trustedUser = (identity: Readonly<ExecutionIdentity>, user?: Readonly<OriginUser>): user is Readonly<OriginUser> => {
    if (!user || user.source !== 'user' || typeof user.text !== 'string' || !id(identity.sessionId) || !id(identity.originMessageId)
      || user.ownerId !== ownerId || identity.ownerId !== ownerId || user.messageId !== identity.originMessageId
      || user.sessionId !== (identity.rootSessionId ?? identity.sessionId)) return false
    const origin = user.channelOrigin
    if (origin === undefined) return identity.channelOrigin === undefined && id(user.rpcId)
    return origin.provider === 'lark' && id(origin.messageId) && origin.nativeMessageId === user.messageId
      && origin.sessionId === user.sessionId && origin.threadId === undefined && isDeepStrictEqual(origin, identity.channelOrigin)
      && bound({ provider: origin.provider, accountId: origin.accountId, ownerId: origin.ownerId, senderId: origin.senderId, chatId: origin.chatId })
  }
  const delivery: ButlerReminderDelivery | undefined = authorize === undefined ? undefined : {
    async destinationFor(identity, user) {
      if (stopped || !trustedUser(identity, user)) return
      const target = await authorize(Object.freeze(structuredClone(identity)), Object.freeze(structuredClone(user)))
      if (!stopped && bound(target)) return structuredClone(target)
    },
    isReady: connected,
    onReady(listener) {
      if (stopped) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async send(destination, text, identity) {
      if (stopped) throw fail('STOPPED')
      if (!bound(destination) || !validIdentity(identity) || identity.ownerId !== ownerId || typeof text !== 'string'
        || !text.trim() || sha256(text) !== identity.textSha256) throw fail('SEND_MISMATCH')
      if (!connected()) throw fail('NOT_CONNECTED')
      const sentIdentity = structuredClone(identity), sentDestination = structuredClone(destination)
      const key = receiptKey(sentIdentity)
      // A receipt is immutable. Core ReminderDeliveries owns the persistent pre-send claim and uncertain state.
      if (Object.hasOwn(readState(receiptFile, emptyReceipts(), validReceipts, { recover: false }).receipts, key)) throw fail('RECEIPT_EXISTS')
      const result = platformReceipt(await original.send(sentDestination.chatId, { text }))
      if (!result || result.messageId === sentIdentity.occurrenceMessageId || result.chunkIds?.includes(sentIdentity.occurrenceMessageId)) throw fail('INVALID_PLATFORM_RECEIPT')
      const row: ReceiptRow = { key, identity: sentIdentity, destination: sentDestination, receipt: result }
      // Commit failures propagate to the existing core's uncertain state. Never return an unpersisted receipt.
      commitState({ path: receiptFile, format: 'json', fallback: emptyReceipts(), validate: validReceipts }, { kind: 'lark.reminder.receipt', targetId: key }, file => {
        if (Object.hasOwn(file.receipts, key)) throw fail('RECEIPT_EXISTS')
        file.receipts[key] = row
        return { value: file, result: undefined }
      })
      return structuredClone(result)
    },
    async reconcile(destination, identity) {
      if (stopped || !readMessage || !bound(destination) || !validIdentity(identity) || identity.ownerId !== ownerId) return
      const checkedDestination = structuredClone(destination), checkedIdentity = structuredClone(identity)
      try {
        const row = readState(receiptFile, emptyReceipts(), validReceipts, { recover: false }).receipts[receiptKey(checkedIdentity)]
        if (!row || !isDeepStrictEqual(row.identity, checkedIdentity) || !isDeepStrictEqual(row.destination, checkedDestination)) return
        // No port contract proves multi-chunk concatenation, so do not infer a complete body from one chunk.
        if (row.receipt.chunkIds !== undefined && (row.receipt.chunkIds.length !== 1 || row.receipt.chunkIds[0] !== row.receipt.messageId)) return
        const message = await readMessage(row.receipt.messageId)
        if (stopped || !message || message.messageId !== row.receipt.messageId || message.chatId !== checkedDestination.chatId
          || message.type !== 'text' || typeof message.text !== 'string' || sha256(message.text) !== checkedIdentity.textSha256) return
        return { destination: checkedDestination, textSha256: checkedIdentity.textSha256, receipt: structuredClone(row.receipt) }
      } catch { return undefined }
    },
  }
  const attribution = adaptLarkChannelPort(ctx, original, { accountId, bindings, file: options.file })
  let releaseReconnect: (() => void) | undefined
  try { if (delivery) releaseReconnect = attribution.port.on('reconnected', notify) }
  catch (error) { attribution.stop(); throw error }
  const port = new Proxy(attribution.port, { get(target, property) {
    const value = Reflect.get(target, property, target)
    if (property !== 'connect') return value
    return async (...args: any[]) => {
      if (stopped) throw fail('STOPPED')
      const result = await (value as LarkButlerPort['connect'])(...args)
      notify()
      return result
    }
  } })
  return { port, delivery,
    status: () => ({ enabled: true, stopped, deliveryEnabled: delivery !== undefined && !stopped, connected: connected(), attribution: attribution.status() }),
    stop() {
      if (stopped) return
      stopped = true
      listeners.clear(); releaseReconnect?.(); releaseReconnect = undefined
      attribution.stop()
    },
  }
}
