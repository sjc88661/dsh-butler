/** Deterministic lexical selection. Budgets measure the exact injected UTF-8 text. */
export function clipBytes(text: string, limit: number): string {
  const budget = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (Buffer.byteLength(text) <= budget) return text
  let used = 0, result = ''
  for (const char of text) {
    const bytes = Buffer.byteLength(char)
    if (used + bytes > budget) break
    result += char; used += bytes
  }
  return result
}

const normalized = (text: string): string => text.normalize('NFKC').toLocaleLowerCase('en-US')
export function relevance(query: string, text: string, title = ''): number {
  const request = normalized(query).trim(), body = normalized(text), heading = normalized(title)
  if (!request) return 0
  const tokens = new Set(request.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [])
  for (const run of request.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) tokens.add(run)
    else for (let i = 0; i < run.length - 1 && tokens.size < 128; i++) tokens.add(run.slice(i, i + 2))
  }
  let score = body.includes(request) ? 24 : 0
  for (const token of tokens) {
    if (body.includes(token)) score += 2
    if (heading.includes(token)) score += 6
  }
  return score
}

export const isBoundary = (text: string): boolean => /边界|禁止|不得|不允许|未经|未获|授权|先.{0,8}(?:确认|询问)|只接受|never\b|must\s+not\b/iu.test(text)

/** Scan every block before selecting, so a boundary near the end can outrank the prefix. */
export function selectText(text: string, query: string, maxBytes: number, boundaryFirst = false, maxBlocks = 8): string {
  const blocks = text.split(/\r?\n/).flatMap(line => line.length > 500 ? line.split(/(?<=[。！？.!?])\s*/u) : [line])
    .map((line, index) => ({ line: line.trim(), index, score: relevance(query, line), boundary: boundaryFirst && isBoundary(line) }))
    .filter(row => row.line && !row.line.startsWith('#') && !row.line.startsWith('<!--'))
    .sort((a, b) => Number(b.boundary) - Number(a.boundary) || b.score - a.score || a.index - b.index)
  let result = '', count = 0
  for (const block of blocks) {
    if (count >= maxBlocks) break
    const remaining = maxBytes - Buffer.byteLength(result) - (result ? 1 : 0)
    if (remaining <= 0) break
    const line = clipBytes(block.line, remaining)
    if (!line) break
    result += `${result ? '\n' : ''}${line}`; count++
  }
  return result
}
