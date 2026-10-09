const short=(value,max=100)=>typeof value==='string'?Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu,'').replace(/\s+/gu,' ').trim()).slice(0,max).join(''):'';
const iso=value=>{const ms=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(ms)&&Math.abs(ms)<8.64e15?new Date(ms).toISOString():null;};
const relative=value=>typeof value==='string' && value.length<=200 && value.split('/').every(p=>p && !['.','..'].includes(p) && !/[\\:<>"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p))?value:null;
const parse=value=>{try{return typeof value==='string'&&value.length<=65536?JSON.parse(value):null;}catch{return null;}};
const values=value=>Object.values(value??{});
const roleName=(b,p)=>b.role==='coordinator'?'执行负责人':b.role==='executor'?`执行者 · ${short(p.tasks?.[b.task]?.title,60)||'执行任务'}`:short(p.reviewers?.find(r=>r.id===b.reviewer)?.name)||'监督者';
const commandTitle=(c,p)=>({create:'项目已启动',propose:'提交规划审查',task:'创建执行任务',assign:'开始执行任务',complete:'执行任务已完成',submit:'提交作品验收',final:'提交最终验收',deliver:'项目已交付',pause:'正在暂停并排空代理',resume:'项目已恢复',cancel:'项目已取消',
  'retry-task':'重试执行任务','task-fault':'执行任务中断','review-fault':'监督审查中断',extend:'里程碑恢复执行',requirements:'更新项目要求',
  vote:c.pass===true?`${['plan','change'].includes(p.rounds?.[c.round]?.kind)?'规划审查':'作品审查'}通过`:'审查要求返工'}[c.type]??null);
const matching=(b,p)=>{
  if(!p || p.deleted===true || !['coordinator','reviewer','executor'].includes(b.role) || b.configVersion!==p.configVersion)return false;
  if(b.role==='executor') {const t=p.tasks?.[b.task];return !!t && t.configVersion===p.configVersion && t.planVersion===b.planVersion && (t.attempt??1)===(b.taskAttempt??1);}
  if(b.role==='reviewer') {const r=p.rounds?.[b.round];return !!r && r.generation===b.generation && (r.attempts?.[b.reviewer]??0)+1===b.attempt && p.reviewers?.some(v=>v.id===b.reviewer);}
  return true;
};
const working=(b,p)=>{
  if(p.paused || ['cancelled','delivered','approved'].includes(p.status))return false;
  if(b.role==='executor')return p.tasks?.[b.task]?.status==='running';
  if(b.role==='reviewer')return p.rounds?.[b.round]?.status==='open' && !Object.hasOwn(p.rounds[b.round].votes??{},b.reviewer);
  return true;
};
const phase=p=>{
  if(p.status==='cancelled')return (p.controlDrainVersion??0)===(p.controlVersion??0)?'cancelled':'cancelling';
  if(p.status==='delivered')return 'delivered';
  if(p.paused)return p.pauseStatus==='drained'?'paused':'pausing';
  if(p.status==='approved')return 'approved';
  if(values(p.milestones).some(m=>m.status==='paused'))return 'decision';
  if(p.status==='final-review'||values(p.rounds).some(r=>r.status==='open'&&['acceptance','final'].includes(r.kind)))return 'review';
  if(values(p.tasks).some(t=>t.status==='running'))return 'work';
  if(values(p.rounds).some(r=>r.status==='open'&&['plan','change'].includes(r.kind))||!values(p.milestones).length)return 'planning';
  if(values(p.milestones).some(m=>m.status==='work'))return 'work';
  return 'idle';
};
const verification=(result,status)=>{
  if(result && Number.isInteger(result.exitCode)) {
    const success=result.exitCode===0 && result.truncated===false && result.oomKilled!==true;
    return {status:success?'success':'failed',exitCode:result.exitCode,summary:success?'命令退出成功，仍需监督验收':result.truncated?'验证输出被截断':result.oomKilled?'验证因资源限制结束':'验证命令退出失败'};
  }
  return {status:['reserved','running'].includes(status)?'running':'unknown',summary:['reserved','running'].includes(status)?'验证执行中':'验证结果待确认'};
};

/** Bounded host-side activity projection. Never calls deprecated synchronous
 * Session readers. Optional sessionQuery.observeSession supplies one asynchronous
 * live observation on attach; thereafter the official session/event feed is used.
 * Without that optional service historical activity is unknown until new events. */
export class ProjectProgress {
  #ctx;#state;#lastState;#cache=new Map();#pending=new Set();#next=0;#off;#closed=false;#abort=new AbortController();
  constructor(ctx,stateGetter) {
    this.#ctx=ctx;this.#state=stateGetter;
    this.#off=ctx.on?.('session/event',(session,event)=>{try{this.#accept(session,event);}catch{}});
  }
  #service(name) {try{return this.#ctx.get?.(name)??this.#ctx[name];}catch{return undefined;}}
  #ownership(session,state,allowRetiring=false) {
    const records=values(state?.runtimeAgents).filter(r=>r.sessionId===session?.id);
    if(records.length!==1)return null;
    const record=records[0],p=state.projects?.[record.binding?.project];
    if(!matching(record.binding,p))return null;
    const draining=p.paused && p.pauseStatus==='requested' || p.status==='cancelled' && (p.controlDrainVersion??0)!==(p.controlVersion??0);
    if((record.binding.controlVersion??0)!==(p.controlVersion??0) && !(allowRetiring && draining))return null;
    const agent=this.#service('agents')?.get?.(record.sessionId);
    if(!agent || agent.session!==session || agent.id!==record.sessionId)return null;
    const sessions=this.#service('sessions');
    if(typeof sessions?.get==='function' && sessions.get(record.sessionId)!==session)return null;
    return {record,p,agent};
  }
  #entry(session,record) {
    let entry=this.#cache.get(session);
    const basis=JSON.stringify(record.binding);
    if(entry?.basis!==basis){entry={basis,calls:new Map(),timeline:[],seen:new Set(),lastAt:null,status:'状态待更新',seeded:false};this.#cache.set(session,entry);}
    while(this.#cache.size>128)this.#cache.delete(this.#cache.keys().next().value);
    return entry;
  }
  #accept(session,event,seed=false) {
    if(this.#closed)return;
    const state=this.#state?.()??this.#lastState,owned=this.#ownership(session,state,['tool/result','turn/end','step/end','assistant/attempt'].includes(event?.type));
    if(!owned || !event || !Number.isSafeInteger(event.seq))return;
    const {record,p}=owned,entry=this.#entry(session,record);
    if(entry.seen.has(event.seq))return;
    entry.seen.add(event.seq);while(entry.seen.size>256)entry.seen.delete(entry.seen.values().next().value);
    const at=iso(event.time);if(!at)return;
    const data=event.data??{},actor=roleName(record.binding,p);
    if(!entry.lastAt || at>=entry.lastAt){entry.lastAt=at;
      if(event.type==='step/start')entry.status='等待模型响应';
      if(event.type==='assistant/message')entry.status='处理模型响应';
      if(event.type==='turn/end')entry.status='回合已结束';
    }
    if(event.type==='tool/call') {
      const args=parse(data.arguments)??{},command=data.name==='foreman_command'?parse(args.command):null;
      let action;
      if(data.name==='foreman_files' && ['list','read','write','delete'].includes(args.action))action={list:'查看文件列表',read:'读取文件',write:'写入文件',delete:'删除文件'}[args.action]+(relative(args.path)?`：${relative(args.path)}`:'');
      else if(data.name==='foreman_verify')action='运行本机验证';
      else if(data.name==='foreman_artifact')action='查看验收制品'+(relative(args.path)?`：${relative(args.path)}`:'');
      else if(data.name==='foreman_evidence')action='查看验证证据';
      else if(data.name==='foreman_read'||data.name==='foreman_detail')action='读取项目状态';
      else if(command)action=({vote:'提交监督结论',complete:'提交任务完成结果',deliver:'提交项目交付',cancel:'提交取消请求',pause:'提交暂停请求'}[command.type]??commandTitle(command,p));
      if(!action || typeof data.callId!=='string' || data.callId.length>200)return;
      const item={id:'activity-'+(++this.#next),at,actor,action,result:'执行中',status:'running'};
      entry.calls.set(data.callId,{item,verify:data.name==='foreman_verify'});
      while(entry.calls.size>32)entry.calls.delete(entry.calls.keys().next().value);
      entry.timeline.unshift(item);entry.timeline=entry.timeline.slice(0,12);
      if(!entry.latest || at>=entry.latest.at)entry.latest=item;
      if(at>=entry.lastAt)entry.status='工具执行中';
      if(data.name==='foreman_verify' && (!entry.verification || at>=entry.verification.at)){entry.verification={at,title:'本机验证',status:'running',summary:'验证执行中'};entry.verifyRunName=null;}
    }
    if(event.type==='tool/result') {
      const callId=data.message?.toolCallId??data.message?.source?.callId,call=entry.calls.get(callId);
      if(!call)return;
      entry.calls.delete(callId);
      const unknown=data.error?.code==='TOOL_OUTCOME_UNKNOWN';
      const failed=!!data.error || data.message?.isError===true;
      Object.assign(call.item,{at,status:unknown?'unknown':failed?'failed':'success',result:unknown?'结果待确认':failed?'工具执行失败':'工具执行成功'});
      if(!entry.latest || at>=entry.latest.at)entry.latest=call.item;
      if(at>=entry.lastAt)entry.status='工具调用结束';
      if(call.verify) {
        // Parse only the known numeric verification result. Never retain text,
        // stdout, stderr, arguments, reasoning or arbitrary error messages.
        const text=data.message?.content?.find(v=>v.type==='text')?.text,result=parse(text);
        if(!entry.verification || at>=entry.verification.at) {
          entry.verification={at,title:'本机验证',...failed?{status:unknown?'unknown':'failed',summary:unknown?'验证结果待确认':'验证工具调用失败'}:verification(result,'removed')};
          entry.verifyRunName=typeof result?.verification==='string'?result.verification:null;
        }
      }
    }
    // Seed observations may contain old events, but their timestamps cannot
    // override activity received while the asynchronous read was pending.
    if(seed)entry.timeline.sort((a,b)=>b.at.localeCompare(a.at));
  }
  #seed(session,record) {
    if(this.#closed)return;
    const entry=this.#entry(session,record),query=this.#service('sessionQuery');
    if(entry.seeded || typeof query?.observeSession!=='function')return;
    entry.seeded=true;
    const pending=(async()=>{
      let observation;
      try {
        observation=await query.observeSession(session.id,{projectionMode:'none',signal:this.#abort.signal});
        if(this.#closed || observation.source!=='live' || observation.header?.id!==session.id)return;
        // At most 256 events are inspected once per attached live session.
        for(const event of observation.events.slice(-256))this.#accept(session,event,true);
      }catch{}finally{try{observation?.[Symbol.dispose]?.();}catch{}}
    })();
    this.#pending.add(pending);pending.finally(()=>this.#pending.delete(pending));
  }
  snapshot(state) {
    this.#lastState=state;
    const result=Object.create(null);
    for(const p of values(state.projects).filter(p=>p.deleted!==true)) {
      const progress={phase:phase(p),completedTasks:values(p.tasks).filter(t=>t.status==='completed').length,totalTasks:values(p.tasks).length,activeAgents:[],lastActivityAt:null,latestAction:null,latestVerification:null,timeline:[]};
      const timeline=[];
      const audit=p.audit??[],auditStart=Math.max(0,audit.length-100);
      for(const [index,a] of audit.slice(auditStart).entries()) {
        const at=iso(a.time),title=commandTitle(a.command??{},p);
        if(at && title)timeline.push({id:'audit-'+(auditStart+index),at,actor:{user:'用户',coordinator:'执行负责人',executor:'执行者',reviewer:'监督者'}[a.actor]??'宿主',title,status:a.command?.type==='vote' && a.command.pass===false?'failed':'success'});
      }
      let latestRunName;
      for(const record of values(state.runtimeAgents).filter(r=>r.binding?.project===p.id && matching(r.binding,p))) {
        const agent=this.#service('agents')?.get?.(record.sessionId),session=agent?.session;
        const draining=p.paused && p.pauseStatus==='requested' || p.status==='cancelled' && (p.controlDrainVersion??0)!==(p.controlVersion??0);
        const live=session && this.#ownership(session,state,true);
        if(live && !draining)this.#seed(session,record);
        const entry=live?this.#entry(session,record):[...this.#cache].find(([s,e])=>s.id===record.sessionId&&e.basis===JSON.stringify(record.binding))?.[1];
        if(live && (working(record.binding,p)||draining))progress.activeAgents.push({name:roleName(record.binding,p),role:record.binding.role,
          ...(record.binding.role==='executor'?{taskTitle:short(p.tasks?.[record.binding.task]?.title)}:{}),
          status:draining?'停止中':agent.status==='idle'?'等待任务或审查结果':entry.status});
        if(!entry)continue;
        const stopped=p.paused && p.pauseStatus==='drained' || !live;
        const displayed=item=>stopped && item.status==='running'?{...item,status:'unknown',result:'停止后结果待确认'}:item;
        if(entry.latest && (!progress.latestAction || entry.latest.at>progress.latestAction.at)) {
          const latest=displayed(entry.latest);
          progress.latestAction={at:latest.at,actor:latest.actor,action:latest.action,result:latest.result,status:latest.status};
        }
        if(entry.verification && (!progress.latestVerification || entry.verification.at>progress.latestVerification.at)) {
          progress.latestVerification=stopped && entry.verification.status==='running'?{...entry.verification,status:'unknown',summary:'停止后验证结果待确认'}:{...entry.verification};latestRunName=entry.verifyRunName;
        }
        timeline.push(...entry.timeline.map(item=>{const d=displayed(item);return {id:d.id,at:d.at,actor:d.actor,title:d.action,status:d.status,summary:d.result};}));
        if(entry.lastAt && (!progress.lastActivityAt || entry.lastAt>progress.lastActivityAt))progress.lastActivityAt=entry.lastAt;
      }
      const run=values(state.verificationRuns).filter(v=>v.project===p.id).at(-1);
      if(run && (!progress.latestVerification || latestRunName===run.name))progress.latestVerification={at:progress.latestVerification?.at??null,title:'本机验证',...verification(run.result,run.status)};
      progress.activeAgents=progress.activeAgents.slice(0,32);
      progress.timeline=timeline.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,12);
      if(progress.timeline[0]?.at && (!progress.lastActivityAt || progress.timeline[0].at>progress.lastActivityAt))progress.lastActivityAt=progress.timeline[0].at;
      result[p.id]=progress;
    }
    return structuredClone(result);
  }
  async flush(){await Promise.allSettled([...this.#pending]);}
  async close(){if(this.#closed)return this.flush();this.#closed=true;this.#abort.abort();this.#off?.();await this.flush();this.#cache.clear();}
}
