import {randomUUID} from 'node:crypto';
import {profileFromFiles,DEPENDENCY_LABEL} from './dependency-profile.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
const safePath=value=>typeof value==='string' && value.length<=1000 && value.split('/').every(part=>
  part && !['.','..'].includes(part) && !/[\\:\x00-\x1f]/.test(part));

// Runs as PID 1 in a disposable Linux container. No project path, mount, Docker
// socket, or host environment is sent to the container. This is fixed host code;
// project commands are argv values, never interpolated into it.
export const CONTAINER_BOOTSTRAP=String.raw`
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
let chunks=[],size=0;
process.stdin.on('data',b=>{size+=b.length;if(size>24*1024*1024)process.exit(125);chunks.push(b)});
process.stdin.on('end',()=>{
  try {
    const input=JSON.parse(Buffer.concat(chunks));
    if(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||input.timeoutMs>600000)throw Error('Invalid timeout');
    for(const file of input.files){
      if(typeof file.path!=='string'||!file.path.split('/').every(p=>p&&!['.','..'].includes(p)&&!/[\\:\x00-\x1f]/.test(p)))throw Error('Unsafe file');
      const target=path.join('/work',file.path);fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,Buffer.from(file.base64,'base64'),{flag:'wx',mode:0o600});
    }
    if(input.preparedDependencies)fs.symlinkSync('/home/node/foreman-deps/node_modules','/work/node_modules','dir');
    const child=spawn(input.command,input.args,{cwd:'/work',stdio:['ignore','inherit','inherit'],shell:false,env:{PATH:'/work/node_modules/.bin:'+process.env.PATH,HOME:'/tmp',TMPDIR:'/tmp',CI:'1'}});
    const timer=setTimeout(()=>process.exit(124),input.timeoutMs);
    child.on('error',()=>process.exit(125));
    child.on('exit',(code,signal)=>{clearTimeout(timer);process.exit(Number.isInteger(code)?code:128)});
  }catch{process.exit(125)}
});
// Bound input stalls too, including a host crash before stdin closes.
setTimeout(()=>process.exit(124),900000).unref();
`;

export function validateVerificationCommand(raw) {
  check(raw && typeof raw==='object' && !Array.isArray(raw) && Object.keys(raw).every(k=>['command','args','timeoutMs'].includes(k)),'Invalid verification request');
  check(typeof raw.command==='string' && raw.command.length>0 && raw.command.length<=1000 && !raw.command.startsWith('-') && !/[\x00\r\n]/.test(raw.command),'Invalid container command');
  check(Array.isArray(raw.args) && raw.args.length<=100 && raw.args.every(a=>typeof a==='string' && a.length<=8000 && !a.includes('\0')),'Invalid container arguments');
  check(raw.command.length+raw.args.reduce((n,a)=>n+a.length,0)<=16000,'Container command too large');
  const timeoutMs=raw.timeoutMs??120000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=600000,'Invalid verification timeout');
  return {command:raw.command,args:[...raw.args],timeoutMs};
}

/** Read verified content into a bounded, plain-file payload. Nothing is mounted
 * from the host, and test-created files never flow back into the project. */
export async function verificationInput(artifacts,reference,raw,{maxBytes=16*1024*1024}={}) {
  const command=validateVerificationCommand(raw),manifest=await artifacts.verify(reference),files=[],seen=new Set();let total=0;
  check(manifest.files.length<=20000,'Too many verification files');
  for(const file of manifest.files) {
    check(safePath(file.path) && !seen.has(file.path),'Unsafe or duplicate verification path');seen.add(file.path);
    const bytes=await artifacts.read(reference,file.path);total+=bytes.length;
    check(total<=maxBytes,'Verification snapshot too large');
    files.push({path:file.path,base64:bytes.toString('base64')});
  }
  const input=Buffer.from(JSON.stringify({...command,files}));
  check(input.length<=24*1024*1024,'Verification payload too large');return input;
}

/** Dormant backend. runCli is a trusted host adapter, never a model argument.
 * Installation/daemon validation and durable container ownership are required
 * before exposing this backend to real projects. */
