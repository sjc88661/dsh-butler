import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixtureParent = resolve('tests/.tmp')
mkdirSync(fixtureParent, { recursive: true })
const fixture = mkdtempSync(join(fixtureParent, 'storage-journal-'))
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
const vault = await import('../src/host/vault.ts')
const store = await import('../src/host/store.ts')
const journalFile = vault.statePath('store-operations.jsonl')
const snapshotFile = vault.statePath('snapshot.txt')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function removeOwned(path) {
  if (!existsSync(path)) return
  assert.ok(realpathSync(path).startsWith(realpathSync(fixtureParent) + sep))
  rmSync(path, { recursive: true, force: true })
}
beforeEach(() => {
  removeOwned(vault.VAULT_HOME)
  removeOwned(vault.STATE_HOME)
  vault.ensureVault()
  writeFileSync(snapshotFile, 'original\n')
})
after(() => removeOwned(fixture))

function prepared(operationId = 'journal-test') {
  return {
    version: 1, phase: 'prepared', operationId, kind: 'test.journal', targetId: 'snapshot', time: '2026-10-16T00:00:00.000Z',
    writes: [{ path: snapshotFile, content: 'changed\n', format: 'text', beforeSha256: digest('original\n'), afterSha256: digest('changed\n') }],
  }
}

function rejectedJournal(text, expected) {
  writeFileSync(journalFile, text)
  const journalBefore = readFileSync(journalFile), snapshotBefore = readFileSync(snapshotFile)
  let failure
  assert.throws(() => store.recoverOperations(), error => {
    failure = error
    return error instanceof store.StorageError
  })
  assert.deepEqual(readFileSync(journalFile), journalBefore, 'rejected evidence must remain byte-identical')
  assert.deepEqual(readFileSync(snapshotFile), snapshotBefore, 'invalid journal must not replay any file')
  const issue = failure.diagnostics[0]
  assert.equal(issue.line, expected.line, 'journal diagnostics must use physical file lines, including blanks')
  assert.equal(issue.code, expected.code)
  assert.equal(issue.operationId, expected.operationId)
  assert.equal(issue.journalSha256, digest(journalBefore), 'identify the exact bytes that failed validation')
  assert.match(failure.message, new RegExp(digest(journalBefore)), 'native turn/end only retains the error message')
  assert.ok(failure.message.includes(expected.operationId))
  if (expected.capture !== false) {
    const expectedPath = vault.statePath('store-failures', `${digest(journalBefore)}.jsonl`)
    assert.equal(issue.snapshotPath, expectedPath)
    assert.ok(failure.message.includes(expectedPath), 'native error must retain the captured evidence location')
    assert.deepEqual(readFileSync(expectedPath), journalBefore, 'capture must preserve exact bytes, including blank rows')
    const metadata = JSON.parse(readFileSync(expectedPath.replace(/\.jsonl$/, '.json'), 'utf8'))
    for (const key of ['code', 'line', 'operationId', 'firstLine']) assert.equal(metadata[key], issue[key])
    assert.equal(metadata.sourcePath, journalFile)
    assert.equal(metadata.journalSha256, digest(journalBefore))
    assert.ok(Number.isFinite(Date.parse(metadata.time)))
  } else {
    assert.equal(issue.snapshotPath, undefined)
    assert.equal(typeof issue.captureError, 'string')
    assert.ok(issue.captureError.length > 0)
  }
  assert.equal(store.storageStatus([journalFile]).degraded, true)
  return issue
}

test('a duplicate prepared id fails closed with its physical line, first line and journal hash', () => {
  const row = JSON.stringify(prepared('duplicate-operation'))
  const issue = rejectedJournal(`${row}\n\n\n${row}\n`, { line: 4, code: 'duplicate-operation', operationId: 'duplicate-operation' })
  assert.equal(issue.firstLine, 1)
  assert.match(issue.message, /重复操作/)
  assert.doesNotMatch(issue.message, /或空写入/)
})

