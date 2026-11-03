import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'execution-retention-'))
process.env.DSH_BUTLER_HOME = join(home, 'state')
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_CONTEXT_MAX_SESSIONS = '5'
process.env.DSH_BUTLER_CONTEXT_MAX_STEPS = '3'
process.env.DSH_BUTLER_CONTEXT_MAX_CALLS = '3'
process.env.DSH_BUTLER_CONTEXT_MAX_USERS = '2'
process.env.DSH_BUTLER_CONTEXT_MAX_USER_TEXT = '40'
const { ExecutionContexts } = await import('../src/host/execution-context.ts')
const { ensureVault } = await import('../src/host/vault.ts')
ensureVault()

const human = id => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(200) }] })

test('execution context keeps only bounded recent provenance and truncated user text', () => {
  const file = join(process.env.DSH_BUTLER_HOME, 'contexts.json')
  const contexts = new ExecutionContexts({ file })
  for (let i = 0; i < 6; i++) contexts.bindUser('owner', human('message-' + i))
  for (let i = 0; i < 8; i++) contexts.capture({ callId: 'call-' + i, name: 'read' })
  for (let i = 0; i < 8; i++) contexts.captureRequest({ id: 'owner' }, 1, i)
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const users = Object.values(data.users)
  assert.equal(users.length, 2, 'users are capped')
  // The newest origin is retained; older origins are pruned by insertion order.
  assert.ok(data.users[JSON.stringify(['owner', 'message-5'])], 'newest origin remains readable')
  assert.equal(data.users[JSON.stringify(['owner', 'message-5'])].text.length, 40, 'user text is bounded')
  assert.equal(Object.keys(data.calls).length, 3, 'calls are capped')
  assert.equal(Object.keys(data.steps).length, 3, 'steps are capped')
  assert.equal(new ExecutionContexts({ file }).originUser({ sessionId: 'owner', originMessageId: 'message-5' })?.text.length, 40)
})
