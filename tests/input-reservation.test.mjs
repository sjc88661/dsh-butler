import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskBudgets, NORMAL_BUDGET, REMINDER_BUDGET } from '../src/host/budget.ts'
import { reserveInput } from '../src/host/runtime-controls.ts'
const context = { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1_000_000 }
const request = (size = 3_200_000) => ({ provider: context.provider, model: context.model, maxTokens: 8192,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(size) }] }], tools: [] })

test('native context capacity bounds a long request reservation without changing hard limits', () => {
  const q = request(), before = JSON.stringify(q), estimate = reserveInput(q, context)
  assert.ok(estimate <= context.contextWindow - q.maxTokens)
  const b = new TaskBudgets(); b.begin('long-history', { humanMessageId: 'fresh-authorized-task' })
  assert.doesNotThrow(() => b.admit('long-history', estimate, q.maxTokens))
  assert.equal(b.status('long-history').reservedTokens, 1_000_000)
  assert.equal(NORMAL_BUDGET.maxTokens, 2_000_000); assert.equal(REMINDER_BUDGET.maxTokens, 64_000)
  assert.equal(JSON.stringify(q), before)
})

test('missing, mismatched or invalid native context never lowers the original conservative bound', () => {
  const q = request(), old = reserveInput(q)
  for (const hint of [undefined, {}, { ...context, provider: 'other' }, { ...context, model: 'other' },
    { ...context, contextWindow: 0 }, { ...context, contextWindow: NaN }, { ...context, contextWindow: 8192 }]) {
    assert.equal(reserveInput(q, hint), old)
  }
})

test('small text requests retain the conservative UTF-8 bound and cached history still consumes budget', () => {
  const q = request(30)
  assert.equal(reserveInput(q, context), reserveInput(q))
  const b = new TaskBudgets({ normal: { maxTokens: 100 } }); b.begin('s', {})
  const lease = b.admit('s', 70, 10); b.finish(lease, 80)
  assert.throws(() => b.admit('s', 20, 1, { requireFullOutput: true }), /token/)
  assert.equal(b.status('s').requests, 1); assert.equal(b.status('s').tokens, 80)
})

test('strict dispatch rejects insufficient output room before allocating a request or reservation', () => {
  const b = new TaskBudgets({ normal: { maxTokens: 100 } }); b.begin('s', {})
  assert.throws(() => b.admit('s', 95, 10, { requireFullOutput: true }), /输入上界=95.*输出额度=10.*可用=100/)
  assert.equal(b.status('s').requests, 0); assert.equal(b.status('s').tokens, 0); assert.equal(b.status('s').reservedTokens, 0)
  assert.ok(b.status('s').blocked)
  assert.throws(() => b.admit('s', 1, 1), /token/)
  b.begin('s', { humanMessageId: 'explicit-new-task' })
  assert.doesNotThrow(() => b.admit('s', 1, 1, { requireFullOutput: true }))
})

test('unknown media uses the native capacity ceiling rather than tiny image descriptors', () => {
  const q = { ...request(10), messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'native-image' } }] }] }
  assert.equal(reserveInput(q, context), context.contextWindow - q.maxTokens)
})

test('DeepSeek local message provenance is not a billable skill catalog', () => {
  const clean = request(300), before = JSON.stringify(clean)
  const catalog = { ...clean, messages: [{ ...clean.messages[0], id: 'native-local-id', source: {
    kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'native-skill', description: 'metadata '.repeat(20000) }],
  } }] }
  assert.equal(reserveInput(catalog, context), reserveInput(clean, context))
  assert.equal(JSON.stringify(clean), before)
  assert.equal(catalog.messages[0].source.entries[0].name, 'native-skill', 'Native discovery authority is retained')
})

test('the verified account adapter excludes local catalog metadata and retains assistant replay', () => {
  const route = { ...context, provider: 'deepseek-account' }
  const clean = { ...request(300), provider: route.provider }
  const catalog = { ...clean, messages: [{ ...clean.messages[0], id: 'local', source: {
    kind: 'skill-catalog', entries: [{ name: 'native', description: 'metadata '.repeat(20000) }],
  } }] }
  assert.equal(reserveInput(catalog, route), reserveInput(clean, route))
  const replay = { ...clean, messages: [{ role: 'assistant', source: { kind: 'model', replayState: { signature: 's'.repeat(60000) } },
    content: [{ type: 'reasoning', text: 'native' }] }] }
  assert.ok(reserveInput(replay, route) > 60000)
  assert.ok(reserveInput(catalog, { ...route, model: 'unverified' }) > 100000)
})

test('visible source text, full tool inputs, native replay and unknown fields stay in the bound', () => {
  const q = { ...request(10), messages: [{ role: 'assistant', source: { kind: 'local' }, id: 'local',
    replay: { signature: 'signed '.repeat(1000) }, unknownPayload: 'keep '.repeat(2000),
    content: [{ type: 'tool-call', id: 'wire-call-id', name: 'write', arguments: '{"text":"source: keep this"}' }] },
    { role: 'tool', toolCallId: 'wire-call-id', isError: true, content: [{ type: 'text', text: 'source entries remain visible when included in content' }] }] }
  const expected = { ...q, messages: q.messages.map(({ id, source, ...message }) => message.role === 'assistant' && source !== undefined ? { ...message, source } : message) }
  const raw = value => Buffer.byteLength(JSON.stringify({ messages: value.messages, tools: value.tools, system: '', toolHistory: [] })) + 1024
  assert.equal(reserveInput(q, context), raw(expected))
  assert.ok(reserveInput(q, context) > 17000)
})

test('non-DeepSeek and unverified native routes retain complete metadata reservations', () => {
  const q = { ...request(30), messages: [{ ...request(30).messages[0], source: { kind: 'metadata', text: 'x'.repeat(10000) } }] }
  assert.equal(reserveInput(q), reserveInput(q, { ...context, model: 'other' }))
  const other = { ...q, provider: 'other' }
  assert.equal(reserveInput(other, { ...context, provider: 'other' }), reserveInput(other))
  assert.ok(reserveInput(other) > 10000)
})

test('assistant source replay signatures remain in the conservative input bound', () => {
  const q = { ...request(30), messages: [{ role: 'assistant', id: 'local', source: { kind: 'model', provider: context.provider, model: context.model,
    replayState: { response: { kind: 'deepseek-messages', version: 1, model: context.model }, blocks: [{ type: 'reasoning', signature: 's'.repeat(60000) }] } },
    content: [{ type: 'reasoning', text: 'native replay' }] }] }
  assert.ok(reserveInput(q, context) > 60000)
  const withoutLocalId = { ...q, messages: q.messages.map(({ id, ...message }) => message) }
  assert.equal(reserveInput(q, context), reserveInput(withoutLocalId, context))
})
