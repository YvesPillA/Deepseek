import {sessionEvents} from './stored-session.mjs';

/** Durable UI classification only. Agents remain owned by the host, never by
 * a coordinator or a fabricated parent. DSH 0.2 accepts an unparented subagent
 * header and excludes it from ordinary conversation rows. */
export const internalSessionMeta=Object.freeze({origin:'subagent'});

const short=(value,limit)=>Array.from(String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu,'').replace(/\s+/gu,' ').trim()).slice(0,limit).join('');

export function internalSessionTitle(binding,project) {
  const prefix=`新工头 · ${short(binding.project,24)} · `;
  if(binding.role==='coordinator')return `${prefix}执行负责人 c${binding.configVersion}`;
  if(binding.role==='executor')return `${prefix}执行 ${short(binding.task,20)} a${binding.taskAttempt??1} · ${short(project.tasks?.[binding.task]?.title,20)}`;
  const round=project.rounds?.[binding.round],reviewer=project.reviewers?.find(r=>r.id===binding.reviewer);
  const kind={plan:'规划',change:'改规',acceptance:'验收',final:'交付',patrol:'巡检'}[round?.kind]??round?.kind??'审查';
  return `${prefix}监督 ${short(binding.reviewer,16)} · ${short(round?.milestone??'项目',12)} ${short(kind,4)} g${binding.generation} a${binding.attempt} ${binding.round?.slice(0,8)??''} · ${short(reviewer?.name,16)}`;
}

export function retiredSession(record,state) {
  const b=record?.binding,p=state.projects?.[b?.project];
  if(!p || !['coordinator','executor','reviewer'].includes(b.role))return false;
  if(p.archived===true || ['cancelled','delivered'].includes(p.status) || p.configVersion!==b.configVersion)return true;
  if(b.role==='executor') {
    const t=p.tasks?.[b.task];
    return !t || ['completed','failed'].includes(t.status) || (t.attempt??1)!==(b.taskAttempt??1) ||
      t.planVersion!==b.planVersion;
  }
  if(b.role==='reviewer') {
    const r=p.rounds?.[b.round];
    return !r || r.status!=='open' || !!r.votes?.[b.reviewer] || r.generation!==b.generation ||
      (r.attempts?.[b.reviewer]??0)+1!==b.attempt;
  }
  return false;
}

/** Narrow host-side presentation. This class never opens a persisted session
 * writer, creates an Agent, rewrites lineage, or deletes history. */
export class SessionPresentation {
  #ctx;#state;#presented=new WeakSet();
  constructor(ctx,state){this.#ctx=ctx;this.#state=state;}
  async present(agent,record) {
    const state=this.#state(),owned=state.runtimeAgents?.[record.key];
    if(owned?.sessionId!==agent.id || record.sessionId!==agent.id ||
      JSON.stringify(owned.binding)!==JSON.stringify(record.binding))throw Error('Session presentation ownership changed');
    if(this.#presented.has(agent))return;
    const titles=this.#ctx.sessionTitle;
    if(!titles)return; // Compatibility with the older offline runtime; the host requires the real services.
    if(titles.get(agent.session)){this.#presented.add(agent);return;} // Preserve every existing/manual title across resume.
    const p=state.projects[record.binding.project];
    if(!p)throw Error('Session presentation project is unavailable');
    titles.rename(agent.session,internalSessionTitle(record.binding,p));
    if(!await this.#ctx.sessions.flush(agent.session))throw Error('Session title could not be durably flushed');
    if(!sessionEvents(agent.session).some(e=>e.type==='session/title'))throw Error('Session title was not recorded');
    this.#presented.add(agent);
  }
  async archiveRetired({signal,isActive=()=>true}={}) {
    if(!isActive())return [];
    if(!this.#ctx.workspaceRegistry)return [];
    if(typeof this.#ctx.agents?.get!=='function')return [{key:'service',error:'Live agent lookup is unavailable; session archive refused'}];
    const errors=[];
    for(const candidate of Object.values(this.#state().runtimeAgents??{})) {
      signal?.throwIfAborted();
      if(!isActive())break;
      const registry=this.#ctx.workspaceRegistry;
      if(!registry)break;
      const state=this.#state(),record=state.runtimeAgents?.[candidate.key];
      const project=state.projects?.[record?.binding?.project];
      if(!record || record.sessionId!==candidate.sessionId || !project || !['cancelled','delivered'].includes(project.status) ||
        !['coordinator','executor','reviewer'].includes(record.binding.role))continue;
      // Refuse an ambiguous ownership map, even if a corrupted imported journal
      // happens to associate an outer/user id with two plugin roles.
      if(Object.values(state.runtimeAgents).filter(r=>r.sessionId===record.sessionId).length!==1) {
        errors.push({key:record.key,error:'Session ownership is ambiguous'});continue;
      }
      if(this.#ctx.agents.get(record.sessionId))continue;
      if(registry.archivedSessionIds.includes(record.sessionId))continue;
      try {
        // No stopActivity: the official registry rechecks inactivity and refuses
        // active work. The exact owned agent must be drained before this call.
        await registry.archiveSession(record.sessionId,{});
      } catch(error) {
        // A reservation may never have materialized; do not create it just to
        // archive it. Every other failure remains visible to the host.
        if(error?.name==='WorkspaceUnknownSessionError' && error.sessionId===record.sessionId)continue;
        errors.push({key:record.key,error:String(error?.message??error)});
      }
    }
    return errors;
  }
}
