import fs from 'node:fs/promises';
import path from 'node:path';
import {selectDshRuntime,parseRuntimeYaml,modelProfilePatch,recordFixtureRuntime} from './dsh-runtime.mjs';
import {smokeRoute,profileModelSettings} from './model-smoke-support.mjs';
import {freshMarker,nativeModelProfileRootConfig,sealNativeModelFresh,nativeModelResumeProfileMatches} from './native-model-entry.mjs';
const args=process.argv.slice(2),resume=args[0]==='--resume',fresh=args[0]==='--fresh';
if(args.length!==2||!resume&&!fresh||fresh&&!/^[a-zA-Z0-9._-]{1,80}$/.test(args[1]))throw Error('Usage: prepare-native-model-ui.mjs --fresh MODEL | --resume EXISTING_ROOT');
const requireDsh=selectDshRuntime().requireDsh;
if(fresh&&selectDshRuntime().version!=='0.2.0-rc.2')throw Error('Fresh bootstrap requires actual 0.2 runtime');
const root=await fs.realpath(resume?process.argv[3]:await fs.mkdtemp('C:/example/foreman-tests/native-model-ui-'));
const resumeMarker=resume?await fs.readFile(path.join(root,'fixture-marker'),'utf8'):null;
const settings=fresh?{'agent-default-model':{provider:'deepseek-official',model:args[1]},'llm-deepseek':{}}:profileModelSettings(parseRuntimeYaml({requireDsh},await fs.readFile(resumeMarker===freshMarker?path.join(root,'home/profiles/web/cordis.patch.yml'):modelProfilePatch(),'utf8')));
const {route,config}=smokeRoute(settings);
if(route.provider!=='deepseek-official')throw Error('Native UI fixture requires official adapter');
if(path.dirname(root)!==path.resolve('C:/example/foreman-tests')||!/^native-model-ui-[a-zA-Z0-9_-]+$/.test(path.basename(root)))throw Error('Invalid native model fixture root');
if(resume){
  const marker=await fs.readFile(path.join(root,'fixture-marker'),'utf8');
  if(!['authorized-native-model-ui-40-4096-600000','prepared-native-model-ui',freshMarker].includes(marker))throw Error('Unknown fixture marker');
  await fs.stat(path.join(root,'journal/state.jsonl'));
}else{
  await fs.mkdir(path.join(root,'home/profiles/web'),{recursive:true});await fs.mkdir(path.join(root,'home/sessions'));await fs.mkdir(path.join(root,'work'));
  await fs.writeFile(path.join(root,'fixture-marker'),freshMarker);
}
// Only non-secret explicitly selected adapter fields enter the isolated profile.
if(!resume){
  await fs.writeFile(path.join(root,'home/profiles/web/package.json'),JSON.stringify({name:'dsh-profile-web',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
  await fs.writeFile(path.join(root,'home/profiles/web/cordis.yml'),nativeModelProfileRootConfig);
}
const patchPath=path.join(root,'home/profiles/web/cordis.patch.yml');
const desired=[
  {id:'agent-default-model',config:route},
  {id:'llm-deepseek',config:{baseURL:config.baseURL,apiKeyEnv:config.apiKeyEnv,maxTokens:4096,retryPolicy:{mode:'normal',maxRetries:0}}},
  {insert:[{id:'native-model-ui',name:new URL('./native-model-ui.mjs',import.meta.url).href,config:{root}}]},
];
if(resume){
  const previous=await fs.readFile(patchPath,'utf8');
  const rows=parseRuntimeYaml({requireDsh},previous);
  if(nativeModelResumeProfileMatches(rows,desired)){if(!fresh)await recordFixtureRuntime(root);console.log(root);process.exit(0);}
  if(!Array.isArray(rows)||rows.length!==1||rows[0]?.insert?.length!==1||rows[0].insert[0].id!=='native-model-ui'||
    rows[0].insert[0].name!==new URL('./native-model-ui.mjs',import.meta.url).href||
    path.resolve(rows[0].insert[0].config?.root??'')!==root)throw Error('Unexpected existing fixture profile; preserve it for manual review');
  const backup=patchPath+'.pre-rc2';
  try{await fs.writeFile(backup,previous,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;if(await fs.readFile(backup,'utf8')!==previous)throw Error('Existing fixture profile backup differs');}
}
await recordFixtureRuntime(root);
await fs.writeFile(patchPath,JSON.stringify(desired));
if(fresh)await sealNativeModelFresh(root);
console.log(root);
