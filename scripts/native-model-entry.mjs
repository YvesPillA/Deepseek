import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateNativeModelResume,validateNativeModelAuthorization} from './model-smoke-support.mjs';

export const freshMarker='prepared-fresh-native-model-ui-v2';
// Actual 0.2 prepareProfile rewrites this exact empty root on every boot.
// Prepare identical bytes before sealing; all later changes still reject.
export const nativeModelProfileRootConfig="# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
const sealFiles=['fixture-marker','fixture-runtime.json','home/profiles/web/package.json','home/profiles/web/cordis.yml','home/profiles/web/cordis.patch.yml'];
export function nativeModelResumeProfileMatches(rows,desired) {
  if(JSON.stringify(rows)===JSON.stringify(desired))return true;
  // The real 0.2 welcome dialog durably adds this exact non-secret receipt.
  // Preserve it on resume; it neither changes the model route nor authorizes
  // another plugin/configuration. All unknown rows still refuse preparation.
  return Array.isArray(rows)&&rows.length===desired.length+1&&
    JSON.stringify(rows.slice(0,desired.length))===JSON.stringify(desired)&&
    JSON.stringify(rows.at(-1))===JSON.stringify({id:'ui-settings-general',name:'@deepseek-ai/dsh-client-ui-settings-general',config:{welcomeNoticeVersion:'2026-09-28.1'}});
}
async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function hash(file){const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('Fresh fixture file must be ordinary');return createHash('sha256').update(await fs.readFile(file)).digest('hex');}
export async function sealNativeModelFresh(root) {
  const files={};for(const relative of sealFiles)files[relative]=await hash(path.join(root,relative));
  await fs.writeFile(path.join(root,'fresh-bootstrap.json'),JSON.stringify({schema:1,fixtureRoot:root,projectId:'chat',workspace:path.join(root,'work'),nonce:randomUUID(),createdAt:Date.now(),files},null,2),{flag:'wx'});
}
export async function validateNativeModelFresh(root,{batch}={}) {
  const seal=JSON.parse(await fs.readFile(path.join(root,'fresh-bootstrap.json'),'utf8'));
  if(seal.schema!==1||seal.fixtureRoot!==root||seal.projectId!=='chat'||seal.workspace!==path.join(root,'work')||! /^[a-f0-9-]{36}$/.test(seal.nonce??''))throw Error('Invalid fresh bootstrap seal');
  if(await fs.readFile(path.join(root,'fixture-marker'),'utf8')!==freshMarker)throw Error('Explicit fresh fixture marker required');
  for(const relative of sealFiles)if(seal.files?.[relative]!==await hash(path.join(root,relative)))throw Error('Fresh fixture changed after preparation');
  const runtime=JSON.parse(await fs.readFile(path.join(root,'fixture-runtime.json'),'utf8'));
  if(runtime.version!=='0.2.0-rc.2')throw Error('Fresh bootstrap requires actual 0.2 runtime');
  for(const relative of ['journal','outer-session.txt','fresh-bootstrap-consumed.json'])if(await exists(path.join(root,relative)))throw Error('Fresh bootstrap already started or contains prior project state');
  for(const relative of ['work','home/sessions']) {
    const dir=path.join(root,relative),info=await fs.lstat(dir);
    if(!info.isDirectory()||info.isSymbolicLink()||(await fs.readdir(dir)).length)throw Error('Fresh bootstrap requires empty ordinary work and session directories');
  }
  const allowed=new Set(['home','work','fixture-marker','fixture-runtime.json','fresh-bootstrap.json',...(batch?['run-authorization-'+batch+'.json']:[])]);
  if((await fs.readdir(root)).some(name=>!allowed.has(name)))throw Error('Fresh bootstrap contains a prior batch or unexpected artifact');
  return {entry:'fresh',nonce:seal.nonce,projectId:'chat',revision:0};
}
export async function validateNativeModelEntry(root,{entry='resume',batch,auth}={}) {
  if(!['fresh','resume'].includes(entry))throw Error('Explicit fresh or resume entry required');
  if(auth){validateNativeModelAuthorization(auth,{root,batch});if((auth.entry??'resume')!==entry)throw Error('Authorization entry does not match fresh/resume launch');}
  return entry==='fresh'?validateNativeModelFresh(root,{batch}):validateNativeModelResume(root);
}
export async function claimNativeModelFresh(root,{batch,nonce}) {
  // This receipt is outside the project journal and survives journal loss.
  // Exclusive creation makes bootstrap one-shot even if setup later fails.
  const file=await fs.open(path.join(root,'fresh-bootstrap-consumed.json'),'wx');
  try{await file.writeFile(JSON.stringify({schema:1,nonce,batch,claimedAt:Date.now()}));await file.sync();}finally{await file.close();}
}
