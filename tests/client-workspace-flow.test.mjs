import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const feature = await import('../src/client/workspace-actions.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })
const ready = id => ({ id, title: '日常管家', state: 'live', cwd: 'E:/vault', titlePinned: true,
  ready: { id, workspaceId: 'workspace-butler', canonicalCwd: 'E:/vault', attached: true, flushed: true } })

test('workspace entry opens only the host-acknowledged native conversation', async () => {
  assert.equal(typeof feature.openWorkspaceConversation, 'function', 'dedicated workspace entry is implemented')
  const opened = [], requests = []
  globalThis.fetch = async (url, init) => { requests.push([url, init]); return { ok: true, json: async () => ({ ok: true, session: ready('topic-b') }) } }
  const result = await feature.openWorkspaceConversation({ get: key => key === 'uiWorkspace' ? { openSession: id => opened.push(id) } : undefined })
  assert.equal(result.ok, true); assert.deepEqual(opened, ['topic-b'])
  assert.equal(requests[0][0], '/dsh-butler/api/workspace/action')
  assert.equal(requests[0][1].headers['X-Butler-UI'], '1')
  assert.equal(requests[0][1].credentials, 'same-origin')
  assert.deepEqual(JSON.parse(requests[0][1].body), { action: 'open' })
})

test('unprepared workspace sessions never trigger navigation', async () => {
  assert.equal(typeof feature.openWorkspaceConversation, 'function')
  const opened = []
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, session: { ...ready('bad'), ready: undefined } }) })
  const result = await feature.openWorkspaceConversation({ get: () => ({ openSession: id => opened.push(id) }) })
  assert.equal(result.ok, false); assert.deepEqual(opened, [])
})

test('an obsolete launchpad response cannot navigate or queue a later pane', async () => {
  let resolveResponse, current = true
  const opened = [], sidebar = { mounted: { getSnapshot: () => 'home', subscribe: () => () => {} }, openTab: kind => opened.push(kind) }
  globalThis.fetch = () => new Promise(resolve => { resolveResponse = resolve })
  const ctx = { get: key => key === 'uiWorkspace' ? { openSession: id => opened.push(id) } : key === 'sidebarRight' ? sidebar : undefined }
  const pending = feature.openWorkspaceConversation(ctx, undefined, 'sources', () => current)
  current = false
  resolveResponse({ ok: true, json: async () => ({ ok: true, session: ready('home') }) })
  assert.equal((await pending).ok, false)
  assert.deepEqual(opened, [])
  assert.equal(feature.consumeWorkspacePaneHandoff(ctx, 'home').ok, false)
})

test('a stale source handoff cannot select references, prepare a draft or navigate after slow metadata', async () => {
  let resolveMetadata, notifyMetadata, current = true
  const metadataRequested = new Promise(resolve => { notifyMetadata = resolve }), events = []
  globalThis.fetch = async url => {
    events.push(url)
    if (url.includes('workspace/action')) return { ok: true, json: async () => ({ ok: true, session: ready('stale-destination') }) }
    if (url.includes('sources/select')) return { ok: true, json: async () => ({ ok: true, selected: [] }) }
    notifyMetadata()
    return await new Promise(resolve => { resolveMetadata = resolve })
  }
  const ctx = { get: key => key === 'uiWorkspace' ? { openSession: id => events.push(`open:${id}`) } : undefined }
  const pending = feature.handoffSourceToWorkspace(ctx, { provider: 'dsh', sessionId: 'old-source' }, () => current)
  await metadataRequested; current = false
  resolveMetadata({ ok: true, json: async () => ({ ok: true, selected: [] }) })
  assert.equal((await pending).ok, false)
  assert.equal(events.some(event => event.includes('sources/select')), false)
  assert.equal(events.some(event => event.startsWith('open:')), false)
  assert.equal(feature.workspaceDraft('stale-destination'), undefined)
})

test('draft insertion is one explicit revision-guarded edit and never submits', () => {
  assert.equal(typeof feature.insertWorkspaceDraft, 'function')
  const writes = [], input = { captureInsertion: () => ({ start: 4, end: 4, draftRev: 9 }),
    insertText: (text, span) => { writes.push({ text, span }); return true }, submit: () => assert.fail('must not send') }
  assert.equal(feature.insertWorkspaceDraft(input, '整理进展').ok, true)
  assert.deepEqual(writes, [{ text: '整理进展', span: { start: 4, end: 4, draftRev: 9 } }])
})

test('selection, changed revision, and missing public insertion API retain the prepared draft', () => {
  assert.equal(typeof feature.insertWorkspaceDraft, 'function')
  const selected = { captureInsertion: () => ({ start: 1, end: 5, draftRev: 1 }), insertText: () => assert.fail('cannot overwrite selected draft') }
  assert.equal(feature.insertWorkspaceDraft(selected, '新指令').ok, false)
  assert.equal(feature.insertWorkspaceDraft({ captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => false }, '新指令').ok, false)
  assert.equal(feature.insertWorkspaceDraft({}, '新指令').ok, false)
})

