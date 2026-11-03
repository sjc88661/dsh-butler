import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixtureParent = resolve('tests/.tmp')
mkdirSync(fixtureParent, { recursive: true })
const fixture = mkdtempSync(join(fixtureParent, 'storage-'))
process.env.DSH_BUTLER_VAULT = join(fixture, 'vault')
process.env.DSH_BUTLER_HOME = join(fixture, 'state')
const vault = await import('../src/host/vault.ts')
const ledger = await import('../src/host/ledger.ts')
const store = await import('../src/host/store.ts').catch(() => ({}))
const tasksFile = vault.vaultPath('ledger', 'tasks.jsonl')
const pendingFile = vault.statePath('pending.json')
const memosFile = vault.statePath('memos.json')
const journalFile = vault.statePath('store-operations.jsonl')
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const task = { id: 'old', title: '保留原始任务', status: 'pending', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' }

function removeOwned(path) {
  if (!existsSync(path)) return
  assert.ok(realpathSync(path).startsWith(realpathSync(fixtureParent) + sep))
  rmSync(path, { recursive: true, force: true })
}
beforeEach(() => {
  removeOwned(vault.VAULT_HOME)
  removeOwned(vault.STATE_HOME)
  vault.ensureVault()
})
after(() => removeOwned(fixture))
function requireStore() { assert.equal(typeof store.commitFiles, 'function', '可恢复的本地存储 API 应存在') }
function journalRows() { return readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
function child(script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve('.'), env: { ...process.env }, encoding: 'utf8', windowsHide: true,
  })
}
const ledgerUrl = pathToFileURL(resolve('src/host/ledger.ts')).href

test('readText only returns undefined for ENOENT and propagates other read failures', () => {
  assert.equal(vault.readText(join(fixture, 'missing.txt')), undefined)
  assert.throws(() => vault.readText(vault.VAULT_HOME), error => error.code !== 'ENOENT')
})

test('a malformed task line rejects upsert and preserves every original byte', () => {
  writeFileSync(tasksFile, `${JSON.stringify(task)}\n{"id":"torn"\n`)
  const before = digest(tasksFile)
  assert.throws(() => ledger.upsertTask('new', { title: '新任务' }), /损坏|degraded|corrupt|JSON/i)
  assert.equal(digest(tasksFile), before)
  assert.throws(() => ledger.listTasks(), /损坏|degraded|corrupt|JSON/i)
  requireStore()
  const status = store.storageStatus([tasksFile])
  assert.equal(status.degraded, true)
  assert.ok(status.diagnostics.some(issue => issue.line === 2 && issue.blocking))
})

test('corrupt pending JSON cannot turn into an empty queue or be overwritten', () => {
  writeFileSync(pendingFile, '[{"id":"old"')
  const before = digest(pendingFile)
  assert.throws(() => ledger.allPending(), /损坏|degraded|corrupt|JSON/i)
  assert.throws(() => ledger.addPending({ id: 'new', title: '标题', reason: '理由' }))
  assert.equal(digest(pendingFile), before)
})

test('memos with valid JSON but an invalid record shape fail closed', () => {
  for (const text of ['null', '{}', '[{"id":"old"}]', '']) {
    writeFileSync(memosFile, text)
    const before = digest(memosFile)
    assert.throws(() => ledger.listMemos(), /损坏|degraded|corrupt|schema|结构|JSON/i)
    assert.throws(() => ledger.addMemo({ id: 'new', text: '事实', source: 'user' }))
    assert.equal(digest(memosFile), before)
  }
})

test('task JSONL also validates record structure rather than only parsing JSON', () => {
  for (const row of [null, {}, { ...task, status: 'invented' }, { ...task, title: null }]) {
    writeFileSync(tasksFile, `${JSON.stringify(row)}\n`)
    const before = digest(tasksFile)
    assert.throws(() => ledger.upsertTask('new', { title: '新任务' }))
    assert.equal(digest(tasksFile), before)
  }
})

