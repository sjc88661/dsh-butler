import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,existsSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {homedir} from 'node:os'
import vm from 'node:vm'
const ts=createRequire(join(process.env.DSH_CHECKOUT||join(homedir(),'dsh-harness'),'package.json'))('typescript')
const pause=()=>new Promise(resolve=>setImmediate(resolve))
function carrier(){
  let cursor=0,dirty=true,component,props,tree,mounted=true,writes=0,obsoleteWrites=0;const states=[],effects=new Map(),pending=[],requests=[],cache=new Map()
  const react={createElement:(type,props,...children)=>({type,props,children}),useSyncExternalStore:(_subscribe,get)=>get(),
    useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{writes++;if(!mounted){obsoleteWrites++;return}states[i]=typeof value==='function'?value(states[i]):value;dirty=true}]},
    useRef(initial){const i=cursor++;return states[i]??(states[i]={current:initial})},
    useEffect(run,deps){const i=cursor++,old=effects.get(i);if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index])))pending.push(()=>{old?.cleanup?.();effects.set(i,{deps,cleanup:run()})})}}
  function load(path){
    if(path==='react')return react
    const file=resolve(path);if(cache.has(file))return cache.get(file).exports
    const module={exports:{}};cache.set(file,module)
    const source=ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023,esModuleInterop:true}}).outputText
    vm.runInNewContext(source,{module,exports:module.exports,require:id=>load(id==='react'?id:resolve(dirname(file),id)),URLSearchParams,AbortController,
      window:{setInterval:()=>1,clearInterval(){}},fetch:(path,options)=>new Promise(resolve=>requests.push({path,options,resolve}))},{filename:file})
    return module.exports
  }
  async function flush(){for(let round=0;round<3;round++){while(dirty){dirty=false;cursor=0;tree=component(props);while(pending.length)pending.shift()()}await pause()}}
  const unmount=()=>{for(const effect of effects.values())effect.cleanup?.();effects.clear();mounted=false}
  return{load,requests,get tree(){return tree},get writes(){return writes},get obsoleteWrites(){return obsoleteWrites},flush,unmount,
    async mount(path,name,value){component=load(path)[name];assert.equal(typeof component,'function');props=value;await flush()},
    async mountComponent(fn,value){unmount();states.length=0;pending.length=0;mounted=true;dirty=true;component=fn;props=value;await flush()},
    async remount(value){unmount();states.length=0;pending.length=0;mounted=true;dirty=true;props=value;await flush()},
    async update(value){props=value;dirty=true;await flush()},reply(index,value){requests[index].resolve({ok:true,json:async()=>value})}}
}
function nodes(tree){return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.children)]:[]}
const button=(tree,label)=>nodes(tree).find(row=>row.type==='button'&&row.children.includes(label))
const ref={provider:'dsh',sessionId:'dsh-science',eventId:'118'}
const detail=source=>({ok:true,conversation:{title:'原始科研结论',provider:source.provider,sessionId:source.sessionId},messages:[{id:source.eventId,role:'assistant',text:'仍未确认的原文结论'}],version:'source-version'})

test('an exact DSH citation can open its original native conversation even when it is absent from the current source page',async()=>{
  const e=carrier(),opened=[],ctx={get:key=>key==='uiWorkspace'?{openSession:async id=>opened.push(id)}:undefined}
  await e.mount('src/client/workspace-sources.ts','ButlerSources',{ctx,sessionId:'theme-a',canSelect:true,initialRef:ref})
  e.reply(0,{ok:true,items:[],status:[],selected:[],settings:{codexEnabled:true,excludedConversations:[],excludedWorkspaces:[]}});e.reply(1,detail(ref));await e.flush()
  assert.match(JSON.stringify(e.tree),/仍未确认的原文结论/)
  const open=button(e.tree,'打开原会话');assert.ok(open,'Exact citation detail needs a native return action')
  open.props.onClick();await e.flush();assert.deepEqual(opened,['dsh-science'])
})

