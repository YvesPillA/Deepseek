import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {freshMarker,nativeModelProfileRootConfig,sealNativeModelFresh,validateNativeModelFresh,validateNativeModelEntry,claimNativeModelFresh,nativeModelResumeProfileMatches} from '../scripts/native-model-entry.mjs';
import {selectDshRuntime} from '../scripts/dsh-runtime.mjs';
import {initialState} from '../src/core.mjs';
import {encodeJournal} from '../src/journal-codec.mjs';
import {apply} from '../scripts/native-model-ui.mjs';

async function fixture({profileRoot='{}'}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-model-fresh-check-')));
  await fs.mkdir(path.join(root,'home/profiles/web'),{recursive:true});await fs.mkdir(path.join(root,'home/sessions'));await fs.mkdir(path.join(root,'work'));
  await fs.writeFile(path.join(root,'fixture-marker'),freshMarker);
  await fs.writeFile(path.join(root,'fixture-runtime.json'),JSON.stringify({version:'0.2.0-rc.2'}));
  for(const name of ['package.json','cordis.yml','cordis.patch.yml'])await fs.writeFile(path.join(root,'home/profiles/web',name),name==='cordis.yml'?profileRoot:'{}');
  await sealNativeModelFresh(root);
  return {root,close:()=>fs.rm(root,{recursive:true,force:true})};
}
const authorization=(root,entry)=>({fixtureRoot:root,batch:'new',entry,projectId:'chat',workspace:path.join(root,'work'),endpoint:'https://api.deepseek.com/anthropic/v1/messages',credentialRef:'DEEPSEEK_API_KEY',maxRequests:40,maxOutputTokens:4096,issuedAt:Date.now(),expiresAt:Date.now()+600000});

test('resume preserves only the exact native 0.2 welcome receipt without accepting extra configuration',()=>{
  const desired=[{id:'agent-default-model',config:{provider:'deepseek-official',model:'deepseek-flash'}},{id:'llm-deepseek',config:{apiKeyEnv:'DEEPSEEK_API_KEY'}},{insert:[{id:'native-model-ui',name:'fixture',config:{root:'isolated'}}]}];
  const receipt={id:'ui-settings-general',name:'@deepseek-ai/dsh-client-ui-settings-general',config:{welcomeNoticeVersion:'2026-09-28.1'}};
  assert.equal(nativeModelResumeProfileMatches(desired,desired),true);
  assert.equal(nativeModelResumeProfileMatches([...desired,receipt],desired),true);
  for(const wrong of [{...receipt,name:'untrusted-plugin'},{...receipt,config:{...receipt.config,apiKey:'never-copy'}},{...receipt,config:{welcomeNoticeVersion:'future'}},...desired])assert.equal(nativeModelResumeProfileMatches([...desired,wrong],desired),false);
  const changed=structuredClone(desired);changed[0].config.provider='other';assert.equal(nativeModelResumeProfileMatches([...changed,receipt],desired),false);
  assert.equal(nativeModelResumeProfileMatches([...desired,receipt,receipt],desired),false);
});

