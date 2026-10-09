import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {profileFromFiles,dependencyDockerfile,npmProfile} from './dependency-profile.mjs';
import {verificationInput} from './container-verifier.mjs';
import {buildDependencies,recoverDependencyBuild} from './dependency-build.mjs';
const check=(ok,message)=>{if(!ok)throw Error(message);};
export class DependencyProvisioner {
  #controller;#store;#artifacts;#root;#base;#createCli;#tickets=new WeakMap();#active=new Set();#abort=new AbortController();#closing;
  constructor({controller,store,artifacts,root,baseReference,createCli}) {
    dependencyDockerfile(baseReference,{fingerprint:'a'.repeat(64)});
    this.#controller=controller;this.#store=store;this.#artifacts=artifacts;this.#root=root;this.#base=baseReference;this.#createCli=createCli;
  }
  async #profile(capture) {
    const reference=await capture(),input=await verificationInput(this.#artifacts,reference,{command:'node',args:[],timeoutMs:1000});
    const profile=profileFromFiles(JSON.parse(input).files);check(profile,'Locked npm manifests required');return profile;
  }
  async prepare(raw) {
    check(!this.#closing,'Dependency provisioner is closed');
    check(raw?.type==='build-dependencies' && Object.keys(raw).every(k=>['type','project'].includes(k)),'Invalid build request');
    const projectId=raw.project;
    return this.#controller.projectTransaction(projectId,async({project,store,capture})=>{
      check(project.status==='running','Project is not running');
      check(!Object.values(store.snapshot().dependencyBuilds??{}).some(b=>b.project===projectId && ['authorized','building','uncertain'].includes(b.status)),'Project has an unresolved dependency build');
      const profile=await this.#profile(capture),count=Object.keys(JSON.parse(profile.lockJson).packages).length-1;
      const ticket=Object.freeze({command:{type:'build-dependencies',project:projectId},detail:
        `项目：${project.objective}\n锁定依赖数：${count}\n清单指纹：${profile.fingerprint}\n基础镜像：${this.#base}\n允许宿主通过 Docker 联网构建依赖镜像，可能消耗下载流量、磁盘和时间（最多10分钟）。只传 package.json 和 package-lock.json，不传项目源码或宿主凭据；使用公共 npm 源，禁用安装脚本。完成后生成候选，使用该镜像仍需单独确认。取消或断连后构建结果可能不明，需核对后才能重试。`});
      this.#tickets.set(ticket,{project:projectId,configVersion:project.configVersion,profile});return ticket;
    });
  }
  confirm(ticket,confirmation,{authorize,signal}) {
    if(this.#closing)return Promise.reject(Error('Dependency provisioner is closed'));
    const op=this.#confirm(ticket,confirmation,authorize,signal);this.#active.add(op);void op.then(()=>this.#active.delete(op),()=>this.#active.delete(op));return op;
  }
  async #write(context,report) {
    const pending=path.join(context,'report-'+randomUUID()+'.pending'),h=await fs.open(pending,'wx');
    try{await h.writeFile(JSON.stringify(report,null,2));await h.sync();}finally{await h.close();}
    await fs.rename(pending,path.join(context,'report.json'));
  }
  async #confirm(ticket,confirmation,authorize,signal) {
    authorize();const basis=this.#tickets.get(ticket);check(basis,'Unknown or consumed build confirmation');this.#tickets.delete(ticket);
    const combined=signal?AbortSignal.any([signal,this.#abort.signal]):this.#abort.signal;
    const id='context-'+randomUUID(),context=path.join(this.#root,id);
    let record={id,project:basis.project,configVersion:basis.configVersion,fingerprint:basis.profile.fingerprint,baseReference:this.#base,confirmation,status:'authorized'};
    await this.#controller.projectTransaction(basis.project,async({project,store,capture})=>{
      authorize();combined.throwIfAborted();check(project.configVersion===basis.configVersion,'Project changed while awaiting build confirmation');
      check((await this.#profile(capture)).fingerprint===basis.profile.fingerprint,'Manifests changed while awaiting build confirmation');
      authorize();combined.throwIfAborted();await store.dispatchRuntime({type:'dependency-build-record',record});
    });
    const tag='dsh-foreman-deps:'+id.slice('context-'.length);
    let started=false;
    const persist=async r=>{
      if(r.status==='building')started=true;
      const next={...record,status:r.status,...(r.image?{image:r.image}:{}),...(r.error?{error:r.error.slice(0,2000)}:{})};
      await this.#store.dispatchRuntime({type:'dependency-build-record',record:next});record=next;
      await this.#write(context,{...r,...record,tag,context});
    };
    try {
      combined.throwIfAborted();await fs.mkdir(context);
      await fs.writeFile(path.join(context,'package.json'),basis.profile.packageJson,{flag:'wx'});
      await fs.writeFile(path.join(context,'package-lock.json'),basis.profile.lockJson,{flag:'wx'});
      await fs.writeFile(path.join(context,'Dockerfile'),dependencyDockerfile(this.#base,basis.profile),{flag:'wx'});
      await fs.writeFile(path.join(context,'.dockerignore'),'*\n!Dockerfile\n!package.json\n!package-lock.json\n',{flag:'wx'});
      await this.#write(context,{...record,tag,context});
      const cli=await this.#createCli(context);
      await buildDependencies({cli,record:{...record,status:'prepared',tag,context},signal:combined,persist,
        saveLog:log=>fs.writeFile(path.join(context,'build.log'),log)});
      await this.#store.dispatchRuntime({type:'incident',project:basis.project,key:'dependency-build:'+id,message:`依赖镜像构建完成，候选 ${id}。请核对并请求使用该镜像；项目清单必须仍然匹配。`});
      return {candidate:id,status:'ready',image:record.image};
    }catch(error) {
      if(!['failed','uncertain','ready'].includes(record.status)) {
        record={...record,status:started?'uncertain':'failed',error:String(error.message).slice(0,2000)};
        await this.#store.dispatchRuntime({type:'dependency-build-record',record});
      }
      await this.#store.dispatchRuntime({type:'incident',project:basis.project,key:'dependency-build:'+id,message:`依赖构建 ${id}：${record.status}。请检查状态；结果不明时不能重复构建。`});
      throw error;
    }
  }
  recover(project,id,{authorize,signal}) {
    check(!this.#closing,'Dependency provisioner is closed');
    check(this.#active.size===0,'Wait for the active build before reconciliation');
    const combined=signal?AbortSignal.any([signal,this.#abort.signal]):this.#abort.signal;
    const op=this.#recover(project,id,()=>{combined.throwIfAborted();authorize();},combined);
    this.#active.add(op);void op.then(()=>this.#active.delete(op),()=>this.#active.delete(op));return op;
  }
  async #recover(project,id,authorize,signal) {
    authorize();
    const record=this.#store.snapshot().dependencyBuilds?.[id];
    check(/^context-[a-f0-9-]{36}$/.test(id) && record?.project===project && ['authorized','building','uncertain','ready'].includes(record.status),'No recoverable project build');
    // The building commit always precedes launching BuildKit. An authorized-only
    // reservation proves no build was launched and can safely release the slot.
    if(record.status==='authorized') {
      authorize();await this.#store.dispatchRuntime({type:'dependency-build-record',record:{...record,status:'failed',error:'Interrupted before build launch'}});
      return {candidate:id,status:'failed',reason:'Interrupted before build launch; a fresh confirmation is required'};
    }
    const context=path.join(this.#root,id);check(await fs.realpath(context)===context,'Unexpected build context');
    const read=async name=>{const file=path.join(context,name),s=await fs.lstat(file);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=4*1024*1024,'Invalid build input file');return fs.readFile(file,'utf8');};
    const profile=npmProfile(await read('package.json'),await read('package-lock.json'));
    check(profile.fingerprint===record.fingerprint && await read('Dockerfile')===dependencyDockerfile(record.baseReference,profile),'Build inputs changed');
    const cli=await this.#createCli(context),tag='dsh-foreman-deps:'+id.slice(8);
    authorize();
    const result=await recoverDependencyBuild({cli:(args,options)=>cli(args,{...options,signal}),record:{...record,tag,context},persist:async r=>{
      authorize();
      if(record.status!=='ready')await this.#store.dispatchRuntime({type:'dependency-build-record',record:{...record,status:'ready',image:r.image}});
      await this.#write(context,r);
    }});
    await this.#store.dispatchRuntime({type:'incident',project,key:'dependency-build:'+id,message:`依赖镜像已核对完成，候选 ${id}。使用仍需单独确认。`});
    return {candidate:id,status:'ready',image:result.image};
  }
  close() {
    if(this.#closing)return this.#closing;this.#abort.abort(Error('Dependency provisioning stopped'));
    this.#closing=Promise.allSettled([...this.#active]).then(()=>{});return this.#closing;
  }
}