test('empty writes are identified separately from a duplicate operation', () => {
  const row = { ...prepared('empty-operation'), writes: [] }
  const issue = rejectedJournal(`\n${JSON.stringify(row)}\n`, { line: 2, code: 'empty-writes', operationId: row.operationId })
  assert.match(issue.message, /空写入/)
  assert.doesNotMatch(issue.message, /重复操作/)
})

test('a non-array writes value is a journal schema failure with the same byte evidence', () => {
  const row = { ...prepared('malformed-writes'), writes: null }
  const issue = rejectedJournal(`\n\n${JSON.stringify(row)}\n`, { line: 3, code: 'invalid-writes', operationId: row.operationId })
  assert.match(issue.message, /写入结构/)
})

test('a committed journal with blank lines remains healthy and byte-identical', () => {
  const start = prepared('healthy-operation')
  const { writes, ...end } = start
  end.phase = 'committed'
  const text = `\n${JSON.stringify(start)}\n\n${JSON.stringify(end)}\n`
  writeFileSync(journalFile, text)
  store.recoverOperations()
  assert.equal(readFileSync(journalFile, 'utf8'), text)
  assert.equal(readFileSync(snapshotFile, 'utf8'), 'original\n')
  assert.equal(store.storageStatus([journalFile]).degraded, false)
  assert.equal(existsSync(vault.statePath('store-failures')), false, 'healthy reads must not create failure evidence')
})

test('a validated journal cache detects same-size edits even when modification time is restored', () => {
  const start = prepared('cached-operation'), { writes, ...end } = start
  const text = `${JSON.stringify(start)}\n${JSON.stringify({ ...end, phase: 'committed' })}\n`
  writeFileSync(journalFile, text)
  store.recoverOperations()
  const stamp = statSync(journalFile)
  const altered = text.replace('changed\\n', 'tampered!')
  assert.equal(Buffer.byteLength(altered), Buffer.byteLength(text))
  writeFileSync(journalFile, altered)
  utimesSync(journalFile, stamp.atime, stamp.mtime)
  assert.throws(() => store.recoverOperations(), error => error.diagnostics[0].code === 'invalid-write')
  assert.equal(readFileSync(journalFile, 'utf8'), altered)
  assert.equal(readFileSync(snapshotFile, 'utf8'), 'original\n')
  writeFileSync(journalFile, text)
  store.recoverOperations()
  assert.equal(store.storageStatus([journalFile]).degraded, false)
})

test('journal line decoding preserves UTF-8, CRLF, initial BOM and the original idempotent result', () => {
  const result = { text: '管家提醒 🛠️', nested: ['保留原始结果'] }
  store.commitFiles({ operationId: 'unicode-result', kind: 'test.journal', targetId: 'snapshot', result,
    writes: [{ path: snapshotFile, content: '新的内容 🛠️\n' }] })
  const text = '\uFEFF' + readFileSync(journalFile, 'utf8').replaceAll('\n', '\r\n')
  writeFileSync(journalFile, text)
  store.recoverOperations()
  const repeated = store.commitFiles({ operationId: 'unicode-result', kind: 'test.journal', targetId: 'snapshot', result: null,
    writes: [{ path: snapshotFile, content: '不应重写\n' }] })
  assert.deepEqual(repeated, result)
  assert.equal(readFileSync(journalFile, 'utf8'), text)
  assert.equal(readFileSync(snapshotFile, 'utf8'), '新的内容 🛠️\n')
})

test('a BOM in a later journal record and malformed UTF-8 still fail closed', () => {
  const start = prepared('later-bom'), { writes, ...end } = start
  writeFileSync(journalFile, `${JSON.stringify(start)}\n\uFEFF${JSON.stringify({ ...end, phase: 'committed' })}\n`)
  assert.throws(() => store.recoverOperations(), error => error.diagnostics[0].kind === 'json' && error.diagnostics[0].line === 2)
  writeFileSync(journalFile, Buffer.concat([Buffer.from(JSON.stringify(start) + '\n'), Buffer.from([0xff])]))
  assert.throws(() => store.recoverOperations(), /UTF-8/)
  assert.equal(readFileSync(snapshotFile, 'utf8'), 'original\n')
})

