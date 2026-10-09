import {ContainerVerifier} from './container-verifier.mjs';
import {profileFromFiles} from './dependency-profile.mjs';
export class DependencyApprovalRequired extends Error {
  constructor(fingerprint){super('This project snapshot requires human-approved dependencies');this.fingerprint=fingerprint;}
}

/** Host-only selection, from durable project approval and the detached snapshot.
 * A selected backend stays fixed for the life of a run; later approval does not
 * relabel old evidence. Models cannot select images or write the catalog. */
export class ProjectVerifier {
  #store;#base;#create;#backends=new Map();#closed=false;#closing;
  constructor({store,runCli,baseImage,createBackend=image=>new ContainerVerifier({runCli,image})}) {
    if(!/^sha256:[a-f0-9]{64}$/.test(baseImage??''))throw Error('Pinned base image required');
    this.#store=store;this.#base=baseImage;this.#create=createBackend;
  }
  async run(input,request,{project,...options}={}) {
    if(this.#closed)throw Error('Project verifier is closed');
    const state=this.#store.snapshot(),p=state.projects[project];
    if(!p || ['cancelled','delivered'].includes(p.status))throw Error('Verification project is closed or absent');
    const profile=profileFromFiles(JSON.parse(input).files);
    let image=this.#base;
    if(profile) {
      const approval=state.dependencyImages?.[project];
      if(!approval || approval.configVersion!==p.configVersion || approval.fingerprint!==profile.fingerprint)
        throw new DependencyApprovalRequired(profile.fingerprint);
      image=approval.image;
    }
    let backend=this.#backends.get(image);
    if(!backend){backend=this.#create(image);this.#backends.set(image,backend);}
    return backend.run(input,request,options);
  }
  close() {
    if(this.#closing)return this.#closing;this.#closed=true;
    this.#closing=(async()=>{
      const results=await Promise.allSettled([...this.#backends.values()].map(b=>b.close()));
      const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
      if(errors.length)throw new AggregateError(errors,'Project verifier cleanup failed');
    })();return this.#closing;
  }
}
