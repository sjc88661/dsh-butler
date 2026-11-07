/** Persisted reminder destinations. A reminder never inherits a development conversation. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ScheduleService } from './ctx.ts'
import { reminderTargetSession, scheduleDelete, type ReminderDeleteReceipt } from './remind.ts'
import { REMINDER_SESSION_PREFIX } from './runtime-controls.ts'

interface ReminderAgent {
  id: string
  session?: unknown
  followup?(message: unknown): void
}
export interface ReminderFactory {
  create(options: { sessionId: string; meta: { cwd: string; agentPreset: string }; agentOptions: { maxTokens: number; provider?: string; model?: string }; setup?: (ctx: unknown) => Promise<void> | void }): Promise<{ agent?: ReminderAgent }>
  resume(options: { resumeSessionId: string; agentOptions?: { maxTokens: number; provider?: string; model?: string }; setup?: (ctx: unknown) => Promise<void> | void }): Promise<{ agent?: ReminderAgent }>
  get?(id: string): ReminderAgent | undefined
}
interface Binding { id: string; sourceSessionId: string; title: string; delivered: string[]; uncertain?: string }

export class ReminderSessions {
  private bindings: Record<string, Binding> = {}
  private readonly inflight = new Map<string, Promise<ReminderAgent>>()
  private readonly deliveries = new Map<string, Promise<void>>()
  private readonly options: {
    file?: string
    cwd: string
    agents(): ReminderFactory | undefined
    prepare?(): { agentOptions?: { provider?: string; model?: string }; setup?: (ctx: unknown) => Promise<void> | void }
    rename?(session: unknown, title: string): void
    flush?(session: unknown): Promise<boolean>
  }

  constructor(options: ReminderSessions['options']) {
    this.options = options
    this.bindings = this.readBindings()
  }

  private readBindings(): Record<string, Binding> {
    if (this.options.file !== undefined && existsSync(this.options.file)) {
      try {
        const data = JSON.parse(readFileSync(this.options.file, 'utf8')) as { version: number; bindings: Record<string, Binding> }
        if (data.version !== 1 || !data.bindings) throw new Error('unsupported format')
        for (const binding of Object.values(data.bindings)) {
          if (!binding.id.startsWith(REMINDER_SESSION_PREFIX) || !Array.isArray(binding.delivered)) throw new Error('invalid reminder destination')
        }
        return data.bindings
      } catch (error) { throw new Error(`提醒会话绑定无法读取，拒绝回退开发会话：${String(error)}`) }
    }
    return this.bindings
  }

  async create(sourceSessionId: string, title: string, callId?: string): Promise<string> {
    if (!sourceSessionId || sourceSessionId === 'butler-vault') throw new Error('无法确定提醒来源会话，提醒未建立')
    const key = callId === undefined ? randomUUID() : `${sourceSessionId}:${callId}`
    this.bindings = this.readBindings()
    this.bindings[key] ??= { id: REMINDER_SESSION_PREFIX + randomUUID(), sourceSessionId, title, delivered: [] }
    const binding = this.bindings[key]!
    this.save(key, binding)
    await this.ensure(binding)
    return binding.id
  }

  /** Redirect an old schedule occurrence once, before the source agent can send it to a model. */
  async redirect(source: { id: string }, message: { id?: string; source?: { kind?: string }; content?: unknown[] }): Promise<void> {
    if (!message.id || message.source?.kind !== 'schedule') throw new Error('提醒投递缺少可信来源或消息 ID')
    const key = `${source.id}:delivery:${message.id}`
    this.bindings = this.readBindings()
    const existing = this.bindings[key]
    if (existing?.delivered.includes(message.id)) return
    const prior = this.deliveries.get(key)
    if (prior) return prior
    const delivery = (async () => {
      const id = await this.create(source.id, '定时提醒', `delivery:${message.id}`)
      const agent = await this.ensure(this.bindings[key]!)
      if (!agent.followup) throw new Error(`隔离提醒会话 ${id} 无法接收消息`)
      // ensure() yields; another plugin revision may have claimed this occurrence.
      // Re-read and persist the claim without any asynchronous boundary before followup.
      this.bindings = this.readBindings()
      const binding = this.bindings[key]!
      if (binding.delivered.includes(message.id!)) return
      if (binding.uncertain) throw new Error(`提醒 ${message.id} 的上次隔离投递结果未知，请检查 ${id}，不自动重放`)
      binding.uncertain = message.id
      this.save(key, binding)
      agent.followup(message)
      if (this.options.flush && !await this.options.flush(agent.session)) throw new Error(`隔离提醒 ${id} 尚未持久化确认，停止源会话`)
      binding.delivered.push(message.id!)
      delete binding.uncertain
      this.save(key, binding)
    })()
    this.deliveries.set(key, delivery)
    try { await delivery } finally { this.deliveries.delete(key) }
  }

  status(): Binding[] { return structuredClone(Object.values(this.readBindings())) }

  private async ensure(binding: Binding): Promise<ReminderAgent> {
    const service = this.options.agents()
    if (!service) throw new Error('agent 服务不可用，不能创建隔离提醒会话')
    const live = service.get?.(binding.id)
    if (live) return live
    const pending = this.inflight.get(binding.id)
    if (pending) return pending
    const promise = (async () => {
      let handle: { agent?: ReminderAgent }
      const prepared = this.options.prepare?.() ?? {}
      const runtime = { ...prepared, agentOptions: { ...prepared.agentOptions, maxTokens: 1024 } }
      try { handle = await service.resume({ resumeSessionId: binding.id, ...runtime }) }
      catch { handle = await service.create({ sessionId: binding.id, meta: { cwd: this.options.cwd, agentPreset: 'standard' }, ...runtime }) }
      if (!handle.agent || handle.agent.id !== binding.id) throw new Error('提醒会话创建结果与目标不一致')
      if (this.options.rename && handle.agent.session) this.options.rename(handle.agent.session, `提醒｜${binding.title}`)
      return handle.agent
    })()
    this.inflight.set(binding.id, promise)
    try { return await promise } finally { this.inflight.delete(binding.id) }
  }

  private save(key: string, binding: Binding): void {
    this.bindings = { ...this.readBindings(), [key]: binding }
    if (!this.options.file) return
    mkdirSync(dirname(this.options.file), { recursive: true })
    const temp = `${this.options.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, bindings: this.bindings }) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.options.file)
  }
}

/**
 * Delete one reminder only after proving the caller owns its target session.
 *
 * DSH 0.2.2 ids are host-wide and `delete` became `edit({ action: 'delete' })`,
 * so the ownership check has to come from the catalog's `target.sessionId`
 * before the id alone is handed to the destructive call.
 */
export async function deleteOwnedReminder(
  schedule: Pick<ScheduleService, 'catalog' | 'edit'>,
  sourceSessionId: string,
  id: string,
): Promise<ReminderDeleteReceipt> {
  const matches = (await schedule.catalog()).filter(row => row.id === id)
  if (matches.length !== 1) return { id, deleted: false, code: 'schedule_not_found_or_ambiguous' }
  const owner = reminderTargetSession(matches[0]!)
  if (!owner) return { id, deleted: false, code: 'schedule_not_found_or_ambiguous' }
  if (owner !== sourceSessionId && !owner.startsWith(REMINDER_SESSION_PREFIX)) return { id, deleted: false, code: 'schedule_owner_mismatch' }
  return scheduleDelete(schedule, id)
}
