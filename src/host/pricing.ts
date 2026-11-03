/**
 * The published price book, and the clock that decides which column applies.
 *
 * Why this file exists: DSH tells you exactly how many tokens a call used, and
 * tells you nothing about what they cost - the runtime has no price field
 * anywhere (searched the whole bundled runtime for `inputPrice` / `costUsd` /
 * `pricePerMillion`: no hits). So the only honest way to answer "what did this
 * cost" is to take the number from the event (real) and the price from the
 * provider's published table (also real, but a *different kind* of fact).
 *
 * Every number this module produces is therefore an ESTIMATE, and it is labelled
 * as one, together with the table it came from and the day that table took
 * effect: an estimate with a provenance is useful; a bare number that looks like
 * a bill is not.
 *
 * The table below is transcribed from DeepSeek's published pricing policy and
 * cross-checked against an independent local implementation
 * (`@linxin666/dsh-usage` v0.4.4, `src/core/pricing.ts`, which cites the same
 * page and the same effective date).
 *
 * @module @dsh-external/dsh-butler/host/pricing
 */

/** Where the numbers come from, quoted verbatim for the panel and the notes. */
export const PRICE_SOURCE =
  'DeepSeek 官方定价页 api-docs.deepseek.com（政策生效 2026-09-10 12:00 北京时间：高峰=北京时周一至周五 09:00-12:00 与 14:00-18:00，其余时段按高峰价五折）'

/** When the published policy took effect, epoch ms (2026-09-10 12:00 Beijing = 04:00Z). */
export const PRICE_EFFECTIVE_AT_MS = Date.UTC(2026, 8, 10, 4, 0)

/** `deepseek-v4-pro` was folded into the flash price row at this instant. */
export const PRO_FOLDED_INTO_FLASH_AT_MS = Date.UTC(2026, 8, 14, 4, 0)

/** Which column of the table applies. */
export type PricePeriod = 'peak' | 'offPeak'

/**
 * The one provider this table prices.
 *
 * Guarded on purpose: a call routed to any other provider has tokens but no
 * price here, and pricing it with DeepSeek's numbers would be a fabrication.
 * Such a call is recorded with its real tokens and left unpriced.
 */
export const PRICED_PROVIDER = 'deepseek-official'

/**
 * Whether this file's table applies to a call from that provider.
 * @param provider - provider name as reported by the event.
 * @returns true only for the official DeepSeek endpoint.
 */
export function isPriced(provider: string | undefined): boolean {
  return provider === PRICED_PROVIDER
}

/** Only model IDs explicitly represented by this stored policy may be priced. */
export function isPricedModel(model: string | undefined): boolean {
  return model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro'
}

/** Price row, CNY per million tokens. */
export interface PriceRow {
  /** Cached prompt tokens (hit). */
  cacheHit: Record<PricePeriod, number>
  /** Prompt tokens that missed the cache (and cache writes). */
  inputMiss: Record<PricePeriod, number>
  /** Completion tokens, reasoning included. */
  output: Record<PricePeriod, number>
}

