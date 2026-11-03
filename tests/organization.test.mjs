import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const base=resolve('tests/.tmp'); mkdirSync(base,{recursive:true})
const root=mkdtempSync(join(base,'organization-'))
process.env.DSH_BUTLER_VAULT=join(root,'vault'); process.env.DSH_BUTLER_HOME=join(root,'state')
const {ensureVault,statePath}=await import('../src/host/vault.ts'); ensureVault()
let service
try { service=await import('../src/host/organization.ts') } catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND') throw error }
const source={provider:'dsh',sessionId:'source-one',eventId:'7'}
let excluded=false,version='v1',readCount=0
const sources={settings:()=>({codexEnabled:false,excludedConversations:excluded?['dsh:source-one']:[],excludedWorkspaces:[]}),
 async read(ref){readCount++; if(excluded)throw Error('来源已排除'); return {conversation:{key:'dsh:source-one',provider:'dsh',sessionId:'source-one',title:'实际进展',project:'project',updatedAt:version,available:true},messages:[{id:'7',role:'assistant',text:'已完成原生引用导出；待核对论文年份。'}],version,truncated:false}},
 async list(){return {items:excluded?[]:[{key:'dsh:source-one',provider:'dsh',sessionId:'source-one',updatedAt:version}],status:[]}}}
const input={title:'项目进展',summary:'已完成引用导出，年份仍需核对。',decisions:['采用原生引用导出'],unconfirmed:['论文年份'],sources:[source],drafts:[{kind:'task',text:'核对论文年份'},{kind:'memory',text:'科研记录保留未确认项'}]}
const make=()=>new service.OrganizationService({sources,owns:id=>id==='butler-topic',file:statePath('organizations.json')})

test('organizing saves an actual sourced note and proposals; only explicit task confirmation creates pending work',async()=>{
 assert.ok(service,'Organization service must exist')
 const {listTasks}=await import('../src/host/ledger.ts'), api=make(),before=listTasks().length
 const doc=await api.save('butler-topic',input)
 assert.match(readFileSync(doc.path,'utf8'),/source-one[\s\S]*7/)
 assert.equal(listTasks().length,before);assert.equal(doc.drafts[0].status,'proposed')
 const same=await api.save('butler-topic',input);assert.equal(same.id,doc.id)
 const result=await api.decide(doc.drafts[0].id,'confirm')
 assert.equal(result.task.status,'pending');assert.equal(result.task.sessionId,'butler-topic')
 await api.decide(doc.drafts[0].id,'confirm'); assert.equal(listTasks().length,before+1)
 const memory=await api.decide(doc.drafts[1].id,'confirm')
 assert.match(memory.confirmationText,/请记住/);assert.equal(memory.draft.status,'proposed','Native memory confirmation remains required')
 const reopened=make();assert.equal((await reopened.list('butler-topic')).documents[0].id,doc.id)
})

test('source identities must match actual read messages; excluded or foreign sources cannot be saved or sent back to a model',async()=>{
 assert.ok(service,'Organization service must exist');const api=make()
 await assert.rejects(api.save('foreign-session',input),/管家/)
 await assert.rejects(api.save('butler-topic',{...input,sources:[{...source,eventId:'invented'}]}),/消息|来源/)
 excluded=true
 await assert.rejects(api.save('butler-topic',input),/排除/)
 assert.equal((await api.list('butler-topic',{forModel:true})).documents.length,0)
 excluded=false
})

test('source updates are visible and malformed organization state is preserved rather than replaced',async()=>{
 assert.ok(service,'Organization service must exist');const api=make();version='v2'
 const result=await api.list('butler-topic');assert.equal(result.documents[0].updated,true)
 const file=statePath('organizations.json'),original=readFileSync(file)
 writeFileSync(file,'{damaged-organization')
 await assert.rejects(api.list('butler-topic'),/JSON|损坏|degraded/)
 assert.equal(readFileSync(file,'utf8'),'{damaged-organization')
 writeFileSync(file,original)
 assert.ok(readCount>0)
})

test('two exact messages in the same conversation both retain verifiable citation identity',async()=>{
 assert.ok(service)
 const bounded={...sources,async read(ref){return {...await sources.read(ref),messages:[{id:ref.eventId,role:'assistant',text:`Actual message ${ref.eventId}`}]}}}
 const api=new service.OrganizationService({sources:bounded,owns:id=>id==='butler-topic',file:statePath('two-citations.json')})
 const doc=await api.save('butler-topic',{...input,sources:[source,{...source,eventId:'8'}],drafts:[]})
 assert.deepEqual(doc.citations.map(row=>row.eventId),['7','8'])
})

