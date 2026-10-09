import fs from 'node:fs/promises';
import path from 'node:path';
import {npmProfile,profileFromFiles,dependencyDockerfile,DEPENDENCY_LABEL} from './dependency-profile.mjs';
import {verificationInput} from './container-verifier.mjs';
const check=(ok,message)=>{if(!ok)throw Error(message);};

// Only a host-configured protected directory supplies candidates. Models pass a
// basename, never an image ID, filesystem path, manifest, or approval receipt.
export class DependencyCandidates {
  #root;#cli;
  constructor({root,runCli}) {this.#root=root;this.#cli=runCli;}
  async list() {
    const entries=await fs.readdir(this.#root,{withFileTypes:true});
    return entries.filter(e=>e.isDirectory() && /^context-[a-zA-Z0-9_-]{1,80}$/.test(e.name)).map(e=>e.name).sort().slice(0,100);
  }
  async resolve(id) {
    check(typeof id==='string' && /^context-[a-zA-Z0-9_-]{1,80}$/.test(id),'Invalid dependency candidate');
    const dir=path.join(this.#root,id);
    check(await fs.realpath(dir)===dir,'Candidate directory must not be a link');
    const read=async name=>{
      const file=path.join(dir,name),s=await fs.lstat(file);
      check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=4*1024*1024,'Bounded plain candidate file required');
      return fs.readFile(file,'utf8');
    };
    const report=JSON.parse(await read('report.json'));
    check(report.status==='ready' && /^sha256:[a-f0-9]{64}$/.test(report.image??''),'Candidate build is not ready');
    const profile=npmProfile(await read('package.json'),await read('package-lock.json'));
    check(report.fingerprint===profile.fingerprint && await read('Dockerfile')===dependencyDockerfile(report.baseReference,profile),'Candidate inputs changed');
    const result=await this.#cli(['image','inspect',report.image],{timeoutMs:10000,maxOutputBytes:65536});
    check(result.exitCode===0,'Prepared dependency image unavailable');
    const images=JSON.parse(result.stdout),image=images[0];
    check(images.length===1 && image.Id===report.image && image.Os==='linux' &&
      !Object.keys(image.Config?.Volumes??{}).length && image.Config?.Labels?.[DEPENDENCY_LABEL]===profile.fingerprint,'Candidate image identity mismatch');
    const pkg=JSON.parse(profile.packageJson),packages=Object.keys(JSON.parse(profile.lockJson).packages).length-1;
    return {id,image:report.image,fingerprint:profile.fingerprint,packages,
      dependencies:Object.fromEntries(['dependencies','devDependencies','optionalDependencies'].map(k=>[k,pkg[k]??{}]))};
  }
}

export class DependencyApproval {
  #controller;#artifacts;#candidates;#tickets=new WeakMap();
  constructor({controller,artifacts,candidates}) {this.#controller=controller;this.#artifacts=artifacts;this.#candidates=candidates;}
  list(){return this.#candidates.list();}
  async #profile(capture) {
    const reference=await capture();
    const input=await verificationInput(this.#artifacts,reference,{command:'node',args:[],timeoutMs:1000});
    const profile=profileFromFiles(JSON.parse(input).files);
    check(profile,'Project has no locked dependency profile');return profile.fingerprint;
  }
  async prepare(raw) {
    check(raw && Object.keys(raw).every(k=>['type','project','candidate'].includes(k)) && raw.type==='use-dependency-image','Invalid dependency approval request');
    const command=structuredClone(raw),candidate=await this.#candidates.resolve(command.candidate);
    return this.#controller.projectTransaction(command.project,async({project,store,capture})=>{
      check(await this.#profile(capture)===candidate.fingerprint,'Project manifests differ from candidate; prepare a fresh build');
      const basis={project:project.id,configVersion:project.configVersion,expectedRevision:store.snapshot().dependencyImages?.[project.id]?.revision??0,...candidate};
      const entries=Object.entries(candidate.dependencies).flatMap(([group,values])=>Object.entries(values).map(([name,version])=>`${group}: ${name}@${version}`));
      const summary=entries.slice(0,30).map(s=>s.slice(0,200)).join('\n');
      const detail=`项目：${project.objective}\n目录：${project.workspace}\n候选：${candidate.id}\n镜像：${candidate.image}\n锁定依赖数：${candidate.packages}\n直接依赖（${entries.length} 项，最多显示30项）：\n${summary}\n清单指纹：${candidate.fingerprint}\n使用已准备镜像；本操作不联网安装。后续验证仍在断网容器运行，正在运行的验证保留原镜像。`;
      const ticket=Object.freeze({command,detail});this.#tickets.set(ticket,basis);return ticket;
    });
  }
  async confirm(ticket,confirmation,{authorize}) {
    authorize();const basis=this.#tickets.get(ticket);check(basis,'Unknown or consumed dependency confirmation');
    this.#tickets.delete(ticket);
    const candidate=await this.#candidates.resolve(basis.id);
    check(candidate.image===basis.image && candidate.fingerprint===basis.fingerprint,'Candidate changed while awaiting confirmation');
    return this.#controller.projectTransaction(basis.project,async({project,store,capture})=>{
      authorize();check(project.configVersion===basis.configVersion,'Project configuration changed while awaiting confirmation');
      check(await this.#profile(capture)===basis.fingerprint,'Project manifests changed while awaiting confirmation');
      authorize();
      return store.dispatchRuntime({type:'approve-dependency-image',project:basis.project,configVersion:basis.configVersion,
        expectedRevision:basis.expectedRevision,image:basis.image,fingerprint:basis.fingerprint,confirmation});
    });
  }
}
