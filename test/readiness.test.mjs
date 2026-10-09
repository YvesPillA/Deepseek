import test from 'node:test';
import assert from 'node:assert/strict';
import {readinessSnapshot} from '../src/readiness.mjs';

test('readiness lists missing assembly without exposing configuration or opening the release gate',()=>{
  const value=readinessSnapshot({application:{},agentOptions:{apiKey:'PRIVATE_KEY',model:'only-model'}});
  assert.equal(value.readyForProjects,false);
  assert.equal(value.modelSelectionConfigured,false);
  assert.deepEqual(value.blockers.map(b=>b.id),['files','verification','model','sessions','scheduler','confirmation','dashboard','release-validation']);
  assert(!JSON.stringify(value).includes('PRIVATE_KEY'));
});

test('complete assembly still requires release validation and tracks removed services',()=>{
  const input={application:{filePipelineConfigured:true,verification:{},provisioner:{}},
    scheduler:{status:()=>({started:true,closed:false,running:false})},sessionContext:{sessionPersistence:{readFrom(){}}},
    userControl:{},dashboardConnected:true,agentOptions:{provider:'deepseek',model:'deepseek-flash',apiKey:'PRIVATE_KEY',readyForProjects:true}};
  const complete=readinessSnapshot(input);
  assert(complete.checks.every(c=>c.configured));assert.equal(complete.automaticScheduler,false);
  assert.deepEqual(complete.blockers.map(b=>b.id),['release-validation']);assert.equal(complete.readyForProjects,false);
  assert(!JSON.stringify(complete).includes('PRIVATE_KEY'));
  input.userControl=undefined;input.sessionContext=undefined;input.dashboardConnected=false;
  input.scheduler={status:()=>({started:true,closed:true,running:false})};
  assert.deepEqual(readinessSnapshot(input).blockers.map(b=>b.id),['sessions','scheduler','confirmation','dashboard','release-validation']);
});

test('native readiness describes partial project validation without leaking executable paths',()=>{
  const value=readinessSnapshot({application:{filePipelineConfigured:true,verification:{},verificationBackend:'native',
    verificationCapabilities:{backend:'native',sandbox:'workspace-write',enforcement:'partial',runtimeNode:'C:/PRIVATE/runtime.exe'}},
    agentOptions:{provider:'deepseek',model:'deepseek-flash'}});
  assert.equal(value.verificationBackend,'native');
  assert.equal(value.checks.find(check=>check.id==='verification').label,'本机项目验证');
  assert.deepEqual(value.verificationCapabilities,{sandbox:'workspace-write',enforcement:'partial',networkRestricted:false,readRestricted:false});
  assert.equal(value.executorIsolation,false);assert.equal(value.readyForProjects,false);
  assert(!JSON.stringify(value).includes('PRIVATE'));
});

test('native startup failure is an actionable validation blocker and leaves release closed',()=>{
  const issue='DSH 本机验证服务未通过启动检查';
  const value=readinessSnapshot({application:{verificationBackend:'native',startupIssue:issue}});
  assert.equal(value.blockers.find(blocker=>blocker.id==='verification').message,issue);
  assert.equal(value.readyForProjects,false);
});
