import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateVerificationCommand} from './container-verifier.mjs';

const check=(ok,message)=>{if(!ok)throw Error(message);};
const inside=(root,target)=>{const relative=path.relative(root,target);return !relative || relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);};
const overlaps=(a,b)=>inside(a,b)||inside(b,a);
const NAME=/^dsh-foreman-native-[a-f0-9-]{36}$/;
const OUTPUT_BYTES=1024*1024;
const BASIC_ENV=new Set(['SYSTEMROOT','WINDIR','PATH','PATHEXT','COMSPEC','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','SYSTEMDRIVE','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS']);
function nativeEnvironment(directory) {
  // The subprocess seam merges overrides after its own credential scrub. Use
  // tombstones for every ambient non-basic key, including case aliases on Windows.
  const env={};
  for(const key of Object.keys(process.env))if(!BASIC_ENV.has(key.toUpperCase()))env[key]=undefined;
  return {...env,ELECTRON_RUN_AS_NODE:'1',CI:'1',HOME:directory,USERPROFILE:directory,
    APPDATA:path.join(directory,'.native-cache','roaming'),LOCALAPPDATA:path.join(directory,'.native-cache','local'),
    npm_config_cache:path.join(directory,'.native-cache','npm'),NODE_OPTIONS:undefined,NODE_TEST_CONTEXT:undefined};
}
function fileParts(value) {
  check(typeof value==='string' && value.length>0 && value.length<=1000,'Unsafe native snapshot path');
  const parts=value.split('/');
  check(parts.every(p=>p && !['.','..'].includes(p) && !/[\\:<>"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) &&
    !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p)),'Unsafe native snapshot path');
  return parts;
}
function payloadOf(input,request) {
  check(Buffer.isBuffer(input) && input.length<=24*1024*1024,'Bounded native snapshot payload required');
  const payload=JSON.parse(input),seen=new Set();let total=0;
  check(payload.command===request.command && JSON.stringify(payload.args)===JSON.stringify(request.args) && payload.timeoutMs===request.timeoutMs &&
    Array.isArray(payload.files) && payload.files.length<=20000,'Snapshot command differs from authorized native request');
  return payload.files.map(file=>{
    const parts=fileParts(file.path),key=parts.join('/').toLowerCase();
    check(!seen.has(key),'Duplicate native snapshot path');seen.add(key);
    check(typeof file.base64==='string' && /^[A-Za-z0-9+/]*={0,2}$/.test(file.base64),'Invalid native snapshot bytes');
    const bytes=Buffer.from(file.base64,'base64');
    check(bytes.toString('base64')===file.base64,'Invalid native snapshot bytes');
    total+=bytes.length;check(total<=16*1024*1024,'Native snapshot too large');
    return {parts,bytes};
  });
}
function outputOf(handle) {
  const stdout=handle.collected.stdout?.readFrom(0)??{text:'',lossy:false};
  const stderr=handle.collected.stderr?.readFrom(0)??{text:'',lossy:false};
  return {stdout:stdout.text,stderr:stderr.text,truncated:stdout.lossy||stderr.lossy};
}

/** Host-owned detached Windows snapshot execution. Official Windows confinement
 * is write-only/partial: reads and network remain available. No shell tool or
 * permission escalation is exposed to the project model. */
