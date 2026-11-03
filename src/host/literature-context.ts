/** Project legacy search receipts onto native surfaces without losing their originals. */
import type { OverviewSession } from './overview-context.ts'
import { LiteratureResults, renderLiteratureResult, type LiteratureScope } from './literature-results.ts'

export function compactLiteratureHistory(session: OverviewSession, results: LiteratureResults,
  scope: LiteratureScope, estimateMessage: (message: any) => number): number {
  if (!session.surface || !session.snapshotEvents || !session.eventAt || !session.append) return 0
  const events = session.snapshotEvents()
  const key = (data: any, callId: unknown) => JSON.stringify([data.turn, data.step, callId])
  const names = new Map<string, string>()
  for (const event of events) if (event.type === 'tool/call') names.set(key(event.data, event.data.callId), event.data.name)
  const parse = (message: any): Record<string, unknown> | undefined => {
    if (message?.isError || message?.content?.length !== 1 || message.content[0].type !== 'text') return
    try {
      const value = JSON.parse(message.content[0].text)
      if (value?.ok === true && Array.isArray(value.records) && value.view !== 'literature-preview') return value
    } catch { /* A native partial result may link back to the complete original. */ }
    return undefined
  }
  let count = 0
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq), message = session.deriveEventMessage?.(event) ?? event?.data?.message
    if (event?.type !== 'tool/result' || message?.isError || names.get(key(event.data, message?.source?.callId)) !== 'butler_literature') continue
    if (message.content?.length !== 1 || message.content[0].type !== 'text') continue
    // A complete preview already has a stable, scope-checked detail path.
    try { if (JSON.parse(message.content[0].text)?.view === 'literature-preview') continue } catch {}
    let value = parse(message), originalSeq = seq
    const pending = [...(event.sourceEventSeqs ?? [])], visited = new Set<number>([seq])
    while (!value && pending.length && visited.size < 64) {
      const sourceSeq = pending.shift()!
      if (visited.has(sourceSeq)) continue
      visited.add(sourceSeq)
      const source = session.eventAt(sourceSeq)
      if (source?.type !== 'tool/result' || key(source.data, source.data.message?.source?.callId) !== key(event.data, message.source?.callId)) continue
      value = parse(source.data.message); originalSeq = sourceSeq
      if (!value) pending.push(...(source.sourceEventSeqs ?? []))
    }
    if (!value) continue
    const shadowedTokenCount = estimateMessage(message)
    if (!Number.isSafeInteger(shadowedTokenCount) || shadowedTokenCount < 0) continue
    const resultSet = results.save(value, scope, { sessionId: scope.sessionId, sourceEventSeq: originalSeq })
    let text = renderLiteratureResult({ ...value, resultSet })
    if (Buffer.byteLength(text) >= Buffer.byteLength(message.content[0].text) && originalSeq !== seq) {
      text = renderLiteratureResult(results.page(resultSet.id, scope, { limit: 2 }))
    }
    if (Buffer.byteLength(text) >= Buffer.byteLength(message.content[0].text)) continue
    session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount })
    session.append('tool/result', { ...event.data, message: { ...message, content: [{ ...message.content[0], text }] } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
    count++
  }
  return count
}
