import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = resolve('tests/.tmp')
mkdirSync(base, { recursive: true })
const home = mkdtempSync(join(base, 'notes-'))
process.env.DSH_BUTLER_VAULT = join(home, 'vault')
process.env.DSH_BUTLER_HOME = join(home, 'state')
const toolsUrl = pathToFileURL(resolve('src/host/tools.ts')).href
const { registerButlerTools } = await import('../src/host/tools.ts')
const notes = await import('../src/host/notes.ts')
const { ensureVault, vaultPath } = await import('../src/host/vault.ts')
ensureVault()
const hash = content => createHash('sha256').update(content).digest('hex')
const body = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
const registry = new Map()
registerButlerTools({ tools: { register(tool) { registry.set(tool.name, tool); return () => {} } } }, {
  timeZone: 'UTC', mailto: 'test@localhost', receiptsByRuntime: true, sessionId: () => 'isolated', currentTaskId: () => undefined,
})
const call = async args => {
  try { return await registry.get('butler_note').execute(args) }
  catch (error) { if (error.name === 'ToolArgsError') return { ok: false, message: error.message }; throw error }
}
const child = code => spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  ${code}
`], { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', windowsHide: true })
const registerChild = `
  const {registerButlerTools}=await import(${JSON.stringify(toolsUrl)});const tools=new Map();
  registerButlerTools({tools:{register(tool){tools.set(tool.name,tool);return()=>{}}}},
    {timeZone:'UTC',mailto:'test@localhost',receiptsByRuntime:true,sessionId:()=> 'isolated',currentTaskId:()=>undefined});
  const call=args=>tools.get('butler_note').execute(args);
`

test('write, replace and append retain exact full revisions with SHA256 and source sections after restart', async () => {
  const slug = 'history', first = await call({ action: 'write', slug, title: 'History', markdown: 'Original body', sources: ['Original DOI — https://doi.org/10.1234/original'] })
  assert.equal(first.ok, true)
  const original = readFileSync(first.path, 'utf8')
  const second = await call({ action: 'write', slug, markdown: 'Replacement body', sources: ['Replacement source'] })
  const replacement = readFileSync(second.path, 'utf8')
  const third = await call({ action: 'append', slug, markdown: 'Appended content', sources: ['Append source'] })
  assert.equal(third.rev, 3)
  const history = await call({ action: 'history', slug })
  assert.equal(history.ok, true, JSON.stringify(history))
  assert.deepEqual(history.revisions.map(row => row.rev), [3, 2, 1])
  const old = await call({ action: 'read', slug, revision: 1 })
  assert.equal(old.body, original)
  assert.equal(old.sha256, hash(original))
  assert.equal((await call({ action: 'read', slug, revision: 2 })).body, replacement)
  assert.equal(history.revisions.find(row => row.rev === 1).sha256, hash(original))
  const restarted = child(`${registerChild}
    const old=await call({action:'read',slug:'history',revision:1});assert.equal(old.ok,true);assert.equal(old.body,${JSON.stringify(original)});
    const current=await call({action:'read',slug:'history'});assert.equal(current.rev,3);assert.ok(current.body.includes('Replacement body'));assert.ok(current.body.includes('Appended content'));
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
})

test('restoring a historical revision creates a new revision with its full original body and sources', async () => {
  const slug = 'restore', first = await call({ action: 'write', slug, title: 'Original title', markdown: 'Restore this body', sources: ['Keep this citation'] })
  const original = readFileSync(first.path, 'utf8')
  await call({ action: 'write', slug, title: 'Changed title', markdown: 'Replaced body', sources: ['Other citation'] })
  const restored = await call({ action: 'restore', slug, revision: 1 })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.equal(restored.rev, 3)
  const current = await call({ action: 'read', slug })
  assert.equal(body(current.body), body(original))
  assert.match(current.body, /title: Original title/)
  assert.match(current.body, /^rev: 3$/m)
  assert.match((await call({ action: 'read', slug, revision: 2 })).body, /Replaced body/)
  const history = await call({ action: 'history', slug })
  assert.equal(history.revisions[0].restoredFrom, 1)
  assert.equal(history.revisions.length, 3)
})

