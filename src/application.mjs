import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JournalStore} from './store.mjs';
import {Controller} from './controller.mjs';
import {ArtifactStore} from './artifacts.mjs';
import {WorkspaceFiles} from './workspace-files.mjs';
import {createRoleComposer} from './role-tools.mjs';
import {ProjectVerifier} from './project-verifier.mjs';
import {dockerCli} from './docker-cli.mjs';
import {recoverVerificationContainers,recoverNativeVerifications} from './verification-ledger.mjs';
import {NativeVerifier} from './native-verifier.mjs';
import {VerificationService} from './verification-service.mjs';
import {DependencyCandidates,DependencyApproval} from './dependency-approval.mjs';
import {DependencyProvisioner} from './dependency-provisioner.mjs';
import {dependencyDockerfile} from './dependency-profile.mjs';

/** Trusted host assembly. Never expose this object through a model tool/RPC.
 * Missing protection configuration permits diagnostics only, never project creation.
 * This does not start a timer, agent or model; production authorization remains gated.
 */
export async function openApplication(config,{runCli,sandbox,subprocess}={}) {
  if(!config || typeof config.storageRoot!=='string' || !path.isAbsolute(config.storageRoot))throw new Error('Absolute storageRoot required');
  const configured=config.dshHome!==undefined || config.sessionRoot!==undefined;
  if(configured && ![config.dshHome,config.sessionRoot].every(p=>typeof p==='string' && path.isAbsolute(p)))throw new Error('Both absolute dshHome and sessionRoot are required');
  const pluginRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const verificationConfig=config.verification;
  const verificationBackend=verificationConfig?(verificationConfig.backend??'docker'):null;
  if(verificationBackend && !['docker','native'].includes(verificationBackend))throw Error('Unsupported verification backend');
  if(verificationConfig && !configured)throw Error('Verification requires protected files');
  if(verificationBackend==='docker' && (typeof verificationConfig.executable!=='string' || !path.isAbsolute(verificationConfig.executable) ||
    !/^sha256:[a-f0-9]{64}$/.test(verificationConfig.image??'')))throw Error('Verification requires protected files, absolute Docker executable and pinned image');
  if(verificationBackend==='native' && Object.keys(verificationConfig).some(key=>key!=='backend'))throw Error('Native verification does not accept Docker image, executable or dependency provisioning settings');
  let dockerRoot,dependencyBuildRoot,buildxDirectory;
  if(verificationBackend==='docker') {
    const executable=await fs.realpath(verificationConfig.executable);
    if(!(await fs.stat(executable)).isFile())throw Error('Docker executable must be a file');
    dockerRoot=path.dirname(executable);
    if(verificationConfig.dependencyBuildRoot!==undefined) {
      if(typeof verificationConfig.dependencyBuildRoot!=='string'||!path.isAbsolute(verificationConfig.dependencyBuildRoot))throw Error('Absolute dependency build root required');
      dependencyBuildRoot=await fs.realpath(verificationConfig.dependencyBuildRoot);
      if(!(await fs.stat(dependencyBuildRoot)).isDirectory())throw Error('Dependency build root must be a directory');
    }
    if(verificationConfig.provisioning) {
      const options=verificationConfig.provisioning;
      if(!dependencyBuildRoot || typeof options.buildxDirectory!=='string'||!path.isAbsolute(options.buildxDirectory))throw Error('Provisioning requires a protected build root and absolute Buildx directory');
      dependencyDockerfile(options.baseReference,{fingerprint:'a'.repeat(64)});
      buildxDirectory=await fs.realpath(options.buildxDirectory);
      if(!(await fs.stat(path.join(buildxDirectory,process.platform==='win32'?'docker-buildx.exe':'docker-buildx'))).isFile())throw Error('Buildx executable required');
    }
  }
  if(configured)for(const p of [config.dshHome,config.sessionRoot]) {
    if(!(await fs.stat(p)).isDirectory())throw new Error('Protected storage must be an existing directory');
  }
  const store=await JournalStore.open(config.storageRoot);
  let verification,provisioner,nativeBackend,verificationCapabilities;
  try {
    let files;
    const requireFiles=()=>{if(!files)throw new Error('DSH home/session protection is not configured; diagnostics only');return files;};
    const controller=new Controller(store,{
      captureArtifact:p=>requireFiles().capture(p),
      validateWorkspace:(workspace,projects,excludeId)=>requireFiles().validateWorkspace(workspace,projects,excludeId),
    });
    const artifacts=new ArtifactStore(path.join(config.storageRoot,'artifacts'));
    if(configured)files=new WorkspaceFiles(controller,{artifacts,protectedRoots:[config.storageRoot,pluginRoot,config.dshHome,config.sessionRoot,...(dockerRoot?[dockerRoot]:[]),...(dependencyBuildRoot?[dependencyBuildRoot]:[]),...(buildxDirectory?[buildxDirectory]:[])]});
    let dependencies;
    if(verificationBackend==='native') {
      try {
        nativeBackend=new NativeVerifier({sandbox,subprocess,protectedRoots:[config.storageRoot,pluginRoot,config.dshHome,config.sessionRoot]});
        verificationCapabilities=await nativeBackend.probe();
      }
      catch(cause){const error=Error('Native project verification is unavailable; check the DSH local sandbox and subprocess services',{cause});error.code='NATIVE_VERIFICATION_UNAVAILABLE';throw error;}
      await recoverNativeVerifications(store);
      verification=new VerificationService({controller,store,files,artifacts,backend:nativeBackend});
    }
    if(verificationBackend==='docker') {
      const configDirectory=path.join(config.storageRoot,'docker-cli');await fs.mkdir(configDirectory,{recursive:true});
      const cli=runCli??dockerCli({executable:verificationConfig.executable,configDirectory});
      const response=await cli(['info','--format={{json .}}'],{timeoutMs:10000,maxOutputBytes:65536});
      if(response.exitCode!==0){const error=Error('Docker Linux engine is unavailable; start or repair Docker Desktop before retrying verification configuration');error.code='DOCKER_UNAVAILABLE';throw error;}
      const info=JSON.parse(response.stdout);
      if(info?.OSType!=='linux' || !info.MemoryLimit || !info.PidsLimit || !info.CpuCfsQuota ||
        !info.SecurityOptions?.some(s=>s.includes('seccomp')))throw Error('Docker Linux resource limits and seccomp required');
      await recoverVerificationContainers(store,cli);
      verification=new VerificationService({controller,store,files,artifacts,backend:new ProjectVerifier({store,runCli:cli,baseImage:verificationConfig.image})});
      if(dependencyBuildRoot)dependencies=new DependencyApproval({controller,artifacts,candidates:new DependencyCandidates({root:dependencyBuildRoot,runCli:cli})});
      if(buildxDirectory)provisioner=new DependencyProvisioner({controller,store,artifacts,root:dependencyBuildRoot,baseReference:verificationConfig.provisioning.baseReference,
        createCli:async context=>{
          const privateConfig=path.join(context,'cli-config');await fs.mkdir(privateConfig,{recursive:true});
          await fs.writeFile(path.join(privateConfig,'config.json'),JSON.stringify({cliPluginsExtraDirs:[buildxDirectory]}));
          return runCli??dockerCli({executable:verificationConfig.executable,configDirectory:privateConfig});
        }});
    }
    let closing;
    return Object.freeze({store,controller,artifacts,files,verification,dependencies,provisioner,
      verificationBackend,verificationCapabilities,
      compose:createRoleComposer(controller,{artifacts,files,verification}),
      filePipelineConfigured:configured,
      close:()=>closing??=(async()=>{try {await provisioner?.close();await verification?.close();}finally {try {await controller.close();}finally {await store.close();}}})(),
    });
  } catch(e){try {await verification?.close();await nativeBackend?.close();}finally {await store.close();}throw e;}
}

// Only the desktop host may fall back to diagnostics when the daemon is down.
// Invalid protection configuration and journal errors must still fail closed.
export async function openHostApplication(config,options) {
  try{return await openApplication(config,options);}
  catch(error){
    if(!['DOCKER_UNAVAILABLE','NATIVE_VERIFICATION_UNAVAILABLE'].includes(error.code))throw error;
    const application=await openApplication({...config,verification:undefined},options);
    return Object.freeze({...application,verificationBackend:config.verification?.backend??'docker',startupIssue:error.code==='NATIVE_VERIFICATION_UNAVAILABLE'
      ?'DSH 本机验证服务未通过启动检查。请检查本机沙箱与进程服务后重启 DSH；当前只能查看进度，不能启动项目。'
      :'Docker 未运行或无法连接。请启动或修复 Docker 后重启 DSH；当前只能查看进度，不能启动项目。'});
  }
}
