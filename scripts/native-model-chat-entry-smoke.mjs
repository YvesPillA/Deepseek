import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {selectDshRuntime} from './dsh-runtime.mjs';
import {initializeNativeModelChat} from './native-model-chat-entry.mjs';

export const name='native-model-chat-entry-smoke';
export const inject=['agents','sessions','sessionTitle','workspaceRegistry','sessionController'];
export async function apply(ctx,{root}) {
  root=await fs.realpath(root);
  assert.equal(path.dirname(root),path.resolve('C:/example/foreman-tests'));
  assert.match(path.basename(root),/^native-chat-entry-[a-zA-Z0-9_-]+$/);
  assert.equal(path.resolve(process.env.DSH_HOME??''),path.join(root,'home'));
  assert.equal(await fs.readFile(path.join(root,'fixture-marker'),'utf8'),'isolated-native-chat-entry-zero-api');
  const originalFetch=globalThis.fetch;let outgoing=0,modelRequests=0;
  globalThis.fetch=async()=>{outgoing++;throw Error('Offline chat entry refuses outgoing fetch');};
  const handle=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:path.join(root,'work')},agentOptions:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:4096}});
  ctx.effect(()=>async()=>{await handle.dispose();globalThis.fetch=originalFetch;});
  const chatEntry=await initializeNativeModelChat(ctx,handle.agent);
  ctx.on('llm/stream',async function*(){modelRequests++;throw Error('Offline chat entry refuses user model requests');});
  const workspace=await ctx.get('workspaceRegistry').create(path.join(root,'work'),chatEntry.title);
  await workspace.attachSession(handle.agent.id);
  const summary=(await ctx.get('sessionController').list()).items.find(item=>item.sessionId===handle.agent.id);
  assert(summary);assert.equal(summary.blank,false);assert.equal(summary.agentAvailable,true);
  assert.equal(outgoing,0);assert.equal(modelRequests,0);
  const report={root,runtime:{root:selectDshRuntime().root,version:selectDshRuntime().version},status:'registered',session:handle.agent.id,workspaceId:workspace.id,chatEntry,summary,modelRequests,outgoing};
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
}
