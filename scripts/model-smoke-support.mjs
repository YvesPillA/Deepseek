import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initialState} from '../src/core.mjs';
import {decodeJournal} from '../src/journal-codec.mjs';

export function profileModelSettings(rows) {
  if(!Array.isArray(rows))throw Error('Profile patch rows required');
  const selected={};
  for(const id of ['agent-default-model','llm-deepseek']) {
    const matches=rows.filter(row=>row?.id===id);
    if(matches.length!==1 || !matches[0].config || typeof matches[0].config!=='object')throw Error(`Profile ${id} configuration required`);
    selected[id]=matches[0].config;
  }
  return selected;
}

export function smokeRoute(settings) {
  const route=settings['agent-default-model'];
  if(!route || route.provider!=='deepseek-official' || typeof route.model!=='string' || !route.model)throw Error('Explicit official DeepSeek model route required');
  const source=settings['llm-deepseek']??{};
  if(source.baseURL!==undefined && source.baseURL!=='https://api.deepseek.com/anthropic')throw Error('Official DeepSeek Messages endpoint required');
  if(Object.hasOwn(source,'protocol'))throw Error('Official DeepSeek adapter has a fixed Messages protocol');
  const ref=source.apiKeyEnv??'DEEPSEEK_API_KEY';
  if(!/^[A-Z_][A-Z0-9_]*$/.test(ref??''))throw Error('Invalid credential reference');
  // Never copy arbitrary profile fields into the isolated fixture: a future
  // profile may contain a credential value or another sensitive setting.
  const config={baseURL:'https://api.deepseek.com/anthropic',apiKeyEnv:ref,maxTokens:4096,retryPolicy:{mode:'normal',maxRetries:0}};
  return {route:{provider:route.provider,model:route.model},ref,adapter:'dsh-llm-deepseek-api-key',config};
}

export async function validateNativeModelResume(root) {
  const journal=await fs.readFile(path.join(root,'journal/state.jsonl'),'utf8');
  if(!journal.endsWith('\n'))throw Error('Incomplete native-model-ui journal tail');
  let state=initialState();
  for(const line of journal.split('\n'))if(line)state=decodeJournal(state,JSON.parse(line),{inPlace:true});
  const projects=Object.values(state.projects);
  if(projects.length!==1 || projects[0].id!=='chat' ||
    path.resolve(projects[0].workspace)!==path.join(root,'work') ||
    projects[0].status!=='running')throw Error('Unexpected native-model-ui resume project');
  return {revision:state.revision,projectId:projects[0].id};
}

export async function persistBatchLedger(file,value) {
  const temp=file+'.'+randomUUID()+'.tmp';
  try {
    const handle=await fs.open(temp,'wx');
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    await fs.rename(temp,file);
  }finally{await fs.rm(temp,{force:true});}
}

export function validateNativeModelAuthorization(value,{root,batch,now=Date.now()}={}) {
  const expected='https://api.deepseek.com/anthropic/v1/messages';
  if(!value || typeof value!=='object' || value.fixtureRoot!==root || value.batch!==batch ||
    value.projectId!=='chat' || value.workspace!==path.join(root,'work') ||
    value.endpoint!==expected || value.credentialRef!=='DEEPSEEK_API_KEY' ||
    value.maxRequests!==40 || value.maxOutputTokens!==4096 ||
    !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
    value.issuedAt>now || value.expiresAt<=now || value.expiresAt-value.issuedAt>600000 ||
    value.expiresAt-value.issuedAt<1)throw Error('Fresh bounded native-model-ui authorization required');
  return value;
}

// Count actual outbound requests, not only high-level agent turns. Redirects
// cannot forward authorization outside the explicitly approved endpoint.
export function boundedModelFetch(delegate,{maxRequests=40,durationMs=600000,now=Date.now}={}) {
  const deadline=now()+durationMs;let calls=0;
  return {
    count:()=>calls,
    fetch:async(url,options={})=>{
      if(String(url)!=='https://api.deepseek.com/anthropic/v1/messages' || options.method!=='POST')throw Error('Unapproved model endpoint');
      if(calls>=maxRequests || now()>=deadline)throw Error('Integration request limit reached');
      const body=JSON.parse(options.body);
      if(!Number.isSafeInteger(body.max_tokens)||body.max_tokens<1||body.max_tokens>4096)throw Error('Model output limit required');
      calls++;
      const signal=AbortSignal.timeout(Math.max(1,deadline-now()));
      return delegate(url,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,signal]):signal});
    },
  };
}

export const parallelObjective='实现无第三方依赖的 Node.js 小项目。规划三个里程碑：math 与 text 互不依赖；integration 同时依赖前两个。math 完成 calculator.cjs 的 add(a,b)，只接受有限 number，否则抛 TypeError，另写 math-test.cjs。text 完成 text.cjs 的 slug(s)，只接受字符串，去首尾空白、转小写、把连续空白替换为单个连字符，非字符串抛 TypeError，另写 text-test.cjs。两项独立工作各自派给执行者，不得合并。integration 完成 test.cjs 运行两套测试以及 README.md。必须通过 foreman_verify 获取对应快照的成功验证证据，按里程碑依赖推进，两名监督者独立验收，最后提交 final。若遭否决，按意见返工并重新提交，不能跳过或重置否决次数。不要添加 package.json 或 npm 依赖。';
