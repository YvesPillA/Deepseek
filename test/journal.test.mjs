import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {initialState,transition} from '../src/core.mjs';
import {JournalStore} from '../src/store.mjs';
import {encodeJournal,decodeJournal} from '../src/journal-codec.mjs';
import {DshTransport} from '../src/dsh-transport.mjs';
import {syncCoordinatorQueue} from '../src/coordinator-scheduler.mjs';

const create={type:'create',id:'p',objective:'Build',workspace:'D:/project',reviewers:[{id:'r',name:'Review',responsibility:'Quality',criteria:'Pass'}]};
const user={role:'user'};
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-journal-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return {dir,file:path.join(dir,'state.jsonl')};
}

test('shared read snapshots are immutable, reused until commit, and cannot alter stored or historical state',async t=>{
  const {dir}=await fixture(t),store=await JournalStore.open(dir);
  try {
    await store.dispatch(user,create);
    let copies=0;const snapshot=store.snapshot.bind(store);store.snapshot=()=>{copies++;return snapshot();};
    const first=store.readSnapshot();
    for(let i=0;i<1000;i++)assert.equal(store.readSnapshot(),first);
    assert.equal(copies,1);
    assert.throws(()=>{first.projects.p.objective='Forged';},TypeError);
    assert.throws(()=>first.projects.p.reviewers.push({id:'forged'}),TypeError);
    const detached=store.snapshot();detached.projects.p.objective='Local edit';
    assert.equal(store.readSnapshot().projects.p.objective,'Build');
    await assert.rejects(store.dispatch(user,{type:'configure',project:'p',objective:''}));
    assert.equal(store.readSnapshot(),first);
    await store.dispatchRuntime({type:'incident',project:'p',key:'absent',message:null});
    assert.equal(store.readSnapshot(),first);
    await store.dispatch(user,{type:'configure',project:'p',objective:'New rules'});
    assert.notEqual(store.readSnapshot(),first);
    assert.equal(first.projects.p.objective,'Build');
    assert.equal(store.readSnapshot().projects.p.objective,'New rules');
  }finally{await store.close();}
});

test('cached read view refreshes when authorization changes during async agent resolution',async t=>{
  const {dir}=await fixture(t),store=await JournalStore.open(dir);
  try {
    await store.dispatch(user,create);await syncCoordinatorQueue(store);
    const job=Object.values(store.readSnapshot().outbox)[0];
    let entered,release;
    const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
    const transport=new DshTransport(store,{send(){assert.fail('Revoked message must not send');}}, {},{
      async resolve(){entered();await waiting;return {id:'agent'};},lookup(){return null;}
    });
    const delivery=transport.deliver(job);
    const rejected=assert.rejects(delivery,/authorization expired during agent creation/);
    await started;
    try {await store.dispatch(user,{type:'configure',project:'p',objective:'Changed during wait'});}
    finally{release();}
    await rejected;
  }finally{await store.close();}
});

test('delta replay preserves nested changes, audit appends, removals, arrays and special own keys',()=>{
  let state={...initialState(),extra:JSON.parse('{"list":[{"value":1},2],"remove":true,"__proto__":{"safe":1}}')};
  for(const extra of [
    JSON.parse('{"list":[{"value":2},2,3],"__proto__":{"safe":2},"new":null}'),
    {list:[],new:[1,2]}, {list:[{x:1}],new:'changed'}, {list:null}
  ]) {
    const next={...state,revision:state.revision+1,extra};
    const record=JSON.parse(JSON.stringify(encodeJournal(state,next))),before=structuredClone(state);
    assert.deepEqual(decodeJournal(state,record),next);assert.deepEqual(state,before);
    state=next;
  }
  assert.equal({}.safe,undefined);
});