test('the first mutation backs up the original bytes and records a SHA256 manifest', () => {
  const original = Buffer.from(`${JSON.stringify(task)}\r\n`)
  writeFileSync(tasksFile, original)
  ledger.upsertTask('new', { title: '新增' }, { operationId: 'backup-once' })
  requireStore()
  const files = store.storageFiles(tasksFile)
  const manifest = JSON.parse(readFileSync(files.manifest, 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.originalPath, tasksFile)
  assert.equal(manifest.sha256, createHash('sha256').update(original).digest('hex'))
  assert.deepEqual(readFileSync(files.backup), original)
  ledger.upsertTask('new', { note: '再次更新' })
  assert.deepEqual(readFileSync(files.backup), original)
})

test('repeating an operationId returns its original result and never reapplies its patch', () => {
  const first = ledger.upsertTask('one', { title: '原题' }, { operationId: 'create-one', time: '2026-10-15T01:00:00.000Z' })
  ledger.upsertTask('one', { note: '后续更新' }, { operationId: 'update-one' })
  const repeated = ledger.upsertTask('one', { title: '原题' }, { operationId: 'create-one', time: '2026-10-15T01:00:00.000Z' })
  assert.deepEqual(repeated, first)
  assert.equal(ledger.getTask('one').note, '后续更新')
  const operations = journalRows().filter(row => row.operationId === 'create-one')
  assert.deepEqual(operations.map(row => row.phase), ['prepared', 'committed'])
  assert.equal(operations[0].version, 1)
  assert.equal(operations[0].targetId, 'one')
  assert.equal(operations[0].time, '2026-10-15T01:00:00.000Z')
})

test('an operationId cannot be reused for another local target', () => {
  ledger.upsertTask('one', { title: '一' }, { operationId: 'stable-op' })
  const before = digest(tasksFile)
  assert.throws(() => ledger.upsertTask('two', { title: '二' }, { operationId: 'stable-op' }), /operation|操作|冲突/i)
  assert.equal(digest(tasksFile), before)
})

test('retrying a status operation on a later date does not append another daily entry', () => {
  ledger.upsertTask('dated', { title: '跨日重试' })
  const first = ledger.setTaskStatus('dated', 'done', '已完成', 'UTC', { operationId: 'dated-status', time: '2026-10-15T10:00:00.000Z' })
  const daily = vault.vaultPath('daily', '2026-10-15.md')
  const before = digest(daily)
  assert.deepEqual(ledger.setTaskStatus('dated', 'done', '已完成', 'UTC', { operationId: 'dated-status', time: '2026-10-16T10:00:00.000Z' }), first)
  assert.equal(digest(daily), before)
  assert.equal(existsSync(vault.vaultPath('daily', '2026-10-16.md')), false)
})

test('a status transition commits attempts and origin with its daily entry while protecting identity', () => {
  const initial = ledger.upsertTask('transition', { title: '一次状态提交', attempts: 0 })
  const changed = ledger.setTaskStatus('transition', 'running', '开始', 'UTC', {
    operationId: 'single-transition', time: '2026-10-15T03:00:00.000Z',
  }, {
    attempts: 1, lastTransitionOriginId: 'human-42',
    id: 'forged', createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z', status: 'done',
  })
  assert.equal(changed.attempts, 1)
  assert.equal(changed.lastTransitionOriginId, 'human-42')
  assert.equal(changed.id, 'transition')
  assert.equal(changed.createdAt, initial.createdAt)
  assert.equal(changed.updatedAt, '2026-10-15T03:00:00.000Z')
  assert.equal(changed.status, 'running')
  assert.equal(changed.note, '开始')
  const prepared = journalRows().filter(row => row.operationId === 'single-transition' && row.phase === 'prepared')
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].writes.length, 2)
  assert.equal(JSON.parse(prepared[0].writes[0].content.trim()).attempts, 1)
  assert.match(prepared[0].writes[1].content, /进行中.*一次状态提交.*开始/)
})

