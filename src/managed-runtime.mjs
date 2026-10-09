import {DshAgentDriver} from './controller.mjs';
import {ForemanRuntime} from './runtime.mjs';
import {RuntimeLoop} from './runtime-loop.mjs';

/** Trusted assembly, deliberately not published on foremanNext. A config field
 * cannot override enabled: only the host's integration gate can start models. */
export function createManagedRuntime(application,ctx,{enabled,intervalMs=1000,reviewTimeoutMs=600000,executionTimeoutMs=null,agentOptions}={}) {
  if(!Number.isSafeInteger(reviewTimeoutMs)||reviewTimeoutMs<1||reviewTimeoutMs>86400000)throw new Error('Invalid review timeout');
  if(executionTimeoutMs!==null && (!Number.isSafeInteger(executionTimeoutMs)||executionTimeoutMs<1||executionTimeoutMs>86400000))throw new Error('Invalid execution timeout');
  const options=structuredClone(agentOptions);
  return new RuntimeLoop({enabled,intervalMs,create:()=>{
    if(!application.filePipelineConfigured)throw new Error('Protected workspace pipeline is not configured');
    if(typeof ctx.sessionPersistence?.open!=='function' && typeof ctx.sessionPersistence?.readFrom!=='function')throw new Error('Durable session persistence is not configured');
    const driver=new DshAgentDriver(ctx,application.controller,{compose:application.compose});
    return new ForemanRuntime(application.store,application.controller,driver,ctx,{model:options,reviewTimeoutMs,executionTimeoutMs});
  }});
}