/** Peak windows, in minutes after Beijing midnight, Monday to Friday. */
const PEAK_WINDOWS: Array<[number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** Beijing has no daylight saving, so a fixed offset is exact. */
const BEIJING_OFFSET_MS = 8 * 3_600_000

/** The published rows for the two model families the official endpoint serves. */
export const PRICE_TABLE: Record<'flash' | 'pro', PriceRow> = {
  flash: {
    cacheHit: { offPeak: 0.02, peak: 0.04 },
    inputMiss: { offPeak: 1.0, peak: 2.0 },
    output: { offPeak: 4.0, peak: 8.0 },
  },
  pro: {
    cacheHit: { offPeak: 0.15, peak: 0.3 },
    inputMiss: { offPeak: 4.5, peak: 9.0 },
    output: { offPeak: 13.5, peak: 27.0 },
  },
}

/**
 * Which pricing period an instant falls into.
 * @param atMs - instant, epoch ms.
 * @returns `peak` inside the weekday windows, `offPeak` everywhere else.
 */
export function periodAt(atMs: number): PricePeriod {
  const beijing = new Date(atMs + BEIJING_OFFSET_MS)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return 'offPeak'
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  for (const [from, to] of PEAK_WINDOWS) {
    if (minutes >= from && minutes < to) return 'peak'
  }
  return 'offPeak'
}

/**
 * Which row of the table a model is billed on.
 * The pro row only ever applied to `deepseek-v4-pro`, and only before the
 * provider folded that model into the flash row.
 * @param model - model id as reported by the provider.
 * @param atMs - instant of the call.
 * @returns the row name.
 */
export function priceRowName(model: string | undefined, atMs: number): 'flash' | 'pro' {
  if (model !== undefined && model.includes('v4-pro') && atMs < PRO_FOLDED_INTO_FLASH_AT_MS) return 'pro'
  return 'flash'
}

/** Token counts a spend estimate needs. */
export interface PricedTokens {
  /** Uncached prompt tokens, as the provider reports them. */
  inputTokens?: number
  /** Completion tokens, reasoning included. */
  outputTokens?: number
  /** Prompt tokens served from cache. */
  cacheReadTokens?: number
  /** Prompt tokens written to cache. */
  cacheWriteTokens?: number
}

/** The result of pricing one call or one bucket. */
export interface SpendEstimate {
  /** Estimated spend, in the currency named by {@link currency}. */
  cost: number
  /** Always `CNY` for the official endpoint. */
  currency: 'CNY'
  /** Which column applied (for a bucket, the column of its instant). */
  period: PricePeriod
  /** Which row applied. */
  row: 'flash' | 'pro'
  /** The table this number came from, for the receipt. */
  source: string
}

/**
 * Price one call (or one bucket) with the published table.
 *
 * Cache reads are billed at the cache-hit rate, uncached prompt tokens plus
 * cache writes at the miss rate, and completion tokens at the output rate -
 * the same shape the provider's page uses. The sum is rounded to six decimals
 * (a millionth of a yuan) so the ledger does not carry float noise.
 *
 * @param tokens - token counts; missing fields count as zero.
 * @param atMs - instant of the call (or of the bucket, for a roll-up).
 * @param model - model id, when the caller knows it.
 * @returns the estimate with its basis, or undefined when nothing was billed.
 */
export function estimateSpend(
  tokens: PricedTokens,
  atMs: number,
  model?: string,
): SpendEstimate | undefined {
  const cacheRead = tokens.cacheReadTokens ?? 0
  const missInput = (tokens.inputTokens ?? 0) + (tokens.cacheWriteTokens ?? 0)
  const output = tokens.outputTokens ?? 0
  if (cacheRead === 0 && missInput === 0 && output === 0) return undefined
  const row = priceRowName(model, atMs)
  const period = periodAt(atMs)
  const price = PRICE_TABLE[row]
  const cost =
    (cacheRead * price.cacheHit[period] + missInput * price.inputMiss[period] + output * price.output[period]) / 1_000_000
  return { cost: Math.round(cost * 1e6) / 1e6, currency: 'CNY', period, row, source: PRICE_SOURCE }
}

/**
 * One-line basis label stored on a ledger row, so a later reader can tell which
 * table and which column produced that number.
 * @param estimate - the estimate.
 * @returns e.g. `official-2026-09-10/flash/offPeak`.
 */
export function priceBasis(estimate: SpendEstimate): string {
  return `official-2026-09-10/${estimate.row}/${estimate.period}`
}

/**
 * The counterfactual: what the same tokens would have cost with no cache hits,
 * i.e. if every cached prompt token had been billed at the miss rate.
 * Used to show what the cache actually saved, not to bill anything.
 * @param tokens - token counts.
 * @param atMs - instant of the call.
 * @param model - model id, when known.
 * @returns estimated CNY, or undefined when nothing was billed.
 */
export function estimateSpendWithoutCache(tokens: PricedTokens, atMs: number, model?: string): number | undefined {
  const estimate = estimateSpend(
    {
      inputTokens: (tokens.inputTokens ?? 0) + (tokens.cacheReadTokens ?? 0),
      outputTokens: tokens.outputTokens ?? 0,
      cacheWriteTokens: tokens.cacheWriteTokens ?? 0,
    },
    atMs,
    model,
  )
  return estimate?.cost
}
