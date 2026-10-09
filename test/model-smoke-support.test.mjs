import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {selectDshRuntime} from '../scripts/dsh-runtime.mjs';
import {pathToFileURL} from 'node:url';
import {initialState} from '../src/core.mjs';
import {encodeJournal} from '../src/journal-codec.mjs';
import {smokeRoute,profileModelSettings,boundedModelFetch,validateNativeModelAuthorization,validateNativeModelResume,persistBatchLedger,parallelObjective} from '../scripts/model-smoke-support.mjs';

test('smoke selects current official adapter and pins endpoint, retry and output bounds',async()=>{
  assert.deepEqual(profileModelSettings([{id:'agent-default-model',config:{provider:'deepseek-official',model:'deepseek-flash'}},{id:'llm-deepseek',config:{}}])['llm-deepseek'],{});
  assert.throws(()=>profileModelSettings([{id:'agent-default-model',config:{}}]),/llm-deepseek/);
  const result=smokeRoute({'agent-default-model':{provider:'deepseek-official',model:'deepseek-flash'},'llm-deepseek':{maxTokens:256000}});
  assert.equal(result.adapter,'dsh-llm-deepseek-api-key');assert.equal(result.ref,'DEEPSEEK_API_KEY');
  assert.equal(result.config.maxTokens,4096);assert.equal(result.config.retryPolicy.maxRetries,0);
  const filtered=smokeRoute({'agent-default-model':result.route,'llm-deepseek':{apiKey:'must-not-copy',token:'must-not-copy',models:[{id:'x'}]}});
  assert.deepEqual(Object.keys(filtered.config).sort(),['apiKeyEnv','baseURL','maxTokens','retryPolicy']);
  const requireDsh=selectDshRuntime().requireDsh;
  const load=n=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+n)).href);
  const [{Context},{LlmRuntime},native]=await Promise.all([load('cordis'),load('dsh-llm'),load('dsh-llm-deepseek-api-key')]);
  const ctx=new Context(),llm=ctx.plugin(LlmRuntime);await llm;let adapter;
  try{adapter=ctx.plugin(native,result.config);await adapter;
    const options=native.resolveAdapterOptions(result.config);
    assert.equal(options.baseURL,'https://api.deepseek.com/anthropic');assert.equal(options.maxTokens,4096);
  }finally{await adapter?.dispose();await llm.dispose();}
  assert.throws(()=>smokeRoute({'agent-default-model':result.route,'llm-deepseek':{baseURL:'https://other.invalid'}}),/Official/);
  assert.throws(()=>smokeRoute({'agent-default-model':result.route,'llm-deepseek':{apiKeyEnv:'bad reference'}}),/credential/);
  assert.throws(()=>smokeRoute({'agent-default-model':result.route,'llm-deepseek':{protocol:'chat-completions'}}),/fixed Messages/);
  assert.throws(()=>smokeRoute({'agent-default-model':{provider:'old',model:'deepseek-flash'},'llm-pi-ai':{providers:{old:{baseURL:'https://api.deepseek.com',apiKeyEnv:'TEST_KEY'}}}}),/official/);
  assert(parallelObjective.includes('互不依赖'));assert(parallelObjective.includes('不能跳过或重置否决次数'));
});

