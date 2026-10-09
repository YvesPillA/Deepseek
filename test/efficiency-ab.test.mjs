import test from 'node:test';
import assert from 'node:assert/strict';
import {AB_LIMITS,PEAK_PRICES,ENDPOINT,abSchedule,createBudgetFetch,wireUsage,runToolLoop,validateAuthorization,planDigest,validatePriorLedger,safeToolArguments} from '../scripts/efficiency-ab-support.mjs';
const options=()=>({method:'POST',body:JSON.stringify({model:'deepseek-flash',stream:true,max_tokens:8192,thinking:{type:'enabled'},output_config:{effort:'high'},messages:[]})});
const response=(usage={input_tokens:100,output_tokens:40,cache_read_input_tokens:50,cache_creation_input_tokens:20},terminal=true)=>new Response(`data: ${JSON.stringify({type:'message_start',message:{usage:{...usage,output_tokens:0}}})}\n\ndata: ${JSON.stringify({type:'message_delta',usage:{output_tokens:usage.output_tokens}})}\n\n${terminal?'data: {"type":"message_stop"}\n\n':''}`,{headers:{'content-type':'text/event-stream'}});
test('AB uses twelve runs with matched inputs and reversed order, not fabricated RNG seeds',()=>{
  const s=abSchedule();assert.equal(s.length,12);
  for(const scenario of new Set(s.map(r=>r.scenario)))assert.deepEqual(s.filter(r=>r.scenario===scenario).map(r=>r.arm),['baseline','candidate','candidate','baseline']);
});
test('authorization rejects absent, noninteger and nonpositive lifetimes',()=>{
  const plan={batch:'test',fixtureRoot:'fixture'},valid={...plan,endpoint:ENDPOINT,model:'deepseek-flash',reasoningEffort:'high',planHash:planDigest(JSON.stringify(plan)),limits:AB_LIMITS,prices:PEAK_PRICES,issuedAt:1,expiresAt:3};
  assert.equal(validateAuthorization(valid,plan,2),valid);
  for(const value of [{issuedAt:undefined},{expiresAt:undefined},{issuedAt:NaN},{expiresAt:2.1},{expiresAt:1},{issuedAt:4}])assert.throws(()=>validateAuthorization({...valid,...value},plan,2),/authorization/);
});
test('actual request accounting reserves durably before network and charges disjoint cache bins once',async()=>{
  const saves=[];let calls=0;
  const b=createBudgetFetch(async()=>{calls++;assert.equal(saves[0].requests[0].status,'reserved');return response();},{persist:async x=>saves.push(x)});
  await(await b.fetch(ENDPOINT,options())).text();const l=b.snapshot();
  assert.equal(calls,1);assert.equal(l.requests[0].status,'complete');assert.equal(l.outputTokens,40);
  assert.deepEqual(l.requests[0].usage,{inputTokens:100,outputTokens:40,cacheReadTokens:50,cacheWriteTokens:20});
  assert(Math.abs(l.usdUpperBound-(100*.3+50*.006+20*.3+40*1.2)/1e6)<1e-12);
});
test('missing usage or incomplete stream stops entire batch and retains worst-case charge',async()=>{
  for(const value of [new Response('data: {"type":"message_stop"}\n\n'),response(undefined,false)]) {
    let calls=0;const b=createBudgetFetch(async()=>{calls++;return value;});await(await b.fetch(ENDPOINT,options())).text();
    assert(b.snapshot().stopped);assert.equal(b.snapshot().requests[0].status,'incomplete');assert(b.snapshot().usdUpperBound>0);
    await assert.rejects(b.fetch(ENDPOINT,options()));assert.equal(calls,1);
  }
});
test('unavailable optional cache bins remain unknown and conservatively charged',async()=>{
  const b=createBudgetFetch(async()=>response({input_tokens:100,output_tokens:40}));await(await b.fetch(ENDPOINT,options())).text();
  assert.equal(b.snapshot().requests[0].usage.cacheWriteTokens,null);assert(b.snapshot().usdUpperBound>.03);
  assert.throws(()=>wireUsage({input_tokens:-1,output_tokens:3}),/missing/);
});
test('request, output, USD, deadline, route and serialized input caps prevent outbound calls',async()=>{
  for(const limits of [{...AB_LIMITS,maxRequests:0},{...AB_LIMITS,maxOutputTokens:8000},{...AB_LIMITS,maxUsd:.001}]) {
    let calls=0;const b=createBudgetFetch(async()=>{calls++;return response();},{limits});await assert.rejects(b.fetch(ENDPOINT,options()),/budget/);assert.equal(calls,0);
  }
  let clock=0,calls=0;const b=createBudgetFetch(async()=>{calls++;return response();},{now:()=>clock});clock=AB_LIMITS.durationMs;
  await assert.rejects(b.fetch(ENDPOINT,options()),/time/);assert.equal(calls,0);
  const c=createBudgetFetch(async()=>{calls++;return response();});await assert.rejects(c.fetch('https://example.com',options()),/endpoint/);
  const huge=options();const body=JSON.parse(huge.body);body.messages=[{role:'user',content:'x'.repeat(131072)}];huge.body=JSON.stringify(body);await assert.rejects(c.fetch(ENDPOINT,huge),/input/);
  const wrong=options();wrong.body=wrong.body.replace('8192','4096');await assert.rejects(c.fetch(ENDPOINT,wrong),/config/);assert.equal(calls,0);
});
test('SSE UTF8 boundaries, repeated usage updates and HTTP failures cannot double-count or pass',async()=>{
  const data=await response().text(),bytes=new TextEncoder().encode(data),b=createBudgetFetch(async()=>new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}})));
  await(await b.fetch(ENDPOINT,options())).text();assert.equal(b.snapshot().outputTokens,40);
  const fail=createBudgetFetch(async()=>new Response('private provider body',{status:500}));await assert.rejects(fail.fetch(ENDPOINT,options()),/HTTP/);assert(!JSON.stringify(fail.snapshot()).includes('private provider body'));
});
test('truncated model generation never executes tools or counts as completion',async()=>{
  let executes=0;const api={createUserMessage:x=>x,BlockAssembler:class {push(){}get usage(){return {inputTokens:1,outputTokens:8192};}get finish(){return {kind:'max-tokens'};}message(){return {content:[{type:'tool-call',name:'write',arguments:'{}',id:'x'}]};}}};
  const run=await runToolLoop({llm:{async *stream(){yield {};}},api,agent:{},tools:new Map([['write',{execute(){executes++;}}]]),prompt:'',objective:''});
  assert.equal(run.status,'incomplete');assert.equal(run.reason,'max-tokens');assert.equal(executes,0);
});
async function priorFixture(){const b=createBudgetFetch(async()=>response(),{now:()=>10});await(await b.fetch(ENDPOINT,options())).text();const raw=JSON.stringify(b.snapshot());return {raw,sha256:planDigest(raw)};}
test('continuation preserves counts, settled fees and original absolute expiry, without resetting allowance',async()=>{
  const prior=await priorFixture(),parsed=JSON.parse(prior.raw);let calls=0,clock=20;
  const b=createBudgetFetch(async()=>{calls++;return response();},{prior,now:()=>clock,limits:{...AB_LIMITS,maxRequests:2}});
  assert.equal(b.snapshot().requests.length,1);assert.equal(b.snapshot().outputTokens,40);assert.equal(b.snapshot().deadline,parsed.deadline);assert.equal(b.snapshot().usdUpperBound,parsed.usdUpperBound);
  await(await b.fetch(ENDPOINT,options())).text();assert.equal(b.snapshot().requests[1].request,2);assert.equal(b.snapshot().outputTokens,80);
  await assert.rejects(b.fetch(ENDPOINT,options()),/budget/);assert.equal(calls,1);
  const c=createBudgetFetch(async()=>{calls++;return response();},{prior,now:()=>clock});clock=parsed.deadline;
  await assert.rejects(c.fetch(ENDPOINT,options()),/time/);assert.equal(calls,1);
  assert.equal(JSON.parse(prior.raw).requests.length,1);
});
test('continuation rejects tampered hashes, unsettled or undercounted ledger and extended authorization',async()=>{
  const prior=await priorFixture(),original=JSON.parse(prior.raw);
  assert.throws(()=>validatePriorLedger({...prior,sha256:'0'.repeat(64)},{now:20}),/hash/);
  for(const mutate of [p=>p.requests[0].status='reserved',p=>p.outputTokens=0,p=>p.usdUpperBound=0,p=>p.requests[0].usdUpperBound=0,p=>p.requests[0].usage.cacheWriteTokens=-1,p=>p.requests[0].request=2,p=>p.deadline=p.startedAt+AB_LIMITS.durationMs+1,p=>p.stopped='failure']){
    const p=structuredClone(original);mutate(p);const raw=JSON.stringify(p);assert.throws(()=>validatePriorLedger({raw,sha256:planDigest(raw)},{now:20}));
  }
  const plan={batch:'b',fixtureRoot:'f',continuation:{sha256:prior.sha256,deadline:original.deadline}},valid={batch:'b',fixtureRoot:'f',endpoint:ENDPOINT,model:'deepseek-flash',reasoningEffort:'high',planHash:planDigest(JSON.stringify(plan)),limits:AB_LIMITS,prices:PEAK_PRICES,issuedAt:20,expiresAt:original.deadline,priorLedgerHash:prior.sha256};
  assert.equal(validateAuthorization(valid,plan,21),valid);
  assert.throws(()=>validateAuthorization({...valid,expiresAt:original.deadline+1},plan,21),/Continuation/);
  assert.throws(()=>validateAuthorization({...valid,priorLedgerHash:'0'.repeat(64)},plan,21),/Continuation/);
});
test('continuation output and dollar reservations use remaining global amounts',async()=>{
  const prior=await priorFixture();let calls=0;
  for(const limits of [{...AB_LIMITS,maxOutputTokens:8192},{...AB_LIMITS,maxUsd:.001}]){
    const b=createBudgetFetch(async()=>{calls++;return response();},{prior,now:()=>20,limits});await assert.rejects(b.fetch(ENDPOINT,options()),/budget/);
  }
  assert.equal(calls,0);
});
test('safe tool trace preserves paths/ranges/argv while dropping source, command findings and writes',()=>{
  assert.deepEqual(safeToolArguments('foreman_files',{action:'write',path:'cart.cjs',text:'secret source'}),{action:'write',path:'cart.cjs'});
  assert.deepEqual(safeToolArguments('foreman_read_files',{requests:[{path:'a',startLine:2,lineCount:3}]}),{requests:[{path:'a',startLine:2,lineCount:3}]});
  assert.deepEqual(safeToolArguments('foreman_verify',{command:'node',args:['-e','secret source'],timeoutMs:3}),{command:'node',args:['-e','[source omitted]'],timeoutMs:3});
  assert.deepEqual(safeToolArguments('foreman_command',{command:JSON.stringify({type:'vote',findings:'secret reasoning'})}),{type:'vote'});
});

