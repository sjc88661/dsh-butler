/** Model-facing success receipts; complete raw values remain in native logs and stores. */
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Bounded discovery view; complete business values stay in receipts and stores. */
export function renderOverviewResult(value: unknown): string {
  if (!record(value) || value['ok'] !== true) return JSON.stringify(value)
  if (value['view'] === 'summary' && record(value['counts']) && Buffer.byteLength(JSON.stringify(value)) <= 12000) return JSON.stringify(value)
  const clip = (item: unknown, size = 160): unknown => typeof item === 'string' && item.length > size ? item.slice(0, size) + '…' : item
  const rows = (key: string): Record<string, unknown>[] => Array.isArray(value[key]) ? value[key].filter(record) : []
  const counts = Object.fromEntries(['openTasks', 'awaitingApproval', 'proposedMemories', 'interrupted', 'recentReceipts', 'evidence', 'packs']
    .map(key => [key, rows(key).length]))
  const pick = (items: Record<string, unknown>[], keys: string[], limit: number) => items.slice(0, limit).map(item =>
    Object.fromEntries(keys.filter(key => key in item && (item[key] === null || ['string', 'number', 'boolean'].includes(typeof item[key])))
      .map(key => [key, key === 'id' || key === 'evidenceId' ? item[key] : clip(item[key])])))
  const usage = record(value['usage']) ? Object.fromEntries(Object.entries(value['usage']).slice(0, 20)
    .filter(([, item]) => item === null || ['number', 'boolean', 'string'].includes(typeof item))
    .map(([key, item]) => [key.slice(0, 80), clip(item, 80)])) : value['usage']
  const build = (limit: number) => ({ ok: true, view: 'summary', counts,
    vault: clip(value['vault'], 256), profileExcerpt: clip(value['profileExcerpt'], 600),
    openTasks: pick(rows('openTasks'), ['id', 'title', 'status', 'kind', 'dueAt', 'note'], limit),
    awaitingApproval: pick(rows('awaitingApproval'), ['id', 'title', 'reason'], Math.min(limit, 5)),
    proposedMemories: pick(rows('proposedMemories'), ['id', 'text'], Math.min(limit, 3)),
    interrupted: pick(rows('interrupted'), ['id', 'title', 'status', 'note'], Math.min(limit, 3)),
    recentReceipts: pick(rows('recentReceipts'), ['at', 'tool', 'ok', 'ms', 'summary', 'error'], Math.min(limit, 3)),
    evidence: pick(rows('evidence'), ['id', 'evidenceId', 'source_type', 'read_level', 'verification'], Math.min(limit, 5)),
    usage,
    packs: pick(rows('packs'), ['id', 'title', 'enabled', 'source', 'cost_class', 'broken'], limit),
    note: '总览为摘要；完整任务用 butler_task list、能力包用 butler_pack show 按需读取。原始记录保留。',
  })
  for (const limit of [10, 5, 2, 1]) {
    const summary = build(limit), text = JSON.stringify(summary)
    if (Buffer.byteLength(text) <= 12000) return text
  }
  // Malformed legacy identifiers must not create an unbounded model message.
  return JSON.stringify({ ok: true, view: 'summary', counts,
    note: '总览内容过大，完整记录保留；请按需查询具体任务和能力包。' })
}

export function renderReminderResult(value: unknown): string {
  if (!record(value) || value['ok'] !== true || value['state'] !== 'committed'
    || !record(value['operation']) || !record(value['reminder'])) return JSON.stringify(value)
  const { operation, reminder, ...rest } = value
  const { raw: _raw, ...receipt } = reminder as Record<string, unknown>
  return JSON.stringify({ ...rest, reminder: receipt,
    deliveryState: operation['deliveryState'] ?? 'unknown' })
}
