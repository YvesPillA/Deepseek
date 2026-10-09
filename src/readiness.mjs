import {isReleaseApprovalValid} from './release-approval.mjs';
/** Host assembly diagnostics, not a model-controlled release switch.
 * A configured component is not proof of successful real-project validation.
 * Never return model options, credentials or filesystem configuration to the UI.
 */
export function readinessSnapshot({application,scheduler,sessionContext,userControl,dashboardConnected,projectManagementConnected=false,agentOptions,releaseApproval}) {
  const selected=typeof agentOptions?.provider==='string' && !!agentOptions.provider.trim() &&
    typeof agentOptions?.model==='string' && !!agentOptions.model.trim();
  const status=scheduler?.status()??null;
  const checks=[
    {id:'files',label:'项目文件保护',configured:!!application.filePipelineConfigured,missing:'尚未配置 DSH 与会话目录保护。'},
    {id:'verification',label:application.verificationBackend==='native'?'本机项目验证':'项目验证',configured:!!application.verification,
      missing:application.startupIssue??(application.verificationBackend==='native'?'尚未接入通过启动检查的 DSH 本机验证服务。':'尚未接入通过启动检查的项目验证服务。')},
    {id:'model',label:'执行与监督模型选择',configured:selected,missing:'尚未明确配置子代理使用的模型与服务商。'},
    {id:'sessions',label:'会话持久化',configured:typeof sessionContext?.sessionPersistence?.readFrom==='function' ||
      (typeof sessionContext?.sessionPersistence?.open==='function' && typeof sessionContext?.sessionPersistence?.flush==='function'),missing:'尚未接入持久会话读取服务。'},
    {id:'scheduler',label:'自动调度器',configured:!!status?.started && !status.closed,missing:'自动调度器尚未装配启动。'},
    {id:'confirmation',label:'用户原生确认',configured:!!userControl,missing:'尚未接入用户原生确认服务。'},
    {id:'dashboard',label:'设置面板连接',configured:!!dashboardConnected,missing:'设置面板连接尚未接入。'},
  ];
  const blockers=checks.filter(c=>!c.configured).map(c=>({id:c.id,message:c.missing}));
  const releaseValid=isReleaseApprovalValid(releaseApproval);
  if(!releaseValid)blockers.push({id:'release-validation',message:'正式启用前需宿主批准匹配当前版本及验收证据的发布凭据。'});
  return {
    kernel:true,durableState:true,agentLifecycle:true,filePipelineConfigured:!!application.filePipelineConfigured,
    automaticScheduler:status?.running??false,scheduler:status,
    verificationConfigured:!!application.verification,dependencyProvisioningConfigured:!!application.provisioner,
    verificationBackend:application.verificationBackend??null,
    verificationCapabilities:application.verificationCapabilities?{
      sandbox:application.verificationCapabilities.sandbox,enforcement:application.verificationCapabilities.enforcement,
      networkRestricted:false,readRestricted:false,
    }:null,
    modelSelectionConfigured:selected,checks:checks.map(({id,label,configured})=>({id,label,configured})),blockers,
    immutableArtifacts:false,executorIsolation:false,userInterface:!!dashboardConnected,projectManagementConfigured:!!projectManagementConnected,readyForProjects:releaseValid && blockers.length===0,
  };
}