test('Codex citation details stay read-only and do not offer a DSH session jump',async()=>{
  const e=carrier(),source={...ref,provider:'codex',sessionId:'codex-thread'}
  await e.mount('src/client/workspace-sources.ts','ButlerSources',{ctx:{},sessionId:'theme-a',canSelect:true,initialRef:source})
  e.reply(0,{ok:true,items:[],status:[],selected:[],settings:{codexEnabled:true,excludedConversations:[],excludedWorkspaces:[]}});e.reply(1,detail(source));await e.flush()
  assert.match(JSON.stringify(e.tree),/仍未确认的原文结论/);assert.equal(button(e.tree,'打开原会话'),undefined)
})

test('theme usage shows exact reported tokens, unknown pricing and a scope separate from source history',async()=>{
  assert.ok(existsSync('src/client/workspace-usage.ts'),'The current native theme needs a visible usage summary')
  const e=carrier();await e.mount('src/client/workspace-usage.ts','ButlerWorkspaceUsage',{sessionId:'theme-a'})
  assert.equal(new URL(e.requests[0].path,'http://test').searchParams.get('sessionId'),'theme-a')
  e.reply(0,{ok:true,sessionId:'theme-a',usage:{calls:4,withoutUsage:0,totalTokens:37992,inputTokens:10781,outputTokens:1227,cacheReadTokens:25984,pricedCalls:0,cost:0,assistantCalls:4,auxiliaryCalls:0,
    byProviderModel:[{provider:'deepseek-account',model:'deepseek-flash',calls:4,withoutUsage:0,totalTokens:37992,inputTokens:10781,outputTokens:1227,cacheReadTokens:25984,cacheWriteTokens:0,
      pricedCalls:0,unpricedCalls:4,cost:0,costBases:[],unknownCostReasons:{'provider-no-price':4},failedCalls:0,cancelledCalls:0}]}});await e.flush()
  const text=JSON.stringify(e.tree);assert.match(text,/37,992/);assert.match(text,/未计价/);assert.match(text,/当前主题/);assert.match(text,/历史用量不计入/);assert.doesNotMatch(text,/¥0\.0000/)
  assert.match(text,/deepseek-account/);assert.match(text,/deepseek-flash/);assert.match(text,/未获得.*账户线路.*价格/);assert.match(text,/deepseek-official.*不能套用/)
  assert.match(text,/计价覆盖 0\/4/);assert.match(text,/费用未知/);assert.match(text,/token 限额.*硬边界/)
  await e.update({sessionId:'theme-b'});assert.doesNotMatch(JSON.stringify(e.tree),/37,992/,'Changing themes clears the previous usage before the next read')
  e.reply(1,{ok:true,sessionId:'theme-a',usage:{calls:4,totalTokens:37992}});await e.flush()
  assert.match(JSON.stringify(e.tree),/主题用量身份不匹配/);assert.doesNotMatch(JSON.stringify(e.tree),/37,992/)
})

