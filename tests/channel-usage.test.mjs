import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'channel-usage-'))
process.env.DSH_BUTLER_HOME = home
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { ensureVault } = await import('../src/host/vault.ts')
const { addUsage, usageRecords } = await import('../src/host/ledger.ts')
ensureVault()

test('late usage backfill cannot overwrite trusted channel owner and source with recovered metadata', () => {
  const channelOrigin = { provider: 'lark', accountId: 'app', senderId: 'ou-owner', chatId: 'oc-private', ownerId: 'me', messageId: 'om-real', nativeMessageId: 'native-user', sessionId: 'lark-test' }
  const call = { sessionId: 'lark-test', turn: 1, step: 1, eventSeq: 7, at: '2026-10-21T00:00:00.000Z' }
  addUsage({ ...call, taskId: 'task-test', runId: 'run-test', ownerId: 'me', channelOrigin, origin: 'live', usageState: 'unknown' })
  addUsage({ ...call, origin: 'backfill', usageState: 'reported', totalTokens: 3, inputTokens: 2, outputTokens: 1,
    ownerId: 'recovered-other', channelOrigin: { ...channelOrigin, ownerId: 'recovered-other', messageId: 'om-wrong' } })
  const rows = usageRecords()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ownerId, 'me')
  assert.deepEqual(rows[0].channelOrigin, channelOrigin)
  assert.equal(rows[0].totalTokens, 3)
  assert.equal(rows[0].taskId, 'task-test')
})
