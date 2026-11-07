/**
 * 飞书（Lark）文本消息发送器 —— 只用于把管家自己的提醒推给主人。
 *
 * 为什么不复用已安装的 lark-channel 插件：0.0.7 没有实现管家的
 * `butlerReminderDelivery` 接口，也拿不到它的发送句柄；这里用应用凭据直连
 * 飞书开放接口，范围只有"给配置里的 owner open_id 发一条文本"。
 *
 * 安全约定：
 * - appSecret 只出现在请求体里，错误信息与日志永远不带它；
 * - 只发文本，不读通讯录、不群发、不回复他人；
 * - 失败如实返回（HTTP/飞书 code + msg），不把发送失败说成成功。
 *
 * @module @dsh-external/dsh-butler/host/feishu
 */

/** Sending identity configured by the owner. */
export interface FeishuConfig {
  appId: string
  appSecret: string
  /** Receive open_id of the owner (self-notification only). */
  ownerOpenId: string
  /** API origin; default is the public Feishu endpoint. */
  baseUrl?: string
}

/** One send outcome. */
export interface FeishuSendResult {
  ok: boolean
  messageId?: string
  error?: string
  /** Feishu business code when the API answered with a refusal. */
  code?: number
}

/** What the sender exposes to the host/status surface. */
export interface FeishuSenderStatus {
  configured: boolean
  sent: number
  lastError?: string
  lastSentAt?: string
}

/** The sender handle. */
export interface FeishuSender {
  sendText(text: string): Promise<FeishuSendResult>
  status(): FeishuSenderStatus
}

/** Test seam for the HTTP layer. */
export type FeishuFetch = typeof fetch

const DEFAULT_BASE = 'https://open.feishu.cn'
const TOKEN_TIMEOUT_MS = 15_000
const SEND_TIMEOUT_MS = 15_000

/** Format one due reminder as the text a phone shows. */
export function formatDueReminderText(record: { title?: string; scheduledAt?: string }, now = new Date()): string {
  const title = typeof record.title === 'string' && record.title.trim() !== '' ? record.title.trim() : '（未命名提醒）'
  if (record.scheduledAt === undefined) return `【管家提醒】${title}`
  const planned = new Date(record.scheduledAt)
  if (!Number.isFinite(planned.getTime())) return `【管家提醒】${title}`
  const minutesLate = Math.floor((now.getTime() - planned.getTime()) / 60000)
  const late = minutesLate >= 60 ? `已过 ${Math.floor(minutesLate / 60)} 小时 ${minutesLate % 60} 分`
    : minutesLate >= 1 ? `已过 ${minutesLate} 分钟` : '刚刚到期'
  return `【管家提醒】${title}\n计划：${record.scheduledAt}（${late}）`
}

/** POST one JSON body with a hard timeout, returning the parsed object. */
async function postJson(fetchImpl: FeishuFetch, url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; payload: Record<string, unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetchImpl(url, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let payload: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
    } catch { /* a non-JSON body is reported by HTTP status alone */ }
    return { status: response.status, payload }
  } catch (error) {
    throw new Error(`连接飞书失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a Feishu sender that caches the tenant token until shortly before expiry.
 * @param config - app credentials and the owner open_id.
 * @param fetchImpl - optional HTTP seam for tests.
 * @returns the sender handle.
 */
export function createFeishuSender(config: FeishuConfig, fetchImpl: FeishuFetch = fetch): FeishuSender {
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
  let token: { value: string; expiresAt: number } | undefined
  let status: FeishuSenderStatus = { configured: true, sent: 0 }

  async function tenantToken(): Promise<string> {
    if (token !== undefined && token.expiresAt > Date.now()) return token.value
    const { status: httpStatus, payload } = await postJson(fetchImpl, `${base}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: config.appId, app_secret: config.appSecret })
    if (httpStatus !== 200) throw new Error(`获取飞书 token 失败：HTTP ${httpStatus}`)
    const value = typeof payload['tenant_access_token'] === 'string' ? payload['tenant_access_token'] : ''
    const expire = typeof payload['expire'] === 'number' ? payload['expire'] : 0
    if (typeof payload['code'] === 'number' && payload['code'] !== 0) {
      throw new Error(`获取飞书 token 被拒绝：code ${payload['code']} ${typeof payload['msg'] === 'string' ? payload['msg'] : ''}`.trim())
    }
    if (value === '') throw new Error('飞书没有返回 tenant_access_token')
    token = { value, expiresAt: Date.now() + Math.max(30, expire - 60) * 1000 }
    return value
  }

  return {
    async sendText(text: string): Promise<FeishuSendResult> {
      try {
        const access = await tenantToken()
        const { status: httpStatus, payload } = await postJson(fetchImpl, `${base}/open-apis/im/v1/messages?receive_id_type=open_id`,
          { receive_id: config.ownerOpenId, msg_type: 'text', content: JSON.stringify({ text }) },
          { authorization: `Bearer ${access}` })
        const code = typeof payload['code'] === 'number' ? payload['code'] : undefined
        if (httpStatus !== 200 || (code !== undefined && code !== 0)) {
          const message = `发送提醒失败：HTTP ${httpStatus}${code === undefined ? '' : ` / code ${code}`}${typeof payload['msg'] === 'string' && payload['msg'] !== '' ? ` ${payload['msg']}` : ''}`
          status = { ...status, lastError: message }
          return { ok: false, error: message, ...(code === undefined ? {} : { code }) }
        }
        const data = payload['data'] !== null && typeof payload['data'] === 'object' ? payload['data'] as Record<string, unknown> : {}
        const messageId = typeof data['message_id'] === 'string' ? data['message_id'] : undefined
        status = { configured: true, sent: status.sent + 1, lastSentAt: new Date().toISOString() }
        return { ok: true, ...(messageId === undefined ? {} : { messageId }) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        status = { ...status, lastError: message }
        return { ok: false, error: message }
      }
    },
    status(): FeishuSenderStatus {
      return { ...status }
    },
  }
}