export class ContainerVerifier {
  #cli;#image;#active=new Map();#closed=false;#closing;
  constructor({runCli,image}) {
    check(typeof runCli==='function','Trusted CLI adapter required');
    check(typeof image==='string' && /^sha256:[a-f0-9]{64}$/.test(image),'Pinned local image ID required');
    this.#cli=runCli;this.#image=image;
  }
  async run(input,raw,{signal,recordOwnership}={}) {
    check(!this.#closed,'Verifier is closed');signal?.throwIfAborted();
    const command=validateVerificationCommand(raw);
    check(Buffer.isBuffer(input) && input.length<=24*1024*1024,'Bounded snapshot payload required');
    input=Buffer.from(input);
    const payload=JSON.parse(input);
    check(payload.command===command.command && JSON.stringify(payload.args)===JSON.stringify(command.args) && payload.timeoutMs===command.timeoutMs &&
      Array.isArray(payload.files) && payload.files.length<=20000 && payload.files.every(f=>safePath(f.path) && typeof f.base64==='string'),'Snapshot command differs from authorized request');
    check(typeof recordOwnership==='function','Durable ownership recorder required');
    const name='dsh-foreman-run-'+randomUUID(),abort=new AbortController();
    const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const operation=this.#run(name,input,command,combined,recordOwnership);
    this.#active.set(name,{abort,operation});
    try{return await operation;}finally{this.#active.delete(name);}
  }
  async #run(name,input,command,signal,recordOwnership) {
    // Durable before even attempting create: a lost CLI response is ambiguous.
    await recordOwnership({name,image:this.#image,status:'reserved'});
    let result,error,cleaned=false;
    try {
      signal.throwIfAborted();
      const info=await this.#cli(['image','inspect',this.#image],{signal,maxOutputBytes:65536,timeoutMs:10000});
      check(info.exitCode===0,'Pinned verification image is not available');
      const images=JSON.parse(info.stdout),image=images[0];
      check(images.length===1 && image.Id===this.#image && image.Os==='linux' && !Object.keys(image.Config?.Volumes??{}).length,'Image must be Linux without declared volumes');
      const payload=JSON.parse(input),profile=profileFromFiles(payload.files),prepared=image.Config?.Labels?.[DEPENDENCY_LABEL];
      if(profile)check(prepared===profile.fingerprint,'Prepared npm image does not match this snapshot; host provisioning required');
      else check(!prepared,'Prepared npm image requires matching manifests');
      // Only host-side image inspection sets this flag; caller payload cannot.
      payload.preparedDependencies=!!profile;input=Buffer.from(JSON.stringify(payload));
      const created=await this.#cli(['create','--pull=never','--name',name,'--label','dsh-foreman.verification=true',
        '--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true',
        '--user=65534:65534','--pids-limit=128','--memory=512m','--memory-swap=512m','--cpus=1',
        '--ipc=private','--cgroupns=private','--no-healthcheck','--log-driver=none',
        '--tmpfs','/work:rw,nosuid,nodev,size=128m,mode=0700,uid=65534,gid=65534',
        '--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=0700,uid=65534,gid=65534',
        '--workdir=/work','--entrypoint=/usr/local/bin/node','-i',this.#image,'-e',CONTAINER_BOOTSTRAP],
        {signal,maxOutputBytes:65536,timeoutMs:10000});
      check(created.exitCode===0 && /^[a-f0-9]{64}$/.test(created.stdout.trim()),'Container creation failed');
      const id=created.stdout.trim();await recordOwnership({name,id,image:this.#image,status:'created'});
      const run=await this.#cli(['start','-a','-i',id],{input,signal,maxOutputBytes:1024*1024,timeoutMs:command.timeoutMs+15000});
      const status=await this.#cli(['inspect','--format={{json .State}}',id],{signal,maxOutputBytes:65536,timeoutMs:10000});
      check(status.exitCode===0,'Cannot verify container completion');
      const state=JSON.parse(status.stdout);
      check(state.Status==='exited' && state.Running===false && Number.isInteger(state.ExitCode),'Container has not stopped');
      result={exitCode:state.ExitCode,stdout:run.stdout,stderr:run.stderr,truncated:!!run.truncated,oomKilled:!!state.OOMKilled};
    } catch(e){error=e;}
    finally {
      // Cleanup has its own deadline and ignores the caller's aborted signal.
      try {
        const removed=await this.#cli(['rm','-f','-v',name],{maxOutputBytes:65536,timeoutMs:10000});
        if(removed.exitCode!==0) {
          const remaining=await this.#cli(['container','ls','--all','--filter',`name=^/${name}$`,'--format={{.ID}}'],{maxOutputBytes:65536,timeoutMs:10000});
          check(remaining.exitCode===0 && remaining.stdout.trim()==='','Container cleanup could not be confirmed');
        }
        await recordOwnership({name,image:this.#image,status:'removed'});cleaned=true;
      } catch(e){error=error?new AggregateError([error,e],'Verification and cleanup failed'):e;}
    }
    if(error)throw error;check(cleaned,'Container cleanup required');return result;
  }
  close() {
    if(this.#closing)return this.#closing;this.#closed=true;
    for(const item of this.#active.values())item.abort.abort(new Error('Verifier shutting down'));
    this.#closing=Promise.allSettled([...this.#active.values()].map(x=>x.operation));return this.#closing;
  }
}
