/** Native, model-free replacement of legacy overview output; source receipts remain. */
import { renderOverviewResult } from './result-rendering.ts'

export interface OverviewSession {
  surface?: { nodes: number[] }
  snapshotEvents?(): Array<{ type: string; data: any }>
  eventAt?(seq: number): any
  deriveEventMessage?(event: any): any
  append?(type: string, data: any, options?: any): any
}

export function compactOverviewHistory(session: OverviewSession, estimateMessage?: (message: any) => number): number {
  if (!session.surface || !session.snapshotEvents || !session.eventAt || !session.append || !estimateMessage) return 0
  const names = new Map<string, string>()
  for (const event of session.snapshotEvents()) if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  let replaced = 0
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage?.(event) ?? event.data.message
    if (message?.isError || names.get(message?.source?.callId) !== 'butler_overview' || message.content?.length !== 1 || message.content[0].type !== 'text') continue
    const block = message.content[0]
    let value: unknown
    try { value = JSON.parse(block.text) } catch { continue }
    const text = renderOverviewResult(value)
    if (Buffer.byteLength(text) >= Buffer.byteLength(block.text)) continue
    const shadowedTokenCount = estimateMessage(message)
    if (!Number.isSafeInteger(shadowedTokenCount) || shadowedTokenCount < 0) continue
    session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount })
    session.append('tool/result', { ...event.data, message: { ...message, content: [{ ...block, text }] } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
    replaced++
  }
  return replaced
}
