import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as hostPlugin from '../src/host.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const load=async name=>import(pathToFileURL(requireDsh.resolve(name)).href);

test('current preset registry mounts the unchanged YAML composition and resolves the package outer export',{timeout:5000},async()=>{
  const {Context}=await load('@deepseek-ai/cordis');
  const {Loader}=await load('@deepseek-ai/cordis-plugin-loader');
  const {default:AgentPresetRegistry,leakedServices,livePresetMounts,entryListProblem,standingMountFor}=await load('@deepseek-ai/dsh-agent-preset-registry');
  const {createScope}=await load('@deepseek-ai/dsh-scope');
  const {default:SessionProjectionRegistry}=await load('@deepseek-ai/dsh-session-projection');
  const {ToolRuntime}=await load('@deepseek-ai/dsh-tools');
  const {SystemPrompt}=await load('@deepseek-ai/dsh-system-prompt');
  const {UserQuestionService}=await load('@deepseek-ai/dsh-user-questions');
  const {Session}=await load('@deepseek-ai/dsh-session');
  const presetPath=path.join(root,'presets/foreman-next/preset.yml');
  const compositionPath=path.join(root,'presets/foreman-next/agent.cordis.yml');
  const original=await fs.readFile(presetPath,'utf8'),originalComposition=await fs.readFile(compositionPath,'utf8');
  const yaml=requireDsh('yaml');
  const preset={id:'foreman-next',...yaml.parse(original),plugins:yaml.parse(originalComposition)};
  assert.match(preset.name,/工头/);assert.equal(entryListProblem(preset.plugins),undefined);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-preset-loader-')),ctx=new Context();
  const agent={id:'loader-agent',session:Session.create('loader-agent')};
  ctx.provide('agents',{get:id=>id===agent.id?agent:undefined,roots:()=>[agent]});ctx.provide('sessions',{});
  const dependencies=[ctx.plugin(Loader,{baseUrl:pathToFileURL(path.join(root,'package.json')).href}),ctx.plugin(SessionProjectionRegistry,{}),ctx.plugin(ToolRuntime,{}),ctx.plugin(SystemPrompt,{}),ctx.plugin(UserQuestionService,{})];await Promise.all(dependencies);
  const registry=ctx.plugin(AgentPresetRegistry,{default:'foreman-next'});await registry;
  const host=ctx.plugin(hostPlugin,{storageRoot:dir});await host;
  const scope=createScope(ctx,agent);agent.ctx=scope.ctx.extend({agent});let unregister;
  try {
    unregister=await ctx.agentPresets.register(preset);
    assert.equal((await ctx.agentPresets.resolve(preset.id)).broken,undefined);
    await ctx.agentPresets.mount(scope.ctx,preset.id);
    const mounted=standingMountFor(agent.ctx);assert(mounted);assert.deepEqual(leakedServices(ctx,mounted.fiber),[]);
    const outcome=await agent.ctx.get('tools').execute({callId:'preset-read',name:'foreman_status',arguments:{},agent,signal:new AbortController().signal});
    assert.equal(outcome.isError,false,JSON.stringify(outcome));
    assert.equal(ctx.get('foremanNext').readiness().readyForProjects,false);
  } finally {
    await scope.dispose();await unregister?.();await host.dispose();await registry.dispose();for(const fiber of dependencies.reverse())await fiber.dispose();
    await fs.rm(dir,{recursive:true,force:true});
  }
  assert.equal(await fs.readFile(presetPath,'utf8'),original,'Mount and teardown must not rewrite preset YAML');
  assert.equal(await fs.readFile(compositionPath,'utf8'),originalComposition);
});