test('first managed update of a legacy note preserves every original byte and its existing revision', async () => {
  const slug = 'legacy', path = vaultPath('notes', `${slug}.md`)
  const original = '---\r\ntitle: Human note\r\nrev: 7\r\ncreated: 2024-01-02\r\n---\r\nOriginal\r\n\r\n## 来源\r\n\r\n- Legacy source\r\n'
  writeFileSync(path, original)
  const appended = await call({ action: 'append', slug, markdown: 'New supplement' })
  assert.equal(appended.ok, true)
  assert.equal(appended.rev, 8)
  const historical = await call({ action: 'read', slug, revision: 7 })
  assert.equal(historical.body, original)
  assert.equal(historical.sha256, hash(original))
})

test('a human edit with an unchanged rev is retained with a durable proposed copy and an explicit line difference', async () => {
  const slug = 'human-conflict', first = await call({ action: 'write', slug, markdown: 'Original managed line' })
  const edited = readFileSync(first.path, 'utf8').replace('Original managed line', 'Human edited line')
  writeFileSync(first.path, edited)
  const conflict = await call({ action: 'write', slug, markdown: 'Assistant proposed line' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'note.conflict')
  assert.equal(conflict.conflict, true)
  assert.equal(readFileSync(first.path, 'utf8'), edited)
  assert.equal(readFileSync(conflict.currentPath, 'utf8'), edited)
  assert.match(readFileSync(conflict.proposedPath, 'utf8'), /Assistant proposed line/)
  assert.ok(conflict.diff.added.some(line => line.includes('Assistant proposed line')))
  assert.ok(conflict.diff.removed.some(line => line.includes('Human edited line')))
  const history = await call({ action: 'history', slug })
  assert.equal(history.revisions.length, 1)
  assert.equal(history.conflicts[0].id, conflict.conflictId)
  const restarted = child(`${registerChild}
    const history=await call({action:'history',slug:${JSON.stringify(slug)}});
    assert.equal(history.conflicts[0].id,${JSON.stringify(conflict.conflictId)});
    assert.equal((await call({action:'read',slug:${JSON.stringify(slug)}})).sha256,${JSON.stringify(hash(edited))});
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
})

test('a stale caller SHA256 cannot overwrite a newer managed revision', async () => {
  const slug = 'stale', first = await call({ action: 'write', slug, markdown: 'First' })
  const firstHash = hash(readFileSync(first.path))
  const second = await call({ action: 'write', slug, markdown: 'Second' })
  const before = readFileSync(second.path, 'utf8')
  const conflict = await call({ action: 'append', slug, markdown: 'Stale append', expectedSha256: firstHash })
  assert.equal(conflict.code, 'note.conflict')
  assert.equal(readFileSync(second.path, 'utf8'), before)
  assert.equal(readFileSync(conflict.currentPath, 'utf8'), before)
  assert.match(readFileSync(conflict.proposedPath, 'utf8'), /Stale append/)
})

test('damaged revision bytes refuse replacement and restore without altering the current note', async () => {
  const slug = 'damaged-history', first = await call({ action: 'write', slug, markdown: 'One' })
  await call({ action: 'write', slug, markdown: 'Two' })
  const history = await call({ action: 'history', slug })
  assert.equal(history.ok, true)
  const oldPath = history.revisions.find(row => row.rev === 1).path
  writeFileSync(oldPath, 'tampered history')
  const before = readFileSync(first.path, 'utf8')
  assert.equal((await call({ action: 'restore', slug, revision: 1 })).ok, false)
  assert.equal((await call({ action: 'write', slug, markdown: 'Three' })).ok, false)
  assert.equal(readFileSync(first.path, 'utf8'), before)
})

test('a revision backup failure preserves the old note and never prepares a partial replacement', async () => {
  const slug = 'backup-failure', path = vaultPath('notes', `${slug}.md`), original = 'Legacy body and sources\n'
  writeFileSync(path, original)
  const result = child(`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const originalOpen=fs.openSync;fs.openSync=(path,...args)=>{
      if(typeof path==='string'&&path.startsWith(${JSON.stringify(`${path}.backup-v1.tmp-`)})){const error=new Error('injected backup write failure');error.code='EACCES';throw error}
      return originalOpen(path,...args)};syncBuiltinESMExports();
    ${registerChild}
    const result=await call({action:'write',slug:${JSON.stringify(slug)},markdown:'Must not replace'});assert.equal(result.ok,false);
    assert.equal(fs.readFileSync(${JSON.stringify(path)},'utf8'),${JSON.stringify(original)});
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(path, 'utf8'), original)
})

test('a crash between revision persistence and note replacement recovers the complete version group', async () => {
  const slug = 'crash', first = await call({ action: 'write', slug, markdown: 'Before crash', sources: ['Before source'] })
  const original = readFileSync(first.path, 'utf8')
  const crashed = child(`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const originalRename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(first.path)})process.exit(77);return originalRename(from,to)};syncBuiltinESMExports();
    ${registerChild}
    await call({action:'write',slug:${JSON.stringify(slug)},markdown:'Recovered replacement',sources:['Recovered source']});
  `)
  assert.equal(crashed.status, 77, crashed.stderr)
  assert.equal(readFileSync(first.path, 'utf8'), original)
  const restarted = child(`${registerChild}
    const current=await call({action:'read',slug:${JSON.stringify(slug)}});assert.equal(current.ok,true);assert.equal(current.rev,2);assert.match(current.body,/Recovered replacement/);
    const old=await call({action:'read',slug:${JSON.stringify(slug)},revision:1});assert.equal(old.body,${JSON.stringify(original)});
    const history=await call({action:'history',slug:${JSON.stringify(slug)}});assert.deepEqual(history.revisions.map(row=>row.rev),[2,1]);
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
})

test('oversized and invalid UTF-8 notes fail closed before replacement', async () => {
  const slug = 'invalid-utf8', path = vaultPath('notes', `${slug}.md`), original = Buffer.from([0x61, 0xff, 0x62])
  writeFileSync(path, original)
  assert.equal((await call({ action: 'write', slug, markdown: 'Refuse replacement' })).ok, false)
  assert.deepEqual(readFileSync(path), original)
  const tooLarge = await call({ action: 'write', slug: 'too-large', markdown: 'x'.repeat(300_000) })
  assert.equal(tooLarge.ok, false)
  assert.equal(existsSync(vaultPath('notes', 'too-large.md')), false)
})

test('a UTF-8 BOM in a legacy note is retained byte for byte in revision history', async () => {
  const slug = 'bom', path = vaultPath('notes', `${slug}.md`)
  const original = '\ufeff---\ntitle: BOM note\nrev: 4\n---\nBody with BOM\n'
  writeFileSync(path, original)
  const written = await call({ action: 'write', slug, markdown: 'New body' })
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.equal(written.rev, 5)
  const old = await call({ action: 'read', slug, revision: 4 })
  assert.equal(old.body, original)
  assert.equal(old.sha256, hash(original))
})

test('a conflict explicitly shows reordered body lines rather than only a revision header', async () => {
  const slug = 'reordered', first = await call({ action: 'write', slug, markdown: 'Alpha\nBeta' })
  const edited = readFileSync(first.path, 'utf8').replace('Alpha\nBeta', 'Beta\nAlpha')
  writeFileSync(first.path, edited)
  const conflict = await call({ action: 'write', slug, markdown: 'Alpha\nBeta' })
  assert.equal(conflict.code, 'note.conflict')
  assert.ok(conflict.diff.added.includes('Alpha'))
  assert.ok(conflict.diff.removed.includes('Beta'))
  assert.equal(readFileSync(first.path, 'utf8'), edited)
})

test('an impossible stale hash on a missing note does not leave a corrupt empty revision index', async () => {
  const slug = 'missing-stale'
  assert.equal((await call({ action: 'write', slug, markdown: 'Rejected stale create', expectedSha256: '0'.repeat(64) })).ok, false)
  const written = await call({ action: 'write', slug, markdown: 'Valid create after refusal' })
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.equal(written.rev, 1)
})

test('find skips oversized or invalid notes with a visible limitation and returns bounded matches', async () => {
  writeFileSync(vaultPath('notes', 'find-large.md'), 'MATCH'.repeat(60_000))
  writeFileSync(vaultPath('notes', 'find-invalid.md'), Buffer.from([0xff, 0xff]))
  await call({ action: 'write', slug: 'find-normal', markdown: 'MATCH small note' })
  const result = await call({ action: 'find', query: 'MATCH' })
  assert.equal(result.ok, true)
  assert.ok(result.notes.some(row => row.path === 'notes/find-normal.md'))
  assert.ok(result.notes.every(row => row.size <= 262144))
  assert.ok(Array.isArray(result.limitations) && result.limitations.length >= 2)
})

test('a human edit between note snapshot and transaction prepare is preserved with both conflict copies', async () => {
  const slug = 'snapshot-race', first = await call({ action: 'write', slug, markdown: 'Managed base' })
  const edited = readFileSync(first.path, 'utf8').replace('Managed base', 'Human edit during prepare')
  const result = child(`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const originalRead=fs.readFileSync;let changed=false;fs.readFileSync=(path,...args)=>{
      if(path===${JSON.stringify(first.path)}&&!changed){changed=true;fs.writeFileSync(path,${JSON.stringify(edited)})}return originalRead(path,...args)};syncBuiltinESMExports();
    ${registerChild}
    const result=await call({action:'write',slug:${JSON.stringify(slug)},markdown:'Assistant pending replacement'});
    assert.equal(result.code,'note.conflict');assert.equal(fs.readFileSync(${JSON.stringify(first.path)},'utf8'),${JSON.stringify(edited)});
    assert.equal(fs.readFileSync(result.currentPath,'utf8'),${JSON.stringify(edited)});assert.ok(fs.readFileSync(result.proposedPath,'utf8').includes('Assistant pending replacement'));
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(first.path, 'utf8'), edited)
})

test('an edit after prepare keeps the single-writer core degraded and preserves current and proposed bytes', () => {
  const isolated = mkdtempSync(join(base, 'note-prepared-race-'))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    ${registerChild}
    const first=await call({action:'write',slug:'prepared-edit',markdown:'Original managed note'});assert.equal(first.ok,true);
    const human=fs.readFileSync(first.path,'utf8').replace('Original managed note','Human edit after prepare');
    const originalRename=fs.renameSync;let changed=false;fs.renameSync=(from,to)=>{
      const result=originalRename(from,to);if(!changed&&String(to).endsWith('index.json')){changed=true;fs.writeFileSync(first.path,human)}return result};syncBuiltinESMExports();
    const updated=await call({action:'write',slug:'prepared-edit',markdown:'Prepared proposed note'});assert.equal(updated.ok,false);
    assert.equal(fs.readFileSync(first.path,'utf8'),human);
    const {recoverOperations,storageStatus}=await import(${JSON.stringify(pathToFileURL(resolve('src/host/store.ts')).href)});
    assert.throws(()=>recoverOperations(),/冲突|conflict|degraded/i);assert.equal(storageStatus().writer,'single-process');
    const journal=fs.readFileSync(join(process.env.DSH_BUTLER_HOME,'store-operations.jsonl'),'utf8').trim().split('\\n').map(line=>JSON.parse(line));
    const prepared=journal.filter(row=>row.phase==='prepared'&&row.kind==='note.write').at(-1);
    assert.ok(prepared.writes.some(row=>row.content.includes('Prepared proposed note')));
    assert.equal(journal.some(row=>row.phase==='committed'&&row.operationId===prepared.operationId),false);
    assert.equal(fs.readFileSync(first.path,'utf8'),human);
  `], { cwd: process.cwd(), env: { ...process.env, DSH_BUTLER_VAULT: join(isolated, 'vault'), DSH_BUTLER_HOME: join(isolated, 'state') }, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
})

test('an explicit current SHA accepts a manual edit into its own complete revision before replacement', async () => {
  const slug = 'accept-manual-write', first = await call({ action: 'write', slug, markdown: 'Managed content', sources: ['Managed citation'] })
  const original = readFileSync(first.path, 'utf8')
  const edited = original.replace('Managed content', 'Human edited content').replace('Managed citation', 'Human citation')
  writeFileSync(first.path, edited)
  const read = await call({ action: 'read', slug })
  const written = await call({ action: 'write', slug, markdown: 'Reviewed replacement', expectedSha256: read.sha256 })
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.equal(written.rev, 3)
  const history = await call({ action: 'history', slug })
  assert.deepEqual(history.revisions.map(row => row.rev), [3, 2, 1])
  assert.equal(history.revisions[1].kind, 'manual')
  assert.equal(history.revisions[1].sha256, hash(edited))
  assert.equal((await call({ action: 'read', slug, revision: 2 })).body, edited)
  assert.equal((await call({ action: 'read', slug, revision: 1 })).body, original)
  const next = await call({ action: 'append', slug, markdown: 'Normal maintenance resumes' })
  assert.equal(next.ok, true)
  assert.equal(next.rev, 4)
})

test('an explicit current SHA append uses the accepted human body and sources as its base', async () => {
  const slug = 'accept-manual-append', first = await call({ action: 'write', slug, title: 'Managed title', markdown: 'Managed base', sources: ['Managed source'] })
  const edited = readFileSync(first.path, 'utf8').replace('title: Managed title', 'title: Human title').replace('Managed base', 'Human maintained base').replace('Managed source', 'Human maintained source')
  writeFileSync(first.path, edited)
  const read = await call({ action: 'read', slug })
  const appended = await call({ action: 'append', slug, markdown: 'New supplement', sources: ['New source'], expectedSha256: read.sha256 })
  assert.equal(appended.ok, true, JSON.stringify(appended))
  assert.equal(appended.rev, 3)
  const current = await call({ action: 'read', slug })
  assert.match(current.body, /title: Human title/)
  assert.match(current.body, /Human maintained base[\s\S]*Human maintained source[\s\S]*New supplement/)
  assert.doesNotMatch(current.body, /Managed base|Managed source/)
  assert.equal((await call({ action: 'read', slug, revision: 2 })).body, edited)
})

test('an explicit current SHA restore preserves the manual preimage and creates a further restored revision', async () => {
  const slug = 'accept-manual-restore', first = await call({ action: 'write', slug, markdown: 'Original restorable body', sources: ['Original source'] })
  const original = readFileSync(first.path, 'utf8'), edited = original.replace('Original restorable body', 'Human changed body')
  writeFileSync(first.path, edited)
  const restored = await call({ action: 'restore', slug, revision: 1, expectedSha256: hash(edited) })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.equal(restored.rev, 3)
  assert.equal(body((await call({ action: 'read', slug })).body), body(original))
  assert.equal((await call({ action: 'read', slug, revision: 2 })).body, edited)
  assert.equal((await call({ action: 'history', slug })).revisions[0].restoredFrom, 1)
})

test('a newer manual edit after an explicit SHA snapshot still conflicts and preserves both latest contents', async () => {
  const slug = 'accept-manual-race', first = await call({ action: 'write', slug, markdown: 'Managed base' })
  const original = readFileSync(first.path, 'utf8'), accepted = original.replace('Managed base', 'Human version A'), latest = original.replace('Managed base', 'Human version B')
  writeFileSync(first.path, accepted)
  const result = child(`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const originalRead=fs.readFileSync;let changed=false;fs.readFileSync=(path,...args)=>{
      if(path===${JSON.stringify(first.path)}&&!changed){changed=true;fs.writeFileSync(path,${JSON.stringify(latest)})}return originalRead(path,...args)};syncBuiltinESMExports();
    ${registerChild}
    const result=await call({action:'append',slug:${JSON.stringify(slug)},markdown:'Proposed after review',expectedSha256:${JSON.stringify(hash(accepted))}});
    assert.equal(result.code,'note.conflict');assert.equal(fs.readFileSync(${JSON.stringify(first.path)},'utf8'),${JSON.stringify(latest)});
    assert.equal(fs.readFileSync(result.currentPath,'utf8'),${JSON.stringify(latest)});
    const proposed=fs.readFileSync(result.proposedPath,'utf8');assert.ok(proposed.includes('Proposed after review'));assert.ok(proposed.includes('Human version A'));assert.equal(proposed.includes('Managed base'),false);
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(first.path, 'utf8'), latest)
})