test('changing exclusions during multi-source metadata or confirmation reads cannot release stale content or create a task',async()=>{
 assert.ok(service)
 let denied=false,mode='',release,entered
 const gate=()=>new Promise(resolve=>{entered();release=resolve})
 const ref2={provider:'codex',sessionId:'source-two',eventId:'8'}
 const query={settings:()=>({codexEnabled:true,excludedWorkspaces:[],excludedConversations:denied?['dsh:source-one']:[]}),
  async read(ref){if(mode==='confirm'&&ref.sessionId===ref2.sessionId)await gate();return {conversation:{...ref,key:`${ref.provider}:${ref.sessionId}`,title:'Source',project:'project',updatedAt:'v1',available:true},messages:[{id:ref.eventId,text:'Actual source',role:'assistant'}],version:'v1',truncated:false}},
  async describe(ref){if(mode==='list'&&ref.sessionId===ref2.sessionId)await gate();return {key:`${ref.provider}:${ref.sessionId}`,provider:ref.provider,sessionId:ref.sessionId,updatedAt:'v1',available:true}},list:async()=>({items:[],status:[]})}
 const api=new service.OrganizationService({sources:query,owns:id=>id==='butler-topic',file:statePath('exclusion-race.json')})
 const doc=await api.save('butler-topic',{...input,sources:[source,ref2]})
 for(const nextMode of ['list','confirm']){
  denied=false;mode=nextMode;const waiting=new Promise(resolve=>{entered=resolve})
  const result=nextMode==='list'?api.list('butler-topic',{forModel:true}):api.decide(doc.drafts[0].id,'confirm')
  const failed=assert.rejects(result,/范围.*变化|变化.*范围/)
  await waiting;denied=true;release();await failed
 }
})

test('concurrent confirmation and dismissal serialize before task promotion without orphan work or degraded state',async()=>{
 assert.ok(service);let pause=false,release,enter
 const query={...sources,async read(ref){if(pause){pause=false;enter();await new Promise(resolve=>{release=resolve})}return await sources.read(ref)}}
 const api=new service.OrganizationService({sources:query,owns:id=>id==='butler-topic',file:statePath('confirmation-race.json')})
 const doc=await api.save('butler-topic',{...input,title:'Concurrent draft'})
 pause=true;const waiting=new Promise(resolve=>{enter=resolve}),confirm=api.decide(doc.drafts[0].id,'confirm')
 const confirming=Promise.allSettled([confirm]);await waiting
 const dismiss=api.decide(doc.drafts[0].id,'dismiss');release()
 const results=[...(await confirming),...await Promise.allSettled([dismiss])]
 assert.ok(results.every(row=>row.status==='fulfilled'),JSON.stringify(results))
 assert.equal((await api.list('butler-topic')).drafts[0].status,'confirmed')
})

test('cached metadata from an unavailable provider is unknown rather than evidence of new content',async()=>{
 assert.ok(service)
 const metadata={...sources,describe:async()=>({key:'dsh:source-one',provider:'dsh',sessionId:'source-one',updatedAt:'v9',available:false})}
 const api=new service.OrganizationService({sources:metadata,owns:id=>id==='butler-topic',file:statePath('organizations.json')})
 const ui=await api.list('butler-topic');assert.equal(ui.documents[0].sourceUnavailable,true);assert.equal(ui.documents[0].updated,false)
 assert.equal((await api.list('butler-topic',{forModel:true})).documents.length,0)
})

test('confirmed draft status follows its own ledger task without rewriting the original organization snapshot',async()=>{
 const{upsertTask,listTasks}=await import('../src/host/ledger.ts')
 const file=statePath('task-projection.json'),api=new service.OrganizationService({sources,owns:id=>id==='butler-topic',file})
 const doc=await api.save('butler-topic',{...input,title:'Task projection',drafts:[{kind:'task',text:'只读任务投影'}]})
 const confirmed=await api.decide(doc.drafts[0].id,'confirm','butler-topic'),saved=readFileSync(file),count=listTasks().length
 upsertTask(confirmed.task.id,{status:'done'})
 const viewed=await api.list('butler-topic')
 assert.equal(viewed.drafts[0].taskStatus,'done','The UI needs current task state, not only the saved confirmation flag')
 assert.deepEqual(readFileSync(file),saved);assert.equal(listTasks().length,count)
 upsertTask(confirmed.task.id,{sessionId:'foreign-topic'})
 const unavailable=await api.list('butler-topic');assert.equal(unavailable.drafts[0].taskStatus,undefined);assert.equal(unavailable.drafts[0].taskUnavailable,true)
 assert.deepEqual(readFileSync(file),saved)
})