test('cost review keeps mixed estimates partial and never labels a historical basis as an official price table',async()=>{
  const group={provider:'deepseek-account',model:'deepseek-flash',calls:2,withoutUsage:0,totalTokens:30,inputTokens:20,outputTokens:10,cacheReadTokens:0,cacheWriteTokens:0,
    pricedCalls:1,unpricedCalls:1,cost:0.5,costBases:['historical-account-policy'],unknownCostReasons:{'provider-no-price':1},failedCalls:0,cancelledCalls:0}
  const usage={...group,costBasis:'historical-account-policy',derivedCalls:0,newTokens:30,reasoningTokens:0,cacheHitRate:0,
    assistantCalls:2,auxiliaryCalls:0,liveCalls:2,backfilledCalls:0,sessions:1,butlerCalls:2,butlerNewTokens:30,butlerCost:0.5,scopeUnknown:0,byProviderModel:[group]}
  const e=carrier();await e.mount('src/client/panel.ts','ButlerWorkbench',{ctx:{}})
  assert.match(e.requests[0].path,/overview/)
  e.reply(0,{ok:true,generatedAt:'2026-10-22T03:00:00Z',timeZone:'Asia/Shanghai',vault:{home:'isolated-fixture',files:[]},
    ledger:{open:[],pending:[],recent:[],interrupted:[],usage},reminders:[],remindersAvailable:true});await e.flush()
  const text=JSON.stringify(e.tree)
  assert.match(text,/已计价部分估算 ¥0\.5000（1\/2 次；其余费用未知）/)
  assert.match(text,/historical-account-policy/);assert.match(text,/未获得.*账户线路.*价格/);assert.match(text,/token 限额.*硬边界/)
  assert.doesNotMatch(text,/官方价目表 historical-account-policy/)
  const {byProviderModel,...legacyUsage}=usage,index=e.requests.length
  button(e.tree,'刷新').props.onClick()
  e.reply(index,{ok:true,generatedAt:'2026-10-22T03:00:01Z',timeZone:'Asia/Shanghai',vault:{home:'isolated-fixture',files:[]},
    ledger:{open:[],pending:[],recent:[],interrupted:[],usage:legacyUsage},reminders:[],remindersAvailable:true});await e.flush()
  const legacyText=JSON.stringify(e.tree)
  assert.match(legacyText,/成本细分未提供/);assert.match(legacyText,/historical-account-policy/)
  assert.match(legacyText,/已计价部分估算 ¥0\.5000/);assert.doesNotMatch(legacyText,/官方价目表 historical-account-policy/)
})

test('a rejected native source navigation is reported instead of becoming an unhandled promise',async()=>{
  const e=carrier(),ctx={get:key=>key==='uiWorkspace'?{openSession:async()=>{throw new Error('原生会话不可用')}}:undefined}
  await e.mount('src/client/workspace-sources.ts','ButlerSources',{ctx,sessionId:'theme-a',canSelect:true,initialRef:ref})
  e.reply(0,{ok:true,items:[],status:[],selected:[],settings:{codexEnabled:false,excludedConversations:[],excludedWorkspaces:[]}});e.reply(1,detail(ref));await e.flush()
  button(e.tree,'打开原会话').props.onClick();await e.flush();assert.match(JSON.stringify(e.tree),/原生会话不可用/)
})

test('the native right pane attaches usage to the exact managed theme',async()=>{
  const e=carrier();await e.mount('src/client/workspace-panel.ts','ButlerRightPane',{ctx:{},sessionId:'theme-a'})
  e.reply(0,{ok:true,workspace:{sessions:[{id:'theme-a'}]}});await e.flush()
  const usage=nodes(e.tree).find(node=>typeof node.type==='function'&&node.type.name==='ButlerWorkspaceUsage')
  assert.ok(usage);assert.equal(usage.props.sessionId,'theme-a');assert.equal(usage.props.key,'theme-a')
})

const sourceList=(selected=[],items=[])=>({ok:true,items,status:[],selected,settings:{codexEnabled:true,excludedConversations:[],excludedWorkspaces:[]}})
const sourceProps=(sessionId='theme-selection')=>({ctx:{},sessionId,canSelect:true})

test('selected exact messages remain visible and removing a conversation never widens it to a full-history selection',async()=>{
  const e=carrier(),second={...ref,eventId:'119'},other={provider:'codex',sessionId:'codex-plan',eventId:'plan-item'}
  await e.mount('src/client/workspace-sources.ts','ButlerSources',sourceProps())
  e.reply(0,sourceList([ref,second,other],[{...ref,key:'dsh:dsh-science',title:'原始科研结论',available:true,project:'project'}]));await e.flush()
  const selected=nodes(e.tree).find(node=>node.props?.['aria-label']==='本次整理参考范围');assert.ok(selected,'The exact reference range needs its own visible list')
  assert.match(JSON.stringify(selected),/118/);assert.match(JSON.stringify(selected),/119/)
  const row=nodes(e.tree).find(node=>node.type==='article'&&JSON.stringify(node).includes('原始科研结论'))
  assert.equal(button(row,'加入参考范围'),undefined)
  button(row,'移出此对话').props.onClick();await e.flush()
  assert.deepEqual(JSON.parse(e.requests[1].options.body).refs,[other])
})

