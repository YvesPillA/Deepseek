import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const excludedNames=['.git','node_modules','.dsh','.codex','.agent-presets'];
const inside=(root,target)=>{const rel=path.relative(root,target);return rel==='' || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel));};

/** Immutable-by-address source snapshots. Does not claim OS write protection.
 * Reviewer reads are verified against hashes. Reject links rather than following
 * them outside the project. Capture only at a host-controlled write barrier.
 */
export class ArtifactStore {
  #root; #limits;
  constructor(root,{maxFiles=20000,maxBytes=256*1024*1024}={}) {
    if(!path.isAbsolute(root))throw new Error('Absolute artifact root required');
    this.#root=path.resolve(root);this.#limits={maxFiles,maxBytes};
  }
  async #scan(workspace) {
    const files=[];let total=0;
    const visit=async(dir,relative='')=>{
      const entries=(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
      for(const entry of entries) {
        const name=relative?relative+'/'+entry.name:entry.name;
        // Dependencies and git internals are not source deliverables. Exclusions are recorded in manifest.
        if(excludedNames.includes(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('.foreman-write-'))continue;
        const absolute=path.join(dir,entry.name);
        const stat=await fs.lstat(absolute);
        if(stat.isSymbolicLink())throw new Error(`Artifact contains a link: ${name}`);
        if(!inside(workspace,await fs.realpath(absolute)))throw new Error('Artifact path escaped workspace');
        if(stat.isDirectory())await visit(absolute,name);
        else if(stat.isFile()) {
          if(stat.nlink!==1)throw new Error(`Artifact contains a hard link: ${name}`);
          if(files.length>=this.#limits.maxFiles || total+stat.size>this.#limits.maxBytes)throw new Error('Artifact size limit exceeded');
          const bytes=await fs.readFile(absolute);
          const after=await fs.lstat(absolute);
          if(after.isSymbolicLink() || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ino!==stat.ino)throw new Error('Workspace changed during capture');
          total+=bytes.length;
          if(total>this.#limits.maxBytes)throw new Error('Artifact size limit exceeded');
          files.push({path:name,size:bytes.length,hash:hash(bytes),bytes});
        } else throw new Error(`Unsupported artifact file: ${name}`);
      }
    };
    await visit(workspace);return files;
  }
  async capture(workspace) {
    const source=await fs.realpath(workspace);
    await fs.mkdir(this.#root,{recursive:true});
    const root=await fs.realpath(this.#root);
    if(inside(source,root)||inside(root,source))throw new Error('Artifact storage must be separate from executor workspace');
    const files=await this.#scan(source);
    const manifest={version:1,excludedNames,excludedPrefixes:['.foreman-write-'],files:files.map(({bytes,...entry})=>entry)};
    const confirmation=await this.#scan(source);
    if(JSON.stringify(manifest.files)!==JSON.stringify(confirmation.map(({bytes,...entry})=>entry)))throw new Error('Workspace changed during capture');
    const json=JSON.stringify(manifest),digest=hash(json),target=path.join(root,digest);
    const staging=path.join(root,'.pending-'+randomUUID());
    await fs.mkdir(staging);
    try {
      for(const file of files){const dst=path.join(staging,'files',file.path);await fs.mkdir(path.dirname(dst),{recursive:true});await fs.writeFile(dst,file.bytes,{flag:'wx'});}
      await fs.writeFile(path.join(staging,'manifest.json'),json,{flag:'wx'});
      try {await fs.rename(staging,target);}
      catch(e){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(e.code))throw e;await this.verify(digest);}
    } finally {
      const checked=path.resolve(staging);
      if(path.dirname(checked)!==root||!path.basename(checked).startsWith('.pending-'))throw new Error('Invalid cleanup target');
      await fs.rm(checked,{recursive:true,force:true});
    }
    await this.verify(digest);return `sha256:${digest}`;
  }
  async #manifest(reference) {
    const id=reference.replace(/^sha256:/,'');
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid artifact reference');
    const dir=path.join(this.#root,id),file=path.join(dir,'manifest.json');
    const raw=await fs.readFile(file);
    if(hash(raw)!==id)throw new Error('Artifact manifest hash mismatch');
    const manifest=JSON.parse(raw);
    if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('Invalid manifest');
    return {dir,manifest};
  }
  async read(reference,relative) {
    const {dir,manifest}=await this.#manifest(reference);
    const record=manifest.files.find(f=>f.path===relative);
    if(!record)throw new Error('File not in reviewed artifact');
    const file=path.resolve(dir,'files',relative);
    if(!inside(path.join(dir,'files'),file))throw new Error('Invalid artifact path');
    const bytes=await fs.readFile(file);
    if(bytes.length!==record.size||hash(bytes)!==record.hash)throw new Error('Artifact content was modified');
    return bytes;
  }
  async verify(reference) {
    const {manifest}=await this.#manifest(reference);
    for(const record of manifest.files)await this.read(reference,record.path);
    return structuredClone(manifest);
  }
}
