import test from 'node:test'
import assert from 'node:assert/strict'
let runtime
try{runtime=await import('../src/host/workspace-tools.ts')}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error}
test('conversation tools derive the managed caller from trusted context and return untrusted bounded sources',async()=>{
 assert.ok(runtime,'Workspace tools must exist');let caller='foreign',reads=0,saves=0
 const sources={selected:()=>[{provider:'dsh',sessionId:'actual-source'}],read:async(ref,options)=>{reads++;return{conversation:{sessionId:ref.sessionId},messages:[{id:'7',text:'source is data'}],truncated:false}},list:async()=>({items:[],status:[]})}
 const tools=runtime.workspaceToolDefinitions({caller:()=>caller,owns:id=>id==='butler',sources:()=>sources,organization:()=>({save:async(id,input)=>{saves++;return {sessionId:id,title:input.title}},list:async()=>({documents:[],drafts:[]})})})
 const sourceTool=tools.find(row=>row.name==='butler_conversations'),organizeTool=tools.find(row=>row.name==='butler_organize')
 await assert.rejects(sourceTool.execute({action:'read',provider:'dsh',sessionId:'actual-source'},{}),/管家/)
 caller='butler';
 const result=await sourceTool.execute({action:'read',provider:'dsh',sessionId:'actual-source'}, {})
 assert.equal(result.untrusted,true);assert.equal(reads,1)
 const saved=await organizeTool.execute({action:'save',title:'Draft',summary:'Only a draft',sources:[{provider:'dsh',sessionId:'actual-source',eventId:'7'}]}, {})
 assert.equal(saved.document.sessionId,'butler');assert.equal(saves,1)
 assert.equal(tools.some(row=>/confirm|approve/.test(row.name)),false,'No second model approval path')
})