test('accepted manual revision and replacement recover together after a crash before note replacement', async () => {
  const slug = 'accept-manual-crash', first = await call({ action: 'write', slug, markdown: 'Managed original' })
  const original = readFileSync(first.path, 'utf8'), edited = original.replace('Managed original', 'Complete human original')
  writeFileSync(first.path, edited)
  const crashed = child(`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const originalRename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(first.path)})process.exit(77);return originalRename(from,to)};syncBuiltinESMExports();
    ${registerChild}
    const result=await call({action:'write',slug:${JSON.stringify(slug)},markdown:'Recovered new managed body',expectedSha256:${JSON.stringify(hash(edited))}});
    assert.equal(result.ok,true,JSON.stringify(result));
  `)
  assert.equal(crashed.status, 77, crashed.stderr)
  assert.equal(readFileSync(first.path, 'utf8'), edited)
  const restarted = child(`${registerChild}
    const current=await call({action:'read',slug:${JSON.stringify(slug)}});assert.equal(current.rev,3);assert.ok(current.body.includes('Recovered new managed body'));
    const manual=await call({action:'read',slug:${JSON.stringify(slug)},revision:2});assert.equal(manual.body,${JSON.stringify(edited)});
    const first=await call({action:'read',slug:${JSON.stringify(slug)},revision:1});assert.equal(first.body,${JSON.stringify(original)});
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
})

test('same write operation and expected SHA replay the original successful result across restart without writes', () => {
  const slug = 'operation-replay-write', initial = notes.writeNote({ slug, markdown: 'Initial body' }, 'write')
  const input = { slug, markdown: 'Exactly once replacement', sources: ['Original request source'], expectedSha256: initial.sha256, operationId: 'note-replay-write' }
  const first = notes.writeNote(input, 'write')
  assert.equal(first.rev, 2)
  const journal = join(home, 'state', 'store-operations.jsonl'), before = hash(readFileSync(journal)), current = readFileSync(first.path, 'utf8')
  assert.deepEqual(notes.writeNote(input, 'write'), first)
  assert.equal(hash(readFileSync(journal)), before)
  assert.equal(readFileSync(first.path, 'utf8'), current)
  assert.equal(notes.noteHistory(slug).totalRevisions, 2)
  const restarted = child(`
    const notes=await import(${JSON.stringify(pathToFileURL(resolve('src/host/notes.ts')).href)});
    assert.deepEqual(notes.writeNote(${JSON.stringify(input)},'write'),${JSON.stringify(first)});
    assert.equal(notes.noteHistory(${JSON.stringify(slug)}).totalRevisions,2);
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.equal(hash(readFileSync(journal)), before)
})

for (const action of ['append', 'restore']) {
  test(`${action} replays the committed result before evaluating its now-stale expected SHA`, () => {
    const slug = `operation-replay-${action}`, first = notes.writeNote({ slug, markdown: 'Original' }, 'write')
    const prior = action === 'restore' ? notes.writeNote({ slug, markdown: 'Other body' }, 'write') : first
    const input = { slug, markdown: action === 'append' ? 'Single supplement' : undefined, expectedSha256: prior.sha256, operationId: `note-replay-${action}` }
    const revision = action === 'restore' ? 1 : undefined, result = notes.writeNote(input, action, revision)
    const current = readFileSync(first.path, 'utf8'), count = notes.noteHistory(slug).totalRevisions
    assert.deepEqual(notes.writeNote(input, action, revision), result)
    assert.equal(readFileSync(first.path, 'utf8'), current)
    assert.equal(notes.noteHistory(slug).totalRevisions, count)
  })
}

test('reusing a committed operation ID with a different note payload is refused without journal or note changes', () => {
  const slug = 'operation-payload', input = { slug, title: 'Request title', markdown: 'Original request', sources: ['Source A'], limitations: ['Limit A'], operationId: 'note-payload-bound' }
  const first = notes.writeNote(input, 'write'), current = readFileSync(first.path, 'utf8'), journal = join(home, 'state', 'store-operations.jsonl'), before = hash(readFileSync(journal))
  for (const changed of [
    { markdown: 'Changed request' }, { sources: ['Source B'] }, { title: 'Changed title' }, { limitations: ['Limit B'] },
    { expectedSha256: first.sha256 }, { slug: 'a-different-target' }, { time: '2026-10-15T10:00:00.000Z' },
  ]) assert.throws(() => notes.writeNote({ ...input, ...changed }, 'write'), /operationId|payload|请求|重复/i)
  assert.throws(() => notes.writeNote(input, 'append'), /operationId|payload|请求|重复/i)
  assert.equal(hash(readFileSync(journal)), before)
  assert.equal(readFileSync(first.path, 'utf8'), current)
  assert.equal(notes.noteHistory(slug).totalRevisions, 1)
  assert.equal(existsSync(vaultPath('notes', 'a-different-target.md')), false)
})

test('replaying a successful operation after a later manual edit returns its old result and preserves the edit', () => {
  const slug = 'operation-human-edit', prior = notes.writeNote({ slug, markdown: 'Before operation' }, 'write')
  const input = { slug, markdown: 'Committed result', expectedSha256: prior.sha256, operationId: 'note-replay-after-human' }, first = notes.writeNote(input, 'write')
  const edited = readFileSync(first.path, 'utf8').replace('Committed result', 'Human edited after success')
  writeFileSync(first.path, edited)
  const before = notes.noteHistory(slug)
  assert.deepEqual(notes.writeNote(input, 'write'), first)
  assert.equal(readFileSync(first.path, 'utf8'), edited)
  assert.deepEqual(notes.noteHistory(slug), before)
})

test('a replay cannot bypass corrupted revision history or a damaged core journal', () => {
  const slug = 'operation-damaged-history', input = { slug, markdown: 'Committed', operationId: 'note-replay-damage' }, first = notes.writeNote(input, 'write')
  const history = notes.noteHistory(slug), current = readFileSync(first.path, 'utf8')
  writeFileSync(history.revisions[0].path, 'damaged revision')
  assert.throws(() => notes.writeNote(input, 'write'), /损坏|SHA256|备份|history/i)
  assert.equal(readFileSync(first.path, 'utf8'), current)
  const isolated = mkdtempSync(join(base, 'note-replay-journal-'))
  const checked = child(`
    import fs from 'node:fs';import {join} from 'node:path';
    process.env.DSH_BUTLER_HOME=${JSON.stringify(join(isolated, 'state'))};process.env.DSH_BUTLER_VAULT=${JSON.stringify(join(isolated, 'vault'))};
    const notes=await import(${JSON.stringify(pathToFileURL(resolve('src/host/notes.ts')).href)});
    const input={slug:'bad-journal',markdown:'Body',operationId:'bad-journal-op'},first=notes.writeNote(input,'write');
    const before=fs.readFileSync(first.path,'utf8');fs.appendFileSync(join(process.env.DSH_BUTLER_HOME,'store-operations.jsonl'),'{torn\\n');
    assert.throws(()=>notes.writeNote(input,'write'),/损坏|degraded|JSON|journal/i);assert.equal(fs.readFileSync(first.path,'utf8'),before);
  `)
  assert.equal(checked.status, 0, checked.stderr)
})

test('a prepared note operation recovers once and retries with the original request result', () => {
  const slug = 'operation-crash-replay', initial = notes.writeNote({ slug, markdown: 'Before interrupted operation' }, 'write')
  const input = { slug, markdown: 'Recovered exactly once', expectedSha256: initial.sha256, operationId: 'note-replay-crash' }
  const crashed = child(`
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(initial.path)})process.exit(77);return original(from,to)};syncBuiltinESMExports();
    const notes=await import(${JSON.stringify(pathToFileURL(resolve('src/host/notes.ts')).href)});notes.writeNote(${JSON.stringify(input)},'write');
  `)
  assert.equal(crashed.status, 77, crashed.stderr)
  const restarted = child(`
    const notes=await import(${JSON.stringify(pathToFileURL(resolve('src/host/notes.ts')).href)});
    const result=notes.writeNote(${JSON.stringify(input)},'write');assert.equal(result.rev,2);assert.equal(result.ok,true);
    assert.deepEqual(notes.writeNote(${JSON.stringify(input)},'write'),result);assert.equal(notes.noteHistory(${JSON.stringify(slug)}).totalRevisions,2);
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
})

test('a persisted conflict result also binds its original request and replays without adding conflict copies', () => {
  const slug = 'operation-conflict-replay', first = notes.writeNote({ slug, markdown: 'Managed original' }, 'write')
  writeFileSync(first.path, readFileSync(first.path, 'utf8').replace('Managed original', 'Human current'))
  const input = { slug, markdown: 'Proposed current', operationId: 'note-conflict-op' }, result = notes.writeNote(input, 'write'), before = notes.noteHistory(slug)
  assert.equal(result.code, 'note.conflict')
  assert.deepEqual(notes.writeNote(input, 'write'), result)
  assert.deepEqual(notes.noteHistory(slug), before)
  assert.throws(() => notes.writeNote({ ...input, markdown: 'A different proposal' }, 'write'), /operationId|payload|请求|重复/i)
})
