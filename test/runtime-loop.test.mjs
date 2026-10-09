import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeLoop} from '../src/runtime-loop.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
test('maintenance stops and drains before mutation, excludes concurrent maintenance, then restarts',async()=>{
  let release,stopped=false,inside=false,finish;const time=clock();
  const loop=new RuntimeLoop({...time,enabled:()=>true,create:()=>({tick:()=>new Promise(r=>release=r),close:async()=>{stopped=true;release();}})});
  loop.start();time.fire();await flush();
  const recovery=loop.runStopped(async()=>{assert(stopped);inside=true;await new Promise(r=>finish=r);});
  await flush();assert(inside);assert.equal(time.pending.size,0);
  await assert.rejects(loop.runStopped(()=>{}),/unavailable/);finish();await recovery;await flush();
  assert.equal(time.pending.size,1);await loop.close();
});
function clock(){let id=0;const pending=new Map();return {pending,schedule:(fn,ms)=>{pending.set(++id,{fn,ms});return id;},cancel:id=>pending.delete(id),fire:()=>{const [id,item]=pending.entries().next().value;pending.delete(id);item.fn();return item.ms;}};}
test('scheduler gate makes zero runtime calls until enabled and never overlaps slow ticks',async()=>{
  const time=clock();let enabled=false,creates=0,ticks=0,closed=0,release;
  const loop=new RuntimeLoop({...time,enabled:()=>enabled,create:()=>{creates++;return {tick:()=>{ticks++;return new Promise(r=>release=r);},close:async()=>{closed++;}};}});
  loop.start();loop.start();time.fire();await flush();assert.equal(creates,0);assert.equal(time.pending.size,1);
  enabled=true;time.fire();await flush();assert.equal(creates,1);assert.equal(ticks,1);assert.equal(time.pending.size,0);
  release();await flush();assert.equal(time.pending.size,1);
  enabled=false;time.fire();await flush();assert.equal(closed,1);assert.equal(ticks,1);
  await loop.close();assert.equal(time.pending.size,0);assert.throws(()=>loop.start(),/closed/);
});
test('failed ticks back off and a successful tick clears the diagnostic',async()=>{
  const time=clock();let fail=true;
  const loop=new RuntimeLoop({...time,intervalMs:100,enabled:()=>true,create:()=>({tick:async()=>{if(fail)throw new Error('Unavailable');},close:async()=>{}})});
  loop.start();time.fire();await flush();assert.equal(loop.status().error,'Unavailable');
  assert.equal(time.fire(),200);await flush();assert.equal(time.fire(),400);await flush();
  fail=false;time.fire();await flush();assert.equal(loop.status().error,null);assert.equal([...time.pending.values()][0].ms,100);
  await loop.close();
});
test('close requests cancellation before waiting on an active tick and drains exactly once',async()=>{
  const time=clock();let release,closed=0;
  const loop=new RuntimeLoop({...time,enabled:()=>true,create:()=>({tick:()=>new Promise(r=>release=r),close:async()=>{closed++;release();}})});
  loop.start();time.fire();await flush();const first=loop.close();assert.equal(loop.close(),first);await first;
  assert.equal(closed,1);assert.equal(time.pending.size,0);assert.equal(loop.status().running,false);
});
test('factory finishing after shutdown is closed without starting a tick',async()=>{
  const time=clock();let resolveFactory,ticks=0,closed=0;
  const loop=new RuntimeLoop({...time,enabled:()=>true,create:()=>new Promise(r=>resolveFactory=r)});
  loop.start();time.fire();await flush();const closing=loop.close();
  resolveFactory({tick:async()=>ticks++,close:async()=>closed++});await closing;
  assert.equal(ticks,0);assert.equal(closed,1);assert.equal(time.pending.size,0);
});
