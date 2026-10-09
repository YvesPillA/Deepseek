import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {selectDshRuntime} from '../scripts/dsh-runtime.mjs';
import {initializeNativeModelChat,nativeModelChatTitle,nativeModelChatWelcome,nativeModelFixtureComposerContext} from '../scripts/native-model-chat-entry.mjs';
import {createOuterComposer} from '../src/outer-tools.mjs';

test('actual 0.2 welcome starts a visible native turn without fetch, then removes its terminal reply', {timeout:15000},async t=>{
  const runtime=selectDshRuntime();if(runtime.version!=='0.2.0-rc.2'){t.skip('Actual 0.2 native chat contract');return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-model-chat-entry-'));
  const [{Context},{SessionStore},{default:SessionProjections},{default:Persistence},{AgentRegistry},{LlmRuntime},{ToolRuntime},{SystemPrompt},{AgentLoop},{SessionTitleService}]=await Promise.all([
    runtime.load('cordis'),runtime.load('dsh-session'),runtime.load('dsh-session-projection'),runtime.load('dsh-session-persistence-jsonl'),runtime.load('dsh-agent'),runtime.load('dsh-llm'),runtime.load('dsh-tools'),runtime.load('dsh-system-prompt'),runtime.load('dsh-agent-loop'),runtime.load('dsh-session-title')]);
  const {ApiSessionList}=await import(pathToFileURL(path.join(path.dirname(runtime.requireDsh.resolve('@deepseek-ai/dsh-api-session-controller')),'types/list.js')).href);
  const ctx=new Context(),fibers=[],originalFetch=globalThis.fetch;let handle,fetches=0,subsequent=0;
  globalThis.fetch=async()=>{fetches++;throw Error('Fixture refuses API');};
  try {
    for(const [plugin,config] of [[SessionStore,{}],[SessionProjections,{}],[Persistence,{root:path.join(root,'sessions')}],[AgentRegistry,{}],[LlmRuntime,{}],[ToolRuntime,{mode:'native'}],[SystemPrompt,{}],[AgentLoop,{agents:[]}],[SessionTitleService,{fallbackMaxWords:10,fallbackMaxBytes:100,maxTitleBytes:200}]]){
      const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber;
    }
    const list=new ApiSessionList(ctx);
    handle=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:root},agentOptions:{provider:'offline-entry',model:'offline-entry'},setup:async(agentCtx,agent)=>{
      await createOuterComposer({}, {snapshot:()=>({})})(nativeModelFixtureComposerContext(agentCtx,root),{contains:candidate=>candidate===agent});
    }});
    assert.equal(list.summaryFor(handle.agent.session).blank,true);
    const entry=await initializeNativeModelChat(ctx,handle.agent);
    assert.deepEqual(entry,{seedingTurns:1,title:nativeModelChatTitle});
    const summary=list.summaryFor(handle.agent.session);
    assert.equal(summary.blank,false);assert.equal(summary.agentAvailable,true);
    assert.equal(summary.projections.values.title,nativeModelChatTitle);
    const events=handle.agent.session.snapshotEvents();
    const systemMessages=events.filter(event=>event.type==='system/message');
    assert.equal(systemMessages.length,1);
    assert(JSON.stringify(systemMessages[0].data.message).includes('你是工头模式的外层主代理'));
    assert(JSON.stringify(systemMessages[0].data.message).includes('唯一项目 ID 是 chat'));
    assert(JSON.stringify(systemMessages[0].data.message).includes('开局 create 的 id 必须为 chat'));
    assert(events.some(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.text===nativeModelChatWelcome)));
    await assert.rejects(initializeNativeModelChat(ctx,handle.agent),/fresh outer/);
    // A subsequent user turn reaches the normal model path after the welcome
    // disposer. This locally supplied response is not a paid-model result.
    ctx.on('llm/stream',async function*(){subsequent++;yield {type:'finish',reason:{kind:'stop'}};});
    handle.agent.followup({id:randomUUID(),role:'user',content:[{type:'text',text:'Real user requirement'}],source:{kind:'user'}});
    await handle.agent.whenIdle();
    assert.equal(subsequent,1);assert.equal(fetches,0);
    assert.equal(handle.agent.session.snapshotEvents().filter(event=>event.type==='turn/start').length,2);
  } finally {await handle?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();globalThis.fetch=originalFetch;await fs.rm(root,{recursive:true,force:true});}
});
