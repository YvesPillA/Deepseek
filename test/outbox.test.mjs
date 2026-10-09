import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JournalStore} from '../src/store.mjs';
import {DeliveryPump} from '../src/outbox.mjs';

const envelope={type:'enqueue',id:'review-1',project:'p',recipient:'supervisor-1',messageId:'message-1',text:'Review immutable snapshot',subject:{kind:'review',round:'round-1',generation:1}};
async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-outbox-test-'));
  let store=await JournalStore.open(dir);
  await store.dispatch({role:'user'},{type:'create',id:'p',objective:'Build project',workspace:'D:/work',reviewers:[{id:'r',name:'Review',responsibility:'test',criteria:'Pass tests'}]});
  await store.dispatchOutbox(envelope);
  t.after(async()=>{await store.close();const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));await fs.rm(target,{recursive:true,force:true});});
  return {get store(){return store;},job:()=>store.snapshot().outbox[envelope.id],reopen:async()=>{await store.close();store=await JournalStore.open(dir);}};
}

test('historical receipts do not cause one full-state clone per delivery on idle drain',async()=>{
  const outbox=Object.fromEntries(Array.from({length:1000},(_,i)=>[String(i),{id:String(i),status:'delivered'}]));
  let snapshots=0;
  const store={snapshot(){snapshots++;return structuredClone({outbox});},dispatchOutbox(){assert.fail('Must retain historical receipts');}};
  const pump=new DeliveryPump(store,{deliver(){assert.fail('Must not resend');},probe(){assert.fail('Must not probe acknowledged delivery');}});
  await pump.drain();await pump.close();
  assert.equal(snapshots,1);
  assert.equal(Object.keys(outbox).length,1000);
});

test('same delivery identity is idempotent, conflicting content is rejected',async t=>{
  const f=await setup(t);const before=f.store.snapshot().revision;
  await f.store.dispatchOutbox(envelope);assert.equal(f.store.snapshot().revision,before);
  await assert.rejects(f.store.dispatchOutbox({...envelope,text:'Different instructions'}),/different content/);
});

test('concurrent drain calls cannot dispatch a job twice; receipts survive reopen',async t=>{
  const f=await setup(t);let deliveries=0;
  const pump=new DeliveryPump(f.store,{async deliver(){deliveries++;},async probe(){return 'unknown';}});
  await Promise.all([pump.drain(),pump.drain(),pump.drain()]);await pump.close();
  assert.equal(deliveries,1);assert.equal(f.job().status,'delivered');
  await f.reopen();assert.equal(f.job().status,'delivered');
  const after=new DeliveryPump(f.store,{async deliver(){deliveries++;}});await after.drain();await after.close();assert.equal(deliveries,1);
});

test('crash between actual send and receipt is reconciled without re-sending',async t=>{
  const f=await setup(t);let deliveries=1;
  await f.store.dispatchOutbox({type:'claim',id:envelope.id,owner:'previous-host'});
  await f.reopen();
  const pump=new DeliveryPump(f.store,{async deliver(){deliveries++;},async probe(){return 'present';}});
  await pump.recover();assert.equal(f.job().status,'uncertain');
  await pump.drain();await pump.close();assert.equal(deliveries,1);assert.equal(f.job().status,'delivered');
});

test('unknown transport outcome is never converted into a timeout retry',async t=>{
  const f=await setup(t);let deliveries=0;
  const pump=new DeliveryPump(f.store,{async deliver(){deliveries++;throw new Error('Connection lost after send');},async probe(){throw new Error('Cannot inspect history');}});
  await pump.drain();await pump.drain();await pump.drain();await pump.close();
  assert.equal(deliveries,1);assert.equal(f.job().status,'uncertain');
  assert.deepEqual(f.store.snapshot().projects.p.milestones,{}); // No approval/denial written by delivery.
  assert.equal(Object.keys(f.store.snapshot().projects.p.rounds).length,0);
});

test('definitive absent evidence permits retry; old transport receipt cannot acknowledge new attempt',async t=>{
  const f=await setup(t);
  await f.store.dispatchOutbox({type:'claim',id:envelope.id,owner:'old'});const old=f.job().token;
  await f.store.dispatchOutbox({type:'uncertain',id:envelope.id,token:old,reason:'interrupted'});
  const pump=new DeliveryPump(f.store,{async probe(){return 'absent';},async deliver(){}});
  await pump.drain();await pump.close();assert.equal(f.job().attempt,2);
  await assert.rejects(f.store.dispatchOutbox({type:'ack',id:envelope.id,token:old}),/Stale/);
  const token=f.job().token;await f.store.dispatchOutbox({type:'complete',id:envelope.id,token});
  const revision=f.store.snapshot().revision;await f.store.dispatchOutbox({type:'complete',id:envelope.id,token});assert.equal(f.store.snapshot().revision,revision);
});

test('cancelled projects do not dispatch queued work',async t=>{
  const f=await setup(t);await f.store.dispatch({role:'user'},{type:'cancel',project:'p'});
  const pump=new DeliveryPump(f.store,{async deliver(){assert.fail('Must not send');}});
  await pump.drain();await pump.close();assert.equal(f.job().status,'cancelled');
});

test('pump close drains its outstanding send and refuses to begin later work',async t=>{
  const f=await setup(t);
  await f.store.dispatchOutbox({...envelope,id:'review-2',messageId:'message-2'});
  let release,started;const waiting=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});let sent=0;
  const pump=new DeliveryPump(f.store,{async deliver(){sent++;started();await waiting;}});
  const draining=pump.drain();await ready;let closed=false;
  const closing=pump.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  release();await Promise.all([draining,closing]);assert.equal(sent,1);
  assert.equal(f.store.snapshot().outbox['review-2'].status,'queued');
  await pump.drain();assert.equal(sent,1);
});

test('journal shutdown rejects new commands but drains already accepted writes',async t=>{
  const f=await setup(t);
  const accepted=f.store.dispatchOutbox({...envelope,id:'review-2',messageId:'message-2'});
  const closing=f.store.close();
  await assert.rejects(f.store.dispatchOutbox({...envelope,id:'review-3',messageId:'message-3'}),/closing/);
  await Promise.all([accepted,closing]);await f.reopen();
  assert.equal(f.store.snapshot().outbox['review-2'].status,'queued');
  assert.equal(f.store.snapshot().outbox['review-3'],undefined);
});
