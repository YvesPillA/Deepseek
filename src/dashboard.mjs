/** Detached, read-only UI projection. Never publish journal commands, sessions or
 * agent capabilities. Findings are rendered as text by the client. */
export function dashboardSnapshot(state,readiness) {
  const projects=Object.values(state.projects).map(p=>({
    id:p.id,objective:p.objective,workspace:p.workspace,status:p.status,configVersion:p.configVersion,
    archived:p.archived===true,archiveVersion:p.archiveVersion??0,archivedAt:p.archivedAt??null,
    settings:{denialLimit:p.denialLimit,patrolEvery:p.patrolEvery,faultRetries:p.faultRetries},
    completions:p.completions,nextPatrol:p.nextPatrol,reviewers:p.reviewers,
    dependencyBuilds:Object.values(state.dependencyBuilds??{}).filter(b=>b.project===p.id).map(b=>({candidate:b.id,status:b.status,fingerprint:b.fingerprint,configVersion:b.configVersion})),
    milestones:Object.values(p.milestones).map(m=>({
      id:m.id,title:m.title,criteria:m.criteria,status:m.status,denials:m.denials,limit:m.limit,
      deps:m.deps,blockedBy:m.deps.filter(id=>p.milestones[id]?.status!=='passed'),
      tasks:Object.values(p.tasks).filter(t=>t.milestone===m.id).map(t=>({id:t.id,title:t.title,status:t.status,attempt:t.attempt??1})),
    })),
    rounds:Object.values(p.rounds).map(r=>({id:r.id,kind:r.kind,milestone:r.milestone,status:r.status,
      outcome:r.outcome??null,generation:r.generation,
      reviewers:p.reviewers.map(reviewer=>({id:reviewer.id,name:reviewer.name,
        vote:r.votes[reviewer.id]??null,attempt:(r.attempts[reviewer.id]??0)+1,fault:r.faults[reviewer.id]??null})),
    })),
    notifications:p.notifications.filter(n=>!n.acknowledged && !n.resolved && n.kind!=='record')
      .map(n=>({id:n.id,kind:n.kind,message:n.message,milestone:n.milestone})),
  }));
  return structuredClone({revision:state.revision,readiness,projects:projects.filter(p=>!p.archived),archivedProjects:projects.filter(p=>p.archived)});
}

export function alertSnapshot(state) {
  return {revision:state.revision,alerts:Object.values(state.projects).filter(p=>p.archived!==true).flatMap(p=>
    p.notifications.filter(n=>!n.acknowledged && !n.resolved && ['decision','fault','delivery'].includes(n.kind))
      .map(n=>({project:p.id,objective:p.objective,id:n.id,kind:n.kind,message:n.message}))) };
}

export function dashboardHandler(snapshot,alerts,actions={}) {
  const authorized=peer=>{
    if(!actions.operator || peer!==actions.operator || typeof peer?.ctx?.fiber?.assertActive!=='function')return false;
    try{peer.ctx.fiber.assertActive();return true;}catch{return false;}
  };
  return async(endpoint,payload,signal,peer)=>{
    if(signal?.aborted)return {ok:false,error:{code:'cancelled',message:'Request cancelled',details:{}}};
    if((endpoint==='archive'||endpoint==='unarchive') && typeof actions[endpoint]==='function') {
      if(!authorized(peer))return {ok:false,error:{code:'forbidden',message:'Only the authenticated live operator can manage archived project cards',details:{}}};
      if(!payload || Array.isArray(payload) || typeof payload!=='object' || Object.keys(payload).length!==2 ||
        Object.keys(payload).some(key=>!['project','archiveVersion'].includes(key)) || typeof payload.project!=='string' || !payload.project || payload.project.length>1000 ||
        !Number.isSafeInteger(payload.archiveVersion) || payload.archiveVersion<0)
        return {ok:false,error:{code:'bad-request',message:'Only a project ID and its displayed archive version are supported',details:{issues:[]}}};
      try {
        await actions[endpoint]({project:payload.project,archiveVersion:payload.archiveVersion},signal,peer);
        if(signal?.aborted)return {ok:false,error:{code:'cancelled',message:'Request cancelled',details:{}}};
        if(!authorized(peer))return {ok:false,error:{code:'forbidden',message:'Operator scope is no longer live',details:{}}};
        return {ok:true,value:snapshot()};
      } catch(error) {return {ok:false,error:{code:'action-failed',message:error.message||'Project card action failed',details:{}}};}
    }
    if(!(endpoint==='snapshot' || endpoint==='alerts' && alerts) || !payload || Array.isArray(payload) || typeof payload!=='object' || Object.keys(payload).length)
      return {ok:false,error:{code:'bad-request',message:'Only empty read-only snapshot or alerts requests are supported',details:{issues:[]}}};
    return {ok:true,value:endpoint==='alerts'?alerts():snapshot()};
  };
}
