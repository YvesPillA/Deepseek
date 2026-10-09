import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,target)=>{const rel=path.relative(root,target);return !rel || rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);};
const reserved=name=>['.git','node_modules','.dsh','.codex','.agent-presets'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('.foreman-write-');
function segments(relative,allowRoot=false) {
  check(typeof relative==='string' && relative.length<=1000,'Invalid workspace path');
  if(relative==='' && allowRoot)return [];
  const parts=relative.split('/');
  check(parts.every(p=>p && !['.','..'].includes(p) && !/[\\:<>"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) &&
    !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p) && !reserved(p)),'Unsafe or protected workspace path');
  return parts;
}

/** Restricted file capability, not a shell sandbox. Assumes all agent writes go
 * through this controller; hostile external filesystem writers remain an OS concern.
 * Caller must include journal, plugin code, DSH home and session storage in protectedRoots.
 */
export class WorkspaceFiles {
  #controller;#artifacts;#protected;#max;#plans=new WeakMap();
  constructor(controller,{artifacts,protectedRoots,maxBytes=1024*1024}) {
    check(Array.isArray(protectedRoots) && protectedRoots.length>0 && protectedRoots.every(p=>path.isAbsolute(p)),'Absolute protected roots required');
    check(Number.isSafeInteger(maxBytes) && maxBytes>0,'Invalid file limit');
    this.#controller=controller;this.#artifacts=artifacts;this.#protected=protectedRoots.map(p=>path.resolve(p));this.#max=maxBytes;
  }
  async #directory(workspace) {
    check(typeof workspace==='string' && path.isAbsolute(workspace),'Absolute workspace required');
    const resolved=path.resolve(workspace),volume=path.parse(resolved).root;
    let current=volume,stat=await fs.lstat(current);
    check(!stat.isSymbolicLink() && stat.isDirectory(),'Workspace links are not permitted');
    for(const part of path.relative(volume,resolved).split(path.sep).filter(Boolean)) {
      current=path.join(current,part);stat=await fs.lstat(current);
      check(!stat.isSymbolicLink(),'Workspace links are not permitted');
      check(stat.isDirectory(),'Workspace must be a directory');
    }
    return {root:await fs.realpath(resolved),stat};
  }
  async #boundaries(root) {
    check(root!==path.parse(root).root,'Volume root cannot be an execution workspace');
    for(const protectedPath of this.#protected) {
      // Missing protected paths fail closed: host must provision them before mounting.
      const real=await fs.realpath(protectedPath);
      check(!inside(root,real) && !inside(real,root),'Workspace overlaps protected storage');
    }
  }
  async #root(workspace) {
    const {root}=await this.#directory(workspace);
    await this.#boundaries(root);return root;
  }
  async #overlaps(root,projects,excludeId) {
    for(const p of Object.values(projects)) {
      if(p.id===excludeId)continue;
      // Only host deletion of a terminal project releases its reservation.
      if(p.deleted===true && ['cancelled','delivered'].includes(p.status))continue;
      let peer;
      try {peer=await fs.realpath(p.workspace);}
      catch(e){if(e.code!=='ENOENT')throw e;peer=path.resolve(p.workspace);}
      check(!inside(root,peer) && !inside(peer,root),`Workspace overlaps project ${p.id}`);
    }
  }
  async validateWorkspace(workspace,projects={},excludeId) {
    const root=await this.#root(workspace);
    await this.#overlaps(root,projects,excludeId);
    return root;
  }
  #sameDirectory(before,after) {
    check(before.root===after.root && before.stat.dev===after.stat.dev && before.stat.ino===after.stat.ino &&
      before.stat.birthtimeMs===after.stat.birthtimeMs,'Workspace parent or directory changed after preparation');
  }
  async #absent(workspace) {
    try {await fs.lstat(workspace);}
    catch(e){if(e.code==='ENOENT')return;throw e;}
    throw new Error('Workspace appeared after preparation; prepare again');
  }
  /** Read-only preparation. The returned object is an instance-bound, single-use
   * host capability; copying its display fields does not grant creation rights. */
  async prepareWorkspace(workspace,projects={}) {
    check(typeof workspace==='string' && path.isAbsolute(workspace),'Absolute workspace required');
    const requested=path.resolve(workspace);
    let existing;
    try {await fs.lstat(requested);existing=true;}
    catch(e){if(e.code!=='ENOENT')throw e;existing=false;}
    let identity,root;
    if(existing) {
      root=await this.validateWorkspace(requested,projects);
      identity=await this.#directory(requested);
      check(root===identity.root,'Workspace changed during preparation');
    } else {
      const leaf=path.basename(requested);segments(leaf);
      identity=await this.#directory(path.dirname(requested));
      root=path.join(identity.root,leaf);
      await this.#boundaries(root);await this.#overlaps(root,projects);
      await this.#absent(requested);
    }
    const plan=Object.freeze({workspace:root,create:!existing});
    this.#plans.set(plan,{requested,identity});return plan;
  }
  async confirmWorkspace(plan,projects={}, {authorize}={}) {
    const prepared=plan && this.#plans.get(plan);
    check(prepared,'Invalid or consumed workspace preparation');
    check(typeof authorize==='function','Workspace confirmation authorization required');
    this.#plans.delete(plan);
    const permit=()=>{
      const allowed=authorize();
      check(!allowed || typeof allowed.then!=='function','Workspace authorization must be synchronous');
      check(allowed!==false,'Workspace confirmation is no longer authorized');
    };
    const recheck=async(created=false)=>{
      const identity=await this.#directory(plan.create?path.dirname(prepared.requested):prepared.requested);
      this.#sameDirectory(prepared.identity,identity);
      await this.#boundaries(plan.workspace);await this.#overlaps(plan.workspace,projects);
      if(plan.create && !created)await this.#absent(prepared.requested);
      else check(await this.validateWorkspace(prepared.requested,projects)===plan.workspace,'Workspace changed after preparation');
    };
    permit();await recheck();permit();
    if(plan.create) {
      // Never merge with an EEXIST race and never recursively remove user data
      // when a subsequent authorization or filesystem check fails.
      await fs.mkdir(prepared.requested);
      await recheck(true);
    }
    permit();await recheck(plan.create);permit();return plan.workspace;
  }
  async #target(root,parts,{parents=false}={}) {
    let current=root;
    for(let i=0;i<parts.length;i++) {
      current=path.join(current,parts[i]);
      let stat;
      try {stat=await fs.lstat(current);}
      catch(e) {
        if(e.code!=='ENOENT')throw e;
        if(i===parts.length-1)return {file:current,stat:null};
        check(parents,'Parent directory does not exist');
        await fs.mkdir(current);stat=await fs.lstat(current);
      }
      check(!stat.isSymbolicLink(),'Workspace links are not permitted');
      check(inside(root,await fs.realpath(current)),'Workspace path escaped');
      if(i<parts.length-1)check(stat.isDirectory(),'Parent is not a directory');
      else return {file:current,stat};
    }
    return {file:root,stat:await fs.lstat(root)};
  }
  async #bytes(target) {
    check(target.stat?.isFile() && target.stat.nlink===1,'Expected an ordinary single-link file');
    check(target.stat.size<=this.#max,'File exceeds capability size limit');
    const handle=await fs.open(target.file,'r');
    try {
      const stat=await handle.stat();
      check(stat.isFile() && stat.nlink===1 && stat.ino===target.stat.ino && stat.size<=this.#max,'File changed while opening');
      const bytes=Buffer.alloc(this.#max+1);let length=0;
      while(length<bytes.length) {
        const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);
        if(!bytesRead)break;length+=bytesRead;
      }
      check(length<=this.#max,'File exceeds capability size limit');return bytes.subarray(0,length);
    } finally {await handle.close();}
  }
  run(agent,raw,signal) {
    const args=structuredClone(raw);
    return this.#controller.executorFiles(agent,async p=>{
      signal?.throwIfAborted();
      check(args && ['list','read','write','delete'].includes(args.action),'Invalid file action');
      const allowed=args.action==='write'?['action','path','text','expectedHash']:args.action==='delete'?['action','path','expectedHash']:['action','path'];
      check(Object.keys(args).every(k=>allowed.includes(k)),'Unexpected file arguments');
      if(['write','delete'].includes(args.action))check(Object.hasOwn(args,'expectedHash') && (args.expectedHash===null || typeof args.expectedHash==='string' && /^[a-f0-9]{64}$/.test(args.expectedHash)),'Expected hash required; null means create only');
      if(args.action==='write')check(typeof args.text==='string' && Buffer.byteLength(args.text,'utf8')<=this.#max,'Invalid or oversized text');
      const parts=segments(args.path,args.action==='list');
      const root=await this.#root(p.workspace);
      const target=await this.#target(root,parts,{parents:args.action==='write'});
      if(args.action==='list') {
        check(target.stat?.isDirectory(),'Not a directory');
        const entries=await fs.readdir(target.file,{withFileTypes:true});check(entries.length<=2000,'Directory too large');
        return {entries:entries.filter(e=>!reserved(e.name)).map(e=>({name:e.name,kind:e.isSymbolicLink()?'blocked-link':e.isDirectory()?'directory':'file'}))};
      }
      const before=target.stat?await this.#bytes(target):null;
      if(args.action==='read') {
        check(before,'File does not exist');return {text:new TextDecoder('utf-8',{fatal:true}).decode(before),hash:hash(before)};
      }
      check(args.expectedHash===(before?hash(before):null),'File changed; read current content before editing');
      signal?.throwIfAborted();
      if(args.action==='delete') {check(before,'File does not exist');await fs.unlink(target.file);return {deleted:true};}
      const bytes=Buffer.from(args.text,'utf8'),temp=path.join(path.dirname(target.file),'.foreman-write-'+randomUUID());
      let handle;
      try {
        handle=await fs.open(temp,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
        signal?.throwIfAborted();
        // All plugin writes and capture operations are serialized. Recheck the path
        // before replacement, and replace the directory entry rather than a hardlink.
        const again=await this.#target(root,parts);
        const current=again.stat?await this.#bytes(again):null;
        check(args.expectedHash===(current?hash(current):null),'File changed during write');
        await fs.rename(temp,target.file);return {hash:hash(bytes),bytes:bytes.length};
      } finally {await handle?.close();await fs.rm(temp,{force:true});}
    });
  }
  async capture(project) {
    // Called only from Controller.captureArtifact inside its serialization queue.
    check(this.#artifacts,'Artifact store is not connected');
    const root=await this.#root(project.workspace);
    return this.#artifacts.capture(root);
  }
}
