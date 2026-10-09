// Install a verified local release. No package downloads or settings changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const yaml=createRequire('C:/example/dsh/node/node_modules/@deepseek-ai/dsh/package.json')('yaml');
const hash=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
export async function installLocal({home,release,receipt,hostOptions={}}) {
  check(hostOptions && typeof hostOptions==='object' && !Array.isArray(hostOptions) && Object.keys(hostOptions).every(k=>['verification','scheduler'].includes(k)),'Unexpected host options');
  hostOptions=structuredClone(hostOptions);
  home=await fs.realpath(home);release=await fs.realpath(release);
  const moduleRoot=path.join(home,'profiles','node_modules','dsh-foreman-next'),presetRoot=path.join(home,'.agent-presets','foreman-next'),patch=path.join(home,'profiles','web','cordis.patch.yml');
  for(const dir of [path.dirname(moduleRoot),path.dirname(presetRoot),path.dirname(patch)])check(await fs.realpath(dir)===dir,'Installation parent must not be a link');
  for(const root of [moduleRoot,presetRoot]){try{await fs.lstat(root);throw Error('Installation target already exists: '+root);}catch(e){if(e.code!=='ENOENT')throw e;}}
  const manifest=JSON.parse(await fs.readFile(path.join(release,'release-manifest.json'),'utf8'));
  check(manifest.name==='dsh-foreman-next'&&manifest.installed===false,'Invalid release manifest');
  check(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=256,'Invalid release file count');
  const files=[];const seen=new Set();
  for(const entry of manifest.files) {
    check(typeof entry.path==='string'&&!entry.path.includes('\\')&&!entry.path.split('/').some(s=>!s||s==='.'||s==='..')&&!entry.path.includes(':')&&!seen.has(entry.path),'Unsafe release path');seen.add(entry.path);
    check(['package.json','README.md'].includes(entry.path)||/^(src|client|presets)\//.test(entry.path),'Unexpected release file');
    const source=path.join(release,entry.path),s=await fs.lstat(source);
    check(await fs.realpath(source)===source,'Linked release source');
    check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=4*1024*1024,'Invalid release file');
    const bytes=await fs.readFile(source);check(hash(bytes)===entry.sha256,'Release hash mismatch');
    files.push({path:path.join(moduleRoot,entry.path),bytes,sha256:entry.sha256});
    if(entry.path.startsWith('presets/foreman-next/'))files.push({path:path.join(presetRoot,entry.path.slice('presets/foreman-next/'.length)),bytes,sha256:entry.sha256});
  }
  const before=await fs.readFile(patch),tree=yaml.parse(before.toString());check(Array.isArray(tree),'Profile patch must be an array');
  const exists=rows=>rows.some(r=>r?.id==='foreman-next-host'||Array.isArray(r?.insert)&&exists(r.insert));check(!exists(tree),'Foreman host already mounted');
  const config={storageRoot:path.join(home,'storages','foreman-next'),dshHome:home,sessionRoot:path.join(home,'sessions'),...hostOptions};
  const suffix='\n# New foreman mode: isolated host component (project startup remains gated).\n'+yaml.stringify([{insert:[{id:'foreman-next-host',name:'dsh-foreman-next',config}]}]);
  const after=Buffer.from(before.toString().replace(/^\s*\[\]\s*$/,'')+suffix);check(Array.isArray(yaml.parse(after.toString())),'Invalid composed patch');
  const record={home,release,patch,original:before.toString('base64'),beforeHash:hash(before),afterHash:hash(after),files:files.map(({path,sha256})=>({path,sha256})),installed:false};
  await fs.writeFile(receipt,JSON.stringify(record,null,2),{flag:'wx'});
  for(const f of files){await fs.mkdir(path.dirname(f.path),{recursive:true});await fs.writeFile(f.path,f.bytes,{flag:'wx'});check(hash(await fs.readFile(f.path))===f.sha256,'Installed hash mismatch');}
  check(hash(await fs.readFile(patch))===record.beforeHash,'Profile changed during install');
  const pending=patch+'.foreman-next.pending';await fs.writeFile(pending,after,{flag:'wx'});await fs.rename(pending,patch);
  record.installed=true;await fs.writeFile(receipt,JSON.stringify(record,null,2));return {home,moduleRoot,presetRoot,receipt,files:files.length,readyForProjects:false};
}
export async function rollbackLocal(receipt) {
  const r=JSON.parse(await fs.readFile(receipt,'utf8')),home=await fs.realpath(r.home);
  check(r.patch===path.join(home,'profiles','web','cordis.patch.yml'),'Unexpected rollback patch');
  const roots=[path.join(home,'profiles','node_modules','dsh-foreman-next'),path.join(home,'.agent-presets','foreman-next')];
  const current=hash(await fs.readFile(r.patch));check([r.beforeHash,r.afterHash].includes(current),'Profile changed after installation; refusing overwrite');
  for(const f of r.files){check(roots.some(root=>f.path.startsWith(root+path.sep)),'Unexpected rollback file');try{check(hash(await fs.readFile(f.path))===f.sha256,'Installed file changed; refusing removal');}catch(e){if(e.code!=='ENOENT')throw e;}}
  if(current===r.afterHash){const before=Buffer.from(r.original,'base64');check(hash(before)===r.beforeHash,'Backup hash mismatch');const tmp=r.patch+'.foreman-next.rollback';await fs.writeFile(tmp,before,{flag:'wx'});await fs.rename(tmp,r.patch);}
  for(const f of r.files)try{await fs.unlink(f.path);}catch(e){if(e.code!=='ENOENT')throw e;}
  const dirs=new Set();for(const f of r.files)for(let dir=path.dirname(f.path);roots.some(root=>dir===root||dir.startsWith(root+path.sep));dir=path.dirname(dir))dirs.add(dir);
  for(const dir of [...dirs].sort((a,b)=>b.length-a.length))try{await fs.rmdir(dir);}catch(e){if(!['ENOENT','ENOTEMPTY'].includes(e.code))throw e;}
  return {rolledBack:true,home,projectDataPreserved:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,...args]=process.argv.slice(2);
  if(mode==='install'&&args.length===3)console.log(JSON.stringify(await installLocal({home:args[0],release:args[1],receipt:args[2]}),null,2));
  else if(mode==='rollback'&&args.length===1)console.log(JSON.stringify(await rollbackLocal(args[0]),null,2));
  else throw Error('Usage: install-local.mjs install HOME RELEASE RECEIPT | rollback RECEIPT');
}
