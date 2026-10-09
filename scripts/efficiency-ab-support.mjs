// Offline-importable AB primitives. Importing this module never sends a request.
import {createHash} from 'node:crypto';
export const ENDPOINT='https://api.deepseek.com/anthropic/v1/messages';
export const AB_LIMITS=Object.freeze({maxRequests:120,maxOutputTokens:400000,maxTokens:8192,durationMs:2700000,maxUsd:3,inputReservationTokens:131072});
export const PEAK_PRICES=Object.freeze({input:0.30,cacheRead:0.006,cacheWrite:0.30,output:1.20});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const digest=value=>createHash('sha256').update(value).digest('hex');
export function abSchedule() {
  return ['long-success','embedded-fail','multi-file-bug'].flatMap(scenario=>[0,1].flatMap(repeat=>(repeat===0?['baseline','candidate']:['candidate','baseline']).map(arm=>({id:`${scenario}-${repeat+1}-${arm}`,scenario,repeat:repeat+1,arm}))));
}
export function validateAuthorization(auth,plan,now=Date.now()) {
  if(!auth||!integer(auth.issuedAt)||!integer(auth.expiresAt)||auth.expiresAt<=auth.issuedAt||auth.batch!==plan.batch||auth.fixtureRoot!==plan.fixtureRoot||auth.endpoint!==ENDPOINT||auth.model!=='deepseek-flash'||auth.reasoningEffort!=='high'||auth.planHash!==digest(JSON.stringify(plan))||auth.expiresAt<=now||auth.issuedAt>now||auth.expiresAt-auth.issuedAt>AB_LIMITS.durationMs||JSON.stringify(auth.limits)!==JSON.stringify(AB_LIMITS)||JSON.stringify(auth.prices)!==JSON.stringify(PEAK_PRICES))throw Error('Exact fresh root AB authorization required');
  if(plan.continuation&&(auth.priorLedgerHash!==plan.continuation.sha256||(plan.continuation.renewWindow?auth.renewWindow!==true:auth.expiresAt!==plan.continuation.deadline||auth.renewWindow===true)))throw Error('Continuation must preserve prior ledger and absolute expiry unless root explicitly renews the time window');
  return auth;
}
// Wire usage uses disjoint Anthropic bins; absent optional bins remain unknown.
export function wireUsage(value) {
  if(!value||!integer(value.input_tokens)||!integer(value.output_tokens))throw Error('Authoritative usage is missing');
  for(const k of ['cache_read_input_tokens','cache_creation_input_tokens'])if(value[k]!==undefined&&!integer(value[k]))throw Error('Invalid authoritative cache usage');
  return {inputTokens:value.input_tokens,outputTokens:value.output_tokens,cacheReadTokens:value.cache_read_input_tokens??null,cacheWriteTokens:value.cache_creation_input_tokens??null};
}
export function validatePriorLedger({raw,sha256}, {limits=AB_LIMITS,prices=PEAK_PRICES,now=Date.now(),allowExpired=false}={}) {
  if(typeof raw!=='string'||!/^[a-f0-9]{64}$/.test(sha256??'')||digest(raw)!==sha256)throw Error('Prior ledger hash mismatch');
  const prior=JSON.parse(raw);
  if(!integer(prior.startedAt)||!integer(prior.deadline)||prior.deadline<=prior.startedAt||prior.deadline-prior.startedAt>AB_LIMITS.durationMs||!allowExpired&&prior.deadline<=now||prior.stopped!==null||!Array.isArray(prior.requests)||!integer(prior.outputTokens)||!Number.isFinite(prior.usdUpperBound)||prior.usdUpperBound<0)throw Error('Only a settled unexpired prior ledger can continue');
  let outputs=0,usd=0;
  for(let i=0;i<prior.requests.length;i++) {
    const r=prior.requests[i],u=r.usage;
    if(r.request!==i+1||r.status!=='complete'||!u||!integer(u.inputTokens)||!integer(u.outputTokens)||u.outputTokens>AB_LIMITS.maxTokens||r.reservedInputTokens!==AB_LIMITS.inputReservationTokens||r.reservedOutputTokens!==AB_LIMITS.maxTokens||!integer(r.requestBytes)||r.requestBytes+8192>r.reservedInputTokens||!Number.isFinite(r.usdUpperBound)||r.usdUpperBound<0)throw Error('Prior request is not completely settled');
    for(const k of ['cacheReadTokens','cacheWriteTokens'])if(u[k]!==null&&!integer(u[k]))throw Error('Prior cache usage is invalid');
    if(u.inputTokens+(u.cacheReadTokens??0)+(u.cacheWriteTokens??0)>r.reservedInputTokens)throw Error('Prior input usage exceeded reservation');
    const input=u.cacheReadTokens===null||u.cacheWriteTokens===null?r.reservedInputTokens*Math.max(prices.input,prices.cacheRead,prices.cacheWrite):u.inputTokens*prices.input+u.cacheReadTokens*prices.cacheRead+u.cacheWriteTokens*prices.cacheWrite;
    const cost=(input+u.outputTokens*prices.output)/1e6;
    if(Math.abs(cost-r.usdUpperBound)>1e-9)throw Error('Prior request charge mismatch');
    outputs+=u.outputTokens;usd+=r.usdUpperBound;
  }
  if(outputs!==prior.outputTokens||Math.abs(usd-prior.usdUpperBound)>1e-9||prior.requests.length>limits.maxRequests||outputs>limits.maxOutputTokens||usd>limits.maxUsd)throw Error('Prior cumulative budget mismatch');
  return prior;
}
export function createBudgetFetch(delegate,{limits=AB_LIMITS,prices=PEAK_PRICES,now=Date.now,persist=async()=>{},prior,renewWindow=false}={}) {
  if(renewWindow&&!prior)throw Error('Time renewal requires the settled parent ledger');
  const inherited=prior?validatePriorLedger(prior,{limits,prices,now:now(),allowExpired:renewWindow}):undefined;
  const start=renewWindow?now():inherited?.startedAt??now(),deadline=renewWindow?start+limits.durationMs:inherited?.deadline??start+limits.durationMs;
  const ledger=inherited?{...structuredClone(inherited),priorLedgerHash:prior.sha256,inheritedRequests:inherited.requests.length,currentBatchStartedAt:now(),...(renewWindow?{startedAt:start,deadline,previousWindows:[...(inherited.previousWindows??[]),{startedAt:inherited.startedAt,deadline:inherited.deadline,ledgerHash:prior.sha256}]}:{})}:{startedAt:start,deadline,requests:[],outputTokens:0,usdUpperBound:0,stopped:null};
  let busy=false,usedUsd=ledger.usdUpperBound,reservedOutput=0;
  const stop=reason=>{ledger.stopped??=reason;};
  const save=()=>persist(structuredClone(ledger));
  const fetch=async(url,options={})=>{
    if(String(url)!==ENDPOINT||options.method!=='POST')throw Error('Unapproved AB endpoint');
    if(busy)throw Error('AB transport permits one in-flight request');
    if(ledger.stopped||now()>=deadline)throw Error(ledger.stopped??'AB time limit reached');
    const body=JSON.parse(options.body);
    if(body.model!=='deepseek-flash'||body.stream!==true||body.max_tokens!==limits.maxTokens||body.thinking?.type!=='enabled'||body.output_config?.effort!=='high')throw Error('AB route/config mismatch');
    const inputReservation=limits.inputReservationTokens;
    // Reserve a declared upper input ceiling, reject oversized wire requests;
    // no chars-to-tokens figure is reported as measured provider token usage.
    if(Buffer.byteLength(options.body)+8192>inputReservation)throw Error('AB input reservation exceeded');
    const reserveUsd=(inputReservation*Math.max(prices.input,prices.cacheRead,prices.cacheWrite)+body.max_tokens*prices.output)/1e6;
    if(ledger.requests.length>=limits.maxRequests||ledger.outputTokens+reservedOutput+body.max_tokens>limits.maxOutputTokens||usedUsd+reserveUsd>limits.maxUsd){stop('budget-limit');await save();throw Error('AB budget limit reached');}
    busy=true;reservedOutput+=body.max_tokens;
    const entry={request:ledger.requests.length+1,startedAt:now(),requestBytes:Buffer.byteLength(options.body),reservedInputTokens:inputReservation,reservedOutputTokens:body.max_tokens,reservedUsd:reserveUsd,status:'reserved',usage:null};
    ledger.requests.push(entry);usedUsd+=reserveUsd;ledger.usdUpperBound=usedUsd;
    let settled=false,usage={},terminal=false,pending='',decoder=new TextDecoder();
    const finish=async(error)=>{
      if(settled)return;settled=true;entry.latencyMs=now()-entry.startedAt;
      try{
        if(error||!terminal)throw Error(error??'Incomplete provider stream');
        entry.usage=wireUsage(usage);
        const u=entry.usage,knownInput=u.inputTokens+(u.cacheReadTokens??0)+(u.cacheWriteTokens??0);
        if(u.outputTokens>body.max_tokens||knownInput>inputReservation)throw Error('Provider usage exceeded reservation');
        // Missing cache bins do not become fictitious zero counts. Keep the
        // maximum input reservation charge when a bin is unavailable.
        const inputUsd=u.cacheReadTokens===null||u.cacheWriteTokens===null?inputReservation*Math.max(prices.input,prices.cacheRead,prices.cacheWrite):(u.inputTokens*prices.input+u.cacheReadTokens*prices.cacheRead+u.cacheWriteTokens*prices.cacheWrite);
        const actualUsd=(inputUsd+u.outputTokens*prices.output)/1e6;
        usedUsd+=actualUsd-reserveUsd;ledger.outputTokens+=u.outputTokens;entry.usdUpperBound=actualUsd;entry.status='complete';
      }catch(e){entry.status='incomplete';entry.error=e.message;stop(e.message);}
      reservedOutput-=body.max_tokens;busy=false;ledger.usdUpperBound=usedUsd;await save();
    };
    const inspect=text=>{
      pending+=text;if(pending.length>1048576)throw Error('Oversized SSE event');
      let match;
      while((match=/\r?\n\r?\n/.exec(pending))) {
        const block=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
        const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(!data||data==='[DONE]')continue;
        const event=JSON.parse(data);
        if(event.type==='message_start')Object.assign(usage,event.message?.usage);
        if(event.type==='message_delta')Object.assign(usage,event.usage);
        if(event.type==='message_stop')terminal=true;
        if(event.type==='error')throw Error('Provider stream error');
      }
    };
    try {
      await save(); // durable reservation precedes the paid outbound request
      const signal=AbortSignal.timeout(Math.max(1,deadline-now()));
      const response=await delegate(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,signal]):signal});
      if(!response.ok||!response.body){await finish('Provider HTTP failure');throw Error('AB provider HTTP failure');}
      const reader=response.body.getReader();
      return new Response(new ReadableStream({
        async pull(controller){
          try {
            const chunk=await reader.read();
            if(chunk.done){inspect(decoder.decode());if(pending.trim())throw Error('Incomplete SSE tail');await finish();controller.close();return;}
            inspect(decoder.decode(chunk.value,{stream:true}));controller.enqueue(chunk.value);
          }catch(e){await finish(e.message);controller.error(e);}
        },
        async cancel(){try{await reader.cancel();}finally{await finish(terminal?undefined:'Provider stream cancelled');}},
      }),{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(e){await finish(e.message);throw e;}
  };
  return {fetch,snapshot:()=>structuredClone(ledger),assertHealthy(){if(ledger.stopped)throw Error(ledger.stopped);}};
}
export async function runToolLoop({llm,api,agent,tools,guard,prompt,objective,maxTurns=10,signal,onStep=async()=>{},assertHealthy=()=>{},isDone=()=>false}) {
  const messages=[api.createUserMessage({source:{kind:'user'},content:[{type:'text',text:objective}]})],steps=[];
  for(let i=0;i<maxTurns;i++) {
    signal?.throwIfAborted();const started=Date.now(),assembly=new api.BlockAssembler();
    for await(const chunk of llm.stream({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high',maxTokens:8192,system:prompt,messages,tools:[...tools.values()].map(({name,description,parameters})=>({name,description,parameters})),signal}))assembly.push(chunk);
    assertHealthy();const response=assembly.message({provider:'deepseek-official',model:'deepseek-flash'});messages.push(response);
    const step={turn:i+1,latencyMs:Date.now()-started,usage:assembly.usage??null,finish:{kind:assembly.finish.kind},toolCalls:[]};steps.push(step);
    if(!assembly.usage||['max-tokens','length','error','aborted'].includes(assembly.finish.kind)){await onStep(step);return {status:'incomplete',reason:!assembly.usage?'missing-usage':assembly.finish.kind,steps};}
    const calls=response.content.filter(b=>b.type==='tool-call');
    for(const call of calls) {
      let isError=false,text;const tool=tools.get(call.name),exec={agent,name:call.name,signal};
      try {if(!tool)throw Error('Tool outside locked role');const denied=guard?.(exec);if(denied)throw Error(denied);const result=await tool.execute(JSON.parse(call.arguments),exec);text=result.text;}
      catch(e){isError=true;text=e.message;}
      messages.push(api.createToolResultMessage({callId:call.id,content:[{type:'text',text}],isError}));
      step.toolCalls.push({name:call.name,isError,resultBytes:Buffer.byteLength(text),arguments:safeToolArguments(call.name,call.arguments)});
      if(isDone()){await onStep(step);return {status:'completed-action',steps};}
    }
    await onStep(step);
    if(!calls.length)return {status:'ended',steps};
  }
  return {status:'incomplete',reason:'turn-limit',steps};
}
export const planDigest=digest;
export function safeToolArguments(name,raw) {
  let args;try{args=typeof raw==='string'?JSON.parse(raw):raw;}catch{return {invalid:true};}
  if(!args||typeof args!=='object'||Array.isArray(args))return {invalid:true};
  const out={};
  const bounded=value=>typeof value==='string'&&value.length<=300&&!/[\r\n\x00]/.test(value)?value:'[omitted]';
  if(['foreman_files','foreman_artifact'].includes(name)){if(args.path!==undefined)out.path=bounded(args.path);if(args.action!==undefined)out.action=bounded(args.action);}
  if(name==='foreman_read_files')out.requests=Array.isArray(args.requests)?args.requests.slice(0,4).map(r=>r&&typeof r==='object'?({path:bounded(r.path),...(integer(r.startLine)?{startLine:r.startLine}:{}),...(integer(r.lineCount)?{lineCount:r.lineCount}:{})}):{invalid:true}):[];
  if(name==='foreman_verify'){
    out.command=bounded(args.command);
    out.args=Array.isArray(args.args)?args.args.slice(0,32).map((v,i)=>i>0&&['-e','--eval','-c','--command','-p','--print'].includes(args.args[i-1])||typeof v==='string'&&/^(?:--eval|--print|--command)=/.test(v)?'[source omitted]':bounded(v)):[];
    if(integer(args.timeoutMs))out.timeoutMs=args.timeoutMs;
  }
  if(name==='foreman_verify_output')for(const k of ['verification','stream','offset','limit'])if(args[k]!==undefined)out[k]=typeof args[k]==='string'?bounded(args[k]):integer(args[k])?args[k]:'[omitted]';
  if(name==='foreman_evidence'&&integer(args.offset))out.offset=args.offset;
  if(name==='foreman_command'){try{out.type=bounded(JSON.parse(args.command).type);}catch{out.invalid=true;}}
  return out;
}
