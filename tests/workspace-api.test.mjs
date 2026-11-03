import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
let api
try {api=await import('../src/host/workspace-api.ts')}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error}
function setup(extra={}){
 const routes=[],calls=[],decisions=[]
 const workspace={snapshot:()=>({root:'vault',sessions:[{id:'butler'}]}),owns:id=>id==='butler',ids:()=>['butler'],open:async id=>{calls.push(id);return {id:'butler',state:'live'}}}
 const sources={list:async()=>({items:[],status:[]}),read:async ref=>({ref,messages:[]}),settings:()=>({codexEnabled:false,excludedWorkspaces:[],excludedConversations:[]}),selected:()=>[],configure:()=>({}),select:async(_id,refs)=>refs}
 const stop=api.registerWorkspaceApi({webServer:{register:route=>{routes.push(route);return()=>routes.splice(routes.indexOf(route),1)}}},{workspace,sources,organization:{list:async()=>({documents:[],drafts:[]}),decide:async(...args)=>{decisions.push(args);return{draft:{id:args[0],status:'confirmed'}}}},...extra})
 const request=async(path,method='GET',payload,extra={})=>{
  const req=Object.assign(new EventEmitter(),{method,url:path,socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:19394',origin:'http://127.0.0.1:19394','content-type':'application/json','x-butler-ui':'1'},...extra})
  let result;const promise=routes.find(route=>route.path===path.split('?')[0]).handler(req,{statusCode:0,setHeader(){},end(body){result={status:this.statusCode,body:JSON.parse(body)}}})
  queueMicrotask(()=>{if(payload!==undefined)req.emit('data',JSON.stringify(payload));req.emit('end')});await promise;return result
 }
 return{calls,decisions,routes,request,stop}
}

test('optional daily trial is visible and the same exact source boundary protects UI reads and selection',async()=>{
 const ref={provider:'dsh',sessionId:'research',eventId:'118'}
 const app=setup({trial:()=>({enabled:true,sessionAllowed:true,refs:[ref],limits:{maxRequests:6}})})
 assert.ok(app.routes.some(row=>row.path==='/dsh-butler/api/workspace/trial'),'daily trial policy must be readable')
 assert.equal((await app.request('/dsh-butler/api/workspace/trial?sessionId=butler')).body.trial.limits.maxRequests,6)
 assert.equal((await app.request('/dsh-butler/api/source?provider=dsh&sessionId=research')).body.ref.eventId,'118')
 assert.equal((await app.request('/dsh-butler/api/source?provider=dsh&sessionId=research&eventId=119')).status,403)
 assert.equal((await app.request('/dsh-butler/api/sources/select','POST',{butlerSessionId:'butler',refs:[{provider:'dsh',sessionId:'foreign'}]})).status,403)
 assert.deepEqual((await app.request('/dsh-butler/api/sources/select','POST',{butlerSessionId:'butler',refs:[{provider:'dsh',sessionId:'research'}]})).body.selected,[ref])
 app.stop()
})
test('trial search never delegates to unrestricted source search or reads other events',async()=>{
 const ref={provider:'dsh',sessionId:'research',eventId:'118'},read=[]
 const app=setup({trial:()=>({enabled:true,refs:[ref]}),sources:{
  settings:()=>({}),selected:()=>[],search:()=>{throw Error('unrestricted search must not run')},list:()=>{throw Error('unrestricted listing must not run')},
  describe:async()=>({provider:'dsh',sessionId:'research',key:'dsh:research',title:'Research',project:'test',available:true}),
  read:async value=>{read.push(value);return{messages:[{text:'approved summary'}]}}
 }})
 const result=await app.request('/dsh-butler/api/sources?q=approved&butlerSessionId=butler')
 assert.equal(result.status,200);assert.equal(result.body.items.length,1);assert.deepEqual(read,[ref]);app.stop()
})
test('a stopped trial keeps its source restrictions instead of restoring global access',async()=>{
 const app=setup({trial:()=>({enabled:false,refs:[{provider:'dsh',sessionId:'research',eventId:'118'}]})})
 assert.equal((await app.request('/dsh-butler/api/source?provider=dsh&sessionId=foreign')).status,403)
 app.stop()
})
test('local UI can open a ready managed session without executing a model and cross-origin/remote requests are denied',async()=>{
 assert.ok(api,'Workspace routes must exist');const app=setup()
 assert.equal((await app.request('/dsh-butler/api/workspace')).status,200)
 assert.equal((await app.request('/dsh-butler/api/workspace/action','POST',{action:'open'})).body.session.id,'butler')
 assert.equal(app.calls.length,1)
 const rejected=await app.request('/dsh-butler/api/workspace/action','POST',{action:'open'},{headers:{host:'127.0.0.1:19394',origin:'https://untrusted.example','content-type':'application/json','x-butler-ui':'1'}})
 assert.equal(rejected.status,403);assert.equal(app.calls.length,1)
 assert.equal((await app.request('/dsh-butler/api/sources','GET',undefined,{socket:{remoteAddress:'192.0.2.1'}})).status,403)
 assert.equal((await app.request('/dsh-butler/api/workspace/action','POST',{action:'open'},{headers:{host:'127.0.0.1:19394'}})).status,403)
 app.stop()
})
test('source selections must target a managed session and unsupported actions fail explicitly',async()=>{
 assert.ok(api,'Workspace routes must exist');const app=setup()
 assert.equal((await app.request('/dsh-butler/api/sources/select','POST',{butlerSessionId:'foreign',refs:[]})).status,400)
 assert.equal((await app.request('/dsh-butler/api/workspace/action','POST',{action:'execute'})).status,400)
 app.stop()
})
test('native first-match routing supports both organization reads and explicit draft decisions on one path',async()=>{
 const app=setup()
 assert.equal((await app.request('/dsh-butler/api/organize?sessionId=butler')).status,200)
 const result=await app.request('/dsh-butler/api/organize','POST',{action:'confirm',id:'draft-1',sessionId:'butler'})
 assert.equal(result.status,200)
 assert.equal(result.body.draft.status,'confirmed')
 assert.deepEqual(app.decisions,[['draft-1','confirm','butler']])
 assert.equal((await app.request('/dsh-butler/api/organize?sessionId=butler')).status,200)
 assert.equal(app.routes.filter(route=>route.path==='/dsh-butler/api/organize').length,1)
 assert.equal((await app.request('/dsh-butler/api/organize','DELETE')).status,405)
 app.stop();assert.equal(app.routes.length,0)
})
test('unconfigured daily trial degrades explicitly instead of showing fabricated limits',async()=>{
 // 没有安装试用服务：快照必须是 available:false + 具体原因，trial 为空。
 const app=setup()
 const off=(await app.request('/dsh-butler/api/workspace/trial?sessionId=butler')).body
 assert.equal(off.available,false)
 assert.equal(off.code,'trial-not-configured')
 assert.ok(off.reason.length>0)
 assert.equal(off.trial,null)
 // 显式禁用/账本不可读同样透传自己的原因，不伪造限额。
 const disabled=setup({trial:()=>undefined,trialAvailability:()=>({available:false,code:'trial-disabled',reason:'trial.enabled=false：试用限额未启用。'})})
 const body=(await disabled.request('/dsh-butler/api/workspace/trial?sessionId=butler')).body
 assert.equal(body.available,false)
 assert.equal(body.code,'trial-disabled')
 assert.equal(body.trial,null)
 app.stop();disabled.stop()
})