test('source handoff stores only a reference and unsent instruction scoped to the exact destination', () => {
  assert.equal(typeof feature.prepareWorkspaceDraft, 'function')
  feature.prepareWorkspaceDraft('topic-a', '请整理', { provider: 'dsh', sessionId: 'source-a' })
  assert.equal(feature.workspaceDraft('topic-b'), undefined)
  assert.equal(feature.workspaceDraft('topic-a').text, '请整理')
  assert.deepEqual(feature.workspaceDraft('topic-a').source, { provider: 'dsh', sessionId: 'source-a' })
  feature.clearWorkspaceDraft('topic-a')
  assert.equal(feature.workspaceDraft('topic-a'), undefined)
})

test('handoff authorizes reference selection before navigation and never submits a model turn', async () => {
  assert.equal(typeof feature.handoffSourceToWorkspace, 'function')
  const order = []
  globalThis.fetch = async (url, init) => {
    order.push(url)
    const body = url.includes('workspace/action') ? { ok: true, session: ready('home') }
      : url.includes('sources/select') ? { ok: true, selected: [{ provider: 'dsh', sessionId: 'origin' }] }
        : { ok: true, selected: [] }
    return { ok: true, json: async () => body }
  }
  const result = await feature.handoffSourceToWorkspace({ get: key => key === 'uiWorkspace' ? { openSession: id => order.push(`open:${id}`) } : undefined }, { provider: 'dsh', sessionId: 'origin' })
  assert.equal(result.ok, true)
  assert.equal(order.at(-1), 'open:home')
  assert.equal(order.some(value => value.includes('sources/select')), true)
  assert.equal(feature.workspaceDraft('home').source.sessionId, 'origin')
  feature.clearWorkspaceDraft('home')
})

test('left source entry opens a native chat before consuming a one-shot sources-pane handoff', async () => {
  assert.equal(typeof feature.consumeWorkspacePaneHandoff, 'function')
  const events = [], sidebar = { mounted: { getSnapshot: () => 'home', subscribe: () => () => {} }, openTab: kind => events.push(`pane:${kind}`) }
  const ctx = { get: key => key === 'uiWorkspace' ? { openSession: id => events.push(`chat:${id}`) } : key === 'sidebarRight' ? sidebar : undefined }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, session: ready('home') }) })
  assert.equal((await feature.openWorkspaceConversation(ctx, undefined, 'sources')).ok, true)
  assert.deepEqual(events, ['chat:home'])
  assert.equal(feature.consumeWorkspacePaneHandoff(ctx, 'foreign').ok, false)
  assert.equal(feature.consumeWorkspacePaneHandoff(ctx, 'home').ok, true)
  assert.deepEqual(events, ['chat:home', 'pane:butler-workspace'])
  assert.equal(feature.consumeWorkspacePaneHandoff(ctx, 'home').ok, false)
})

function paneTransitionEnvironment(initial = 'ordinary-chat') {
  let mounted = initial, listener
  const opened = [], sidebar = { mounted: { getSnapshot: () => mounted, subscribe: callback => { listener = callback; return () => { listener = undefined } } }, openTab: kind => opened.push(kind) }
  const ctx = { get: key => key === 'uiWorkspace' ? { openSession() {} } : key === 'sidebarRight' ? sidebar : undefined }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, session: ready('home') }) })
  return { ctx, opened, transition(value) { mounted = value; listener?.() } }
}

test('source-pane handoff survives native old-to-unmounted-to-destination navigation', async () => {
  const env = paneTransitionEnvironment()
  await feature.openWorkspaceConversation(env.ctx, undefined, 'sources')
  env.transition('ordinary-chat') // Initial old mount may repeat before React commits.
  env.transition(undefined) // The old Session unmounts before the new one is mounted.
  assert.equal(feature.consumeWorkspacePaneHandoff(env.ctx, 'home').ok, false)
  env.transition('home')
  assert.equal(feature.consumeWorkspacePaneHandoff(env.ctx, 'home').ok, true)
  assert.deepEqual(env.opened, ['butler-workspace'])
})

test('source-pane handoff cancels an unrelated nonempty mount before destination and cannot reopen later', async () => {
  const env = paneTransitionEnvironment()
  await feature.openWorkspaceConversation(env.ctx, undefined, 'sources')
  env.transition(undefined); env.transition('another-chat'); env.transition('home')
  assert.equal(feature.consumeWorkspacePaneHandoff(env.ctx, 'home').ok, false)
  assert.deepEqual(env.opened, [])
})

test('leaving an arrived destination cancels a not-yet-consumed source-pane handoff', async () => {
  const env = paneTransitionEnvironment()
  await feature.openWorkspaceConversation(env.ctx, undefined, 'sources')
  env.transition('home'); env.transition(undefined); env.transition('ordinary-chat'); env.transition('home')
  assert.equal(feature.consumeWorkspacePaneHandoff(env.ctx, 'home').ok, false)
  assert.deepEqual(env.opened, [])
})

