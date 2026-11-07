/**
 * 飞书密钥的凭据层适配。
 *
 * DSH 0.2.2 提供 `credentials` 服务：`resolve(ref)` 读 provider 管理的值（并可回退
 * 环境变量），`set/unset` 写入 provider 管理的来源。管家把飞书 appSecret 从
 * profile 的 Cordis patch 迁到这里：
 *
 * - 配置里 `feishuAppSecret` 非空时仍可用（迁移前的兼容路径）；
 * - 否则读 credentials 的 {@link FEISHU_SECRET_REF}；
 * - 两处都没有 → 未配置，页面明确显示来源，不把空值当成已配置。
 *
 * 注意：这里只处理"应用密钥"这一个 ref；不列出、不读取其他凭据。
 *
 * @module @dsh-external/dsh-butler/host/feishu-credentials
 */

/** The environment-variable-style reference used for the Feishu app secret. */
export const FEISHU_SECRET_REF = 'DSH_BUTLER_FEISHU_APP_SECRET'

/** The slice of DSH's `credentials` service this module uses. */
export interface CredentialsLike {
  resolve(ref: unknown): Promise<{ value: string; source: string } | undefined>
  set(ref: unknown, value: string): Promise<void>
  unset(ref: unknown): Promise<void>
  describe?(ref: unknown): Promise<{ configured: boolean; source?: string; writable: boolean }>
}

/** Where the effective secret came from. */
export type FeishuSecretSource = 'config' | 'credentials' | 'none'

/** Result of resolving the app secret. */
export interface FeishuSecretResolution {
  source: FeishuSecretSource
  /** Never log or persist this value outside the sender. */
  secret?: string
}

/**
 * Resolve the Feishu app secret: explicit config first, then the credential store.
 * @param configSecret - `config.feishuAppSecret` (may be empty).
 * @param credentials - the DSH credentials service, when available.
 * @returns the effective source and secret.
 */
export async function resolveFeishuSecret(configSecret: string | undefined, credentials: CredentialsLike | undefined): Promise<FeishuSecretResolution> {
  if (typeof configSecret === 'string' && configSecret.trim() !== '') return { source: 'config', secret: configSecret.trim() }
  if (credentials === undefined) return { source: 'none' }
  try {
    const resolved = await credentials.resolve(FEISHU_SECRET_REF)
    if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.trim() !== '') {
      return { source: 'credentials', secret: resolved.value.trim() }
    }
  } catch { /* an unavailable credential store means "not configured", never a crash */ }
  return { source: 'none' }
}

/**
 * Store the app secret in the provider-managed credential source.
 * @param credentials - the DSH credentials service.
 * @param secret - non-empty app secret.
 * @throws when the service is unavailable or refuses the write.
 */
export async function storeFeishuSecret(credentials: CredentialsLike | undefined, secret: string): Promise<void> {
  if (credentials === undefined) throw new Error('宿主未提供 credentials 服务，无法保存密钥')
  const value = secret.trim()
  if (value === '') throw new Error('密钥不能为空')
  await credentials.set(FEISHU_SECRET_REF, value)
}

/** Remove the stored app secret; ambient fallbacks may become effective again. */
export async function clearFeishuSecret(credentials: CredentialsLike | undefined): Promise<void> {
  if (credentials === undefined) throw new Error('宿主未提供 credentials 服务，无法删除密钥')
  await credentials.unset(FEISHU_SECRET_REF)
}

/** Describe the credential without exposing its value, for the settings page. */
export async function describeFeishuSecret(credentials: CredentialsLike | undefined): Promise<{ configured: boolean; source?: string; writable: boolean }> {
  if (credentials?.describe === undefined) return { configured: false, writable: false }
  try {
    const info = await credentials.describe(FEISHU_SECRET_REF)
    return { configured: info.configured, writable: info.writable, ...(info.source === undefined ? {} : { source: info.source }) }
  } catch {
    return { configured: false, writable: false }
  }
}
