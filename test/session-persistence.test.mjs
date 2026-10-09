import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {DshAgentDriver} from '../src/controller.mjs';
import {assertEmptySession} from '../src/session-recovery.mjs';
import {readStoredSession,sessionEvents} from '../src/stored-session.mjs';
const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const load=async name=>import(pathToFileURL(requireDsh.resolve(name)).href);

test('read-only persistence handles close after both successful and failed reads',async()=>{
  let closed=0;
  const persistence={open:async()=>({header:{id:'s'},read:async()=>({events:[]}),close:async()=>{closed++;}})};
  assert.deepEqual(await readStoredSession(persistence,'s'),{meta:{id:'s'},events:[]});
  assert.equal(closed,1);
  persistence.open=async()=>({header:{id:'s'},read:async()=>{throw Error('read failed');},close:async()=>{closed++;}});
  await assert.rejects(readStoredSession(persistence,'s'),/read failed/);
  assert.equal(closed,2);
});

test('installed JSONL handle preserves an empty agent session and a flushed first Inbox record without model calls',async()=>{
  const [{Context},{SessionStore},{default:JsonlSessionPersistence},{AgentRegistry},{LlmRuntime},{ToolRuntime},{SystemPrompt},{AgentLoop},{default:SessionProjectionRegistry}]=await Promise.all([
    load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-session'),load('@deepseek-ai/dsh-session-persistence-jsonl'),load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-llm'),load('@deepseek-ai/dsh-tools'),load('@deepseek-ai/dsh-system-prompt'),load('@deepseek-ai/dsh-agent-loop'),load('@deepseek-ai/dsh-session-projection')]);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-real-session-')),ctx=new Context(),fibers=[];
  let driver,modelCalls=0;
  try {
    for(const [plugin,config] of [[LlmRuntime,{}],[SessionStore,{}],[SessionProjectionRegistry,{}],[SystemPrompt,{}],[ToolRuntime,{mode:'native'}],
      [AgentRegistry,{}],[JsonlSessionPersistence,{root:dir}],[AgentLoop,{agents:[]}]]) {
      const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber;
    }
    ctx.on('llm/stream',async function*(){modelCalls++;throw Error('Offline persistence test forbids model calls');});
    const id=randomUUID();
    driver=new DshAgentDriver(ctx,{bind:()=>()=>{}},{compose:async()=>{}});
    const agent=await driver.create({role:'coordinator'},{sessionId:id,cwd:dir});
    assert.equal(await ctx.sessions.flush(agent.session),true);
    assert.equal(await driver.checkpoint(agent),false);
    await assertEmptySession(ctx.sessionPersistence,id);
    await assert.rejects(assertEmptySession({open:async()=>{throw Error('permission denied');}},id),/permission denied/);
    await driver.send(agent,{id:'first',text:'Test message, no model'});
    const stored=await readStoredSession(ctx.sessionPersistence,id);
    assert.equal(stored.meta.id,id);
    assert(stored.events.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.id==='first')));
    await assert.rejects(assertEmptySession(ctx.sessionPersistence,id),/content exists/);
    assert.equal(modelCalls,0);
    assert(sessionEvents(agent.session).length>=stored.events.length);
  } finally {await driver?.close();for(const fiber of fibers.reverse())await fiber.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
