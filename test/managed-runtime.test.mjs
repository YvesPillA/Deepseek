import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openApplication} from '../src/application.mjs';
import {createManagedRuntime} from '../src/managed-runtime.mjs';
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){if(Date.now()>deadline)throw new Error('Scheduler did not progress');await new Promise(r=>setTimeout(r,10));}}

test('managed periodic runtime progresses from a durable plan to its supervisor without manual ticks',{timeout:5000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-managed-'));
  for(const d of ['dsh','sessions','work'])await fs.mkdir(path.join(root,d));
  const app=await openApplication({storageRoot:path.join(root,'journal'),dshHome:path.join(root,'dsh'),sessionRoot:path.join(root,'sessions')});
  const live=new Map(),disk=new Map();let sends=0;
  const ctx={agents:{create:async options=>{
    assert.deepEqual(options.agentOptions,{model:'offline-test'});
    const agent={id:options.sessionId,session:{id:options.sessionId,events:[]},followup:message=>{
      sends++;agent.session.events.push({type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[message]}});
    }};
    const setup=await options.setup({agent});setup.commit();live.set(agent.id,agent);
    return {agent,dispose:async()=>{live.delete(agent.id);}};
  }},sessions:{flush:async session=>{disk.set(session.id,structuredClone(session.events));return true;}},
  sessionPersistence:{readFrom:async id=>({meta:{id},events:structuredClone(disk.get(id)??[])})}};
  // Model/tool execution remains mocked here; real scoped-tool contracts are
  // covered separately. All state, scheduling, delivery and persistence is real.
  const loop=createManagedRuntime({...app,compose:async()=>{}},ctx,{enabled:()=>true,intervalMs:50,agentOptions:{model:'offline-test'}});
  try {
    await app.controller.userCommand({type:'create',id:'p',workspace:path.join(root,'work'),objective:'Offline program',reviewers:[{id:'r',name:'Quality',responsibility:'Behavior',criteria:'Pass'}]});
    loop.start();
    const find=role=>[...live.values()].find(a=>app.controller.identity(a).role===role);
    await until(()=>!!find('coordinator'));const boss=find('coordinator');
    await app.controller.modelCommand(boss,{type:'propose',definition:{id:'a',title:'Program',criteria:'Works',deps:[]}});
    await until(()=>!!find('reviewer') && Object.values(app.store.snapshot().outbox??{}).some(j=>j.subject.kind==='review'&&j.status==='delivered'));
    assert.equal(Object.values(app.controller.view('p').rounds)[0].status,'open');assert(sends>=2);
    await loop.close();assert.equal(live.size,0);assert.equal(loop.status().closed,true);
  } finally {await loop.close();await app.close();await fs.rm(root,{recursive:true,force:true});}
});
