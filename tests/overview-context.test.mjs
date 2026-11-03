import test from 'node:test'
import assert from 'node:assert/strict'
import { renderOverviewResult } from '../src/host/result-rendering.ts'
import { compactOverviewHistory } from '../src/host/overview-context.ts'

const overview = () => ({ ok: true, vault: 'E:/vault', profileExcerpt: '中文档案',
  openTasks: Array.from({ length: 20 }, (_, i) => ({ id: `task-${i}`, title: `学习任务 ${i}`, status: 'pending', kind: 'research',
    dueAt: null, note: '已有进度说明。'.repeat(400), execution: { internal: 'raw details '.repeat(1000) } })),
  awaitingApproval: [{ id: 'approval-1', title: '待批准操作', reason: '需要本人确认' }],
  proposedMemories: [], interrupted: [], recentReceipts: [], evidence: [], usage: { totalTokens: 27601 },
  packs: [{ id: 'research', title: '科研包', enabled: true, guidance: { workflow: '完整工作流。'.repeat(1000) } }] })

test('overview output fits a small model context while retaining task identities, statuses and pending approval', () => {
  const value = overview(), before = structuredClone(value)
  const text = renderOverviewResult(value), compact = JSON.parse(text)
  assert.ok(Buffer.byteLength(text) <= 12000)
  assert.equal(compact.counts.openTasks, 20)
  assert.equal(compact.openTasks[0].id, 'task-0')
  assert.equal(compact.openTasks[0].status, 'pending')
  assert.equal(compact.awaitingApproval[0].id, 'approval-1')
  assert.equal(compact.usage.totalTokens, 27601)
  assert.equal(compact.packs[0].guidance, undefined)
  assert.deepEqual(value, before, 'The full raw tool value must remain available')
  assert.equal(renderOverviewResult(compact), text, 'Summaries must not repeatedly lose counts or change on replay')
})

test('failed overview results retain complete diagnostic details', () => {
  const value = { ok: false, error: '失败细节'.repeat(5000) }
  assert.deepEqual(JSON.parse(renderOverviewResult(value)), value)
})

test('only confirmed overview results are replaced in the native surface, with original receipts retained', () => {
  const original = { id: 'result', role: 'tool', toolCallId: 'overview-call', source: { kind: 'tool', callId: 'overview-call' },
    content: [{ type: 'text', text: JSON.stringify(overview(), null, 2) }] }
  const literature = { ...original, id: 'papers', toolCallId: 'papers-call', source: { kind: 'tool', callId: 'papers-call' } }
  const events = [
    { seq: 0, type: 'tool/call', data: { callId: 'overview-call', name: 'butler_overview' } },
    { seq: 1, type: 'tool/result', data: { turn: 1, step: 1, message: original } },
    { seq: 2, type: 'tool/call', data: { callId: 'papers-call', name: 'butler_literature' } },
    { seq: 3, type: 'tool/result', data: { turn: 1, step: 1, message: literature } },
  ]
  const before = structuredClone(events), writes = []
  const session = { surface: { nodes: [1, 3] }, snapshotEvents: () => events, eventAt: seq => events[seq],
    deriveEventMessage: event => event.data.message,
    append(type, data, options) {
      const event = { seq: events.length, type, data, ...options }; events.push(event); writes.push(event)
      if (options?.surfaceOp) session.surface.nodes = session.surface.nodes.map(seq => seq === options.surfaceOp.startSeq ? event.seq : seq)
      return event
    } }
  assert.equal(compactOverviewHistory(session, message => { assert.equal(message, original); return 1000 }), 1)
  assert.deepEqual(events.slice(0, 4), before)
  assert.equal(writes[0].type, 'compaction/prune')
  assert.equal(writes[0].data.shadowedTokenCount, 1000)
  assert.deepEqual(writes[1].sourceEventSeqs, [1])
  assert.equal(writes[1].data.message.source.callId, 'overview-call')
  assert.ok(Buffer.byteLength(writes[1].data.message.content[0].text) <= 12000)
  assert.equal(session.surface.nodes[1], 3, 'Literature evidence must stay intact')
  assert.equal(compactOverviewHistory(session, () => 1000), 0)
})
