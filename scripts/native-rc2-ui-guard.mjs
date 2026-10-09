// Isolated rc.2 browser fixture: fail closed before any model network request.
import fs from 'node:fs/promises';
import path from 'node:path';

export const name='foreman-native-rc2-ui-guard';
export async function apply(ctx,{root}) {
  const resolved=await fs.realpath(root);
  if(path.dirname(resolved)!==path.resolve('C:/example/foreman-tests') || !/^native-rc2-ui-[a-zA-Z0-9_-]+$/.test(path.basename(resolved)))throw Error('Invalid offline fixture root');
  if(await fs.readFile(path.join(resolved,'fixture-marker'),'utf8')!=='foreman-native-rc2-ui-offline')throw Error('Missing offline fixture marker');
  const reportPath=path.join(resolved,'network-guard.json');
  const report={modelTurnsBlocked:0,externalFetchesBlocked:0};
  const save=()=>fs.writeFile(reportPath,JSON.stringify(report,null,2));
  await save();
  const diagnostic={hostPresent:false,dashboardConnected:false,clientModules:null,presets:null};
  const saveDiagnostic=()=>fs.writeFile(path.join(resolved,'fixture-status.json'),JSON.stringify(diagnostic,null,2));
  await saveDiagnostic();
  ctx.inject(['foremanNext'],child=>{
    diagnostic.hostPresent=true;void saveDiagnostic();
    const timer=setTimeout(()=>{diagnostic.dashboardConnected=child.foremanNext.readiness().checks.find(c=>c.id==='dashboard')?.configured===true;void saveDiagnostic();},1000);
    child.effect(()=>()=>clearTimeout(timer));
  });
  ctx.inject(['clientModules'],child=>{
    const timer=setTimeout(()=>{diagnostic.clientModules=child.clientModules.graph().entries.map(entry=>entry.id);void saveDiagnostic();},1000);
    child.effect(()=>()=>clearTimeout(timer));
  });
  ctx.inject(['agentPresets'],child=>{
    const timer=setTimeout(async()=>{diagnostic.presets=(await child.agentPresets.list()).map(({id,broken})=>({id,...broken?{broken}:{}}));await saveDiagnostic();},1000);
    child.effect(()=>()=>clearTimeout(timer));
  });
  const prior=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
    const address=new URL(input instanceof Request?input.url:String(input));
    if(['http:','https:'].includes(address.protocol) && !['127.0.0.1','localhost','[::1]'].includes(address.hostname)){
      report.externalFetchesBlocked++;await save();throw Error('Offline UI fixture blocks external fetch');
    }
    return prior(input,options);
  };
  ctx.effect(()=>()=>{globalThis.fetch=prior;});
  ctx.on('llm/stream',async function*(){report.modelTurnsBlocked++;await save();throw Error('Offline UI fixture blocks model turns');});
}