test('read-only resume check binds the persisted project and rejects incomplete journals',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'stats-resume-check-'));
  try {
    await fs.mkdir(path.join(root,'journal'));
    const journalPath=path.join(root,'journal/state.jsonl');
    const line=workspace=>{
      const before=initialState(),after=structuredClone(before);
      after.revision=1;after.projects.chat={id:'chat',workspace,status:'running'};
      return JSON.stringify(encodeJournal(before,after));
    };
    await fs.writeFile(journalPath,line(path.join(root,'work'))+'\n');
    assert.deepEqual(await validateNativeModelResume(root),{revision:1,projectId:'chat'});
    await fs.writeFile(journalPath,line(path.join(root,'other'))+'\n');
    await assert.rejects(validateNativeModelResume(root),/Unexpected/);
    await fs.writeFile(journalPath,line(path.join(root,'work')));
    await assert.rejects(validateNativeModelResume(root),/Incomplete/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('batch ledger replacement preserves the last complete count',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'stats-ledger-check-'));
  try {
    const file=path.join(root,'requests-batch.json');
    await persistBatchLedger(file,{batch:'batch',calls:1,deadline:123});
    await persistBatchLedger(file,{batch:'batch',calls:2,deadline:123});
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{batch:'batch',calls:2,deadline:123});
    assert.deepEqual(await fs.readdir(root),['requests-batch.json']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('native launcher path contract matches the PowerShell launch environment',async()=>{
  const plugin=await fs.readFile(new URL('../scripts/native-model-ui.mjs',import.meta.url),'utf8');
  const launcher=await fs.readFile(new URL('../scripts/launch-native-model-ui.ps1',import.meta.url),'utf8');
  const literal=plugin.match(/assert\.equal\(process\.env\.FOREMAN_UI_LAUNCHER,('(?:[^'\\]|\\.)*')/u)?.[1];
  assert(literal,'Native fixture must validate its launcher');
  const assigned=launcher.match(/\$env:FOREMAN_UI_LAUNCHER='([^']+)'/u)?.[1];
  assert.equal(vm.runInNewContext(literal),assigned);
  assert.equal(assigned,'C:\\example\\dsh\\launch.cmd');
});

test('network boundary caps actual requests and rejects redirects, other destinations and oversized outputs',async()=>{
  let now=0,requests=0,last;
  const limited=boundedModelFetch(async(url,options)=>{requests++;last=options;return 'ok';},{maxRequests:2,durationMs:1000,now:()=>now});
  const url='https://api.deepseek.com/anthropic/v1/messages',options={method:'POST',body:JSON.stringify({max_tokens:4096})};
  await assert.rejects(limited.fetch('https://other.invalid',options),/endpoint/);
  await assert.rejects(limited.fetch('https://api.deepseek.com/chat/completions',options),/endpoint/);
  await assert.rejects(limited.fetch('https://api.deepseek.com/anthropic/v1/files',options),/endpoint/);
  await assert.rejects(limited.fetch(url,{...options,body:JSON.stringify({max_tokens:4097})}),/output/);
  assert.equal(requests,0);
  await limited.fetch(url,options);assert.equal(last.redirect,'error');assert(last.signal instanceof AbortSignal);
  await limited.fetch(url,options);await assert.rejects(limited.fetch(url,options),/limit/);
  assert.equal(requests,2);assert.equal(limited.count(),2);
  const expired=boundedModelFetch(()=>assert.fail('Must not send'),{durationMs:1,now:()=>now});
  now=2;await assert.rejects(expired.fetch(url,options),/limit/);
});

test('native stats resume needs a fresh authorization tied to its batch, project, root and endpoint',()=>{
  const root='C:\\example\\foreman-tests\\native-model-ui-offline';
  const auth={fixtureRoot:root,batch:'new-batch',projectId:'chat',workspace:root+'\\work',
    endpoint:'https://api.deepseek.com/anthropic/v1/messages',credentialRef:'DEEPSEEK_API_KEY',
    maxRequests:40,maxOutputTokens:4096,issuedAt:1000,expiresAt:601000};
  assert.equal(validateNativeModelAuthorization(auth,{root,batch:'new-batch',now:2000}),auth);
  for(const altered of [{batch:'old-batch'},{workspace:'D:\\other'},{maxRequests:41},{maxOutputTokens:4097},
    {endpoint:'https://api.deepseek.com/chat/completions'},{expiresAt:601001}])
    assert.throws(()=>validateNativeModelAuthorization({...auth,...altered},{root,batch:'new-batch',now:2000}),/authorization/);
  assert.throws(()=>validateNativeModelAuthorization(auth,{root,batch:'new-batch',now:601000}),/authorization/);
});

test('installed Messages adapter reaches the bounded offline fetch with its real request shape',async()=>{
  const requireDsh=selectDshRuntime().requireDsh;
  const load=n=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+n)).href);
  const [{DeepSeekAdapter},{createUserMessage},native]=await Promise.all([load('dsh-llm-deepseek'),load('dsh-llm'),load('dsh-llm-deepseek-api-key')]);
  const route=smokeRoute({'agent-default-model':{provider:'deepseek-official',model:'deepseek-flash'},'llm-deepseek':{}});
  const events=[
    {type:'message_start',message:{id:'offline',model:'deepseek-flash',usage:{input_tokens:1,output_tokens:1}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'offline'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
    {type:'message_stop'},
  ];
  let seen;
  const bounded=boundedModelFetch(async(url,options)=>{
    seen={url,options,body:JSON.parse(options.body)};
    return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  },{maxRequests:1});
  const adapter=new DeepSeekAdapter({options:()=>native.resolveAdapterOptions(route.config),
    resolveAuth:async()=>({headers:{'x-api-key':'offline-key'}}),resolveUserId:()=> 'offline-user',
    prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
  const originalFetch=globalThis.fetch;globalThis.fetch=bounded.fetch;
  try {
    const chunks=[];
    for await(const chunk of adapter.stream({provider:'deepseek-official',model:'deepseek-flash',messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]})]}))chunks.push(chunk);
    assert(chunks.some(c=>c.type==='finish'));
    assert.equal(seen.url,'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(seen.body.max_tokens,4096);assert.equal(seen.options.redirect,'error');
    assert.equal(bounded.count(),1);
  }finally{globalThis.fetch=originalFetch;}
});
