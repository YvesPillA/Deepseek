import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as foreman from '../src/host.mjs';

const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const loadDsh=async name=>import(pathToFileURL(requireDsh.resolve(name)).href);

function response(){
  const state={status:200,headers:{},body:''};
  const chunks=[];
  const sink=Object.assign(new EventEmitter(),{
    writableEnded:false,
    writeHead(status,headers={}){state.status=status;state.headers=headers;return this;},
    write(chunk){chunks.push(Buffer.from(chunk));return true;},
    end(chunk){if(chunk!==undefined)chunks.push(Buffer.from(chunk));state.body=Buffer.concat(chunks).toString();this.writableEnded=true;return this;},
  });
  return {sink,state};
}
function request(url,body,headers={}){
  const stream=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  Object.assign(stream,{url,method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:43823',...body===undefined?{}:{'content-type':'application/json'},...headers}});
  return stream;
}

test('real rc.2 Connection serves only authenticated read-only foreman RPC and removes its route with the host',async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const connectionPlugin=await loadDsh('@deepseek-ai/dsh-client-connection');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-native-rpc-'));
  const ctx=new Context(),routes=[];
  let record;
  ctx.provide('credentials',{modifyRecord:async(_key,mutate)=>{record=await mutate(record)??record;return record;}});
  ctx.provide('webServer',{port:43823,register:route=>{routes.push(route);return()=>{routes.splice(routes.indexOf(route),1);}},tapIndex:()=>()=>{}});
  ctx.provide('agents',{});ctx.provide('sessions',{});
  let host,connection;
  try {
    connection=ctx.plugin({inject:connectionPlugin.inject,apply:connectionPlugin.apply});await connection;
    host=ctx.plugin(foreman,{storageRoot:root});await host;
    const route=routes.find(item=>item.path==='/foreman-next');
    assert(route,'foreman RPC route must be registered by the real Connection');
    const unauthorized=response();
    await route.handler(request('/foreman-next/snapshot',{type:'client-request',rpcId:'unauthorized',method:'snapshot',payload:{}}),unauthorized.sink);
    assert.equal(unauthorized.state.status,401);
    const foreign=response();
    await route.handler(request('/foreman-next/snapshot',{}, {origin:'https://evil.example'}),foreign.sink);
    assert.equal(foreign.state.status,403);
    const service=ctx.get('connection');
    const login=new URL(service.authenticatedUrl('http://127.0.0.1:43823/'));
    const exchanged=response();
    service.authorizeIndex(request(login.pathname+login.search),exchanged.sink);
    const cookie=exchanged.state.headers['set-cookie']?.split(';',1)[0];
    assert(cookie,'authenticated browser cookie must be issued');
    for(const endpoint of ['snapshot','alerts','deliver']){
      const output=response();
      await route.handler(request('/foreman-next/'+endpoint,{type:'client-request',rpcId:endpoint,method:endpoint,payload:{}},{cookie}),output.sink);
      assert.equal(output.state.status,200);
      const frame=JSON.parse(output.state.body);
      assert.equal(frame.result.ok,endpoint!=='deliver');
      if(endpoint==='snapshot')assert.equal(frame.result.value.readiness.readyForProjects,false);
      if(endpoint==='deliver')assert.equal(frame.result.error.code,'bad-request');
    }
    await host.dispose();host=undefined;
    assert(!routes.some(item=>item.path==='/foreman-next'),'host disposal must remove RPC route');
  } finally {
    await host?.dispose();await connection?.dispose();await fs.rm(root,{recursive:true,force:true});
  }
});
