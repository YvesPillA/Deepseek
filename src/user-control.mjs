import {randomUUID} from 'node:crypto';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
// Providers should honor cancellation, but a provider that never settles must
// not keep a disposed outer tool waiting or allow a late answer to commit.
function askUntilAborted(ask,signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    if(signal.aborted){reject(signal.reason);return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{signal.throwIfAborted();return ask();}).then(
      value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
const fields={
  create:['id','objective','workspace','reviewers','denialLimit','patrolEvery','faultRetries'],
  configure:['project','objective','reviewers'],extend:['project','milestone','additional'],
  'resume-review':['project','round'],'cancel-milestone':['project','milestone'],
  'resume-coordinator':['project','notification','reason'],
  cancel:['project'],deliver:['project'],archive:['project'],unarchive:['project'],'delete-project':['project'],
  'use-dependency-image':['project','candidate'],
  'build-dependencies':['project'],
  'recover-empty-session':['project','notification'],
};
const labels={create:'锁定开局设置',configure:'修改已锁定规则',extend:'追加返工机会','resume-review':'恢复技术暂停的审查',
  'resume-coordinator':'恢复停滞的执行负责人','build-dependencies':'允许联网构建依赖','recover-empty-session':'接管异常空会话',
  'cancel-milestone':'取消里程碑',cancel:'终止项目',deliver:'确认最终交付',archive:'归档项目',unarchive:'恢复项目显示','delete-project':'删除归档项目记录','use-dependency-image':'确认项目依赖'};

export function describeUserCommand(command,project) {
  const lines=[labels[command.type]];
  if(project)lines.push(`项目：${project.objective}`,`目录：${project.workspace}`);
  if(command.type==='create') {
    lines.push(`目标：${command.objective}`,`目录：${command.workspace}`,
      `每完成 ${command.patrolEvery??3} 个任务巡查一次；单个里程碑累计第 ${command.denialLimit??3} 轮否决暂停。`,
      `监督者初次失败后最多重试 ${command.faultRetries??3} 次。`);
  }
  if(command.objective && command.type!=='create')lines.push(`新目标：${command.objective}`);
  if(command.reviewers)for(const r of command.reviewers)lines.push(`监督者：${r.name}（${r.id}）\n职责：${r.responsibility}\n验收标准：${r.criteria}`);
  if(command.milestone)lines.push(`里程碑：${project?.milestones[command.milestone]?.title??command.milestone}（${command.milestone}）`);
  if(command.additional)lines.push(`追加 ${command.additional} 次机会，历史否决次数保留。`);
  if(command.round)lines.push(`审查轮次：${command.round}`);
  if(command.type==='resume-coordinator')lines.push(`待处理问题：${project?.notifications.find(n=>n.id===command.notification)?.message??command.notification}`,`恢复说明：${command.reason}`,'重新唤醒原执行负责人处理现有项目。里程碑状态、否决次数和监督标准保持不变。');
  if(command.type==='configure')lines.push('旧审批将失效，按新规则重新审查；已有否决次数保留。');
  if(command.type==='create')lines.push('确认后锁定监督名单。执行模块不能修改监督职责或自行批准交付。');
  if(command.type==='cancel')lines.push('任务将停止，已有文件保留。');
  if(['archive','unarchive'].includes(command.type))lines.push(`项目ID：${project.id}`,`当前状态：${project.status}`,
    command.type==='archive'?'将已结束项目从默认列表隐藏；项目文件、会话、审计记录和监督规则全部保留，可恢复显示。':'将归档项目恢复到默认列表；保留原来的结束状态，不重新启动任务或更改监督规则。');
  if(command.type==='delete-project')lines.push(`项目ID：${project.id}`,`当前状态：${project.status}`,
    '删除记录，文件保留：从当前和已归档列表移除这个项目，不再提供恢复入口。工作区文件和外层聊天不会删除；内部保留必要审计和旧项目ID，原始日志不会被擦除。');
  return lines.join('\n\n');
}

/** Only host-bound outer agents can initiate this UI workflow. Execution and review
 * agents do not inherit this capability, even though DSH considers them runtime roots.
 * No model argument, chat text or timeout substitutes for the provider's answer.
 */
export class UserControl {
  #controller;#ctx;#roots=new Map();#pending=new WeakSet();#canStart;#closed=false;#dependencies;#provisioner;#recovery;
  constructor(controller,ctx,{canStart=()=>false,dependencies,provisioner,recovery}={}){this.#controller=controller;this.#ctx=ctx;this.#canStart=canStart;this.#dependencies=dependencies;this.#provisioner=provisioner;this.#recovery=recovery;}
  recoverDependencyBuild(agent,project,candidate,signal){this.#authorize(agent);check(this.#provisioner,'Dependency provisioning is not configured');return this.#provisioner.recover(project,candidate,{signal:AbortSignal.any([this.#roots.get(agent).abort.signal,...(signal?[signal]:[])]),authorize:()=>this.#authorize(agent)});}
  dependencyCandidates(agent){this.#authorize(agent);return this.#dependencies?this.#dependencies.list():Promise.resolve([]);}
  bindRoot(agent,{validate=()=>{}}={}) {
    check(!this.#closed,'User control is closed');
    check(agent && typeof agent==='object','Exact outer agent required');
    check(!this.#roots.has(agent),'Outer agent is already bound');
    const lifetime={abort:new AbortController(),validate};this.#roots.set(agent,lifetime);
    return ()=>{
      if(this.#roots.get(agent)!==lifetime)return;
      this.#roots.delete(agent);lifetime.abort.abort(new Error('Outer agent scope was disposed'));
    };
  }
  close() {
    if(this.#closed)return;
    this.#closed=true;
    for(const lifetime of this.#roots.values())lifetime.abort.abort(new Error('User control is closed'));
    this.#roots.clear();
  }
  authorizeRoot(agent){this.#authorize(agent);}
  #authorize(agent) {
    check(!this.#closed,'User control is closed');
    check(this.#roots.has(agent) && this.#ctx.agents.get(agent.id)===agent && this.#ctx.agents.roots().includes(agent),'Only the bound live outer agent can request human confirmation');
    this.#roots.get(agent).validate(agent);
    let execution=false;try{this.#controller.identity(agent);execution=true;}catch{}
    check(!execution,'Execution and review agents cannot act as the outer agent');
  }
  async request(agent,raw,signal) {
    this.#authorize(agent);check(!this.#pending.has(agent),'An outer-agent confirmation is already pending');
    const lifetime=this.#roots.get(agent).abort.signal;
    signal=signal?AbortSignal.any([signal,lifetime]):lifetime;
    const command=structuredClone(raw),allowed=fields[command?.type];
    check(allowed && Object.keys(command).every(k=>k==='type'||allowed.includes(k)),'Unsupported user-control command or unexpected fields');
    if(command.type==='create')check(this.#canStart(),'Project startup is not enabled until integration gates are satisfied');
    this.#pending.add(agent);
    try {
      signal?.throwIfAborted();
      const dependency=['use-dependency-image','build-dependencies','recover-empty-session'].includes(command.type);
      const service=command.type==='recover-empty-session'?this.#recovery:command.type==='build-dependencies'?this.#provisioner:this.#dependencies;
      if(dependency)check(service,'Dependency operation is not configured');
      const ticket=await (dependency?service.prepare(command):this.#controller.prepareUserCommand(command));
      signal.throwIfAborted();this.#authorize(agent);
      const project=command.project?this.#controller.view(command.project):null;
      const id='foreman-confirm-'+randomUUID(),approve='确认执行';
      let answer;
      try {
        answer=await askUntilAborted(()=>this.#ctx.userQuestions.ask({agent,signal,questions:[{id,header:labels[command.type],
          question:'请检查以下设置或变更，确认后才会生效。',detail:dependency?ticket.detail:describeUserCommand(ticket.command,project),
          options:[{label:approve},{label:'返回调整'}],multiSelect:false,intent:{kind:'plan-review',approve}}]}),signal);
      } catch(error) {
        signal.throwIfAborted();this.#authorize(agent);
        if(error?.code==='ASK_CANCELLED')return {applied:false,feedback:'用户没有确认，请根据意见调整后重新提交。'};
        throw error;
      }
      signal?.throwIfAborted();this.#authorize(agent);
      const response=answer?.answers?.length===1 && answer.answers[0].id===id?answer.answers[0]:undefined;
      if(!response || response.selected?.length!==1 || response.selected[0]!==approve || response.custom?.trim())
        return {applied:false,feedback:response?.custom??'用户没有确认，请根据意见调整后重新提交。'};
      if(command.type==='create')check(this.#canStart(),'Startup eligibility changed while awaiting confirmation');
      const options={signal,authorize:()=>{
        signal?.throwIfAborted();this.#authorize(agent);
        if(command.type==='create')check(this.#canStart(),'Startup eligibility changed while awaiting confirmation');
      }};
      const result=dependency?await service.confirm(ticket,id,options):await this.#controller.confirmUserCommand(ticket,id,options);
      return {applied:true,project:command.project??command.id,...(command.type==='build-dependencies'?{build:result}:{})};
    } finally {this.#pending.delete(agent);}
  }
}
