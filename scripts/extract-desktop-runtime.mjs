import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function safeArchivePath(root,relative) {
  if(typeof relative!=='string'||!relative||/[\\:\0<>|?*]/.test(relative)||relative.startsWith('/')||relative.split('/').some(p=>!p||p==='.'||p==='..'||/[ .]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe archive path');
  const out=path.resolve(root,...relative.split('/'));
  if(!out.startsWith(path.resolve(root)+path.sep))throw Error('Archive path escapes root');
  return out;
}

export async function extractDesktopRuntime(archive,destination,{shellOnly=false}={}) {
  const file=await fs.open(archive,'r');
  try {
    const prefix=Buffer.alloc(16);await file.read(prefix,0,16,0);
    const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
    if(headerSize<8||jsonSize>headerSize-8||headerSize>32000000)throw Error('Invalid ASAR header');
    const json=Buffer.alloc(jsonSize);await file.read(json,0,json.length,16);
    const header=JSON.parse(json),base=8+headerSize,entries=new Map();
    function walk(files,parent=''){for(const [name,entry] of Object.entries(files??{})){const rel=parent?parent+'/'+name:name;safeArchivePath(destination,rel);if(entry.files)walk(entry.files,rel);else entries.set(rel,entry);}}
    walk(header.files);
    await fs.mkdir(destination); // Refuse overwriting an existing extracted runtime.
    const installed=path.resolve(archive+'.unpacked');let packed=0,unpacked=0,links=0;
    async function materialize(rel,visiting=new Set()) {
      if(visiting.has(rel))throw Error('Cyclic ASAR link');
      const entry=entries.get(rel);if(!entry)throw Error('Missing ASAR link target: '+rel);
      if(entry.link){const target=entry.link;safeArchivePath(destination,target);if(!target.startsWith('dsh/'))throw Error('ASAR link outside runtime');links++;return materialize(target,new Set([...visiting,rel]));}
      let data;
      if(entry.unpacked){const source=safeArchivePath(installed,rel);const real=await fs.realpath(source);if(!real.startsWith(installed+path.sep))throw Error('Unpacked source escapes root');data=await fs.readFile(real);unpacked++;}
      else {const size=entry.size,offset=Number(entry.offset);if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid ASAR file bounds');data=Buffer.alloc(size);const read=await file.read(data,0,size,base+offset);if(read.bytesRead!==size)throw Error('Truncated ASAR file');packed++;}
      if(entry.integrity?.algorithm==='SHA256'&&createHash('sha256').update(data).digest('hex')!==entry.integrity.hash)throw Error('ASAR integrity mismatch: '+rel);
      return data;
    }
    for(const [rel,entry] of entries){if(shellOnly?!rel.startsWith('lib/')&&rel!=='package.json':!rel.startsWith('dsh/'))continue;const out=safeArchivePath(destination,rel);await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,await materialize(rel));}
    const archiveHash=createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    const pkg=JSON.parse(await fs.readFile(path.join(destination,shellOnly?'package.json':'dsh/package.json'),'utf8'));
    const desktop=shellOnly?{}:JSON.parse(await fs.readFile(path.join(destination,'dsh/desktop-runtime.json'),'utf8'));
    const appPkg=JSON.parse((await materialize('package.json')).toString('utf8'));
    const metadata={source:path.resolve(archive),sourceSha256:archiveHash,extractedAt:new Date().toISOString(),version:pkg.version,buildCommit:appPkg.dshBuildCommit??appPkg.buildCommit??desktop.buildCommit??pkg.buildCommit,packed,unpacked,links};
    await fs.writeFile(path.join(destination,'source-metadata.json'),JSON.stringify(metadata,null,2)+'\n');return metadata;
  }finally{await file.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await extractDesktopRuntime(process.argv[2],process.argv[3],{shellOnly:process.argv[4]==='--shell-only'}),null,2));
