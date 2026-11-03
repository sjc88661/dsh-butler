import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
process.env.DSH_BUTLER_HOME = mkdtempSync(join(base, 'literature-context-'))
process.env.DSH_BUTLER_VAULT = join(process.env.DSH_BUTLER_HOME, 'vault')
const { LiteratureResults } = await import('../src/host/literature-results.ts')
const { compactLiteratureHistory } = await import('../src/host/literature-context.ts').catch(() => ({}))

test('legacy literature projection preserves raw evidence and restores pruned records through native source links', () => {
  assert.equal(typeof compactLiteratureHistory, 'function')
  const value = { ok: true, query: 'introductory models', records: Array.from({ length: 16 }, (_, i) => ({
    title: `Paper ${i}`, doi: `10.1234/${i}`, source: 'crossref', authors: ['Author'], abstract: 'returned abstract '.repeat(1000),
  })), providers: [{ name: 'PubMed', ok: false, note: 'HTTP 503' }], limitations: ['PubMed unavailable'] }
  const message = { id: 'raw', role: 'tool', source: { kind: 'tool', callId: 'same-call' }, content: [{ type: 'text', text: JSON.stringify(value) }] }
  const events = [
    { seq: 0, type: 'tool/call', data: { turn: 1, step: 1, callId: 'same-call', name: 'butler_literature' } },
    { seq: 1, type: 'tool/result', data: { turn: 1, step: 1, message } },
    { seq: 2, type: 'tool/result', data: { turn: 1, step: 1, message: { ...message, content: [{ type: 'text', text: 'old native partial '.repeat(600) }] } }, sourceEventSeqs: [1] },
    { seq: 3, type: 'tool/call', data: { turn: 2, step: 1, callId: 'same-call', name: 'other_tool' } },
    { seq: 4, type: 'tool/result', data: { turn: 2, step: 1, message } },
    { seq: 5, type: 'tool/result', data: { turn: 1, step: 1, message: { ...message, isError: true } } },
  ]
  const before = structuredClone(events), session = { surface: { nodes: [2, 4, 5] }, snapshotEvents: () => events,
    eventAt: seq => events[seq], deriveEventMessage: event => event.data.message,
    append(type, data, options) { const event = { seq: events.length, type, data, ...options }; events.push(event)
      if (options?.surfaceOp) session.surface.nodes = session.surface.nodes.map(seq => seq === options.surfaceOp.startSeq ? event.seq : seq)
      return event
    } }
  const store = new LiteratureResults(), scope = { sessionId: 's', taskId: 'task' }
  assert.equal(compactLiteratureHistory(session, store, scope, () => 9999), 1)
  assert.deepEqual(events.slice(0, before.length), before)
  assert.deepEqual(session.surface.nodes.slice(1), [4, 5], 'Other calls and error receipts remain intact')
  const projected = JSON.parse(events[session.surface.nodes[0]].data.message.content[0].text)
  assert.equal(projected.total, 16)
  assert.equal(projected.providerErrorCount, 1)
  assert.equal(store.page(projected.resultSet.id, scope, { offset: 8 }).records[0].index, 8)
  assert.equal(compactLiteratureHistory(session, store, scope, () => 9999), 0)
})