test('sealed profile root exactly matches actual 0.2 repeated boot bytes',async t=>{
  const runtime=selectDshRuntime();if(runtime.version!=='0.2.0-rc.2'){t.skip('Actual 0.2 profile bootstrap contract');return;}
  const lib=path.dirname(runtime.cli),matches=(await fs.readdir(lib)).filter(name=>/^profile-boot-.*\.js$/.test(name));
  assert.equal(matches.length,1);
  const source=await fs.readFile(path.join(lib,matches[0]),'utf8');
  const literal=source.match(/const PROFILE_ROOT_CONFIG = `([^`]*)`;/)?.[1];assert(literal);
  assert.equal(nativeModelProfileRootConfig,literal.replace(/\r\n/g,'\n'));
  assert.match(source,/writeFileSync\(join\(profile\.dir, PROFILE_ROOT_FILENAME\), PROFILE_ROOT_CONFIG\)/);
  const f=await fixture({profileRoot:nativeModelProfileRootConfig});try{
    const file=path.join(f.root,'home/profiles/web/cordis.yml');
    await fs.writeFile(file,literal.replace(/\r\n/g,'\n'));
    assert.equal((await validateNativeModelFresh(f.root)).revision,0);
    await fs.writeFile(file,'[]\n');
    await assert.rejects(validateNativeModelFresh(f.root),/changed/);
  }finally{await f.close();}
});

test('fresh is explicit, sealed and tied to a fresh-only authorization',async()=>{
  const f=await fixture();try {
    const state=await validateNativeModelEntry(f.root,{entry:'fresh',batch:'new',auth:authorization(f.root,'fresh')});assert.equal(state.revision,0);
    await assert.rejects(validateNativeModelEntry(f.root,{entry:'fresh',batch:'new',auth:authorization(f.root,'resume')}),/entry does not match/);
    await assert.rejects(validateNativeModelEntry(f.root,{entry:'resume',batch:'new',auth:authorization(f.root,'fresh')}),/entry does not match/);
    await assert.rejects(validateNativeModelEntry(f.root,{entry:'resume',batch:'new'}),/ENOENT/);
    await fs.appendFile(path.join(f.root,'home/profiles/web/cordis.patch.yml'),'changed');await assert.rejects(validateNativeModelFresh(f.root),/changed/);
  }finally{await f.close();}
});

test('prior sessions, work, journal or batch artifacts cannot masquerade as fresh',async()=>{
  for(const relative of ['work/used.txt','home/sessions/session.json','journal/state.jsonl','outer-session.txt','requests-old.json','report-old.json']) {
    const f=await fixture();try{
      await fs.mkdir(path.dirname(path.join(f.root,relative)),{recursive:true});await fs.writeFile(path.join(f.root,relative),'prior state');
      await assert.rejects(validateNativeModelFresh(f.root),/prior project|empty ordinary|prior batch/);
    }finally{await f.close();}
  }
});

test('one-shot bootstrap claim survives missing journal and new batch cannot rebootstrap',async()=>{
  const f=await fixture();try {
    const state=await validateNativeModelFresh(f.root);await claimNativeModelFresh(f.root,{batch:'new',nonce:state.nonce});
    await assert.rejects(claimNativeModelFresh(f.root,{batch:'another',nonce:state.nonce}),/EEXIST/);
    await assert.rejects(validateNativeModelFresh(f.root,{batch:'another'}),/already started/);
    await fs.mkdir(path.join(f.root,'journal'));
    const before=initialState(),after=structuredClone(before);after.revision=1;after.projects.chat={id:'chat',workspace:path.join(f.root,'work'),status:'running'};
    await fs.writeFile(path.join(f.root,'journal/state.jsonl'),JSON.stringify(encodeJournal(before,after))+'\n');
    assert.equal((await validateNativeModelEntry(f.root,{entry:'resume',batch:'new',auth:authorization(f.root,'resume')})).revision,1);
    await fs.rm(path.join(f.root,'journal'),{recursive:true});await assert.rejects(validateNativeModelFresh(f.root),/already started/);await assert.rejects(validateNativeModelEntry(f.root,{entry:'resume'}),/ENOENT/);
  }finally{await f.close();}
});

test('native fixture without authorization refuses before any credential read or fetch',async()=>{
  const root=await fs.realpath(await fs.mkdtemp('C:/example/foreman-tests/native-model-ui-noauth-'));
  const originalEnv=process.env,originalFetch=globalThis.fetch;let credentialReads=0,requests=0;
  try {
    await fs.mkdir(path.join(root,'home/profiles/web'),{recursive:true});await fs.writeFile(path.join(root,'fixture-marker'),freshMarker);
    await fs.writeFile(path.join(root,'home/profiles/web/cordis.patch.yml'),JSON.stringify([{id:'agent-default-model',config:{provider:'deepseek-official',model:'deepseek-flash'}},{id:'llm-deepseek',config:{}}]));
    process.env=new Proxy(originalEnv, {get(target,key){if(key==='DEEPSEEK_API_KEY'){credentialReads++;throw Error('Credential was read');}if(key==='DSH_HOME')return path.join(root,'home');if(key==='FOREMAN_UI_BATCH')return 'noauth';if(key==='FOREMAN_UI_ENTRY')return 'fresh';return target[key];}});
    globalThis.fetch=async()=>{requests++;throw Error('Unexpected network');};
    await assert.rejects(apply({}, {root}),/ENOENT/);
    assert.equal(credentialReads,0);assert.equal(requests,0);
  }finally{process.env=originalEnv;globalThis.fetch=originalFetch;await fs.rm(root,{recursive:true,force:true});}
});
