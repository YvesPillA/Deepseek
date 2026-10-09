window.__ModuleLoader__.load({
  id:'dsh-foreman-next',
  factory:require=>{
    const React=require('react'),h=React.createElement;
    const labels={running:'执行中',approved:'验收通过，等待交付',delivered:'已交付',cancelled:'已取消',
      work:'等待实现',unplanned:'等待规划',planning:'规划审查',review:'验收中',passed:'已通过',paused:'已暂停',pausing:'正在暂停',idle:'等待调度',
      pending:'待分配',completed:'已完成',failed:'执行失败',open:'审查中',faulted:'技术暂停',stale:'已失效',closed:'已结束',
      plan:'规划',change:'变更',acceptance:'里程碑验收',patrol:'巡查',final:'最终验收','final-review':'最终验收中',rejected:'未通过',
      decision:'需要裁决',fault:'技术问题',delivery:'等待交付',success:'执行成功',unknown:'结果待确认',cancelling:'已请求取消，正在停止执行活动'};
    const label=value=>labels[value]??value;
    // Main slot outlets use display:contents; each page owns its insets and scroll
    // surface. Match the native PluginManagerPage geometry and theme text roles.
    const css=`
.fmn-panel{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;align-items:center;gap:32px;padding:0 clamp(24px,4vw,48px) 48px;overflow:auto;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);overflow-wrap:anywhere}
.fmn-panel *,.fmn-alerts *{box-sizing:border-box}
.fmn-panel>header,.fmn-content{width:100%;max-width:960px;min-width:0;flex:none}
.fmn-panel>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px}
[data-platform=darwin] .fmn-panel>header{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.fmn-panel h2{margin:0;font:var(--dsw-font-l-20)}
.fmn-panel h3,.fmn-panel h4{margin:0 0 8px;font:var(--dsw-font-s-strong-14)}
.fmn-panel p,.fmn-alerts p{margin:0 0 8px;font:var(--dsw-font-xs-13)}
.fmn-panel>header .fmn-muted{margin:4px 0 0}
.fmn-panel strong,.fmn-alerts strong{font-weight:500}
.fmn-panel button,.fmn-panel select,.fmn-alerts button{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:5px 12px}
.fmn-panel button,.fmn-alerts button{cursor:pointer;flex:none}
.fmn-panel button:hover:not(:disabled),.fmn-alerts button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fmn-panel button:disabled{opacity:.5;cursor:wait}
.fmn-panel :focus-visible,.fmn-alerts :focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.fmn-card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);padding:16px;margin:16px 0;background:var(--dsw-alias-settings-card-fill)}
.fmn-content>:first-child{margin-top:0}
.fmn-note{padding:14px 16px;border-left:3px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);border-radius:var(--dsw-radius-sm);margin:16px 0}
.fmn-muted{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.fmn-tag{display:inline-block;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);padding:2px 8px;margin:2px 6px 2px 0;font:var(--dsw-font-xxs-12)}
.fmn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px}
.fmn-grid .fmn-card{margin:0;min-width:0}
.fmn-panel ul,.fmn-panel ol{padding-left:22px;margin:8px 0}
.fmn-panel li{margin:6px 0}
.fmn-panel details{margin-top:12px}
.fmn-panel summary{cursor:pointer;font:var(--dsw-font-s-strong-14)}
.fmn-findings{white-space:pre-wrap;font:var(--dsw-font-xs-13)}
.fmn-alert{color:var(--dsw-alias-state-error-primary)}
.fmn-panel select{max-width:100%;width:100%;margin-top:5px}
.fmn-panel time{font-variant-numeric:tabular-nums}
.fmn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
.fmn-actions button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);font-weight:500}
.fmn-progress{margin-top:0}.fmn-progress dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 16px;margin:12px 0 0;font:var(--dsw-font-xs-13)}
.fmn-progress dt{color:var(--dsw-alias-label-secondary)}.fmn-progress dd{margin:0;min-width:0}
.fmn-timeline{border-top:.5px solid var(--dsw-alias-border-l4);margin-top:14px;padding-top:12px}.fmn-timeline ol{margin-bottom:0}.fmn-timeline time{color:var(--dsw-alias-label-secondary);margin-right:8px}
.fmn-alerts{position:absolute;right:16px;bottom:16px;width:min(360px,calc(100% - 32px));max-height:45vh;overflow-y:auto;padding:16px;border:0;border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-panel);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);overflow-wrap:anywhere}
.fmn-alerts ul{padding-left:20px}.fmn-alerts li{margin:8px 0}.fmn-alerts small{display:block;margin-top:6px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
@media(max-width:520px){.fmn-card{padding:13px}.fmn-grid{grid-template-columns:1fr}}
`;
    const tag=(text,key)=>h('span',{className:'fmn-tag',key},text);
    const empty=text=>h('p',{className:'fmn-muted'},text);
    const time=value=>{
      if(!value)return null;const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;
      return h('time',{dateTime:date.toISOString()},date.toLocaleString('zh-CN',{hour12:false}));
    };
    function projectProgress(p) {
      const tasks=p.milestones.flatMap(m=>m.tasks),provided=p.progress??{};
      const phase=p.paused?(p.pauseStatus==='drained'?'paused':'pausing'):p.status==='running'?(p.milestones.some(m=>m.status==='planning')?'planning':p.milestones.some(m=>m.status==='review')?'review':tasks.some(t=>t.status==='running')?'work':'idle'):p.status;
      return {...provided,phase:provided.phase??phase,
        completedTasks:provided.completedTasks??tasks.filter(t=>t.status==='completed').length,totalTasks:provided.totalTasks??tasks.length};
    }
    const milestoneStatus=m=>m.status==='work'?(m.blockedBy.length?'等待依赖':m.tasks.some(t=>t.status==='running')?'实现中':'等待实现'):label(m.status);
    const phaseLabel=phase=>({work:'实现中',planning:'规划审查中',idle:'等待调度',pausing:'正在暂停，等待执行活动停止',decision:'相关里程碑等待裁决，其他任务可继续'}[phase]??label(phase));
    const controlActions=p=>p.archived||['cancelled','delivered'].includes(p.status)?[]:p.paused===true?(p.pauseStatus==='drained'?['resume','cancel']:['cancel']):['running','final-review','approved'].includes(p.status)?['pause','cancel']:[];
    const controlCopy={pause:{label:'暂停项目',confirm:'确认暂停项目',description:'暂停这个项目的后续调度，并请求停止当前执行活动。文件、任务和审查记录保留，可继续执行。'},
      resume:{label:'继续项目',confirm:'确认继续项目',description:'继续这个项目的调度，沿用当前任务、里程碑和监督规则。'},
      cancel:{label:'取消项目',confirm:'确认取消项目',description:'结束这个项目，并请求停止当前执行活动。取消后不能继续执行；工作区文件和审查记录保留。'}};
    function Progress({project:p,onRequestAction,pendingAction,onConfirmAction,onCancelAction,actionBusy}) {
      const progress=projectProgress(p),active=progress.activeAgents??[],action=controlCopy[pendingAction?.endpoint];
      const confirming=pendingAction?.project===p.id&&action&&controlActions(p).includes(pendingAction.endpoint);
      const latest=progress.latestAction,verification=progress.latestVerification;
      return h('section',{className:'fmn-card fmn-progress','aria-label':'项目执行进度'},
        h('h3',null,'项目执行进度'),tag(phaseLabel(progress.phase)),tag(`已完成任务 ${progress.completedTasks} / ${progress.totalTasks}`),
        h('p',{className:'fmn-muted'},'项目 ID：',p.id),
        h('dl',null,
          h('dt',null,'正在执行'),h('dd',null,active.length?active.map((a,i)=>h('span',{key:i},i?'；':'',a.name??label(a.role),a.taskTitle?'：'+a.taskTitle:'',a.status?'（'+label(a.status)+'）':'')):'当前没有可确认的活动信息'),
          h('dt',null,'最近活动'),h('dd',null,time(progress.lastActivityAt)??'尚无活动记录'),
          h('dt',null,'最近动作'),h('dd',null,latest?h(React.Fragment,null,latest.actor?latest.actor+'：':'',latest.action,latest.status?' · '+label(latest.status):'',latest.result?h('p',{className:'fmn-muted'},latest.result):null):'尚无动作记录'),
          h('dt',null,'最近验证'),h('dd',null,verification?h(React.Fragment,null,verification.title??'验证',verification.status?' · '+label(verification.status):'',Number.isInteger(verification.exitCode)?` · 退出码 ${verification.exitCode}`:'',verification.summary?h('p',{className:'fmn-muted'},verification.summary):null):'尚无验证记录')),
        onRequestAction&&controlActions(p).length?h('div',{className:'fmn-actions'},controlActions(p).map(endpoint=>h('button',{key:endpoint,type:'button',disabled:actionBusy,onClick:()=>onRequestAction({endpoint,project:p.id,controlVersion:p.controlVersion??0})},controlCopy[endpoint].label))):null,
        confirming?h('div',{className:'fmn-note','aria-label':action.confirm},h('p',null,action.description),h('div',{className:'fmn-actions'},
          h('button',{type:'button',disabled:actionBusy,onClick:onConfirmAction},actionBusy?'处理中…':action.confirm),
          h('button',{type:'button',disabled:actionBusy,onClick:onCancelAction},'返回'))):null,
        progress.timeline?.length?h('div',{className:'fmn-timeline'},h('h4',null,'最近进展'),h('ol',null,progress.timeline.slice(0,5).map((event,i)=>h('li',{key:event.id??i},
          time(event.at),event.actor?event.actor+'：':'',event.title,event.status?' · '+label(event.status):'',event.summary?h('p',{className:'fmn-muted'},event.summary):null)))):null);
    }
    function Project({project:p,onRequestAction,pendingAction,onConfirmAction,onCancelAction,actionBusy}) {
      const terminal=['cancelled','delivered'].includes(p.status),confirm=pendingAction?.project===p.id,deleting=confirm&&pendingAction.endpoint==='delete-project';
      return h(React.Fragment,null,
        h(Progress,{project:p,onRequestAction,pendingAction,onConfirmAction,onCancelAction,actionBusy}),
        h('section',{className:'fmn-card','aria-label':'项目设置'},
          h('h3',null,p.objective),tag(label(p.status)),tag(`规则版本 ${p.configVersion}`),
          h('p',{className:'fmn-muted'},p.workspace),
          h('p',null,`每 ${p.settings.patrolEvery} 个完成任务巡查 · 默认第 ${p.settings.denialLimit} 轮否决暂停 · 监督故障重试 ${p.settings.faultRetries} 次`),
          h('p',{className:'fmn-muted'},`已完成 ${p.completions} 次任务，累计完成 ${p.nextPatrol} 次时触发下一轮巡查。`),
          p.archived?h('p',{className:'fmn-muted'},'已归档。恢复只显示项目，已结束的任务不会重新启动。'):null,
          terminal && onRequestAction?h('div',{className:'fmn-actions'},
            h('button',{type:'button',disabled:actionBusy,onClick:()=>onRequestAction({endpoint:p.archived?'unarchive':'archive',project:p.id,archiveVersion:p.archiveVersion??0})},p.archived?'恢复到项目列表':'从列表归档'),
            p.archived?h('button',{type:'button',disabled:actionBusy,onClick:()=>onRequestAction({endpoint:'delete-project',project:p.id,archiveVersion:p.archiveVersion??0})},'删除记录，文件保留'):null):null,
          terminal && confirm && (!deleting||p.archived)?h('div',{className:'fmn-note','aria-label':deleting?'确认删除归档项目记录':p.archived?'确认恢复项目显示':'确认归档项目'},
            h('p',null,deleting?'从列表删除，此处不能恢复；工作区文件和原始审计保留。外层聊天保留；内部保留旧项目ID。':p.archived?'恢复后重新显示这个项目；项目仍保持已结束状态，不会重启任务。':'从列表归档这个项目，保留项目文件、日志和审查记录。可在“已归档”中查看或恢复。'),
            h('div',{className:'fmn-actions'},
              h('button',{type:'button',disabled:actionBusy,onClick:onConfirmAction},actionBusy?'处理中…':deleting?'确认删除记录':p.archived?'确认恢复显示':'确认归档'),
              h('button',{type:'button',disabled:actionBusy,onClick:onCancelAction},'返回'))):null),
        p.notifications.length?h('section',{className:'fmn-note','aria-label':'待处理问题'},
          h('h3',null,'需要你处理'),h('ul',null,p.notifications.map(n=>h('li',{key:n.id},tag(label(n.kind)),n.message))),
          h('p',{className:'fmn-muted'},'回到工头对话说明裁决；系统会展示具体变更，等你确认后生效。')):null,
        p.dependencyBuilds?.length?h('section',{className:'fmn-card','aria-label':'依赖构建'},h('h3',null,'依赖构建'),
          h('ul',null,p.dependencyBuilds.map(b=>h('li',{key:b.candidate},
            {authorized:'已确认，准备启动',building:'正在构建',uncertain:'结果不明，等待核对',failed:'构建失败',ready:'镜像已准备，使用需另行确认'}[b.status]??b.status,
            b.configVersion!==p.configVersion?' · 原规则版本，需重新核对':null,
            h('details',null,h('summary',null,'候选编号'),h('code',null,b.candidate)))))):null,
        h('section',{'aria-label':'里程碑'},h('h3',null,'里程碑'),
          !p.milestones.length?empty('执行负责人尚未提交里程碑。'):h('div',{className:'fmn-grid'},p.milestones.map(m=>h('article',{className:'fmn-card',key:m.id},
            h('h4',null,m.title),tag(milestoneStatus(m)),tag(`否决 ${m.denials} / ${m.limit}`),
            m.blockedBy.length?h('p',{className:'fmn-alert'},'等待依赖：'+m.blockedBy.map(id=>p.milestones.find(x=>x.id===id)?.title??id).join('、')):null,
            h('p',{className:'fmn-muted'},m.criteria),
            m.tasks.length?h('ul',null,m.tasks.map(t=>h('li',{key:t.id},t.title,' · ',label(t.status),t.attempt>1?`（第 ${t.attempt} 次尝试）`:''))):empty('尚无实现任务。'))))),
        h('section',{className:'fmn-card','aria-label':'锁定的监督名单'},h('h3',null,'锁定的监督名单'),
          p.reviewers.map(r=>h('details',{key:r.id},h('summary',null,r.name,' · ',r.responsibility),h('p',{className:'fmn-findings'},r.criteria))),
          h('p',{className:'fmn-muted'},'各自审查，全部通过才放行。执行模块不能修改这些职责和标准。')),
        h('section',{className:'fmn-card','aria-label':'审查记录'},h('h3',null,'审查记录'),
          !p.rounds.length?empty('还没有审查记录。'):p.rounds.slice().reverse().map(r=>h('details',{key:r.id},
            h('summary',null,label(r.kind),' · ',r.milestone?(p.milestones.find(m=>m.id===r.milestone)?.title??r.milestone):'整个项目',' · ',r.kind==='plan'&&r.status==='closed'&&r.outcome==='passed'?'规划已通过，可开始实现':label(r.status)+(r.outcome?' / '+label(r.outcome):'')),
            r.kind==='plan'?h('p',{className:'fmn-muted'},'这里审查的是实现计划；规划通过不代表成品验收通过。成品需在实现完成后另行验收。'):null,
            r.kind==='patrol'?h('p',{className:'fmn-muted'},'巡查记录意见，执行继续；阶段验收时统一处理。'):null,
            h('ul',null,r.reviewers.map(v=>h('li',{key:v.id},h('strong',null,v.name),'：',v.vote?(v.vote.pass?'通过':'提出问题'):'尚无结论',
              v.vote?h('p',{className:'fmn-findings'},v.vote.findings):null,
              v.fault?h('p',{className:'fmn-alert'},'技术失败记录：',typeof v.fault==='string'?v.fault:JSON.stringify(v.fault)):null)))))));
    }
    function ForemanView({data,selected,onSelect,showArchived=false,onShowArchived,onRequestAction,pendingAction,onConfirmAction,onCancelAction,actionBusy=false}) {
      const archived=data.archivedProjects??[],projects=showArchived?archived:data.projects,p=projects.find(p=>p.id===selected)??projects[0];
      return h(React.Fragment,null,
        !data.readiness.readyForProjects?h('div',{className:'fmn-note'},h('strong',null,'开发中，尚未启用接项目'),
          h('p',null,'当前可查看已保存的进度；自动执行与项目启动尚未开放。'),
          data.readiness.blockers?.length?h('ul',{'aria-label':'尚未启用的原因'},data.readiness.blockers.map(b=>h('li',{key:b.id},b.message))):null,
          data.readiness.checks?.length?h('details',null,h('summary',null,'查看配置接线状态'),
            h('ul',null,data.readiness.checks.map(c=>h('li',{key:c.id},c.label,'：',c.configured?'已接入':'未接入'))),
            h('p',{className:'fmn-muted'},'已接入不代表真实项目验收已通过；模型选择也不代表已验证连接或余额。')):null):null,
        archived.length || showArchived?h('nav',{className:'fmn-actions','aria-label':'项目列表'},
          h('button',{type:'button','aria-pressed':!showArchived,onClick:()=>onShowArchived?.(false)},`项目（${data.projects.length}）`),
          h('button',{type:'button','aria-pressed':showArchived,onClick:()=>onShowArchived?.(true)},`已归档（${archived.length}）`)):null,
        projects.length>1?h('label',null,showArchived?'已归档项目':'项目',h('select',{value:p.id,onChange:e=>onSelect(e.target.value)},projects.map(p=>h('option',{key:p.id,value:p.id},p.objective)))):null,
        p?h(Project,{project:p,onRequestAction,pendingAction,onConfirmAction,onCancelAction,actionBusy}):h('section',{className:'fmn-card'},h('h3',null,showArchived?'没有已归档项目':'还没有项目'),
          h('p',null,showArchived?'归档只隐藏列表卡片，项目文件和日志仍保留。':'启用后，在工头对话中描述目标。系统会建议监督名单，由你调整并确认。')));
    }
    function ForemanPanel({load,manage}) {
      const [data,setData]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
      const [selected,setSelected]=React.useState(''),[refresh,setRefresh]=React.useState(0),[updated,setUpdated]=React.useState(null);
      const [showArchived,setShowArchived]=React.useState(false),[pendingAction,setPendingAction]=React.useState(null),[actionBusy,setActionBusy]=React.useState(false),[actionError,setActionError]=React.useState('');
      const actionAbort=React.useRef(null),latest=React.useRef(0);
      React.useEffect(()=>()=>{actionAbort.current?.abort();},[]);
      const confirmAction=async()=>{
        if(!pendingAction || actionBusy || !manage)return;
        const abort=new AbortController();actionAbort.current=abort;setActionBusy(true);setActionError('');
        try {
          const result=await manage(pendingAction,abort.signal);if(abort.signal.aborted)return;
          if((result.revision??0)>=latest.current){latest.current=result.revision??0;setData(result);setUpdated(new Date());}
          setPendingAction(null);
          if(pendingAction.endpoint==='unarchive'){setShowArchived(false);setSelected(pendingAction.project);}
        } catch(e){if(!abort.signal.aborted)setActionError(e.message||'项目操作失败');}
        finally {if(!abort.signal.aborted)setActionBusy(false);if(actionAbort.current===abort)actionAbort.current=null;}
      };
      React.useEffect(()=>{
        const abort=new AbortController();let timer;
        const poll=async()=>{
          setBusy(true);
          try {const result=await load(abort.signal);if(!abort.signal.aborted && (result.revision??0)>=latest.current){latest.current=result.revision??0;setData(result);setError('');setUpdated(new Date());}}
          catch(e){if(!abort.signal.aborted)setError(e.message||'读取失败');}
          finally {if(!abort.signal.aborted){setBusy(false);timer=setTimeout(poll,5000);}}
        };
        void poll();return ()=>{abort.abort();clearTimeout(timer);};
      },[load,refresh]);
      return h('main',{className:'fmn-panel'},h('style',null,css),
        h('header',null,h('div',null,h('h2',null,'新工头模式'),h('p',{className:'fmn-muted'},'执行自主推进，监督按职责把关。')),
          h('button',{type:'button',disabled:busy,onClick:()=>setRefresh(n=>n+1)},busy?'读取中…':'刷新')),
        h('div',{className:'fmn-content'},
          error?h('p',{role:'alert',className:'fmn-alert'},'无法更新进度：',error,data?'。以下为上次成功读取的状态。':''):null,
          actionError?h('p',{role:'alert',className:'fmn-alert'},'项目操作未完成：',actionError):null,
          !data&&!error?empty('正在读取项目状态…'):null,
          data?h(ForemanView,{data,selected,onSelect:id=>{setSelected(id);setPendingAction(null);setActionError('');},showArchived,
            onShowArchived:value=>{setShowArchived(value);setPendingAction(null);setActionError('');},
            onRequestAction:manage?action=>{setPendingAction(action);setActionError('');}:undefined,pendingAction,onConfirmAction:confirmAction,
            onCancelAction:()=>setPendingAction(null),actionBusy}):null,
          updated?h('p',{className:'fmn-muted'},'最后更新 ',h('time',{dateTime:updated.toISOString()},updated.toLocaleTimeString('zh-CN')),' · 面板打开时每 5 秒刷新'):null));
    }
    // One serial feed per mounted overlay. Dismissal is local presentation only;
    // a changed message or an incident disappearing and recurring is shown again.
    function createAlertFeed(load,{schedule=setTimeout,cancel=clearTimeout}={}) {
      let closed=false,started=false,timer,failures=0,current=[],stale=false,listener=()=>{};
      const abort=new AbortController(),hidden=new Map();
      const key=a=>JSON.stringify([a.project,a.id]);
      const signature=a=>JSON.stringify([a.kind,a.message,a.objective]);
      const emit=()=>listener({alerts:current.filter(a=>hidden.get(key(a))!==signature(a)),stale});
      const poll=async()=>{
        try {
          const result=await load(abort.signal);if(closed)return;
          current=result.alerts;stale=false;failures=0;
          const live=new Set(current.map(key));for(const id of hidden.keys())if(!live.has(id))hidden.delete(id);
          emit();
        } catch {if(closed)return;stale=true;failures++;emit();}
        if(!closed)timer=schedule(poll,Math.min(60000,5000*2**Math.min(failures,4)));
      };
      return {
        start(fn){if(closed||started)return;started=true;listener=fn;void poll();},
        dismiss(){for(const a of current)hidden.set(key(a),signature(a));emit();},
        close(){closed=true;abort.abort();cancel(timer);},
      };
    }
    function AlertView({alerts,stale,onDismiss}) {
      if(!alerts.length)return null;
      return h('aside',{'aria-label':'新工头模式待处理事项',className:'fmn-alerts'},h('style',null,css),
        h('div',{role:'status','aria-live':'polite'},h('strong',null,`新工头模式：${alerts.length} 项需要处理`),
          stale?h('p',null,'连接暂时不可用，以下为上次读取的问题。'):null,
          h('ul',null,alerts.slice(0,3).map(a=>h('li',{key:JSON.stringify([a.project,a.id])},
            h('strong',null,a.objective),' · ',label(a.kind),h('div',null,a.message))))),
        h('p',null,'在新工头模式面板查看详情，回到工头对话提出裁决。'),
        h('button',{type:'button',onClick:onDismiss},'暂时收起'),
        h('small',null,'收起不会确认或解决问题；重新打开应用后仍会提醒。'));
    }
    function ForemanAlerts({load}) {
      const [state,setState]=React.useState({alerts:[],stale:false}),feed=React.useRef(null);
      React.useEffect(()=>{
        const active=createAlertFeed(load);feed.current=active;active.start(setState);
        return ()=>{active.close();if(feed.current===active)feed.current=null;};
      },[load]);
      return h(AlertView,{...state,onDismiss:()=>feed.current?.dismiss()});
    }
    function ForemanPanelIcon({size}) {
      return h('span',{style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:size,height:size,fontWeight:700,fontSize:Math.max(12,size-3)}},'工');
    }
    function apply(ctx) {
      const load=async signal=>{
        const result=await ctx.connection.rpc.call('/foreman-next','snapshot',{},signal);
        if(!result.ok)throw new Error(result.error.message);
        return result.value;
      };
      const manage=async({endpoint,project,archiveVersion,controlVersion},signal)=>{
        if(!['archive','unarchive','delete-project','pause','resume','cancel'].includes(endpoint))throw new Error('Unsupported project action');
        const payload=['pause','resume','cancel'].includes(endpoint)?{project,controlVersion}:{project,archiveVersion};
        const result=await ctx.connection.rpc.call('/foreman-next',endpoint,payload,signal);
        if(!result.ok)throw new Error(result.error.message);return result.value;
      };
      ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'foreman-next',inject:()=>({load,manage})},ForemanPanel));
      ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'foreman-next',order:20,label:()=>'新工头模式'},ForemanPanelIcon));
      const loadAlerts=async signal=>{
        const result=await ctx.connection.rpc.call('/foreman-next','alerts',{},signal);
        if(!result.ok)throw new Error(result.error.message);
        return result.value;
      };
      ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'foreman-next-alerts',order:30,inject:()=>({load:loadAlerts})},ForemanAlerts));
    }
    return {apply,inject:['slots','connection'],ForemanPanel,ForemanPanelIcon,ForemanView,ForemanAlerts,AlertView,createAlertFeed,css};
  }
});
