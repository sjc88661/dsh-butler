import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {EventEmitter} from 'node:events'
const base=resolve('tests/.tmp');mkdirSync(base,{recursive:true})
const home=mkdtempSync(join(base,'workspace-usage-'))
process.env.DSH_BUTLER_VAULT=join(home,'vault');process.env.DSH_BUTLER_HOME=join(home,'state')
const ledger=await import('../src/host/ledger.ts')
const {ensureVault,vaultPath}=await import('../src/host/vault.ts');ensureVault()
ledger.setButlerSessionIds(['topic-a','topic-b'])
for(const row of [
  {sessionId:'topic-a',turn:1,step:1,inputTokens:10,outputTokens:2,cacheReadTokens:30,totalTokens:42},
  {sessionId:'child-a',rootSessionId:'topic-a',turn:1,step:1,inputTokens:3,outputTokens:2,totalTokens:5},
  {sessionId:'topic-a',callId:'title-a',callKind:'auxiliary',purpose:'session-title',usageState:'unknown'},
  {sessionId:'topic-b',turn:1,step:1,totalTokens:900},
  {sessionId:'dsh-source',turn:1,step:1,totalTokens:300},
  {totalTokens:33},
])ledger.addUsage({...row,provider:'unpriced-test',model:'unpriced-test'})

test('theme usage includes its own auxiliary and child calls but never other themes, sources or unknown ownership',()=>{
  assert.equal(typeof ledger.sessionUsageTotals,'function','A theme needs an independently scoped usage roll-up')
  const usage=ledger.sessionUsageTotals('topic-a')
  assert.equal(usage.calls,3);assert.equal(usage.totalTokens,47)
  assert.equal(usage.assistantCalls,2);assert.equal(usage.auxiliaryCalls,1)
  assert.equal(usage.withoutUsage,1);assert.equal(usage.pricedCalls,0);assert.equal(usage.unpricedCalls,2)
  assert.equal(usage.byPurpose['session-title'].withoutUsage,1)
  assert.equal(ledger.sessionUsageTotals('topic-b').totalTokens,900)
  assert.equal(ledger.sessionUsageTotals('empty-topic').calls,0)
})

test('the workspace read endpoint returns only the requested managed theme and cannot fall back to global usage',async()=>{
  const {registerWorkspaceApi}=await import('../src/host/workspace-api.ts'),routes=[]
  const stop=registerWorkspaceApi({webServer:{register:route=>{routes.push(route);return()=>{}}}},
    {workspace:{owns:id=>id==='topic-a',snapshot:()=>({sessions:[]})},sources:{},organization:{}})
  const route=routes.find(row=>row.path==='/dsh-butler/api/workspace/usage')
  assert.ok(route,'Theme usage must be exposed through the same local owner API')
  const before=readFileSync(vaultPath('ledger','usage.jsonl'))
  const request=async sessionId=>{
    const req=Object.assign(new EventEmitter(),{method:'GET',url:'/dsh-butler/api/workspace/usage?'+new URLSearchParams({sessionId}),
      socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:19394',origin:'http://127.0.0.1:19394'}})
    let result;await route.handler(req,{statusCode:0,setHeader(){},end(body){result={status:this.statusCode,body:JSON.parse(body)}}});return result
  }
  const own=await request('topic-a');assert.equal(own.status,200);assert.equal(own.body.sessionId,'topic-a');assert.equal(own.body.usage.totalTokens,47)
  assert.equal((await request('topic-b')).status,400);assert.equal((await request('')).status,400)
  assert.deepEqual(readFileSync(vaultPath('ledger','usage.jsonl')),before,'Read-only review cannot append usage')
  stop()
})
