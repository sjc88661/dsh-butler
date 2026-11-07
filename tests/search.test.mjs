/**
 * 全局搜索：跨笔记/任务/记忆的命中、大小写、片段、上限与超大文件跳过。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(join(base, 'search-'))
process.env.DSH_BUTLER_VAULT = join(root, 'vault')
process.env.DSH_BUTLER_HOME = join(root, 'state')

const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
const { searchAll, excerpt } = await import('../src/host/search.ts')
const { upsertTask, addMemo } = await import('../src/host/ledger.ts')
ensureVault()

after(() => {
  assert.ok(realpathSync(root).startsWith(realpathSync(base) + sep))
  rmSync(root, { recursive: true, force: true })
})

test('one query finds notes, tasks and confirmed/proposed memory case-insensitively', () => {
  writeFileSync(vaultPath('notes', 'enzyme-notes.md'), '# 酶稳定性\n\nEnzyme stability under harsh conditions, see Fig. 2.\n')
  writeFileSync(vaultPath('notes', 'other.md'), '# 其他\n\nnothing relevant here\n')
  upsertTask('search-task-1', { title: 'Enzyme assay follow-up', status: 'pending' })
  upsertTask('search-task-2', { title: 'Unrelated', status: 'pending' })
  addMemo({ id: 'search-memo-1', text: 'prefers enzyme kinetics papers', source: 'butler' })
  addMemo({ id: 'search-memo-2', text: 'likes coffee', source: 'user' })

  const found = searchAll('enzyme')
  assert.deepEqual([...found.notes].map(hit => hit.id), ['enzyme-notes'])
  assert.deepEqual([...found.tasks].map(hit => hit.id), ['search-task-1'])
  assert.deepEqual([...found.memory].map(hit => hit.id), ['search-memo-1'])
  assert.equal(found.total, 3)
  assert.equal(found.truncated, false)
  assert.match(found.notes[0].title, /酶稳定性/)
  assert.match(found.notes[0].snippet, /Enzyme stability/)
  assert.equal(found.notes[0].path, 'notes/enzyme-notes.md')

  assert.equal(searchAll('KINETICS').memory.length, 1)
  assert.equal(searchAll('').total, 0)
})

test('group caps and oversized notes are explicit', () => {
  for (let index = 0; index < 5; index += 1) upsertTask(`bulk-task-${index}`, { title: `bulk item ${index}`, status: 'pending' })
  const limited = searchAll('bulk', { limit: 2 })
  assert.equal(limited.tasks.length, 2)
  assert.equal(limited.truncated, true)

  writeFileSync(vaultPath('notes', 'huge.md'), `# huge\n\n${'x'.repeat(2048)}needle ${'y'.repeat(2048)}`)
  assert.equal(searchAll('needle', { maxNoteBytes: 1024 }).notes.length, 0)
  assert.equal(searchAll('needle', { maxNoteBytes: 1024 * 1024 }).notes.length, 1)
})

test('excerpt centres the match and marks both edges', () => {
  const text = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`
  const snippet = excerpt(text, 'needle', 10)
  assert.match(snippet, /^…/)
  assert.match(snippet, /NEEDLE/)
  assert.match(snippet, /…$/)
  assert.equal(excerpt('short text', 'missing', 10), 'short text')
})
