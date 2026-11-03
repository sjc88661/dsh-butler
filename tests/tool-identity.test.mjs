import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '../src/host/tool-spec.ts'

function tool(name, parameters, execute = async () => ({ ok: true })) {
  return defineTool({ name, description: name, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute })
}

test('the recorded literature mistake identifies the failing tool and call', async () => {
  const literature = tool('butler_literature', { action: { type: 'string', required: true, enum: ['search', 'verify'] } })
  await assert.rejects(literature.execute({ operation: 'search' }, { id: 'call-lit-316' }), error => {
    assert.match(error.message, /butler_literature/)
    assert.match(error.message, /call-lit-316/)
    assert.match(error.message, /args\.action: required/)
    assert.equal(error.toolName, 'butler_literature')
    assert.equal(error.callId, 'call-lit-316')
    return true
  })
})

test('overview with empty arguments still succeeds', async () => {
  assert.deepEqual(await tool('butler_overview', {}).execute({}, { id: 'call-overview-314' }), { ok: true })
})

test('tool errors remain attributable when no execution ID is available', async () => {
  await assert.rejects(tool('butler_literature', { action: { type: 'string', required: true } }).execute({}, undefined), error => {
    assert.equal(error.toolName, 'butler_literature')
    assert.match(error.message, /butler_literature/)
    assert.equal(error.callId, undefined)
    return true
  })
})

test('invalid arguments never reach a handler', async () => {
  let entered = false
  const literature = tool('butler_literature', { action: { type: 'string', required: true } }, async () => { entered = true })
  await assert.rejects(literature.execute({}, { callId: 'alternate-call-id' }))
  assert.equal(entered, false)
})
