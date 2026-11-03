import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'usage-cost-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const ledger = await import('../src/host/ledger.ts')
const { priceUsage } = await import('../src/host/usage.ts')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
ensureVault()
const at = '2026-10-22T03:00:00.000Z'

test('provider/model cost review leaves account tokens unpriced and preserves historical estimates without writing the ledger', () => {
  const account = { provider: 'deepseek-account', model: 'deepseek-flash' }
  const official = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const rows = [
    { ...account, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, totalTokens: 15 },
    { ...account, usageState: 'unknown' },
    { ...account, inputTokens: 3, outputTokens: 1, totalTokens: 4, cost: 0.5, costBasis: 'historical-account-policy' },
    { ...official, inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    { provider: 'deepseek-official', model: 'future-model', inputTokens: 7, outputTokens: 2, totalTokens: 9 },
    { ...official, totalTokens: 7 },
  ].map((row, index) => ({ ...row, at, sessionId: 'cost-theme', eventSeq: index + 1 }))
  const path = vaultPath('ledger', 'usage.jsonl')
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const before = readFileSync(path)

  assert.deepEqual(priceUsage({ ...account, inputTokens: 10, outputTokens: 2 }, Date.parse(at)), {})
  const totals = ledger.sessionUsageTotals('cost-theme')
  assert.equal(totals.calls, 6); assert.equal(totals.totalTokens, 160)
  assert.equal(totals.pricedCalls, 2); assert.equal(totals.unpricedCalls, 3); assert.equal(totals.withoutUsage, 1)
  assert.ok(Array.isArray(totals.byProviderModel), 'cost review needs provider/model coverage and missing-price reasons')
  const accountGroup = totals.byProviderModel.find(row => row.provider === account.provider && row.model === account.model)
  assert.ok(accountGroup)
  assert.equal(accountGroup.calls, 3); assert.equal(accountGroup.totalTokens, 19)
  assert.equal(accountGroup.inputTokens, 13); assert.equal(accountGroup.outputTokens, 3); assert.equal(accountGroup.cacheReadTokens, 3)
  assert.equal(accountGroup.pricedCalls, 1); assert.equal(accountGroup.unpricedCalls, 1); assert.equal(accountGroup.withoutUsage, 1)
  assert.equal(accountGroup.cost, 0.5)
  assert.deepEqual(accountGroup.costBases, ['historical-account-policy'])
  assert.deepEqual(accountGroup.unknownCostReasons, { 'provider-no-price': 1, 'missing-usage': 1 })
  const officialGroup = totals.byProviderModel.find(row => row.provider === official.provider && row.model === official.model)
  assert.equal(officialGroup.totalTokens, 132); assert.equal(officialGroup.pricedCalls, 1); assert.equal(officialGroup.unpricedCalls, 1)
  assert.ok(officialGroup.cost > 0); assert.deepEqual(officialGroup.unknownCostReasons, { 'incomplete-usage': 1 })
  assert.match(officialGroup.costBases[0], /^official-2026-09-10\/flash\//)
  assert.deepEqual(totals.byProviderModel.find(row => row.model === 'future-model').unknownCostReasons, { 'model-no-price': 1 })
  assert.equal(totals.byProviderModel.reduce((sum, row) => sum + row.cost, 0), totals.cost)
  assert.equal(ledger.usageRecords()[2].cost, 0.5)
  assert.equal(ledger.usageRecords()[2].costBasis, 'historical-account-policy')
  assert.equal(ledger.usageRecords()[0].cost, undefined)
  ledger.usageTotals()
  assert.deepEqual(readFileSync(path), before, 'cost review must leave every historical ledger byte unchanged')
})
