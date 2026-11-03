// Temporary: print the `usage` object keys of one assistant/message row, so the
// recorder's field list can be checked against what DSH really publishes.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
const buffer = readFileSync(path)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = [0]
let index = buffer.indexOf(magic, magic.length)
while (index >= 0) {
  offsets.push(index)
  index = buffer.indexOf(magic, index + magic.length)
}
const seen = new Set()
let shown = 0
for (let i = 0; i < offsets.length; i += 1) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
  let text
  try {
    text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.includes('"assistant/message"')) continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (row.type !== 'assistant/message') continue
    const usage = row.data?.usage
    seen.add(Object.keys(usage ?? {}).sort().join(','))
    if (shown < 3) {
      console.log(`#${row.data?.turn}#${row.data?.step} usage=${JSON.stringify(usage)}`)
      console.log(`  source=${JSON.stringify(row.data?.message?.source)}`)
      shown += 1
    }
  }
}
console.log('usage key shapes seen:')
for (const shape of seen) console.log(`  ${shape}`)