test('legacy full states and new deltas reopen together; interrupted tail loses no committed revision',async t=>{
  const {dir,file}=await fixture(t);
  const first=transition(initialState(),user,create);
  const second=transition(first,user,{type:'configure',project:'p',objective:'Updated'});
  const legacy=JSON.stringify(first)+'\n'+JSON.stringify(second)+'\n';
  await fs.writeFile(file,legacy);
  let store=await JournalStore.open(dir);let expected;
  try {expected=await store.dispatch(user,{type:'configure',project:'p',objective:'Newest'});}finally{await store.close();}
  const committed=await fs.readFile(file,'utf8');assert(committed.startsWith(legacy));
  assert.equal(JSON.parse(committed.trim().split('\n').at(-1)).format,'foreman-delta-v1');
  await fs.appendFile(file,'{"format":"foreman-delta-v1","broken');
  store=await JournalStore.open(dir);
  try {assert.deepEqual(store.snapshot(),expected);assert.equal(await fs.readFile(file,'utf8'),committed);
    expected=await store.dispatch(user,{type:'configure',project:'p',objective:'After restart'});
  }finally{await store.close();}
  store=await JournalStore.open(dir);try{assert.deepEqual(store.snapshot(),expected);}finally{await store.close();}
});

test('committed corrupt, reordered and missing delta records are rejected without repairing the file',async t=>{
  const {dir,file}=await fixture(t);
  let store=await JournalStore.open(dir);
  try {await store.dispatch(user,create);for(const objective of ['Second','Third'])await store.dispatch(user,{type:'configure',project:'p',objective});}
  finally{await store.close();}
  const lines=(await fs.readFile(file,'utf8')).trim().split('\n');
  const altered=JSON.parse(lines[1]);altered.changes[0].value='tampered';
  for(const records of [[lines[0],JSON.stringify(altered),lines[2]],[lines[0],lines[2],lines[1]],[lines[0],lines[2]]]) {
    const bytes=records.join('\n')+'\n';await fs.writeFile(file,bytes);
    await assert.rejects(JournalStore.open(dir),/Corrupt journal/);
    assert.equal(await fs.readFile(file,'utf8'),bytes);
  }
});

test('streaming replay preserves multibyte records spanning chunks and truncates only an unfinished tail',async t=>{
  const {dir,file}=await fixture(t);let store=await JournalStore.open(dir),expected;
  try {expected=await store.dispatch(user,{...create,objective:'汉😀'.repeat(6000),reviewers:[{...create.reviewers[0],criteria:'汉😀'.repeat(6000)}]});}
  finally{await store.close();}
  const committed=await fs.readFile(file);assert(committed.length>64*1024);
  await fs.appendFile(file,'{"unfinished":"'+ '汉😀'.repeat(15000));
  store=await JournalStore.open(dir);
  try {assert.deepEqual(store.snapshot(),expected);assert.deepEqual(await fs.readFile(file),committed);}
  finally{await store.close();}
});

test('even checksummed malformed delta paths cannot traverse inherited properties',()=>{
  const body={format:'foreman-delta-v1',baseRevision:0,revision:1,changes:[{op:'set',path:['projects','__proto__','polluted'],value:true}]};
  const checksum=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  assert.throws(()=>decodeJournal(initialState(),{...body,checksum}),/Corrupt journal/);
  assert.equal({}.polluted,undefined);
});

test('growing delivery history is persisted once instead of repeating every previous envelope',async t=>{
  const {dir,file}=await fixture(t);let store=await JournalStore.open(dir),baseline=0,expected;
  try {
    await store.dispatch(user,create);
    for(let i=0;i<200;i++) {
      expected=await store.dispatchOutbox({type:'enqueue',id:'job-'+i,project:'p',recipient:'reviewer',messageId:'message-'+i,text:'Review '+ 'x'.repeat(500),subject:{kind:'review',round:'r',generation:1}});
      baseline+=Buffer.byteLength(JSON.stringify(expected)+'\n');
    }
  }finally{await store.close();}
  const actual=(await fs.stat(file)).size;
  assert(actual<baseline/20,`${actual} delta bytes vs ${baseline} full-state bytes`);
  t.diagnostic(`200 deliveries: ${actual} bytes; previous full-state strategy: ${baseline} bytes`);
  store=await JournalStore.open(dir);try {assert.deepEqual(store.snapshot(),expected);}finally{await store.close();}
});