test('a process stopped after prepare recovers the same operation exactly once', () => {
  const crashed = child(`
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === ${JSON.stringify(tasksFile)}) process.exit(77); return original(from, to) };
    syncBuiltinESMExports();
    const ledger = await import(${JSON.stringify(ledgerUrl)});
    ledger.upsertTask('recover', {title:'可恢复'}, {operationId:'crash-op',time:'2026-10-15T02:00:00.000Z'});
  `)
  assert.equal(crashed.status, 77, crashed.stderr)
  const restarted = child(`
    import assert from 'node:assert/strict'; const ledger = await import(${JSON.stringify(ledgerUrl)});
    const first = ledger.getTask('recover'); assert.equal(first.title,'可恢复');
    assert.deepEqual(ledger.upsertTask('recover',{title:'可恢复'},{operationId:'crash-op'}),first);
    console.log(JSON.stringify(ledger.listTasks()));
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.equal(JSON.parse(restarted.stdout).length, 1)
  assert.deepEqual(journalRows().filter(row => row.operationId === 'crash-op').map(row => row.phase), ['prepared', 'committed'])
})

test('a recovery filesystem failure is exposed as degraded StorageError', () => {
  requireStore()
  const crashed = child(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync; fs.renameSync=(from,to)=>{if(to===${JSON.stringify(tasksFile)})process.exit(79);return original(from,to)}; syncBuiltinESMExports();
    const ledger=await import(${JSON.stringify(ledgerUrl)}); ledger.upsertTask('blocked',{title:'暂时无法恢复'},{operationId:'blocked-recovery'});
  `)
  assert.equal(crashed.status, 79, crashed.stderr)
  const restarted = child(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync; fs.renameSync=(from,to)=>{if(to===${JSON.stringify(tasksFile)}){const error=new Error('simulated access failure');error.code='EACCES';throw error}return original(from,to)}; syncBuiltinESMExports();
    const store=await import(${JSON.stringify(pathToFileURL(resolve('src/host/store.ts')).href)});
    assert.throws(()=>store.recoverOperations(),error=>error instanceof store.StorageError);
    assert.equal(store.storageStatus().degraded,true);
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
})

test('approval and memo decisions are journaled and remain idempotent across restart', () => {
  ledger.addPending({ id: 'approval', title: '确认', reason: '需确认' }, { operationId: 'pending-add' })
  const accepted = ledger.decidePending('approval', 'approved', { operationId: 'pending-answer' })
  ledger.addMemo({ id: 'memo', text: '偏好', source: 'butler' }, { operationId: 'memo-add' })
  const confirmed = ledger.decideMemo('memo', 'confirmed', { operationId: 'memo-answer' })
  const restarted = child(`
    import assert from 'node:assert/strict'; const ledger=await import(${JSON.stringify(ledgerUrl)});
    assert.deepEqual(ledger.decidePending('approval','approved',{operationId:'pending-answer'}),${JSON.stringify(accepted)});
    assert.deepEqual(ledger.decideMemo('memo','confirmed',{operationId:'memo-answer'}),${JSON.stringify(confirmed)});
    assert.equal(ledger.allPending().length,1); assert.equal(ledger.listMemos().length,1);
  `)
  assert.equal(restarted.status, 0, restarted.stderr)
  for (const operationId of ['pending-add', 'pending-answer', 'memo-add', 'memo-answer']) {
    assert.deepEqual(journalRows().filter(row => row.operationId === operationId).map(row => row.phase), ['prepared', 'committed'])
  }
})

test('a changed migration backup refuses later business writes', () => {
  requireStore()
  writeFileSync(tasksFile, `${JSON.stringify(task)}\n`)
  ledger.upsertTask('one', { title: '一' })
  writeFileSync(store.storageFiles(tasksFile).backup, 'tampered backup')
  const before = digest(tasksFile)
  assert.throws(() => ledger.upsertTask('two', { title: '二' }), /备份|SHA256|degraded/)
  assert.equal(digest(tasksFile), before)
})

test('invalid UTF-8 state is preserved rather than decoded and rewritten', () => {
  writeFileSync(tasksFile, Buffer.concat([Buffer.from(`${JSON.stringify(task)}\n`), Buffer.from([0xff])]))
  const before = digest(tasksFile)
  assert.throws(() => ledger.upsertTask('two', { title: '二' }), /UTF-8|degraded/)
  assert.equal(digest(tasksFile), before)
})

test('multi-file recovery first detects human edits and leaves all files untouched', () => {
  requireStore()
  const profile = vault.vaultPath('profile.md')
  writeFileSync(profile, 'old profile\n')
  writeFileSync(memosFile, '[]\n')
  const storeUrl = pathToFileURL(resolve('src/host/store.ts')).href
  const crashed = child(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync;
    fs.renameSync=(from,to)=>{if(to===${JSON.stringify(memosFile)})process.exit(78);return original(from,to)}; syncBuiltinESMExports();
    const {commitFiles}=await import(${JSON.stringify(storeUrl)});
    commitFiles({operationId:'memory-transaction',kind:'memo.confirm',targetId:'memo-1',writes:[
      {path:${JSON.stringify(profile)},content:'confirmed profile\\n'},
      {path:${JSON.stringify(memosFile)},content:'[]\\n',format:'json'}]});
  `)
  assert.equal(crashed.status, 78, crashed.stderr)
  writeFileSync(profile, 'human edit\n')
  const memoBefore = digest(memosFile), profileBefore = digest(profile), journalBefore = digest(journalFile)
  assert.throws(() => store.recoverOperations(), /冲突|conflict|degraded/i)
  assert.equal(digest(profile), profileBefore)
  assert.equal(digest(memosFile), memoBefore)
  assert.equal(digest(journalFile), journalBefore)
})

test('multi-file recovery completes the remaining local snapshots exactly once', () => {
  requireStore()
  const profile = vault.vaultPath('profile.md')
  writeFileSync(profile, 'old\n'); writeFileSync(memosFile, '[]\n')
  const storeUrl = pathToFileURL(resolve('src/host/store.ts')).href
  const content = JSON.stringify([{ id: 'confirmed' }]) + '\n'
  const crashed = child(`
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync; fs.renameSync=(from,to)=>{if(to===${JSON.stringify(memosFile)})process.exit(80);return original(from,to)}; syncBuiltinESMExports();
    const {commitFiles}=await import(${JSON.stringify(storeUrl)});
    commitFiles({operationId:'local-group',kind:'test.group',targetId:'memo',writes:[{path:${JSON.stringify(profile)},content:'new\\n'},{path:${JSON.stringify(memosFile)},content:${JSON.stringify(content)},format:'json'}]});
  `)
  assert.equal(crashed.status, 80, crashed.stderr)
  assert.equal(readFileSync(profile, 'utf8'), 'new\n')
  assert.equal(readFileSync(memosFile, 'utf8'), '[]\n')
  store.recoverOperations(); store.recoverOperations()
  assert.equal(readFileSync(profile, 'utf8'), 'new\n')
  assert.equal(readFileSync(memosFile, 'utf8'), content)
  assert.deepEqual(journalRows().filter(row => row.operationId === 'local-group').map(row => row.phase), ['prepared', 'committed'])
})

test('boot restores state and marks running tasks interrupted without replaying external actions', () => {
  const external = join(fixture, 'external-actions.txt')
  writeFileSync(external, 'performed once\n')
  ledger.upsertTask('running', { title: '外部动作', status: 'running' }, { operationId: 'external-local-state' })
  const before = digest(external)
  const restarted = child(`const ledger=await import(${JSON.stringify(ledgerUrl)}); console.log(JSON.stringify(ledger.markInterruptedOnBoot()));`)
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.equal(JSON.parse(restarted.stdout)[0].status, 'interrupted')
  assert.equal(digest(external), before)
  assert.deepEqual(ledger.markInterruptedOnBoot(), [])
})

test('bad append-only receipts and usage report skipped rows without blocking a task write', () => {
  requireStore()
  const receipts = vault.vaultPath('ledger', 'receipts.jsonl'), usage = vault.vaultPath('ledger', 'usage.jsonl')
  writeFileSync(receipts, '{broken\n{"at":"2026-10-15T00:00:00Z","tool":"read","ok":true}\n')
  writeFileSync(usage, '{broken\n{"at":"2026-10-15T00:00:00Z","totalTokens":3}\n')
  assert.equal(ledger.receipts().length, 1)
  assert.equal(ledger.usageRecords().length, 1)
  const issues = store.storageStatus([receipts, usage]).diagnostics
  assert.equal(issues.length, 2)
  assert.ok(issues.every(issue => issue.line === 1 && issue.blocking === false))
  assert.equal(ledger.upsertTask('safe', { title: '有效任务' }).title, '有效任务')
})

test('a malformed operations journal fails closed and preserves snapshot and journal bytes', () => {
  ledger.upsertTask('one', { title: '存在' })
  writeFileSync(journalFile, `${readFileSync(journalFile, 'utf8')}{torn\n`)
  const snapshotBefore = digest(tasksFile), journalBefore = digest(journalFile)
  assert.throws(() => ledger.upsertTask('two', { title: '二' }), /损坏|degraded|corrupt|JSON/i)
  assert.equal(digest(tasksFile), snapshotBefore)
  assert.equal(digest(journalFile), journalBefore)
})

test('atomic writes use unique temporary names and clean temporary files after success', () => {
  const fixedTime = Date.now
  Date.now = () => 7
  try {
    const file = join(fixture, 'atomic.txt')
    const collision = `${file}.tmp-${process.pid}-7`
    writeFileSync(collision, 'unrelated existing temporary data')
    vault.writeText(file, 'one'); vault.writeText(file, 'two')
    assert.equal(readFileSync(collision, 'utf8'), 'unrelated existing temporary data')
    assert.equal(readFileSync(file, 'utf8'), 'two')
    assert.deepEqual(readdirSync(fixture).filter(name => name.startsWith('atomic.txt.tmp-')), [collision.slice(fixture.length + 1)])
  } finally { Date.now = fixedTime }
})

test('commitState preserves an edit made after its snapshot was read', () => {
  requireStore()
  writeFileSync(memosFile, '[]\n')
  const edited = '[{"id":"human-edit"}]\n'
  assert.throws(() => store.commitState({
    path: memosFile, format: 'json', fallback: [], validate: Array.isArray,
  }, { operationId: 'optimistic-edit', kind: 'memo.test', targetId: 'memo' }, current => {
    writeFileSync(memosFile, edited)
    return { value: [...current, { id: 'stale-update' }], result: true }
  }), /冲突|conflict|已被修改/i)
  assert.equal(readFileSync(memosFile, 'utf8'), edited)
  assert.equal(existsSync(journalFile), false, '冲突应在prepared写入前拒绝')
})

test('commitFiles checks the caller supplied expectedBefore hash before preparing', () => {
  requireStore()
  writeFileSync(memosFile, '[]\n')
  const expectedBefore = digest(memosFile)
  const edited = '[{"id":"another-writer"}]\n'
  writeFileSync(memosFile, edited)
  assert.throws(() => store.commitFiles({
    operationId: 'explicit-before', kind: 'memo.test', targetId: 'memo',
    writes: [{ path: memosFile, content: '[{"id":"stale"}]\n', format: 'json', expectedBefore }],
  }), /冲突|conflict|已被修改/i)
  assert.equal(readFileSync(memosFile, 'utf8'), edited)
  assert.equal(existsSync(journalFile), false)
})

test('a missing snapshot is decoded from the same missing read without a second file read', () => {
  requireStore()
  const created = '[{"id":"created-between-reads"}]\n'
  const result = child(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.readFileSync;let first=true;
    fs.readFileSync=(path,...args)=>{if(path===${JSON.stringify(memosFile)}&&first){first=false;fs.writeFileSync(path,${JSON.stringify(created)});const error=new Error('missing at snapshot read');error.code='ENOENT';throw error}return original(path,...args)};syncBuiltinESMExports();
    const {readSnapshot}=await import(${JSON.stringify(pathToFileURL(resolve('src/host/store.ts')).href)});
    const snapshot=readSnapshot({path:${JSON.stringify(memosFile)},format:'json',fallback:[],validate:Array.isArray});
    assert.deepEqual(snapshot,{value:[],expectedBefore:null});
    assert.equal(fs.readFileSync(${JSON.stringify(memosFile)},'utf8'),${JSON.stringify(created)});
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('a task status transaction preserves a human edit made during its snapshot read', () => {
  ledger.upsertTask('status-race', { title: '状态变更' })
  const edited = JSON.stringify({ ...ledger.getTask('status-race'), note: 'human edit while reading' }) + '\n'
  const result = child(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.readFileSync; let changed=false;
    fs.readFileSync=(path,...args)=>{const bytes=original(path,...args);if(path===${JSON.stringify(tasksFile)}&&!changed){changed=true;fs.writeFileSync(path,${JSON.stringify(edited)})}return bytes};syncBuiltinESMExports();
    const ledger=await import(${JSON.stringify(ledgerUrl)});
    assert.throws(()=>ledger.setTaskStatus('status-race','done','完成','UTC',{operationId:'status-race'}),/冲突|conflict|已被修改/i);
    assert.equal(fs.readFileSync(${JSON.stringify(tasksFile)},'utf8'),${JSON.stringify(edited)});
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('a task status transaction also preserves a daily edit made during its snapshot read', () => {
  ledger.upsertTask('daily-race', { title: '状态变更' })
  const daily = vault.vaultPath('daily', '2026-10-15.md'), edited = '# edited by human\n'
  writeFileSync(daily, '# before\n')
  const tasksBefore = digest(tasksFile)
  const result = child(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.readFileSync; let changed=false;
    fs.readFileSync=(path,...args)=>{const bytes=original(path,...args);if(path===${JSON.stringify(daily)}&&!changed){changed=true;fs.writeFileSync(path,${JSON.stringify(edited)})}return bytes};syncBuiltinESMExports();
    const ledger=await import(${JSON.stringify(ledgerUrl)});
    assert.throws(()=>ledger.setTaskStatus('daily-race','done','完成','UTC',{operationId:'daily-race',time:'2026-10-15T05:00:00.000Z'}),/冲突|conflict|已被修改/i);
    assert.equal(fs.readFileSync(${JSON.stringify(daily)},'utf8'),${JSON.stringify(edited)});
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(digest(tasksFile), tasksBefore)
})

function preparedFor(writes) {
  return {
    version: 1, phase: 'prepared', operationId: 'untrusted-target', time: '2026-10-15T05:00:00.000Z',
    targetId: 'local-state', kind: 'test.recovery', writes: writes.map(write => ({
      format: 'text', beforeSha256: existsSync(write.path) ? digest(write.path) : null,
      afterSha256: createHash('sha256').update(write.content).digest('hex'), ...write,
    })),
  }
}

test('recovery refuses a journal target outside the configured state and vault roots before any writes', () => {
  requireStore()
  const safe = vault.vaultPath('profile.md'), outside = join(fixture, 'outside-root.txt')
  writeFileSync(safe, 'safe before\n'); writeFileSync(outside, 'outside before\n')
  writeFileSync(journalFile, JSON.stringify(preparedFor([
    { path: safe, content: 'safe after\n' }, { path: outside, content: 'outside after\n' },
  ])) + '\n')
  const safeBefore = digest(safe), outsideBefore = digest(outside), journalBefore = digest(journalFile)
  assert.throws(() => store.recoverOperations(), /禁止|边界|root|路径|outside/i)
  assert.equal(digest(safe), safeBefore)
  assert.equal(digest(outside), outsideBefore)
  assert.equal(digest(journalFile), journalBefore)
})

test('recovery cannot overwrite journals, migration backups, or SHA256 manifests', () => {
  requireStore()
  for (const target of [store.storageFiles(tasksFile).backup, store.storageFiles(tasksFile).manifest, journalFile]) {
    if (target !== journalFile) writeFileSync(target, 'preserved sidecar\n')
    writeFileSync(journalFile, JSON.stringify(preparedFor([{ path: target, content: 'overwritten\n' }])) + '\n')
    const before = digest(target)
    assert.throws(() => store.recoverOperations(), /禁止|边界|root|路径|outside/i)
    assert.equal(digest(target), before)
  }
})

test('a custom operations journal still obeys the configured root boundary', () => {
  requireStore()
  const outsideJournal = join(fixture, 'outside-journal.jsonl')
  writeFileSync(outsideJournal, '')
  assert.throws(() => store.recoverOperations(outsideJournal), /禁止|边界|root|路径|outside/i)
})

test('a junction in the closest existing parent cannot escape the configured roots', () => {
  requireStore()
  const outside = join(fixture, 'junction-target'), link = vault.vaultPath('escape')
  mkdirSync(outside)
  symlinkSync(outside, link, 'junction')
  const target = join(link, 'not-created', 'escaped.txt')
  writeFileSync(journalFile, JSON.stringify(preparedFor([{ path: target, content: 'escaped\n' }])) + '\n')
  assert.throws(() => store.recoverOperations(), /禁止|边界|root|路径|outside/i)
  assert.equal(existsSync(join(outside, 'not-created')), false)
})

for (const damage of ['missing', 'changed']) {
  test(`recovery preserves the original snapshot when its prepared migration backup is ${damage}`, () => {
    requireStore()
    writeFileSync(tasksFile, `${JSON.stringify(task)}\n`)
    const before = digest(tasksFile)
    const crashed = child(`
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.renameSync; fs.renameSync=(from,to)=>{if(to===${JSON.stringify(tasksFile)})process.exit(81);return original(from,to)}; syncBuiltinESMExports();
      const ledger=await import(${JSON.stringify(ledgerUrl)}); ledger.upsertTask('after-prepare',{title:'准备后中断'},{operationId:'prepared-backup'});
    `)
    assert.equal(crashed.status, 81, crashed.stderr)
    const backup = store.storageFiles(tasksFile).backup
    if (damage === 'missing') rmSync(backup)
    else writeFileSync(backup, 'changed after prepare\n')
    const journalBefore = digest(journalFile)
    assert.throws(() => store.recoverOperations(), /备份|SHA256|backup/i)
    assert.equal(digest(tasksFile), before)
    assert.equal(digest(journalFile), journalBefore)
  })
}
