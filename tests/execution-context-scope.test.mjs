import test from 'node:test'
import assert from 'node:assert/strict'
import { installExecutionContext } from '../src/host/execution-context.ts'

for (const id of ['external', 'external-child']) test(`execution hooks leave ${id} native, including failures`, async () => {
  const hooks = new Map(), receipts = []
  const agents = [{ id: 'butler' }, { id: 'butler-child' }, { id: 'external' }, { id: 'external-child' }]
  const contexts = installExecutionContext({ get: () => ({ list: () => agents }), on(name, fn) { hooks.set(name, fn); return () => {} } }, {
    appliesTo: agent => agent.id.startsWith('butler'), onReceipt: row => receipts.push(row), runFor: () => 'run',
  })
  const agent = agents.find(row => row.id === id), message = { id: 'input', source: { kind: 'user' } }
  hooks.get('agent/created')({ agent })
  hooks.get('agent/inbox/claimed')({ agent, message })
  hooks.get('session/event')({ id }, { type: 'user/message', data: message })
  hooks.get('session/event')({ id: 'missing' }, { type: 'user/message', data: message })
  const expected = { kind: 'continue' }, exec = { agent, callId: 'call', name: 'native' }
  assert.equal(await hooks.get('agent/pre-step')({ agent, messages: [message] }, () => expected), expected)
  assert.equal(await hooks.get('agent/request')({ agent, turn: 1, step: 1 }, () => expected), expected)
  assert.equal(hooks.get('tools/pre-execute')(exec, () => expected), expected)
  hooks.get('tools/result')(exec, { isError: true })
  await assert.rejects(async () => hooks.get('tools/pre-execute')(exec, () => { throw Error('native failure') }), /native failure/)
  assert.deepEqual(contexts.status(), { active: true, sessions: 0, callPositions: 0, executions: 0 })
  assert.deepEqual(receipts, [])
  for (const managed of agents.filter(row => row.id.startsWith('butler'))) {
    hooks.get('agent/inbox/claimed')({ agent: managed, message })
    hooks.get('agent/request')({ agent: managed, turn: 1, step: 1 }, () => expected)
    hooks.get('tools/result')({ agent: managed, callId: 'managed', name: 'native' }, { isError: true })
  }
  assert.equal(receipts.length, 2)
  assert.ok(receipts.every(row => row.ok === false))
})
