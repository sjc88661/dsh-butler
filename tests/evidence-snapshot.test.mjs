import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base = resolve('tests/.tmp'); mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'evidence-snapshot-'))
process.env.DSH_BUTLER_HOME = join(home, 'state'); process.env.DSH_BUTLER_VAULT = join(home, 'vault')
const { EvidenceStore } = await import('../src/host/evidence-store.ts')
const { ensureVault } = await import('../src/host/vault.ts'); ensureVault()
const fs = createRequire(import.meta.url)('node:fs')
const owner = (callId, taskId = 'task') => ({ sessionId: 'owner', rootSessionId: 'owner', runId: 'run', turn: 1, step: 1, callId: sequence + '-' + callId, taskId })
let sequence = 0
const nextFile = () => join(process.env.DSH_BUTLER_HOME, 'evidence-' + ++sequence + '.json')

test('evidence publish uses its first business snapshot instead of a second commitState snapshot', () => {
  const file = nextFile(), evidence = new EvidenceStore({ file }); evidence.registerReceipt({ tool: 'calendar_create', ok: true }, owner('seed'))
  const original = fs.readFileSync; let reads = 0
  fs.readFileSync = function (path, ...args) { if (path === file) reads++; return Reflect.apply(original, this, [path, ...args]) }; syncBuiltinESMExports()
  try { evidence.registerReceipt({ tool: 'calendar_create', ok: true }, owner('next')) }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
  assert.equal(reads, 3, 'One snapshot plus unchanged commitFiles file checks; publish must not read the same business state twice')
})

test('peer publication after snapshot read is retained and the stale publisher rejects conflict', () => {
  const file = nextFile(), evidence = new EvidenceStore({ file }), peer = new EvidenceStore({ file })
  evidence.registerReceipt({ tool: 'calendar_create', ok: true }, owner('seed'))
  const original = fs.readFileSync; let armed = true, peerBytes, peerIds
  fs.readFileSync = function (path, ...args) {
    const bytes = Reflect.apply(original, this, [path, ...args])
    if (path === file && armed) { armed = false; peerIds = peer.observe('calendar_create', { ok: true }, owner('peer')); peerBytes = Reflect.apply(original, this, [file]) }
    return bytes
  }; syncBuiltinESMExports()
  try { assert.throws(() => evidence.observe('calendar_create', { ok: true }, owner('outer')), /冲突|snapshot|changed/i) }
  finally { fs.readFileSync = original; syncBuiltinESMExports() }
  assert.deepEqual(readFileSync(file), peerBytes); assert.equal(peer.resolve(peerIds, 'task').length, 1)
})

test('snapshot publication retains unknown fields and pending/final/rejection and operation replay semantics', () => {
  const file = nextFile(), evidence = new EvidenceStore({ file }), id = owner('pending')
  const pending = evidence.prepare('calendar_create', { ok: true }, id); assert.equal(pending.length, 1)
  const data = JSON.parse(readFileSync(file, 'utf8')); data.future = { keep: true }; writeFileSync(file, JSON.stringify(data) + '\n')
  const confirmed = evidence.observe('calendar_create', { ok: true }, id); assert.deepEqual(confirmed, pending)
  assert.deepEqual(evidence.observe('calendar_create', { ok: true }, id), confirmed)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).future, { keep: true })
  assert.throws(() => evidence.observe('calendar_create', { ok: true }, { ...id, taskId: 'other' }), /其他|conflict/)
  assert.deepEqual(evidence.observe('calendar_create', { ok: false }, id), [])
  assert.throws(() => evidence.resolve(confirmed, 'task'), /失效|rejected/)
  assert.deepEqual(evidence.prepare('calendar_create', { ok: true }, id), [])
})

for (const differentTask of [false, true]) test('a concurrent same-operation replay ' + (differentTask ? 'cannot return IDs from another task' : 'returns the original IDs without rewriting the peer'), () => {
  const file = nextFile(), evidence = new EvidenceStore({ file }), peer = new EvidenceStore({ file })
  evidence.registerReceipt({ tool: 'calendar_create', ok: true }, owner('seed'))
  const original = fs.readFileSync; let armed = true, peerBytes, peerIds
  const current = owner('shared'), other = { ...current, ...(differentTask ? { taskId: 'other-task' } : {}) }
  fs.readFileSync = function (path, ...args) {
    const bytes = Reflect.apply(original, this, [path, ...args])
    if (path === file && armed) { armed = false; peerIds = peer.observe('calendar_create', { ok: true }, other); peerBytes = Reflect.apply(original, this, [file]) }
    return bytes
  }; syncBuiltinESMExports()
  try {
    if (differentTask) assert.throws(() => evidence.observe('calendar_create', { ok: true }, current), /其他|冲突|conflict/)
    else assert.deepEqual(evidence.observe('calendar_create', { ok: true }, current), peerIds)
  } finally { fs.readFileSync = original; syncBuiltinESMExports() }
  assert.deepEqual(readFileSync(file), peerBytes)
})