test('source search conditions survive returning to the same theme and stay separate from another theme',async()=>{
  const e=carrier(),props=sourceProps('theme-filter-memory')
  await e.mount('src/client/workspace-sources.ts','ButlerSources',props);e.reply(0,sourceList());await e.flush()
  const input=nodes(e.tree).find(node=>node.type==='input'&&node.props?.placeholder==='标题或内容关键词')
  input.props.onChange({target:{value:'arxiv'}});await e.flush()
  nodes(e.tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await e.flush()
  await e.remount(props)
  assert.equal(nodes(e.tree).find(node=>node.type==='input'&&node.props?.placeholder==='标题或内容关键词').props.value,'arxiv')
  assert.match(e.requests.at(-1).path,/q=arxiv/)
  await e.remount(sourceProps('theme-other-filter'))
  assert.equal(nodes(e.tree).find(node=>node.type==='input'&&node.props?.placeholder==='标题或内容关键词').props.value,'')
})

test('late source reads and selection results cannot update a closed source pane',async()=>{
  const e=carrier();await e.mount('src/client/workspace-sources.ts','ButlerSources',{...sourceProps('theme-late-source'),initialRef:ref})
  e.reply(0,sourceList());await e.flush();e.unmount();e.reply(1,detail(ref));await pause()
  assert.equal(e.obsoleteWrites,0,'Closing a source view invalidates its raw-message read')
})

const organizationDocument={id:'org-ui-task',sessionId:'theme-a',title:'整理产物',summary:'只读整理',decisions:[],unconfirmed:[],sources:[],citations:[],createdAt:'2026-10-22T00:00:00Z',path:'E:/vault/note.md',
  drafts:[{id:'draft-task',kind:'task',text:'确认的事项',status:'confirmed',taskId:'todo-a',taskStatus:'done'}]}
async function resultsCarrier(){
  const e=carrier();await e.mount('src/client/workspace-panel.ts','ButlerRightPane',{ctx:{},sessionId:'theme-a'})
  e.reply(0,{ok:true,workspace:{sessions:[{id:'theme-a'},{id:'theme-b'}]}});await e.flush()
  const result=nodes(e.tree).find(node=>typeof node.type==='function'&&node.type.name==='OrganizationResults');assert.ok(result)
  return{e,result}
}

test('confirmed organization work opens its exact task and shows the current ledger status',async()=>{
  const{e,result}=await resultsCarrier(),opened=[]
  await e.mountComponent(result.type,{...result.props,showTask:id=>opened.push(id)})
  e.reply(e.requests.length-1,{ok:true,documents:[organizationDocument],drafts:organizationDocument.drafts});await e.flush()
  assert.match(JSON.stringify(e.tree),/已完成/)
  const open=button(e.tree,'查看正式待办');assert.ok(open,'A confirmed draft must link to its existing task')
  open.props.onClick();assert.deepEqual(opened,['todo-a'])
})

test('leaving an organization pane invalidates a late memory-confirmation reply',async()=>{
  const{e,result}=await resultsCarrier()
  await e.mountComponent(result.type,result.props)
  const memory={...organizationDocument,drafts:[{id:'draft-memory',kind:'memory',text:'仅属于主题 A 的记忆',status:'proposed'}]}
  e.reply(e.requests.length-1,{ok:true,documents:[memory],drafts:memory.drafts});await e.flush()
  button(e.tree,'准备记忆确认').props.onClick();await e.flush();const decision=e.requests.length-1
  e.unmount();e.reply(decision,{ok:true,draft:memory.drafts[0],confirmationText:'请记住：仅属于主题 A 的记忆'});await pause()
  const actions=e.load('src/client/workspace-actions.ts')
  assert.equal(actions.workspaceDraft('theme-a'),undefined,'An obsolete confirmation cannot prepare another draft')
  assert.equal(e.obsoleteWrites,0)
})

test('the linked-task entry starts the existing workbench at the exact requested task',async()=>{
  const e=carrier();await e.mount('src/client/panel.ts','ButlerWorkbench',{ctx:{},initialTaskId:'todo-requested'})
  assert.ok(e.requests.some(request=>request.path==='/dsh-butler/api/task?id=todo-requested'),'Opening a linked task must read that task immediately')
})

test('refreshing workspace metadata preserves the active pane while the same owner is loading',async()=>{
  const{e}=await resultsCarrier(),props={ctx:{},sessionId:'theme-a'}
  const before=nodes(e.tree).find(node=>typeof node.type==='function'&&node.type.name==='OrganizationResults');assert.ok(before)
  e.load('src/client/workspace-actions.ts').refreshWorkspaceUi();await e.update(props)
  const during=nodes(e.tree).find(node=>typeof node.type==='function'&&node.type.name==='OrganizationResults')
  assert.ok(during,'A metadata refresh must not tear down the current results, source view or workbench')
})

test('linked task and citation state cannot carry over to a different native theme',async()=>{
  const{e,result}=await resultsCarrier()
  result.props.showTask('todo-a');await e.flush()
  const workbench=nodes(e.tree).find(node=>typeof node.type==='function'&&node.type.name==='ButlerWorkbench')
  assert.equal(workbench.props.initialTaskId,'todo-a')
  await e.update({ctx:{},sessionId:'theme-b'})
  const next=nodes(e.tree).find(node=>typeof node.type==='function'&&node.type.name==='OrganizationResults')
  assert.ok(next);assert.equal(next.props.key,'theme-b')
})

test('a late selection response cannot refresh or write into a closed source pane',async()=>{
  const e=carrier();await e.mount('src/client/workspace-sources.ts','ButlerSources',sourceProps('late-selection'))
  e.reply(0,sourceList([ref]));await e.flush();button(e.tree,'移除此项').props.onClick();await e.flush()
  const actions=e.load('src/client/workspace-actions.ts'),revision=actions.workspaceUiRevision()
  e.unmount();e.reply(1,{ok:true,selected:[]});await pause()
  assert.equal(e.obsoleteWrites,0);assert.equal(actions.workspaceUiRevision(),revision)
})

test('a rejected source-chip removal cannot update the unmounted native composer dock',async()=>{
  const e=carrier(),props={ctx:{},sessionId:'dock-a'}
  await e.mount('src/client/workspace-panel.ts','ButlerSourceDock',props)
  e.reply(0,{ok:true,workspace:{sessions:[{id:'dock-a'}]}});await e.flush()
  e.reply(1,sourceList([ref]));await e.flush()
  const chip=nodes(e.tree).find(node=>node.type==='button'&&node.props?.title?.includes('点击移出'))
  assert.ok(chip);chip.props.onClick();await e.flush();e.unmount()
  e.requests[2].resolve({ok:false,status:503,json:async()=>({ok:false,error:'测试中的延迟失败'})});await pause()
  assert.equal(e.obsoleteWrites,0)
})

test('a transient workspace read failure offers a read-only retry instead of leaving the pane stuck',async()=>{
  const e=carrier(),props={ctx:{},sessionId:'retry-theme'}
  await e.mount('src/client/workspace-panel.ts','ButlerRightPane',props)
  e.requests[0].resolve({ok:false,status:503,json:async()=>({ok:false,error:'工作区暂不可读'})});await e.flush()
  const retry=button(e.tree,'重新读取工作区');assert.ok(retry)
  retry.props.onClick();await e.update(props)
  assert.equal(e.requests[1].path,'/dsh-butler/api/workspace');assert.equal(e.requests[1].options.method,'GET')
})

test('the native right pane handles the interval before any conversation is mounted',async()=>{
  const e=carrier()
  await assert.doesNotReject(e.mount('src/client/workspace-panel.ts','ButlerRightPane',{ctx:{}}))
  assert.match(JSON.stringify(e.tree),/请先打开一条原生会话/)
})
