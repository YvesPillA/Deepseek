import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateDelta} from '../src/state-delta.mjs';

function reconstruct(before,response) {
  if(response._read.full) {const result=structuredClone(response);delete result._read;return result;}
  const result=structuredClone(before);
  for(const change of response.changes) {
    let parent=result;for(const key of change.path.slice(0,-1))parent=parent[key];
    const key=change.path.at(-1);
    if(change.op==='remove')delete parent[key];
    else Object.defineProperty(parent,key,{value:structuredClone(change.value),writable:true,enumerable:true,configurable:true});
  }
  return result;
}
test('literal object patches and atomic arrays reconstruct every full JSON state without losing requirements',()=>{
  const read=createStateDelta(),states=[
    {padding:'long locked standard '.repeat(40),reviewers:[{id:'r',criteria:'locked'}],tasks:{t:{status:'running',failures:[]}},rounds:{}},
    {padding:'long locked standard '.repeat(40),reviewers:[{id:'r',criteria:'locked'}],tasks:{t:{status:'failed',failures:['exact failure']}},rounds:{r:{votes:{r:{pass:false,findings:'specific rework'}}}}},
    {padding:'long locked standard '.repeat(40),reviewers:[{id:'r',criteria:'locked'}],tasks:{},rounds:{r:{votes:{r:{pass:false,findings:'specific rework'}},generation:2}}},
  ];
  let cursor,baseline;
  for(const state of states) {
    const response=read(state,cursor);baseline=reconstruct(baseline,response);assert.deepEqual(baseline,state);
    if(cursor) {assert.equal(response._read.full,false);assert.equal(response._read.baseCursor,cursor);}
    cursor=response._read.cursor;
  }
  const unchanged=read(states.at(-1),cursor);assert.equal(unchanged._read.full,false);assert.deepEqual(unchanged.changes,[]);
});
test('unknown, cross-instance, evicted and oversized baselines fall back to complete state',()=>{
  const read=createStateDelta({maxEntries:2,maxBytes:2048}),state=n=>({locked:'criteria '.repeat(20),n});
  const a=read(state(1)),b=read(state(2),a._read.cursor);read(state(3),b._read.cursor);
  assert.equal(read(state(4),a._read.cursor)._read.full,true);
  assert.equal(read(state(4),'f'.repeat(64))._read.full,true);
  assert.equal(createStateDelta()(state(4),b._read.cursor)._read.full,true);
  const large=read({locked:'x'.repeat(3000)});assert.equal(read({locked:'x'.repeat(3000)},large._read.cursor)._read.full,true);
  assert.throws(()=>createStateDelta({maxEntries:0}),/bounds/);
});
test('cache captures detached JSON, large deltas choose full state, and literal prototype keys stay data',()=>{
  const read=createStateDelta(),state={padding:'a'.repeat(1000),item:{status:'running'}},first=read(state);
  state.item.status='failed';const next=read(state,first._read.cursor);
  assert.deepEqual(reconstruct(reconstruct(null,first),next),state);
  assert.equal(read({padding:'b'.repeat(1000),item:{status:'finished'}},next._read.cursor)._read.full,true);
  const base=read(JSON.parse('{"padding":"'+ 'x'.repeat(1000)+'","__proto__":{"value":1}}'));
  const updated=JSON.parse('{"padding":"'+ 'x'.repeat(1000)+'","__proto__":{"value":2},"constructor":"literal"}');
  assert.deepEqual(reconstruct(reconstruct(null,base),read(updated,base._read.cursor)),updated);
  assert.equal({}.value,undefined);
});
