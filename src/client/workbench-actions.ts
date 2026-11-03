import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useSyncExternalStore } from 'react'
import type { HistoryItems } from './api.ts'
import { clientService, openButlerConversation } from './navigate.ts'

/** A UI receipt describes only the requested local action, never business progress. */
export interface TaskActionOutcome { ok: boolean; message: string }

export interface TaskDetailActions {
  openFile?(path: string): void
  copyContinuation?(): void
  continueWithButler?(): void
  openSourceConversation?(): void
  outcome?: TaskActionOutcome
}

const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const validId = (id: unknown): id is string => typeof id === 'string' && id.trim() !== '' && id.length <= 512 && !controls.test(id)

/** Preserve the exact ledger id; titles and shortened display labels are not identifiers. */
export function continuationCommand(taskId: unknown): string | undefined {
  return validId(taskId) ? `继续任务 ${taskId}` : undefined
}

function absoluteFilePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || controls.test(value)) return undefined
  const normalized = value.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//.test(normalized) || (normalized.startsWith('/') && !normalized.startsWith('//'))
    || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(normalized)) return normalized
  return undefined
}

/** Only explicit file facts may offer a native file action; a generic reference stays a reference. */
export function artifactFilePath(artifact: HistoryItems['artifacts']): string | undefined {
  return absoluteFilePath(artifact.path ?? (artifact.kind === 'file' ? artifact.reference : undefined))
}

/** The shipped sidebar-files encoder keeps colons and preserves absolute/UNC leading slashes. */
const encodeSegment = (value: string): string => encodeURIComponent(value).replace(/%3A/gi, ':')

interface SidebarFileFace {
  openResource?(address: string): unknown
  mounted?: { getSnapshot(): string | undefined; subscribe(callback: () => void): () => void }
}
interface TaskFileResult { taskId: string; path: string; outcome: TaskActionOutcome }
interface PendingFile {
  token: number; ctx: Context; taskId: string; sessionId: string; path: string; address: string
  sidebar: SidebarFileFace; unsubscribe?: () => void; timeout?: number
}
interface TaskFileSnapshot { pending?: { token: number; sessionId: string }; result?: TaskFileResult }

let pendingFile: PendingFile | undefined
let fileGeneration = 0
let lastFileOwner: Context | undefined
let fileSnapshot: TaskFileSnapshot = {}
const fileSubscribers = new Set<() => void>(), fileLifetimes = new WeakSet<Context>()

export const taskFileSnapshot = (): TaskFileSnapshot => fileSnapshot
export function subscribeTaskFiles(callback: () => void): () => void {
  fileSubscribers.add(callback)
  return () => { fileSubscribers.delete(callback) }
}
function publishFile(result = fileSnapshot.result): void {
  fileSnapshot = { pending: pendingFile && { token: pendingFile.token, sessionId: pendingFile.sessionId }, result }
  for (const callback of fileSubscribers) callback()
}
function recordFile(ctx: Context, taskId: string, path: string, outcome: TaskActionOutcome): TaskActionOutcome {
  lastFileOwner = ctx
  publishFile({ taskId, path, outcome })
  return outcome
}
function releaseFile(request: PendingFile): void {
  if (request.timeout !== undefined) window.clearTimeout(request.timeout)
  request.unsubscribe?.()
}
function finishFile(request: PendingFile, outcome: TaskActionOutcome): TaskActionOutcome {
  if (pendingFile !== request) return outcome
  pendingFile = undefined
  releaseFile(request)
  return recordFile(request.ctx, request.taskId, request.path, outcome)
}
function cancelFile(message: string): void {
  if (pendingFile) finishFile(pendingFile, { ok: false, message })
}
function retainFileLifetime(ctx: Context): void {
  if (fileLifetimes.has(ctx)) return
  if (typeof ctx?.effect !== 'function') throw new Error('这个界面无法管理文件打开交接，请按记录路径打开。')
  ctx.effect(() => () => {
    if (pendingFile?.ctx === ctx) cancelFile('插件已释放，文件打开交接已取消。')
    if (lastFileOwner === ctx) {
      lastFileOwner = undefined
      fileSnapshot = {}
      for (const callback of fileSubscribers) callback()
    }
    fileLifetimes.delete(ctx)
  }, 'dsh-butler: file handoff')
  fileLifetimes.add(ctx)
}

/** Claim before opening: native callbacks or repeated renders cannot consume a request twice. */
function consumeTaskFile(ctx: Context, token: number | undefined): void {
  const request = pendingFile
  if (!request || request.ctx !== ctx || request.token !== token) return
  try {
    if (request.sidebar.mounted?.getSnapshot() !== request.sessionId) return
    pendingFile = undefined
    releaseFile(request)
    request.sidebar.openResource!(request.address)
    recordFile(ctx, request.taskId, request.path, { ok: true, message: '已请求用 DSH 打开文件。' })
  } catch (error) {
    if (pendingFile === request) { pendingFile = undefined; releaseFile(request) }
    recordFile(ctx, request.taskId, request.path, { ok: false, message: `DSH 文件打开失败：${errorText(error)}；记录路径保留。` })
  }
}

/** The source header's effect runs after the native framework has created its Session store. */
export function useTaskFileHandoff(ctx: Context): TaskFileResult | undefined {
  const snapshot = useSyncExternalStore(subscribeTaskFiles, taskFileSnapshot)
  useEffect(() => { consumeTaskFile(ctx, snapshot.pending?.token) }, [ctx, snapshot])
  return lastFileOwner === ctx ? snapshot.result : undefined
}

