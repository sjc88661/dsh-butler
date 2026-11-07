/**
 * The butler's hands: the tools an agent session can call.
 *
 * The set is deliberately small and grouped by the only three jobs the kernel
 * owns - remember the owner, track the work, hold the evidence. Everything else
 * is meant to arrive as an installable pack, so adding "book a table" one day
 * means writing one more pack, not growing this file.
 *
 * Every write goes through the ledger or the vault, which is what makes the
 * owner's requirement checkable: a claim of "done" is a row with a status and a
 * receipt, and a claim of "read the full text" is refused unless a stored
 * original and a page anchor exist.
 *
 * @module @dsh-external/dsh-butler/host/tools
 */
// `defineTool` comes from the plugin's own boundary module, not from
// `@deepseek-ai/dsh-tools`: that package is inside the application bundle and
// is not resolvable from an external plugin at run time (see tool-spec.ts).
import { defineTool, type ToolDefinition } from './tool-spec.ts'
import { workspaceToolDefinitions, type WorkspaceToolAccess } from './workspace-tools.ts'
import { dialogueControlDefinition, type DialogueControlAccess } from './dialogue-control.ts'
import { renderOverviewResult, renderReminderResult } from './result-rendering.ts'
import { executionKey, type ExecutionContexts } from './execution-context.ts'
import { readFileSync } from 'node:fs'
import { GuardRefusal, clarifyTime, dedupe, normalizeDoi } from './guard.ts'
import type { Task, TaskStatus } from './ledger.ts'
import type { HistoryBudget } from './budget.ts'
import { projectTaskRead, readTaskBudgets } from './task-projection.ts'
import { EvidenceStore } from './evidence-store.ts'
import { MemoryService, type RememberOptions } from './memory.ts'
import type { ReminderOperations } from './reminder-operations.ts'
import {
  ATTEMPT_LIMIT,
  addReceipt,
  addUsage,
  appendDaily,
  getTask,
  isToolFenced,
  listMemos,
  listPending,
  listTasks,
  noteToolOutcome,
  openTasks,
  receipts,
  setTaskStatus,
  snapshot,
  upsertTask,
  usageTotals,
} from './ledger.ts'
import { readPdfFile, readPdfTextCached, pageAnchors } from './pdf.ts'
import { findNotes, noteHistory, readNote, writeNote } from './notes.ts'
import { searchLiterature, verifyRecords, type LiteratureRecord } from './literature.ts'
import { exportLiterature } from './literature-export.ts'
import { LiteratureResults, renderLiteratureResult, type LiteratureScope } from './literature-results.ts'
import { getPack, listPacks, matchPacks, packsSummary, scaffoldPack, setPackEnabled } from './packs.ts'
import { PACK_BOUNDARY_DESCRIPTION } from '../shared/packs.ts'
import type { ScheduleService, ScheduleTiming, WebService } from './ctx.ts'
import { projectReminderCatalog } from './remind.ts'
import {
  PROFILE_FILE,
  VAULT_HOME,
  ensureVault,
  listFiles,
  readText,
  sha256,
  statePath,
  vaultPath,
  writeBytes,
  writeText,
} from './vault.ts'

/** Services the tools need at call time. */
export interface ToolDeps {
  appliesTo?(agent: { id: string }): boolean
  dialogueAccess?: DialogueControlAccess
  workspaceAccess?: WorkspaceToolAccess
  /** Confirmed zone for every date the butler writes. */
  timeZone: string
  /** Polite-pool contact for Crossref. */
  mailto: string
  /** DSH web service, when available. */
  web?: WebService
  /** DSH schedule service, when available. */
  schedule?: ScheduleService
  /**
   * Refresh the borrowed services before the body reads them.
   *
   * Called at the top of every tool. Returns `false` when the schedule service
   * still cannot be seen, in which case reminder tools answer with
   * {@link ToolDeps.scheduleWhy} instead of pretending the list is empty.
   */
  ready?: () => boolean
  /** Why the schedule service is unusable, for an honest refusal message. */
  scheduleWhy?: () => string
  /** Session id a reminder should be bound to. */
  sessionId(): string
  /** Record which task the current turn belongs to, when the UI set one. */
  currentTaskId(): string | undefined
  /** Scoped business identity; supplied by the production runtime. */
  executionContext?: ExecutionContexts
  evidence?: EvidenceStore
  memory?: MemoryService
  reminderOperations?: ReminderOperations
  /** Saved runtime counters; unavailable counters stay unknown, never inferred from usage rows. */
  budgetHistory?: () => HistoryBudget[]
  /** The native tools/result event records the final result after all gates. */
  receiptsByRuntime?: boolean
  /** Allocate an isolated destination, never fall back to the development session. */
  reminderSession?(sourceSessionId: string, title: string, callId?: string): Promise<string>
}

/** Result envelope every tool returns; `ok: false` carries the refusal reason. */
interface Envelope {
  ok: boolean
  [key: string]: unknown
}

/** Wrap a tool body so a refusal becomes a readable result instead of a crash. */
async function guarded(fn: () => Promise<Envelope>): Promise<Envelope> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof GuardRefusal) return { ok: false, refused: true, code: error.code, message: error.message }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Current ISO instant. */
const now = (): string => new Date().toISOString()