export class NativeVerifier {
  get kind(){return 'native';}
  get description(){return '本机 Windows 快照执行；限制文件写入，读取与网络不隔离。';}
  get cwdNote(){return '项目根的本机临时副本；验证生成的文件不会写回项目。';}
  #sandbox;#subprocess;#protected;#parent;#node;#active=new Map();#closed=false;#closing;
  constructor({sandbox,subprocess,protectedRoots,runtimeNode=process.execPath,snapshotParent=os.tmpdir()}) {
    check(typeof sandbox?.confine==='function' && typeof subprocess?.spawn==='function' && typeof subprocess?.resolveExecutable==='function','Native sandbox and subprocess services required');
    check(Array.isArray(protectedRoots) && protectedRoots.length>0 && protectedRoots.every(p=>path.isAbsolute(p)),'Absolute native protected roots required');
    check(path.isAbsolute(snapshotParent) && path.isAbsolute(runtimeNode),'Absolute native snapshot parent and runtime Node required');
    this.#sandbox=sandbox;this.#subprocess=subprocess;this.#protected=[...protectedRoots];this.#parent=path.resolve(snapshotParent);this.#node=runtimeNode;
  }
  #requireJob() {
    check(process.platform==='win32','Native verification currently requires Windows');
    check(this.#subprocess.selectContainmentMode?.('ordinary')==='windows-job','Native verification requires the official Windows Job owner; weaker fallbacks are refused');
  }
  async #safeParent() {
    const parent=await fs.realpath(this.#parent);
    check((await fs.lstat(parent)).isDirectory(),'Native snapshot parent must be a directory');
    for(const root of this.#protected)check(!inside(await fs.realpath(root),parent),'Native snapshot parent is inside protected storage');
    return parent;
  }
  async #remove(name,directory) {
    const parent=await this.#safeParent();
    check(NAME.test(name) && directory===path.join(parent,name),'Invalid native snapshot cleanup identity');
    for(const root of this.#protected)check(!overlaps(directory,await fs.realpath(root)),'Native snapshot overlaps protected storage');
    let stat;try{stat=await fs.lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
    check(!stat.isSymbolicLink() && stat.isDirectory() && await fs.realpath(directory)===directory,'Native snapshot cleanup path was replaced');
    // Node removes links encountered inside a tree rather than following them.
    // The exact root was checked above; no parent or computed broad path is removed.
    await fs.rm(directory,{recursive:true,force:false});
    try{await fs.lstat(directory);throw Error('Native snapshot cleanup could not be confirmed');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async probe() {
    this.#requireJob();
    const request={command:'node',args:['-e','process.stdout.write("foreman-native-probe")'],timeoutMs:15000};
    const result=await this.run(Buffer.from(JSON.stringify({...request,files:[]})),request,{recordOwnership:async()=>{}});
    check(result.exitCode===0 && result.stdout==='foreman-native-probe' && !result.truncated,'Native runtime/sandbox startup probe failed');
    return {backend:'native',sandbox:'workspace-write',enforcement:'partial',runtimeNode:this.#node,
      resourceLimits:{timeoutMs:600000,outputBytes:OUTPUT_BYTES,cpu:false,memory:false,pids:false},readsRestricted:false,networkRestricted:false};
  }
  run(input,raw,options={}) {
    if(this.#closed)return Promise.reject(Error('Native verifier is closed'));
    const name='dsh-foreman-native-'+randomUUID(),abort=new AbortController();
    const operation=this.#run(name,Buffer.isBuffer(input)?Buffer.from(input):input,raw,{...options,signal:options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal});
    this.#active.set(name,{abort,operation});
    void operation.then(()=>this.#active.delete(name),()=>this.#active.delete(name));return operation;
  }
  async #run(name,input,raw,{signal,recordOwnership,project,workspaceRoot}) {
    this.#requireJob();const request=validateVerificationCommand(raw),files=payloadOf(input,request);
    check(typeof recordOwnership==='function','Durable native ownership recorder required');signal?.throwIfAborted();
    const parent=await this.#safeParent(),directory=path.join(parent,name);
    for(const root of this.#protected)check(!overlaps(directory,await fs.realpath(root)),'Native snapshot overlaps protected storage');
    check(!project || path.isAbsolute(workspaceRoot??''),'Trusted native project workspace required');
    if(workspaceRoot!==undefined) {
      check(path.isAbsolute(workspaceRoot),'Absolute native project workspace required');
      const workspace=await fs.realpath(workspaceRoot),tempRoot=await fs.realpath(os.tmpdir());
      check(!overlaps(directory,workspace) && !inside(workspace,tempRoot),'Native snapshot or private temp would overlap the real project workspace');
    }
    const record=status=>recordOwnership({name,backend:'native',status,directory});
    await record('reserved');
    let handle,result,failure,cleanupFailure,timer,timeout=false,created=false;
    const deadline=new AbortController(),combined=AbortSignal.any([signal,deadline.signal]);
    try {
      combined.throwIfAborted();await fs.mkdir(directory,{recursive:false});created=true;
      for(const file of files) {
        combined.throwIfAborted();const target=path.join(directory,...file.parts);
        await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.bytes,{flag:'wx'});
      }
      const env=nativeEnvironment(directory);
      const command=await this.#subprocess.resolveExecutable(request.command.toLowerCase()==='node'||request.command.toLowerCase()==='node.exe'?this.#node:request.command,env,combined);
      const confined=await this.#sandbox.confine([command,...request.args],{mode:'workspace-write',workspaceRoot:directory},combined);
      check(confined?.enforcement==='partial' && Array.isArray(confined.argv) && confined.argv.length>request.args.length+1,'Official Windows confinement required');
      combined.throwIfAborted();this.#requireJob();
      handle=this.#subprocess.spawn({argv:confined.argv,cwd:directory,env,stdio:{stdin:'ignore',stdout:{maxBytes:OUTPUT_BYTES/2},stderr:{maxBytes:OUTPUT_BYTES/2}},graceMs:1000,signal:combined});
      // Observe settlement immediately, including a failed spawn while recording.
      const done=handle.done;void done.catch(()=>{});
      timer=setTimeout(()=>{timeout=true;deadline.abort(Error('Native verification timed out'));},request.timeoutMs);
      await record('running');
      const outcome=await done;await handle.waitForExit();
      result={exitCode:Number.isInteger(outcome.exitCode)?outcome.exitCode:128,...outputOf(handle),oomKilled:false};
      if(result.stderr.includes('windows-acl-run:'))throw Error('Official Windows sandbox runner failed or could not clean its private temp: '+result.stderr.slice(0,2000));
    } catch(error){failure=error;}
    finally {
      clearTimeout(timer);
      try {
        if(handle){await handle.terminate();await handle.waitForExit();await handle.done.catch(()=>{});}
        if(created)await this.#remove(name,directory);
        else {try{await fs.lstat(directory);throw Error('Uncreated native snapshot unexpectedly exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
        await record('removed');
      } catch(error){cleanupFailure=error;failure=failure?new AggregateError([failure,error],'Native verification and cleanup failed'):error;}
    }
    // Cancellation never receives an authoritative success, even after cleanup.
    if(cleanupFailure)throw failure;
    signal?.throwIfAborted();
    if(failure)throw failure;
    if(timeout)return {exitCode:124,...outputOf(handle),stderr:outputOf(handle).stderr+'\n[native verification timed out]',oomKilled:false};
    return result;
  }
  close() {
    if(this.#closing)return this.#closing;this.#closed=true;
    for(const active of this.#active.values())active.abort.abort(Error('Native verifier shutting down'));
    this.#closing=Promise.allSettled([...this.#active.values()].map(active=>active.operation));return this.#closing;
  }
}