export function openTaskFile(ctx: Context, taskId: string, sessionId: unknown, path: unknown): TaskActionOutcome {
  cancelFile('新的文件打开请求已替换上一项，上一项已取消。')
  const recordedPath = typeof path === 'string' ? path : ''
  const fail = (message: string): TaskActionOutcome => recordFile(ctx, taskId, recordedPath, { ok: false, message })
  if (!validId(taskId)) return fail('任务 ID 无效，无法打开文件；记录路径保留。')
  if (!validId(sessionId)) return fail('任务没有有效的来源会话 ID，无法用 DSH 打开文件；记录路径保留。')
  const normalized = absoluteFilePath(path)
  if (normalized === undefined) return fail('文件路径必须是没有控制字符的本地绝对路径；记录路径保留。')
  try {
    const sidebar = clientService<SidebarFileFace>(ctx, 'sidebarRight')
    if (typeof sidebar?.openResource !== 'function') return fail('这个界面没有文件打开能力（sidebarRight.openResource 不存在）；记录路径保留。')
    const mounted = sidebar.mounted
    if (typeof mounted?.getSnapshot !== 'function' || typeof mounted.subscribe !== 'function') return fail('原生文件面的挂载状态不可读；记录路径保留。')
    let observed = mounted.getSnapshot(), sawSource = observed === sessionId
    const workspace = observed === sessionId ? undefined : clientService<{ openSession?(id: string): void }>(ctx, 'uiWorkspace')
    if (!sawSource && typeof workspace?.openSession !== 'function') return fail('这个界面没有会话导航能力（uiWorkspace.openSession 不存在）；记录路径保留。')
    retainFileLifetime(ctx)
    const request: PendingFile = { token: ++fileGeneration, ctx, taskId, sessionId, path: recordedPath, sidebar,
      address: `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized.split('/').map(encodeSegment).join('/')}` }
    pendingFile = request
    if (sawSource) { consumeTaskFile(ctx, request.token); return fileSnapshot.result!.outcome }
    const waiting = recordFile(ctx, taskId, recordedPath, { ok: true, message: '已请求打开来源会话，等待原生文件面挂载。' })
    const unsubscribe = mounted.subscribe(() => {
      if (pendingFile !== request) return
      try {
        const current = mounted.getSnapshot()
        if (current === observed) return
        observed = current
        if ((current !== undefined && current !== sessionId) || (sawSource && current === undefined)) {
          finishFile(request, { ok: false, message: '来源会话已离开或已改选其他会话，文件打开交接已取消；记录路径保留。' })
          return
        }
        if (current === sessionId) sawSource = true
        // mounted changes before React creates the native store. Only notify; the header effect consumes it.
        publishFile()
      } catch (error) { finishFile(request, { ok: false, message: `文件面挂载状态不可读：${errorText(error)}；记录路径保留。` }) }
    })
    if (pendingFile !== request) { unsubscribe(); return fileSnapshot.result!.outcome }
    request.unsubscribe = unsubscribe
    request.timeout = window.setTimeout(() => {
      finishFile(request, { ok: false, message: '等待来源会话文件面挂载超时，文件打开交接已取消；记录路径保留。' })
    }, 15000)
    workspace!.openSession!(sessionId)
    return waiting
  } catch (error) {
    if (pendingFile?.ctx === ctx && pendingFile.taskId === taskId) return finishFile(pendingFile, { ok: false, message: `DSH 文件打开失败：${errorText(error)}；记录路径保留。` })
    return fail(`DSH 文件打开失败：${errorText(error)}；记录路径保留。`)
  }
}

/** Called only by the owner's copy button; the readonly command always remains available. */
export async function copyTaskContinuation(taskId: unknown): Promise<TaskActionOutcome> {
  const command = continuationCommand(taskId)
  if (command === undefined) return { ok: false, message: '任务 ID 无效，无法生成接续指令。' }
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (typeof clipboard?.writeText !== 'function') return { ok: false, message: `剪贴板不可用，请手动复制：${command}` }
    await clipboard.writeText(command)
    return { ok: true, message: '已复制接续指令；在对话中手动发送后才会接续任务。' }
  } catch (error) {
    return { ok: false, message: `复制失败：${errorText(error)}；请手动复制：${command}` }
  }
}

export function openTaskSourceConversation(ctx: Context, sessionId: unknown): TaskActionOutcome {
  if (!validId(sessionId)) return { ok: false, message: '任务没有有效的来源会话 ID，无法打开来源会话。' }
  try {
    const workspace = clientService<{ openSession?(id: string): void }>(ctx, 'uiWorkspace')
    if (typeof workspace?.openSession !== 'function') return { ok: false, message: '这个界面没有会话导航能力（uiWorkspace.openSession 不存在）。' }
    workspace.openSession(sessionId)
    return { ok: true, message: '已请求打开来源会话；需要接续时请手动发送接续指令。' }
  } catch (error) {
    return { ok: false, message: `来源会话打开失败：${errorText(error)}` }
  }
}

/** This always asks the existing fresh-readiness navigation path; it never sends a task command. */
export async function continueTaskWithButler(ctx: Context): Promise<TaskActionOutcome> {
  try {
    const outcome = await openButlerConversation(ctx)
    return outcome.ok ? { ok: true, message: '已请求打开管家会话；请手动发送接续指令。' }
      : { ok: false, message: outcome.reason ?? '管家会话打开失败。' }
  } catch (error) {
    return { ok: false, message: `管家会话打开失败：${errorText(error)}` }
  }
}
