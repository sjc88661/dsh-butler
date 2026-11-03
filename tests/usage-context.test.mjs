import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'usage-context-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const { installUsageRecorder } = await import('../src/host/usage.ts')
const { usageRecords } = await import('../src/host/ledger.ts')

test('usage keeps the exact request task snapshot instead of guessing the active task', () => {
  let listener
  const identity = { sessionId: 'usage-context-A', rootSessionId: 'usage-context-A', runId: 'run-A', taskId: 'business-A', originMessageId: 'human-A', turn: 1, step: 2 }
  const recorder = installUsageRecorder({ on(_name, fn) { listener = fn; return () => {} } }, {
    context: (id, turn, step) => id === identity.sessionId && turn === 1 && step === 2 ? identity : undefined,
  })
  listener({ id: identity.sessionId }, { type: 'assistant/message', data: { turn: 1, step: 2, usage: { inputTokens: 3, outputTokens: 1 }, message: {} } })
  listener({ id: 'usage-context-B' }, { type: 'assistant/message', data: { turn: 1, step: 2, usage: { inputTokens: 2, outputTokens: 1 }, message: {} } })
  const rows = usageRecords()
  assert.equal(rows[0].taskId, 'business-A')
  assert.equal(rows[0].runId, 'run-A')
  assert.equal(rows[0].originMessageId, 'human-A')
  assert.equal(rows[1].taskId, undefined)
  recorder.stop()
})