test('repeated failures reuse the captured bytes and first metadata without another write', () => {
  const row = { ...prepared('repeated-failure'), writes: [] }
  const text = `${JSON.stringify(row)}\n`, expected = { line: 1, code: 'empty-writes', operationId: row.operationId }
  const issue = rejectedJournal(text, expected)
  const metadataPath = issue.snapshotPath.replace(/\.jsonl$/, '.json')
  utimesSync(issue.snapshotPath, 1, 1)
  utimesSync(metadataPath, 1, 1)
  rejectedJournal(text, expected)
  assert.equal(statSync(issue.snapshotPath).mtimeMs, 1000)
  assert.equal(statSync(metadataPath).mtimeMs, 1000)
  assert.equal(readdirSync(vault.statePath('store-failures')).length, 2)
})

test('capture I/O failure retains the original validation error and all business bytes', () => {
  const blocked = vault.statePath('store-failures')
  writeFileSync(blocked, 'preserve blocking file\n')
  const row = { ...prepared('capture-blocked'), writes: [] }
  const issue = rejectedJournal(`${JSON.stringify(row)}\n`, { line: 1, code: 'empty-writes', operationId: row.operationId, capture: false })
  assert.match(issue.message, /空写入/)
  assert.equal(readFileSync(blocked, 'utf8'), 'preserve blocking file\n')
})

test('failure evidence captures the rejected read even if the source changes before validation', () => {
  const text = `\n${JSON.stringify({ ...prepared('capture-read-race'), writes: [] })}\r\n`
  writeFileSync(journalFile, text)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const journal=${JSON.stringify(journalFile)}, rejected=Buffer.from(${JSON.stringify(text)});
    const original=fs.readFileSync; let changed=false;
    fs.readFileSync=(path,...args)=>{const bytes=original(path,...args);if(path===journal&&!changed){changed=true;fs.writeFileSync(journal,'')}return bytes};
    syncBuiltinESMExports();
    const store=await import(${JSON.stringify(pathToFileURL(resolve('src/host/store.ts')).href)});
    assert.throws(()=>store.recoverOperations(),error=>{
      assert.equal(error.diagnostics[0].code,'empty-writes');
      assert.deepEqual(fs.readFileSync(error.diagnostics[0].snapshotPath),rejected);
      return error instanceof store.StorageError;
    });
    assert.equal(fs.readFileSync(journal,'utf8'),'');
  `], { cwd: resolve('.'), env: { ...process.env }, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(snapshotFile, 'utf8'), 'original\n')
})

test('an existing conflicting evidence file is preserved and cannot mask the original failure', () => {
  const text = `${JSON.stringify({ ...prepared('evidence-collision'), writes: [] })}\n`
  const directory = vault.statePath('store-failures')
  mkdirSync(directory)
  const existing = join(directory, `${digest(text)}.jsonl`)
  writeFileSync(existing, 'preserve existing evidence\n')
  rejectedJournal(text, { line: 1, code: 'empty-writes', operationId: 'evidence-collision', capture: false })
  assert.equal(readFileSync(existing, 'utf8'), 'preserve existing evidence\n')
})

test('a junction cannot redirect failure evidence outside the configured state and vault roots', () => {
  const outside = join(fixture, 'outside-evidence')
  mkdirSync(outside)
  writeFileSync(join(outside, 'sentinel.txt'), 'untouched\n')
  symlinkSync(outside, vault.statePath('store-failures'), 'junction')
  const row = { ...prepared('capture-escape'), writes: [] }
  rejectedJournal(`${JSON.stringify(row)}\n`, { line: 1, code: 'empty-writes', operationId: row.operationId, capture: false })
  assert.deepEqual(readdirSync(outside), ['sentinel.txt'])
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'untouched\n')
})