test('explicit next-day time renewal preserves every cumulative charge and cannot silently extend authorization',async()=>{
  const prior=await priorFixture(),p=JSON.parse(prior.raw),clock=p.deadline+1000;
  assert.throws(()=>createBudgetFetch(async()=>response(),{prior,now:()=>clock}),/unexpired/);
  assert.throws(()=>createBudgetFetch(async()=>response(),{renewWindow:true}),/parent ledger/);
  const renewed=createBudgetFetch(async()=>response(),{prior,now:()=>clock,renewWindow:true,limits:{...AB_LIMITS,maxRequests:2}});
  assert.equal(renewed.snapshot().requests.length,p.requests.length);assert.equal(renewed.snapshot().outputTokens,p.outputTokens);assert.equal(renewed.snapshot().usdUpperBound,p.usdUpperBound);
  assert.equal(renewed.snapshot().previousWindows[0].ledgerHash,prior.sha256);assert.equal(renewed.snapshot().deadline,clock+AB_LIMITS.durationMs);
  await(await renewed.fetch(ENDPOINT,options())).text();await assert.rejects(renewed.fetch(ENDPOINT,options()),/budget/);
  const plan={batch:'b',fixtureRoot:'f',continuation:{sha256:prior.sha256,deadline:p.deadline,renewWindow:true}},auth={batch:'b',fixtureRoot:'f',endpoint:ENDPOINT,model:'deepseek-flash',reasoningEffort:'high',planHash:planDigest(JSON.stringify(plan)),limits:AB_LIMITS,prices:PEAK_PRICES,issuedAt:clock,expiresAt:clock+1000,priorLedgerHash:prior.sha256,renewWindow:true};
  assert.equal(validateAuthorization(auth,plan,clock+1),auth);assert.throws(()=>validateAuthorization({...auth,renewWindow:undefined},plan,clock+1),/Continuation/);
});
