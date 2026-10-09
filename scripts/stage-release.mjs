// Reproducible local staging only. Does not install or edit DSH configuration.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const source=fileURLToPath(new URL('../',import.meta.url)),root=path.join(source,'artifacts','releases');
await fs.mkdir(root,{recursive:true});
const destination=await fs.mkdtemp(path.join(root,'candidate-')),files=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function copy(relative) {
  const target=path.join(source,relative),stat=await fs.lstat(target);
  if(stat.isSymbolicLink())throw Error('Release sources cannot contain links');
  if(stat.isDirectory()) {
    for(const name of (await fs.readdir(target)).sort())await copy(relative+'/'+name);
  }else {
    if(!stat.isFile()||stat.nlink!==1||stat.size>4*1024*1024)throw Error('Unexpected release source');
    const bytes=await fs.readFile(target),out=path.join(destination,relative);
    await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,bytes,{flag:'wx'});
    if(hash(await fs.readFile(out))!==hash(bytes))throw Error('Staged file hash mismatch');
    files.push({path:relative,bytes:bytes.length,sha256:hash(bytes)});
  }
}
for(const relative of ['package.json','README.md','src','client','presets'])await copy(relative);
const pkg=JSON.parse(await fs.readFile(path.join(destination,'package.json'),'utf8'));
for(const file of Object.values(pkg.exports))if(!files.some(f=>'./'+f.path===file))throw Error('Package export is missing');
await fs.writeFile(path.join(destination,'release-manifest.json'),JSON.stringify({name:pkg.name,version:pkg.version,
  stagedAt:new Date().toISOString(),readyForProjects:false,installed:false,files},null,2));
console.log(JSON.stringify({destination,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),installed:false},null,2));
