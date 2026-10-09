import {randomUUID} from 'node:crypto';
import {replaceEmptySession} from './session-recovery.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};

/** Private host journal namespace. Models never receive this mutation capability. */
export function runtimeTransition(previous,command) {
  if(command.type==='project-control-drained') {
    const p=previous.projects[command.project];
    check(p && (p.paused===true || p.status==='cancelled') && p.controlVersion===command.controlVersion,'Project control changed while draining');
    if(p.controlDrainVersion===command.controlVersion && (!p.paused || p.pauseStatus==='drained'))return previous;
    const state=structuredClone(previous),next=state.projects[command.project];
    next.controlDrainVersion=command.controlVersion;if(next.paused)next.pauseStatus='drained';
    state.revision++;return state;
  }
  if(command.type==='replace-empty-session')return replaceEmptySession(previous,command);
  if(command.type==='dependency-build-record') {
    const r=command.record,p=previous.projects[r?.project],old=previous.dependencyBuilds?.[r?.id];
    check(p && /^context-[a-f0-9-]{36}$/.test(r.id??''),'Invalid dependency build identity');
    check(['authorized','building','uncertain','failed','ready'].includes(r.status),'Invalid dependency build state');
    check(/^[a-f0-9]{64}$/.test(r.fingerprint??'') && /^node@sha256:[a-f0-9]{64}$/.test(r.baseReference??''),'Invalid build profile');
    if(!old) {
      check(r.status==='authorized' && p.status==='running' && r.configVersion===p.configVersion,'Build requires current running project');
      check(/^foreman-confirm-[a-f0-9-]{36}$/.test(r.confirmation??''),'Native build confirmation required');
      check(!Object.values(previous.dependencyBuilds??{}).some(b=>b.project===r.project && ['authorized','building','uncertain'].includes(b.status)),'Project has an unresolved build; reconcile it first');
    }else {
      for(const k of ['project','configVersion','fingerprint','baseReference','confirmation'])check(old[k]===r[k],'Build identity changed');
      check(!['ready','failed'].includes(old.status),'Build is already terminal');
      check(old.status===r.status || old.status==='authorized' && ['building','failed','uncertain'].includes(r.status) ||
        old.status==='building' && ['ready','failed','uncertain'].includes(r.status) || old.status==='uncertain' && r.status==='ready','Invalid build transition');
    }
    if(r.status==='ready')check(/^sha256:[a-f0-9]{64}$/.test(r.image??''),'Pinned build output required');
    const state=structuredClone(previous);state.dependencyBuilds??={};state.dependencyBuilds[r.id]=structuredClone(r);state.revision++;return state;
  }
  if(command.type==='dependency-profile-observed') {
    const p=previous.projects[command.project],need=previous.dependencyNeeds?.[command.project];
    check(p && command.configVersion===p.configVersion,'Dependency configuration expired');
    check(command.fingerprint===null || /^[a-f0-9]{64}$/.test(command.fingerprint??''),'Invalid observed dependency profile');
    if(!need || need.resolved || need.configVersion===command.configVersion && need.fingerprint===command.fingerprint)return previous;
    const state=structuredClone(previous);state.dependencyNeeds[command.project].resolved=true;
    const project=state.projects[command.project],notification=project.notifications.find(n=>n.id===need.notificationId);
    if(notification){notification.resolved=true;notification.acknowledged=true;}
    for(const task of Object.values(project.tasks))if(task.dependencyWait===need.fingerprint)delete task.dependencyWait;
    project.dependencyWake=(project.dependencyWake??0)+1;
    state.revision++;return state;
  }
  if(command.type==='dependency-needed') {
    const p=previous.projects[command.project],old=previous.dependencyNeeds?.[command.project];
    check(p && !p.paused && !['cancelled','delivered'].includes(p.status),'Dependency project is closed or absent');
    check(command.configVersion===p.configVersion && /^[a-f0-9]{64}$/.test(command.fingerprint??''),'Invalid dependency request');
    const approval=previous.dependencyImages?.[command.project];
    if(approval?.fingerprint===command.fingerprint && approval.configVersion===command.configVersion)return previous;
    if(command.task!==undefined)check(p.tasks[command.task]?.status==='running' && p.tasks[command.task].attempt===command.taskAttempt,'Stale dependency task');
    if(old?.fingerprint===command.fingerprint && old.configVersion===command.configVersion && !old.resolved &&
      (command.task===undefined || p.tasks[command.task].dependencyWait===command.fingerprint))return previous;
    const state=structuredClone(previous);state.dependencyNeeds??={};
    const notificationId=old?.notificationId??randomUUID();
    let notification=state.projects[command.project].notifications.find(n=>n.id===notificationId);
    if(!notification){notification={id:notificationId,kind:'fault',milestone:null};state.projects[command.project].notifications.push(notification);}
    Object.assign(notification,{acknowledged:false,resolved:false,message:'验证需要批准项目依赖。请由外层代理选择宿主已准备的候选并请求原生确认；没有匹配候选时需先准备依赖镜像。清单指纹：'+command.fingerprint});
    Object.defineProperty(state.dependencyNeeds,command.project,{enumerable:true,writable:true,configurable:true,value:{fingerprint:command.fingerprint,configVersion:command.configVersion,notificationId,resolved:false}});
    if(command.task!==undefined)state.projects[command.project].tasks[command.task].dependencyWait=command.fingerprint;
    state.revision++;return state;
  }
  if(command.type==='approve-dependency-image') {
    // Host-only commit after human confirmation. The reference is audit evidence,
    // not an authentication token; dispatchRuntime must never reach model tools.
    const p=previous.projects[command.project],old=previous.dependencyImages?.[command.project];
    check(p && !p.paused && !['cancelled','delivered'].includes(p.status),'Dependency project is closed or absent');
    check(command.configVersion===p.configVersion,'Dependency configuration expired');
    check(command.expectedRevision===(old?.revision??0),'Dependency approval changed; request fresh confirmation');
    check(/^sha256:[a-f0-9]{64}$/.test(command.image??'') && /^[a-f0-9]{64}$/.test(command.fingerprint??''),'Pinned dependency image and fingerprint required');
    check(typeof command.confirmation==='string' && /^foreman-confirm-[a-f0-9-]{36}$/.test(command.confirmation),'Native confirmation reference required');
    const state=structuredClone(previous);state.dependencyImages??={};
    Object.defineProperty(state.dependencyImages,command.project,{enumerable:true,writable:true,configurable:true,value:{
      image:command.image,fingerprint:command.fingerprint,configVersion:command.configVersion,
      confirmation:command.confirmation,revision:(old?.revision??0)+1,
    }});
    const need=state.dependencyNeeds?.[command.project];
    if(need && need.fingerprint===command.fingerprint && need.configVersion===command.configVersion) {
      need.resolved=true;
      const notification=state.projects[command.project].notifications.find(n=>n.id===need.notificationId);
      if(notification){notification.resolved=true;notification.acknowledged=true;}
    }
    for(const task of Object.values(state.projects[command.project].tasks))if(task.dependencyWait===command.fingerprint)delete task.dependencyWait;
    for(const build of Object.values(state.dependencyBuilds??{}))if(build.project===command.project && build.status==='ready' && build.image===command.image && build.fingerprint===command.fingerprint) {
      const incident=state.runtimeIncidents?.[`${command.project}:dependency-build:${build.id}`];
      if(incident){incident.message=null;const notification=state.projects[command.project].notifications.find(n=>n.id===incident.notificationId);if(notification){notification.resolved=true;notification.acknowledged=true;}}
    }
    state.projects[command.project].dependencyWake=(p.dependencyWake??0)+1;
    state.revision++;return state;
  }
  if(command.type==='native-verification-record') {
    const e=command.entry;
    check(e && e.backend==='native' && /^dsh-foreman-native-[a-f0-9-]{36}$/.test(e.name??''),'Invalid native verification identity');
    check(typeof e.directory==='string' && e.directory.length<=2000 && /^(?:[a-z]:[\\/]|\/)/i.test(e.directory) &&
      !/[\x00\r\n]/.test(e.directory) && !e.directory.split(/[\\/]/).includes('..'),'Invalid native snapshot directory');
    check(['reserved','running','removed','interrupted'].includes(e.status),'Invalid native verification state');
    const old=previous.verificationRuns?.[e.name];
    if(!old) {
      check(e.status==='reserved','Native verification must be reserved first');
      const {project,reference,request}=command;
      check(previous.projects[project],'Unknown native verification project');
      check(/^sha256:[a-f0-9]{64}$/.test(reference??''),'Verified snapshot reference required');
      check(request && typeof request.command==='string' && Array.isArray(request.args) && Number.isSafeInteger(request.timeoutMs),'Verification request required');
      const state=structuredClone(previous);state.verificationRuns??={};
      state.verificationRuns[e.name]={name:e.name,backend:'native',sandbox:'windows-acl',directory:e.directory,status:e.status,
        project,reference,request:structuredClone(request)};
      state.revision++;return state;
    }
    check(old.backend===e.backend && old.directory===e.directory,'Native verification ownership changed');
    if(old.status===e.status)return previous;
    check(!['removed','interrupted'].includes(old.status) &&
      (['removed','interrupted'].includes(e.status) || old.status==='reserved' && e.status==='running'),'Invalid native verification lifecycle');
    const state=structuredClone(previous);state.verificationRuns[e.name].status=e.status;state.revision++;return state;
  }
  if(command.type==='verification-result' || command.type==='native-verification-result') {
    const bucket=command.type==='native-verification-result'?'verificationRuns':'verificationContainers';
    const record=previous[bucket]?.[command.name],r=command.result;
    check(record?.status==='removed' && !record.result,'Completed owned verification required');
    check(r && Number.isInteger(r.exitCode) && r.exitCode>=0 && r.exitCode<=255 && typeof r.stdout==='string' && typeof r.stderr==='string' &&
      r.stdout.length+r.stderr.length<=1048576 && typeof r.truncated==='boolean' && typeof r.oomKilled==='boolean','Invalid verification result');
    const state=structuredClone(previous);state[bucket][command.name].result={exitCode:r.exitCode,stdout:r.stdout,stderr:r.stderr,truncated:r.truncated,oomKilled:r.oomKilled};
    state.revision++;return state;
  }
  if(command.type==='verification-record') {
    const e=command.entry;
    check(e && typeof e.name==='string' && /^dsh-foreman-run-[a-f0-9-]{36}$/.test(e.name),'Invalid verification container name');
    check(/^sha256:[a-f0-9]{64}$/.test(e.image) && ['reserved','created','removed'].includes(e.status),'Invalid verification ownership');
    const old=previous.verificationContainers?.[e.name];
    if(!old) {
      check(e.status==='reserved','Verification must be reserved first');
      const {project,reference,request}=command;
      check(previous.projects[project],'Unknown verification project');
      check(typeof reference==='string' && /^sha256:[a-f0-9]{64}$/.test(reference),'Verified snapshot reference required');
      check(request && typeof request.command==='string' && Array.isArray(request.args) && Number.isSafeInteger(request.timeoutMs),'Verification request required');
      const state=structuredClone(previous);state.verificationContainers??={};
      state.verificationContainers[e.name]={name:e.name,image:e.image,status:'reserved',project,reference,request:structuredClone(request)};
      state.revision++;return state;
    }
    check(old.image===e.image,'Verification image changed');
    check(e.id===undefined || /^[a-f0-9]{64}$/.test(e.id),'Invalid container ID');
    check(!old.id || e.id===undefined || old.id===e.id,'Container ID changed');
    if(old.status===e.status) {check(old.id===e.id || e.id===undefined,'Container identity changed');return previous;}
    check(old.status!=='removed' && (e.status==='removed' || old.status==='reserved' && e.status==='created' && e.id),'Invalid verification lifecycle');
    const state=structuredClone(previous);state.verificationContainers[e.name]={...old,status:e.status,...(e.id?{id:e.id}:{})};
    state.revision++;return state;
  }
  if(command.type==='begin-agent' || command.type==='ready-agent') {
    const record=previous.runtimeAgents?.[command.key];
    check(record && record.sessionId===command.sessionId,'Unknown or changed agent reservation');
    const next=command.type==='begin-agent'?'starting':'ready';
    if(record.phase===next)return previous;
    check(next==='starting'?record.phase==='reserved':record.phase!=='reserved','Invalid agent creation phase');
    const state=structuredClone(previous);state.runtimeAgents[command.key].phase=next;state.revision++;return state;
  }
  if(command.type==='incident') {
    const p=previous.projects[command.project];
    check(p,'Unknown incident project');
    check(typeof command.key==='string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,399}$/.test(command.key),'Invalid incident key');
    check(command.message===null || typeof command.message==='string' && command.message.length>0 && command.message.length<=4000,'Invalid incident message');
    const key=`${command.project}:${command.key}`,old=previous.runtimeIncidents?.[key];
    if(!old && command.message===null || old && old.message===command.message)return previous;
    const state=structuredClone(previous);state.runtimeIncidents??={};
    const entry=state.runtimeIncidents[key]??{notificationId:randomUUID(),project:command.project};
    const notifications=state.projects[command.project].notifications;
    let notification=notifications.find(n=>n.id===entry.notificationId);
    if(!notification) {notification={id:entry.notificationId,kind:'fault',milestone:null,acknowledged:false};notifications.push(notification);}
    if(command.message===null){notification.acknowledged=true;notification.resolved=true;}
    else {notification.message=command.message;notification.resolved=false;if(old?.message===null)notification.acknowledged=false;}
    entry.message=command.message;state.runtimeIncidents[key]=entry;state.revision++;return state;
  }
  if(command.type==='watch-review' || command.type==='watch-execution') {
    const review=command.type==='watch-review',bucket=review?'reviewWatches':'executionWatches';
    const job=previous.outbox?.[command.id];
    check(job?.subject.protocol===(review?'foreman-review-v1':'foreman-execution-v1') && job.status==='delivered','Job must be durably delivered before watching');
    if(previous[bucket]?.[command.id])return previous;
    check(Number.isSafeInteger(command.now) && command.now>=0 && Number.isSafeInteger(command.timeoutMs) && command.timeoutMs>0 && command.timeoutMs<=86400000 && Number.isSafeInteger(command.now+command.timeoutMs),'Invalid job deadline');
    const state=structuredClone(previous);state[bucket]??={};
    state[bucket][command.id]={deadline:command.now+command.timeoutMs};state.revision++;return state;
  }
  check(command.type==='reserve-agent','Unknown runtime command');
  const {key,sessionId,binding}=command;
  check(typeof key==='string' && key.length>0 && key.length<=300,'Invalid actor key');
  check(typeof sessionId==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(sessionId),'Invalid session id');
  const p=previous.projects[binding?.project];
  check(p && !p.paused && !['cancelled','delivered'].includes(p.status),'Project is closed, paused or absent');
  check(['coordinator','executor','reviewer'].includes(binding.role),'Invalid runtime role');
  check(binding.configVersion===p.configVersion,'Stale runtime configuration');
  if(binding.role==='reviewer')check(p.reviewers.some(r=>r.id===binding.reviewer),'Unknown supervisor');
  const record={key,sessionId,binding:structuredClone(binding)};
  const existing=previous.runtimeAgents?.[key];
  if(existing){check(existing.sessionId===sessionId && JSON.stringify(existing.binding)===JSON.stringify(record.binding),'Actor reservation conflict');return previous;}
  check(!Object.values(previous.runtimeAgents??{}).some(a=>a.sessionId===sessionId),'Session already reserved');
  const state=structuredClone(previous);state.runtimeAgents??={};
  Object.defineProperty(state.runtimeAgents,key,{value:{...record,phase:'reserved'},enumerable:true,writable:true,configurable:true});
  state.revision++;return state;
}