/** Make a stable-ish id from a prefix and the clock. */
function makeId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const salt = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${stamp}-${salt}`
}

/** Coerce one task into the shape the model should see. */
function projectTask(task: Task, budgetHistory?: () => HistoryBudget[]): Record<string, unknown> {
  const actual = projectTaskRead(task, readTaskBudgets(budgetHistory))
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    kind: task.kind ?? 'other',
    dueAt: task.dueAt ?? null,
    note: task.note ?? null,
    usage: actual.usage,
    execution: actual.execution,
    evidenceCount: task.evidence?.length ?? 0,
    evidenceVerification: task.evidenceVerification ?? (task.evidence?.length ? 'legacy-unverified' : null),
  }
}

/**
 * Register every butler tool on a context.
 * @param ctx - host context with `tools` in scope.
 * @param deps - service accessors and the confirmed zone.
 * @returns a disposer that unregisters the whole set.
 */
export function registerButlerTools(
  ctx: { tools: { register(tool: unknown): () => void } },
  deps: ToolDeps,
): () => void {
  const disposers: Array<() => void> = []
  const taskView = (task: Task) => projectTask(task, deps.budgetHistory)
  const evidence = deps.evidence ?? (!deps.receiptsByRuntime && deps.executionContext ? new EvidenceStore({ identity: () => deps.executionContext?.current() }) : undefined)
  const memory = deps.memory ?? (!deps.receiptsByRuntime && deps.executionContext ? new MemoryService({ contexts: deps.executionContext }) : undefined)
  const literatureResults = new LiteratureResults()
  const literatureScope = (): LiteratureScope => {
    const identity = deps.executionContext?.current()
    return { sessionId: identity?.sessionId ?? deps.sessionId(), ownerId: identity?.ownerId, taskId: identity?.taskId ?? deps.currentTaskId() }
  }
  const saveLiterature = (value: Envelope): Envelope => ({ ...value,
    resultSet: literatureResults.save(value, literatureScope(), { ...deps.executionContext?.current() }) })
  const operation = (kind: string) => {
    const identity = deps.executionContext?.current()
    const key = identity && executionKey(identity)
    return key ? { operationId: `${kind}:${sha256(Buffer.from(key))}` } : undefined
  }
  const add = (tool: ToolDefinition): void => {
    const original = tool.execute
    disposers.push(ctx.tools.register({ ...tool, async execute(args, execution) {
      const caller = (execution as { agent?: { id: string } } | undefined)?.agent
      if (deps.appliesTo && (!caller || !deps.appliesTo(caller))) return { ok: false, message: '管家专用工具仅在已登记的管家会话中使用。' }
      const started = Date.now()
      // Native executions are frozen and identity-bearing; preserve the object
      // captured before an approval wait instead of copying its fields.
      const exec = execution && typeof execution === 'object' && 'name' in execution
        ? execution as import('./execution-context.ts').ContextExecution
        : { ...(execution && typeof execution === 'object' ? execution : {}), name: tool.name }
      const record = (result?: unknown, error?: unknown): void => {
        if (deps.receiptsByRuntime) return
        const ok = error === undefined && (result as { ok?: boolean } | undefined)?.ok !== false
        if (deps.executionContext) deps.executionContext.receipt(exec, result, error)
        else addReceipt({ tool: tool.name, taskId: deps.currentTaskId(), ok, ms: Date.now() - started,
          summary: typeof args['action'] === 'string' ? args['action'] : tool.name,
          ...(error ? { error: error instanceof Error ? error.name : 'ToolError' } : {}) })
        noteToolOutcome(tool.name, ok)
      }
      const run = async () => {
        try {
          if (tool.name === 'butler_pdf' && typeof args['taskId'] === 'string') {
            const taskId = args['taskId']
            if (!getTask(taskId)) return { ok: false, code: 'task.unknown_id', message: 'PDF 指定的业务任务不存在。' }
            if (!deps.executionContext) return { ok: false, code: 'task.context_unavailable', message: '执行归因不可用，PDF 未读取。' }
            deps.executionContext.activate(taskId)
          }
          const result = await original(args, execution)
          const identity = deps.executionContext?.current()
          if (evidence && identity?.taskId) {
            const ids = deps.receiptsByRuntime ? evidence.prepare(tool.name, result, identity) : evidence.observe(tool.name, result, identity)
            if (ids.length && result && typeof result === 'object') Object.assign(result, { evidenceIds: ids,
              ...(deps.receiptsByRuntime ? { evidenceState: 'pending-final-result' } : {}) })
          }
          record(result)
          return result
        } catch (error) { record(undefined, error); throw error }
      }
      return deps.executionContext ? deps.executionContext.withExecution(exec, run) : run()
    } } satisfies ToolDefinition))
  }

  if (deps.workspaceAccess) for (const tool of workspaceToolDefinitions(deps.workspaceAccess)) add(tool)
  if (deps.dialogueAccess) add(dialogueControlDefinition(deps.dialogueAccess))

  // ── 记忆与状态 ────────────────────────────────────────────────────────────
  add(defineTool({
    name: 'butler_overview',
    description: '管家总览：今天要做什么、什么在等你点头、最近发生了什么、用了多少。开工或用户问"今天有什么"时先调这个。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderOverviewResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const started = Date.now()
      const result = await guarded(async () => {
        deps.ready?.()
        ensureVault()
        const snap = snapshot()
        const profile = readText(PROFILE_FILE()) ?? ''
        const proposed = listMemos().filter((memo) => memo.status === 'proposed')
        return {
          ok: true,
          vault: VAULT_HOME,
          profileExcerpt: profile.split('\n').filter((line) => line.trim() !== '').slice(0, 24).join('\n'),
          openTasks: snap.open.map(taskView),
          awaitingApproval: snap.pending.map((item) => ({ id: item.id, title: item.title, reason: item.reason })),
          proposedMemories: proposed.map((memo) => ({ id: memo.id, text: memo.text })),
          interrupted: snap.interrupted.map(taskView),
          recentReceipts: snap.recent.slice(0, 10).map((row) => ({ at: row.at, tool: row.tool, ok: row.ok, ms: row.ms ?? null, summary: row.summary ?? null, error: row.error ?? null })),
          evidence: deps.executionContext?.current()?.taskId ? evidence?.listForTask(deps.executionContext.current()!.taskId!) ?? [] : [],
          usage: snap.usage,
          packs: packsSummary(),
          note: '完成声明必须对应 receipt 或落盘文件；没有证据的一律按未完成报告。',
        }
      })
      return result
    },
  }))

  add(defineTool({
    name: 'butler_task',
    description: '任务账本：开立、选择或更新任务。done 必须引用本任务真实工具结果已登记的 evidenceIds；evidence 查询可用证据。',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'activate', 'update', 'list', 'evidence'], description: 'open 新建并关联，activate 选择已有任务，update 改状态，list 查询，evidence 查询任务的已确认产物或回执。' },
      id: { type: 'string', description: 'update 时的任务 id。' },
      title: { type: 'string', description: 'open 时的标题（用户原话优先）。' },
      kind: { type: 'string', enum: ['todo', 'reminder', 'research', 'note', 'pdf', 'digest', 'other'], description: '任务类型。' },
      dueAt: { type: 'string', description: 'ISO 时间，仅在时间已确认时填。' },
      status: { type: 'string', enum: ['pending', 'running', 'waiting_review', 'done', 'failed', 'cancelled', 'interrupted'], description: 'update 时的目标状态。' },
      note: { type: 'string', description: '一句话结论或失败原因。' },
      evidenceIds: { type: 'array', items: { type: 'string' }, description: 'done 时引用真实工具返回的 evidenceIds；原生工具的证据可用 action=evidence 查询。' },
      filter: { type: 'string', enum: ['open', 'done', 'failed', 'all'], description: 'list 的过滤条件。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        // Borrowed services are re-resolved here, not frozen at activation:
        // one unlucky start order must not make the schedule service vanish.
        deps.ready?.()
        const action = String(args['action'] ?? '')
        if (action === 'evidence') {
          const id = typeof args['id'] === 'string' ? args['id'] : deps.executionContext?.current()?.taskId
          if (!id || !getTask(id)) throw new GuardRefusal('task.unknown_id', '请先选择或指定一个已有业务任务。')
          if (!evidence) throw new GuardRefusal('evidence.unavailable', '证据登记服务不可用。')
          return { ok: true, taskId: id, evidence: evidence.listForTask(id) }
        }
        if (action === 'list') {
          const filter = String(args['filter'] ?? 'open')
          const rows = filter === 'all' ? listTasks() : filter === 'open' ? openTasks() : listTasks().filter((task) => task.status === filter)
          return { ok: true, tasks: rows.slice(0, 50).map(taskView) }
        }

        if (action === 'open') {
          const title = String(args['title'] ?? '').trim()
          if (title === '') throw new GuardRefusal('task.no_title', '新建任务必须有 title。')
          const identity = deps.executionContext?.current()
          const key = identity && executionKey(identity)
          const id = key ? `task-${sha256(Buffer.from(key)).slice(0, 24)}` : makeId('task')
          const prior = getTask(id)
          if (prior) {
            deps.executionContext?.activate(id)
            return { ok: true, task: taskView(prior), replayed: true }
          }
          const task = upsertTask(id, {
            title,
            status: 'pending',
            ...(identity === undefined ? {} : {
              sessionId: identity.sessionId, rootSessionId: identity.rootSessionId, runId: identity.runId,
              originMessageId: identity.originMessageId, lastTransitionOriginId: identity.originMessageId,
              ...(identity.ownerId === undefined ? {} : { ownerId: identity.ownerId }),
              ...(identity.channelOrigin === undefined ? {} : { channelOrigin: identity.channelOrigin }),
            }),
            ...(typeof args['kind'] === 'string' ? { kind: args['kind'] as Task['kind'] } : {}),
            ...(typeof args['dueAt'] === 'string' ? { dueAt: args['dueAt'] } : {}),
            attempts: 0,
          }, operation('task.open'))
          if (task) deps.executionContext?.activate(id)
          appendDaily(deps.timeZone, `- [新建] ${title}`)
          return { ok: true, task: task === undefined ? null : taskView(task) }
        }

        if (action === 'activate' || action === 'update') {
          const id = String(args['id'] ?? '')
          const existing = getTask(id)
          if (existing === undefined) throw new GuardRefusal('task.unknown_id', `没有 id 为 ${id} 的任务；先用 butler_task list 查。`)
          deps.executionContext?.activate(id)
          if (action === 'activate') return { ok: true, task: taskView(existing) }
          const status = typeof args['status'] === 'string' ? args['status'] as TaskStatus : existing.status
          const note = typeof args['note'] === 'string' ? args['note'] : undefined
          const identity = deps.executionContext?.current()
          const latestOrigin = identity?.rootSessionId
            ? deps.executionContext?.forAgent(identity.rootSessionId).originMessageId : undefined
          if (identity?.originMessageId && latestOrigin && identity.originMessageId !== latestOrigin) {
            throw new GuardRefusal('task.stale_origin', '这次调用属于较早的工作输入；保留原回执，但不能覆盖用户后来的任务决定。')
          }
          const isReopening = ['done', 'cancelled', 'interrupted'].includes(existing.status)
            && ['pending', 'running'].includes(status) && status !== existing.status
          if (isReopening && (!identity?.originMessageId || identity.originMessageId === existing.lastTransitionOriginId)) {
            throw new GuardRefusal('task.reopen_requires_human', '重新打开已结束或中断的任务需要新的人类工作输入；自动继续不能重放。')
          }

          if (status === 'done') {
            if (!evidence) throw new GuardRefusal('evidence.unavailable', '证据登记服务不可用；未完成状态变更。')
            const ids = Array.isArray(args['evidenceIds']) ? args['evidenceIds'] as string[] : []
            const registered = evidence.resolve(ids, id)
            const done = setTaskStatus(id, 'done', note, deps.timeZone, operation('task.done'), { evidence: registered, evidenceVerification: 'host-registered',
              ...(identity?.originMessageId === undefined ? {} : { lastTransitionOriginId: identity.originMessageId }) })
            return { ok: true, task: done === undefined ? null : taskView(done), evidenceCount: registered.length }
          }

          if (status === 'running' && (existing.attempts ?? 0) >= ATTEMPT_LIMIT) {
            throw new GuardRefusal(
              'task.attempt_limit',
              `这条任务已经试过 ${existing.attempts ?? 0} 次（上限 ${ATTEMPT_LIMIT}）。先说清前几次为什么失败，或者改用别的方法。`,
            )
          }
          const effect: Partial<Task> = {
            status,
            ...(identity?.originMessageId === undefined ? {} : { lastTransitionOriginId: identity.originMessageId }),
            ...(note === undefined ? {} : { note }),
            ...(status === 'running' && existing.status !== 'running' ? { attempts: (existing.attempts ?? 0) + 1 } : {}),
          }
          const updated = setTaskStatus(id, status, note, deps.timeZone, operation('task.transition'), effect)
          if (updated === undefined) throw new GuardRefusal('task.update_failed', '任务更新失败。')
          return { ok: true, task: taskView(updated) }
        }

        throw new GuardRefusal('task.bad_action', `不认识 action="${action}"。`)
      })
      return result
    },
  }))

  add(defineTool({
    name: 'butler_remember',
    description: '长期记忆：remember 保存；read/search 读取或检索；correct 更正；withdraw 撤回。profile只放少量稳定偏好和边界，项目/资料用topic。推断和维护操作须核验真实用户决定，旧值与来源保留审计。',
    parameters: {
      action: { type: 'string', enum: ['remember', 'read', 'search', 'correct', 'withdraw'], description: '默认remember；read/search只读；correct/withdraw需要目标id。' },
      text: { type: 'string', description: 'remember/correct的新事实，尽量用用户原话。' },
      id: { type: 'string', description: 'read/correct/withdraw的记忆id。' },
      query: { type: 'string', description: 'search的当前请求关键词。' },
      scope: { type: 'string', enum: ['profile', 'topic'], description: '少量稳定偏好/边界用profile；项目背景和资料用topic。' },
      topic: { type: 'string', description: 'topic记忆的主题名称。' },
      key: { type: 'string', description: '同一偏好的稳定键，例如reply-length；变值将产生替换提案，不能反复追加相反偏好。' },
      maxBytes: { type: 'integer', description: 'search摘录UTF-8字节上限，默认4000，最多16000。' },
      includeInactive: { type: 'boolean', description: 'search是否包含proposed/rejected/retracted审计记录；默认只检索有效记忆。' },
      source: { type: 'string', enum: ['user', 'butler'], description: '来源提示；宿主会核验真实用户原话，此字段不能批准。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        // Borrowed services are re-resolved here, not frozen at activation:
        // one unlucky start order must not make the schedule service vanish.
        deps.ready?.()
        if (!memory) throw new GuardRefusal('memory.unavailable', '记忆来源核验服务不可用。')
        const action = args['action'] ?? 'remember', id = String(args['id'] ?? '')
        if (action === 'read') return { ok: true, memory: memory.read(id) ?? null }
        if (action === 'search') return { ok: true, ...memory.search(String(args['query'] ?? ''), {
          ...(typeof args['maxBytes'] === 'number' ? { maxBytes: args['maxBytes'] } : {}), includeInactive: args['includeInactive'] === true }) }
        if ((action === 'correct' || action === 'withdraw') && !id) throw new GuardRefusal('memo.no_id', '更正或撤回需要已有记忆id。')
        const options: RememberOptions = { ...(args['scope'] === 'profile' || args['scope'] === 'topic' ? { scope: args['scope'] } : {}),
          ...(typeof args['topic'] === 'string' ? { topic: args['topic'] } : {}), ...(typeof args['key'] === 'string' ? { key: args['key'] } : {}) }
        const text = String(args['text'] ?? '').trim()
        if (action !== 'withdraw' && text.length < 2) throw new GuardRefusal('memo.empty', '要记住的内容太短。')
        const saved = action === 'withdraw' ? memory.withdraw(id) : action === 'correct' ? memory.correct(id, text, options) : memory.remember(text, options)
        return { ok: true, ...saved, ...(saved.proposal?.status === 'pending' ? { next: '使用原生 ask_user_question，questions=[proposal.question]；只在最终真实答案确认后写入档案。' } : {}) }
      })
      return result
    },
  }))

  add(defineTool({
    name: 'butler_approve',
    description: '列出记忆待批项；decide 核验真实用户原话中的明确确认或拒绝。外部动作继续使用宿主原生权限，不能用本工具的决定提升权限。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'decide'], description: 'list 列出，decide 做决定。' },
      id: { type: 'string', description: 'decide 时的待批项 id。' },
      decision: { type: 'string', enum: ['approved', 'declined'], description: 'decide 时的决定。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        // Borrowed services are re-resolved here, not frozen at activation:
        // one unlucky start order must not make the schedule service vanish.
        deps.ready?.()
        if (args['action'] === 'list') {
          const rows = listPending()
          return { ok: true, pending: rows }
        }
        const id = String(args['id'] ?? '')
        if (!memory) throw new GuardRefusal('memory.unavailable', '记忆来源核验服务不可用。')
        const decision = args['decision']
        if (decision !== 'approved' && decision !== 'declined') throw new GuardRefusal('approval.bad_decision', '需要明确的批准或拒绝决定。')
        return { ok: true, ...memory.decide(id, decision), note: '已应用这条记忆的真实用户决定。外部动作仍经过原生权限与预算。' }
      })
      return result
    },
  }))

  // ── 检索与兑现 ────────────────────────────────────────────────────────────
  add(defineTool({
    name: 'butler_literature',
    description: '文献：search多库检索，verify核实题录。默认至多8条跨来源预览；完整结果已本地保存，page分页、read读取题录/摘要。入门优先tutorial/introduction或具体经典文章标题，可并行几条聚焦查询，命中几篇合适文献即答复，无需穷尽检索。export离线导出输入records为RIS/BibTeX，不重新核验或读全文。',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'verify', 'page', 'read', 'export'], description: 'search检索；verify核实已有记录；page/read离线读取已保存结果；export导出输入题录。' },
      query: { type: 'string', description: 'search 的主题、标题或作者。' },
      rows: { type: 'integer', description: '每个库取几条，默认4，上限20；三库总数可超过rows。需要更多优先page已有结果。' },
      resultSetId: { type: 'string', description: 'page/read必填：本会话、本业务任务此前返回的resultSet.id。' },
      offset: { type: 'integer', description: 'page的题录偏移；read的Unicode字符偏移，默认0，使用返回的nextOffset继续。' },
      limit: { type: 'integer', description: 'page每页1–8条；read每片1–2000字符，默认1500。' },
      index: { type: 'integer', description: 'read的题录index，默认0；来自预览或page。' },
      field: { type: 'string', enum: ['record', 'abstract', 'metadata'], description: 'read读取完整题录JSON、摘要或检索来源/限制元数据；默认record。按nextOffset拼接可还原完整内容。' },
      records: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'verify 的记录；export 接收 1–100 条带有效 title 的输入题录，其他字段缺失时保留缺项，不自动去重或补造。' },
      format: { type: 'string', enum: ['ris', 'bibtex'], description: 'export 必填：ris 生成 .ris，bibtex 生成 .bib。' },
      slug: { type: 'string', description: 'export 必填：1–80 个 ASCII 字母数字、下划线或短横线；不含路径或扩展名，不用 Windows 保留设备名。已有不同内容不覆盖。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderLiteratureResult(value) }],
    },
    async execute(args) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        // Borrowed services are re-resolved here, not frozen at activation:
        // one unlucky start order must not make the schedule service vanish.
        deps.ready?.()
        if (args['action'] === 'export') return { ...exportLiterature({ format: args['format'], slug: args['slug'], records: args['records'] }, operation('literature.export')) }
        if (args['action'] === 'page') return { ok: true, ...literatureResults.page(String(args['resultSetId'] ?? ''), literatureScope(), {
          offset: args['offset'] as number | undefined, limit: args['limit'] as number | undefined,
        }) }
        if (args['action'] === 'read') return { ok: true, view: 'literature-detail', read_level: '题录或摘要片段，未读取全文',
          ...literatureResults.read(String(args['resultSetId'] ?? ''), literatureScope(), {
            index: args['index'] as number | undefined, field: args['field'] as 'record' | 'abstract' | 'metadata' | undefined,
            offset: args['offset'] as number | undefined, limit: args['limit'] as number | undefined,
          }) }
        const web = deps.web
        if (web === undefined) throw new GuardRefusal('web.unavailable', '当前没有可用的 web 服务，无法检索文献（这属于明确的失败，不是"没找到"）。')
        if (args['action'] === 'verify') {
          const raw = Array.isArray(args['records']) ? args['records'] : []
          const records = raw.filter((row: unknown): row is LiteratureRecord => typeof row === 'object' && row !== null && typeof (row as Record<string, unknown>)['title'] === 'string')
          if (records.length === 0) throw new GuardRefusal('literature.nothing_to_verify', 'verify 需要 records 数组。')
          if (records.length > 100) throw new GuardRefusal('literature.too_many_records', 'verify每次最多100条题录。')
          const verified = await verifyRecords(web, records, deps.mailto)
          const conflicts = verified.filter((row) => row.verified === 'conflict')
          return saveLiterature({
            ok: true,
            records: verified,
            verifiedCount: verified.filter((row) => row.verified === 'verified').length,
            unconfirmedCount: verified.filter((row) => row.verified === 'unconfirmed').length,
            conflictCount: conflicts.length,
            limitations: conflicts.map((row) => `标题冲突：${row.verificationNote ?? ''}`),
          })
        }
        const query = String(args['query'] ?? '').trim()
        if (query === '') throw new GuardRefusal('literature.no_query', 'search 需要 query。')
        const rows = typeof args['rows'] === 'number' ? Math.max(1, Math.min(20, args['rows'])) : 4
        const found = await searchLiterature(web, query, { rows, mailto: deps.mailto })
        return saveLiterature({
          ok: true,
          query,
          records: found.records,
          duplicatesRemoved: found.duplicatesRemoved,
          providers: found.providers,
          limitations: found.limitations,
          discipline: 'abstract 只代表摘要可读；要声称读过全文，必须先 butler_pdf 落盘原件并拿到页码锚点。',
        })
      })
      return result
    },
  }))

  add(defineTool({
    name: 'butler_pdf',
    description: '收下一个 PDF：保存原件到 vault/uploads 并算 SHA256，然后读它的文本层。没有文本层（扫描件）会明确报告"无法解析，需要 OCR"，绝不假装读到了。',
    parameters: {
      action: { type: 'string', required: true, enum: ['ingest', 'read'], description: 'ingest 保存原件并解析；read 只读已保存的原件。' },
      path: { type: 'string', description: 'PDF 的绝对路径（用户上传或本机文件）。' },
      taskId: { type: 'string', description: '关联的任务 id。' },
      pages: { type: 'array', items: { type: 'integer' }, description: 'read 指定真实物理页码；不指定默认返回前 3 页片段。' },
      fullText: { type: 'boolean', description: 'read 时请求全部可解析页；超出返回上限会明确降级。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        // Borrowed services are re-resolved here, not frozen at activation:
        // one unlucky start order must not make the schedule service vanish.
        deps.ready?.()
        const source = String(args['path'] ?? '').trim()
        if (source === '') throw new GuardRefusal('pdf.no_path', '需要 PDF 的绝对路径。')
        let bytes: Uint8Array
        try {
          bytes = readPdfFile(source)
        } catch (error) {
          throw new GuardRefusal('pdf.unreadable', `读不到这个文件：${error instanceof Error ? error.message : String(error)}`)
        }
        const requested = Array.isArray(args['pages']) ? args['pages'] as number[] : undefined
        const parsed = readPdfTextCached(bytes, { cacheDir: statePath('cache', 'pdf-text'), ...(requested ? { pages: requested } : {}) })
        const hash = sha256(bytes)
        let stored: string | undefined
        if (args['action'] === 'ingest') {
          const name = source.replace(/\\/g, '/').split('/').pop() ?? 'document.pdf'
          const target = vaultPath('uploads', `${hash.slice(0, 12)}-${name}`)
          writeBytes(target, bytes)
          stored = target
          appendDaily(deps.timeZone, `- [原件] ${name} → ${target} (sha256 ${hash.slice(0, 12)}…)`)
        }
        const selected = requested || args['fullText'] === true ? parsed.pages : parsed.pages.slice(0, 3)
        let remaining = 60000
        const returnedPages = selected.map(page => {
          const text = page.text.slice(0, Math.max(0, remaining))
          remaining -= text.length
          return { ...page, text }
        })
        const complete = parsed.complete && returnedPages.length === parsed.pages.length
          && returnedPages.every((page, index) => page.text === parsed.pages[index]?.text)
        const anchors = pageAnchors({ ...parsed, pages: returnedPages })
        return {
          ok: true,
          storedPath: stored ?? null,
          sourcePath: stored ?? source,
          sha256: hash,
          pages: parsed.declaredPages ?? parsed.pages.length,
          declaredPages: parsed.declaredPages ?? null,
          textLayer: parsed.textLayer,
          pageOrderKnown: parsed.pageOrderKnown,
          cache: parsed.cache,
          anchors,
          returnedPages,
          fullTextAvailable: complete && parsed.textLayer,
          limitations: [
            ...parsed.limitations,
            ...parsed.cache.warnings,
            ...(complete ? [] : ['本次仅返回部分内容；可指定 pages 读取后续真实物理页，或请求 fullText。保存原件不代表读过全文。']),
          ],
          readLevel: complete && parsed.textLayer ? 'fulltext' : 'abstract',
        }
      })
      return result
    },
  }))

  add(defineTool({
    name: 'butler_note',
    description: '笔记库：写入/追加均保存完整正文与SHA256历史；history查历史，read+revision读旧版，restore恢复成新rev。手改或旧SHA256冲突时保留双方副本并返回差异。',
    parameters: {
      action: { type: 'string', required: true, enum: ['write', 'append', 'read', 'find', 'history', 'restore'], description: 'write 新建/覆盖，append 补充，read 读当前或revision，history查历史，restore恢复为新rev，find 找。' },
      slug: { type: 'string', description: '文件名（不含 .md）。中英文均可。' },
      title: { type: 'string', description: '笔记标题。' },
      markdown: { type: 'string', description: '笔记正文（markdown）。' },
      sources: { type: 'array', items: { type: 'string' }, description: '来源行，例如"标题 — DOI 链接 — 2026-10-03 取"。' },
      limitations: { type: 'array', items: { type: 'string' }, description: '失败、冲突、无法解析之处。没有也要显式说明。' },
      query: { type: 'string', description: 'find 的关键词。' },
      revision: { type: 'integer', description: 'read/restore 的历史 revision 号；read省略时读当前正文。' },
      expectedSha256: { type: 'string', description: '可选的读取时SHA256；写入前不一致则保存冲突，禁止覆盖。' },
      limit: { type: 'integer', description: 'history返回条数，默认30，最多100。' },
      beforeRevision: { type: 'integer', description: 'history分页：只查小于此revision的版本。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        // Borrowed services are re-resolved here, not frozen at activation:
        // one unlucky start order must not make the schedule service vanish.
        deps.ready?.()
        const action = String(args['action'] ?? '')
        if (action === 'find') {
          const query = String(args['query'] ?? '').toLowerCase()
          return findNotes(query)
        }
        const slug = String(args['slug'] ?? '')
        if (slug === '') throw new GuardRefusal('note.no_slug', '需要 slug（文件名）。')
        if (action === 'history') return noteHistory(slug, typeof args['limit'] === 'number' ? args['limit'] : undefined, typeof args['beforeRevision'] === 'number' ? args['beforeRevision'] : undefined)
        if (action === 'read') {
          return readNote(slug, typeof args['revision'] === 'number' ? args['revision'] : undefined)
        }
        const title = typeof args['title'] === 'string' ? args['title'] : undefined
        const markdown = String(args['markdown'] ?? '')
        const sources = Array.isArray(args['sources']) ? args['sources'].filter((line): line is string => typeof line === 'string') : []
        const limitations = Array.isArray(args['limitations']) ? args['limitations'].filter((line): line is string => typeof line === 'string') : []
        const kind = action === 'restore' ? 'restore' : action === 'append' ? 'append' : 'write'
        const written = writeNote({ slug, title, markdown, sources, limitations, expectedSha256: typeof args['expectedSha256'] === 'string' ? args['expectedSha256'] : undefined,
          ...operation(`note.${kind}`) }, kind, typeof args['revision'] === 'number' ? args['revision'] : undefined)
        if (written.ok) appendDaily(deps.timeZone, `- [笔记] ${title ?? slug} → notes/${written.slug}.md (rev ${written.rev})`)
        return { ...written, openWith: '记事本或任何 markdown 阅读器直接打开即可' }
      })
      return result
    },
  }))

  add(defineTool({
    name: 'butler_remind',
    description: '设提醒（到期投递到独立提醒会话，最多 5 次模型请求，只读查询，留下送达回执）。时间含糊时返回 needsClarification。取消用 action=cancel。',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'list', 'cancel', 'history'], description: 'create 新建，list 查，cancel 取消，history 看送达记录。' },
      title: { type: 'string', description: '提醒标题（必填，调度服务要求）。' },
      prompt: { type: 'string', description: '到点要说的内容。' },
      when: { type: 'string', description: '用户原话里的时间描述；支持明确数字相对时间，例如"从现在起60秒后"、"2分钟后"、"1小时后"。' },
      at: { type: 'string', description: '已确认的具体时间，ISO 或 YYYY-MM-DDTHH:mm。给了就按这个建。' },
      timing: {
        type: 'object',
        description: 'P1 预留的结构化重复规则（0.2.2 timing 联合）：{kind:"at",at}、{kind:"after",after_seconds}、{kind:"daily",daily:{time,time_zone}}、{kind:"weekly",weekly:{time,time_zone,weekdays}}、{kind:"every",every_seconds}、{kind:"cron"|"rrule"}。与 at/when 不能同时提供；自然语言→timing 的解析下一步再做。',
      },
      id: { type: 'string', description: 'cancel 时的提醒 id。' },
      originalText: { type: 'string', description: '用户原话，用于判断时间是否含糊。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderReminderResult(value) }],
    },
    async execute(args, exec) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        // Borrowed services are re-resolved here, not frozen at activation:
        // one unlucky start order must not make the schedule service vanish.
        deps.ready?.()
        const schedule = deps.schedule
        const action = String(args['action'] ?? 'create')

        // A failed lookup is its own answer. Returning `reminders: []` here
        // would read as "you have no reminders" — the one thing this must
        // never fake, since the owner's trust in a reminder is about whether
        // it will actually arrive.
        if (schedule === undefined && action !== 'history') {
          return {
            ok: false,
            unavailable: true,
            action,
            reason: deps.scheduleWhy?.() ?? '调度服务不可用',
            note: '调度服务这次没能读到，所以既不能列出也不能改动提醒；这不代表你没有提醒。稍后重试，或直接看 ~/.dsh/storages/schedule.json。',
          }
        }

        if (action === 'list') {
          // Host-side projection: native 0.2.2 status is normalized for the
          // existing 'active'|'inactive' consumer type, raw status preserved.
          const rows = await (schedule as ScheduleService).catalog()
          return { ok: true, reminders: projectReminderCatalog(rows) }
        }
        if (action === 'history') {
          if (!deps.reminderOperations) return { ok: false, available: false, reason: '提醒业务记录服务不可用；无法核对真实历史。' }
          return { ...await deps.reminderOperations.history({ sourceSessionId: deps.sessionId(), id: String(args['id'] ?? ''), timeZone: deps.timeZone }) }
        }
        if (action === 'cancel') {
          const id = String(args['id'] ?? '')
          const identity = deps.executionContext?.current()
          if (!identity || !deps.reminderOperations) throw new GuardRefusal('remind.operations_unavailable', '提醒操作记录服务不可用，无法安全取消。')
          const outcome = await deps.reminderOperations.cancel({ identity, id, timeZone: deps.timeZone })
          return { ...outcome, task: outcome.task ? taskView(outcome.task) : null }
        }

        const title = String(args['title'] ?? '').trim()
        if (title === '') throw new GuardRefusal('remind.no_title', '提醒必须给标题。')
        const at = typeof args['at'] === 'string' && args['at'].trim() !== '' ? args['at'].trim() : undefined
        // P1 hook: a validated 0.2.2 timing object may be passed through as-is.
        // Natural language → timing parsing is deliberately not done here yet.
        const timingArg = typeof args['timing'] === 'object' && args['timing'] !== null && !Array.isArray(args['timing'])
          ? args['timing'] as ScheduleTiming : undefined
        const heardWhen = typeof args['when'] === 'string' && args['when'].trim() !== '' ? args['when'].trim() : undefined
        if (timingArg !== undefined && (at !== undefined || heardWhen !== undefined)) {
          throw new GuardRefusal('remind.conflicting_time', '结构化 timing 与 at/when 只能提供一种，提醒未建立。')
        }
        const relative = timingArg === undefined && at === undefined && heardWhen !== undefined
          ? /^(?:从现在起|从现在开始|现在起)?\s*(\d+(?:\.\d+)?)\s*(秒钟?|分钟?|小时)\s*(?:之|以)?后$/.exec(heardWhen) : null
        const afterSeconds = relative ? Number(relative[1]) * (relative[2]!.startsWith('秒') ? 1 : relative[2]!.startsWith('分') ? 60 : 3600) : undefined
        if (afterSeconds !== undefined && (afterSeconds <= 0 || !Number.isSafeInteger(afterSeconds * 1000))) {
          throw new GuardRefusal('remind.invalid_time', '相对提醒时间必须是有效的正数秒数、分钟数或小时数。')
        }
        const vague = timingArg !== undefined || afterSeconds !== undefined ? undefined : clarifyTime(String(args['originalText'] ?? args['when'] ?? title), at)
          ?? (at === undefined ? '什么时候提醒你？请给出具体日期时间，或明确的数字秒、分钟、小时后。' : undefined)
        if (vague !== undefined) {
          return {
            ok: true,
            needsClarification: true,
            question: vague,
            note: '时间不明确，先按"待定"记着，问清楚再设。绝不自作主张定时。',
            draft: { title, prompt: String(args['prompt'] ?? title), heard: String(args['when'] ?? '') },
          }
        }
        if (schedule === undefined) throw new GuardRefusal('schedule.unavailable', '调度服务不可用，提醒没有建立（如实报告）。')
        const identity = deps.executionContext?.current()
        if (!identity || !deps.reminderOperations) throw new GuardRefusal('remind.operations_unavailable', '提醒操作记录服务不可用，提醒未建立。')
        const outcome = await deps.reminderOperations.create({ identity, reminder: { title, prompt: String(args['prompt'] ?? title),
          ...(timingArg !== undefined ? { timing: timingArg } : afterSeconds === undefined ? { at } : { afterSeconds }), timeZone: deps.timeZone } })
        let persistedTask = outcome.task
        if (!persistedTask && outcome.taskId) {
          try { persistedTask = getTask(outcome.taskId) } catch { /* Preserve the original create/storage failure. */ }
        }
        if (persistedTask && persistedTask.id === outcome.taskId) deps.executionContext?.activate(persistedTask.id)
        return { ...outcome, task: outcome.task ? taskView(outcome.task) : null, tz: deps.timeZone }
      })
      return result
    },
  }))

  add(defineTool({
    name: 'butler_pack',
    description: '能力包是可编辑工作指引：列包、看完整工作流/证据/授权成本提示、启停、按原话匹配、建脚手架。tools/permissions/max_attempts/cost均为建议声明，不能授予权限、创建硬预算或保证零成本。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'show', 'enable', 'disable', 'match', 'scaffold'], description: 'list 列全部，show 看一个，enable/disable 装卸，match 按原话匹配，scaffold 生成一个可编辑的包文件。' },
      id: { type: 'string', description: 'show / enable / disable / scaffold 用的包 id。' },
      title: { type: 'string', description: 'scaffold 时的标题（可省，默认用 id）。' },
      request: { type: 'string', description: 'match 时的用户原话，照抄不改写。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const started = Date.now()
      const result = await guarded(async (): Promise<Envelope> => {
        deps.ready?.()
        const action = String(args['action'] ?? 'list')

        if (action === 'list') {
          const packs = listPacks()
          return {
            ok: true,
            packs: packs.map((pack) => ({
              id: pack.id,
              title: pack.title,
              enabled: pack.enabled,
              source: pack.source,
              cost_class: pack.cost_class,
              boundary: pack.boundary,
              triggers: pack.triggers,
              tools: pack.tools,
              ...(pack.path === undefined ? {} : { path: pack.path }),
              ...(pack.broken === undefined ? {} : { broken: pack.broken }),
            })),
            location: VAULT_HOME + '\\packs',
            boundaryDescription: PACK_BOUNDARY_DESCRIPTION,
            note: '用户自己写的包放在 vault/packs/*.md，改完下个回合就生效；同 id 的包会盖掉内置包。',
          }
        }

        if (action === 'match') {
          const request = String(args['request'] ?? '').trim()
          if (request === '') throw new GuardRefusal('pack.no_request', 'match 需要 request：把用户原话抄进来。')
          const hits = matchPacks(request, 3)
          return {
            ok: true,
            request,
            matches: hits.map((row) => ({ id: row.pack.id, title: row.pack.title, hits: row.hits, tools: row.pack.tools, source: row.pack.source, cost_class: row.pack.cost_class, boundary: row.pack.boundary })),
            boundaryDescription: PACK_BOUNDARY_DESCRIPTION,
            note: hits.length === 0
              ? '没有任何包的触发词命中：按内核纪律直接做，或问用户要不要为这件事新建一个包。'
              : '这是关键词命中，不是意图判断；先用 show 看完整工作流与证据要求。命中或启用都不代表授权执行。',
          }
        }

        if (action === 'scaffold') {
          const id = String(args['id'] ?? '').trim()
          if (id === '') throw new GuardRefusal('pack.no_id', 'scaffold 需要 id。')
          const created = scaffoldPack(id, typeof args['title'] === 'string' ? args['title'] : undefined)
          if (created.refused !== undefined) return { ok: false, refused: true, code: 'pack.scaffold_refused', message: created.refused }
          appendDaily(deps.timeZone, `- [能力包] 新建脚手架 ${id}`)
          return {
            ok: true,
            path: created.path,
            markdown: created.markdown,
            note: '文件已写好，请把正文改成真实说明；改完我就照它做事。用户没让你写包时，不要自己建。',
          }
        }

        const id = String(args['id'] ?? '').trim()
        if (id === '') throw new GuardRefusal('pack.no_id', `${action} 需要 id。`)
        const pack = getPack(id)
        if (pack === undefined) {
          return {
            ok: false,
            id,
            known: listPacks().map((row) => row.id),
            note: '没有这个 id 的包（可能是内置包被改写、或文件名不同），如实报告，别当成"已存在"。',
          }
        }

        if (action === 'show') {
          return {
            ok: true,
            pack: {
              id: pack.id,
              title: pack.title,
              enabled: pack.enabled,
              source: pack.source,
              cost_class: pack.cost_class,
              boundary: pack.boundary,
              triggers: pack.triggers,
              instructions: pack.instructions,
              tools: pack.tools,
              evidence: pack.evidence,
              permissions: pack.permissions,
              budget: pack.budget,
              ...(pack.path === undefined ? {} : { path: pack.path }),
              ...(pack.broken === undefined ? {} : { broken: pack.broken }),
            },
            boundaryDescription: PACK_BOUNDARY_DESCRIPTION,
          }
        }

        const wanted = action === 'enable'
        if (pack.enabled === wanted) {
          return { ok: true, pack: { id: pack.id, title: pack.title, enabled: pack.enabled, boundary: pack.boundary }, note: wanted ? '这个包本来就是开着的。' : '这个包本来就是关的。' }
        }
        const updated = setPackEnabled(pack.id, wanted)
        appendDaily(deps.timeZone, `- [能力包] ${wanted ? '启用' : '停用'} ${pack.id}（${pack.title}）`)
        return {
          ok: updated !== undefined,
          pack: updated === undefined ? null : { id: updated.id, title: updated.title, enabled: updated.enabled, boundary: updated.boundary },
          note: wanted
            ? '已启用：下个回合起按它的说明做事。'
            : '已停用：我不再照它做事；它的文件还在 vault/packs，随时能再开。',
        }
      })
      return result
    },
  }))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** Export the pieces tests reach for directly. */
export { openTasks, receipts, usageTotals, isToolFenced, dedupe, normalizeDoi }
