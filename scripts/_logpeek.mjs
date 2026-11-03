// Temporary: show the first rows of one session log, to see why a legacy log
// has no `session` row that names its own id.
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
console.log(`frames=${offsets.length} bytes=${buffer.length}`)
const types = new Map()
let shown = 0
for (let i = 0; i < offsets.length; i += 1) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
  let text
  try {
    text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  } catch (error) {
    if (shown < 3) console.log(`frame ${i} failed: ${String(error).slice(0, 80)}`)
    continue
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    types.set(row.type, (types.get(row.type) ?? 0) + 1)
    if (shown < 4) {
      const data = row.data ?? {}
      console.log(`type=${row.type} keys=${Object.keys(data).join(',')} id=${data.id ?? '-'} seq=${row.seq} time=${row.time}`)
      shown += 1
    }
  }
}
console.log('types:', Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}=${n}`).join(' '))