test('leaving an arrived destination for a global panel cancels the pane even when the same chat returns', async () => {
  const env = paneTransitionEnvironment()
  await feature.openWorkspaceConversation(env.ctx, undefined, 'sources')
  env.transition('home'); env.transition(undefined); env.transition('home')
  assert.equal(feature.consumeWorkspacePaneHandoff(env.ctx, 'home').ok, false)
  assert.deepEqual(env.opened, [])
})

test('source list carries server pagination beyond 200 entries without pretending the first page is complete', async () => {
  const { fetchSources } = await import('../src/client/workspace-api.ts')
  const urls = []
  globalThis.fetch = async url => { urls.push(url); const offset = new URL(url, 'http://localhost').searchParams.get('offset'); return { ok: true, json: async () => ({ ok: true,
    items: Array.from({ length: offset === '200' ? 1 : 200 }, (_, index) => ({ sessionId: `id-${Number(offset ?? 0) + index}` })),
    status: [], settings: {}, selected: [], truncated: offset !== '200', ...(offset === '200' ? {} : { nextOffset: 200 }) }) } }
  const first = await fetchSources({ provider: 'dsh', limit: '200' })
  assert.equal(first.items.length, 200); assert.equal(first.truncated, true); assert.equal(first.nextOffset, 200)
  const next = await fetchSources({ provider: 'dsh', limit: '200', offset: String(first.nextOffset) })
  assert.equal(next.items.length, 1); assert.equal(next.items[0].sessionId, 'id-200'); assert.equal(next.nextOffset, undefined)
  assert.equal(new URL(urls.at(-1), 'http://localhost').searchParams.get('offset'), '200')
})

test('preparing organization rechecks the exact selected references and only creates an unsent per-theme draft',async()=>{
 assert.equal(typeof feature.prepareOrganizationDraft,'function')
 const refs=[{provider:'dsh',sessionId:'science',eventId:'118'},{provider:'codex',sessionId:'plan',eventId:'turn:item'}],requests=[]
 globalThis.fetch=async(url,options)=>{requests.push([url,options]);return{ok:true,json:async()=>({ok:true,selected:refs})}}
 const result=await feature.prepareOrganizationDraft('prepare-theme')
 assert.equal(result.ok,true);assert.equal(requests.length,1);assert.equal(requests[0][1].method,'GET')
 const draft=feature.workspaceDraft('prepare-theme');assert.match(draft.text,/118/);assert.match(draft.text,/turn:item/);assert.match(draft.text,/不.*(?:确认|执行)/)
 assert.equal(feature.workspaceDraft('another-theme'),undefined)
 feature.clearWorkspaceDraft('prepare-theme')
})

test('preparing organization preserves an existing draft and discards empty or obsolete source ranges',async()=>{
 assert.equal(typeof feature.prepareOrganizationDraft,'function')
 feature.prepareWorkspaceDraft('keep-theme','现有待发送记忆指令')
 globalThis.fetch=async()=>assert.fail('An existing draft must not be replaced')
 assert.equal((await feature.prepareOrganizationDraft('keep-theme')).ok,false);assert.equal(feature.workspaceDraft('keep-theme').text,'现有待发送记忆指令')
 feature.clearWorkspaceDraft('keep-theme')
 globalThis.fetch=async()=>({ok:true,json:async()=>({ok:true,selected:[]})})
 assert.equal((await feature.prepareOrganizationDraft('empty-theme')).ok,false);assert.equal(feature.workspaceDraft('empty-theme'),undefined)
 let resolve,current=true
 globalThis.fetch=()=>new Promise(done=>{resolve=done})
 const pending=feature.prepareOrganizationDraft('obsolete-theme',()=>current);current=false
 resolve({ok:true,json:async()=>({ok:true,selected:[{provider:'dsh',sessionId:'old-source',eventId:'1'}]})})
 assert.equal((await pending).ok,false);assert.equal(feature.workspaceDraft('obsolete-theme'),undefined)
})

test('ordinary-source handoff preserves an existing unsent destination draft before changing its scope',async()=>{
 feature.prepareWorkspaceDraft('protected-home','已有记忆确认指令')
 const paths=[],opened=[]
 globalThis.fetch=async url=>{paths.push(url);return{ok:true,json:async()=>({ok:true,session:ready('protected-home')})}}
 const result=await feature.handoffSourceToWorkspace({get:key=>key==='uiWorkspace'?{openSession:id=>opened.push(id)}:undefined},{provider:'dsh',sessionId:'new-source'})
 assert.equal(result.ok,false);assert.equal(feature.workspaceDraft('protected-home').text,'已有记忆确认指令')
 assert.equal(paths.length,1);assert.deepEqual(opened,[])
 feature.clearWorkspaceDraft('protected-home')
})
