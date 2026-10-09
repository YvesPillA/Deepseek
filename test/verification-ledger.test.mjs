import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JournalStore} from '../src/store.mjs';
import {verificationRecorder,recoverVerificationContainers,recoverNativeVerifications} from '../src/verification-ledger.mjs';
const name='dsh-foreman-run-12345678-1234-1234-1234-123456789abc',image='sha256:'+'a'.repeat(64),id='b'.repeat(64);
test('durable container reservation survives restart; recovery removes only the verified owned identity',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-container-ledger-'));let store=await JournalStore.open(dir);
  try {
    await store.dispatch({role:'user'},{type:'create',id:'p',objective:'Test',workspace:'D:/example',reviewers:[{id:'r',name:'Review',responsibility:'Quality',criteria:'Pass'}]});
    const recorder=verificationRecorder(store,{project:'p',reference:'sha256:'+'c'.repeat(64),request:{command:'node',args:['--test']}});
    await recorder({name,image,status:'reserved'});await recorder({name,image,id,status:'created'});
    await store.close();store=await JournalStore.open(dir);
    const calls=[];let wrong=true;
    const cli=async args=>{
      calls.push(args);
      if(args[0]==='container')return {exitCode:0,stdout:id};
      if(args[0]==='inspect')return {exitCode:0,stdout:JSON.stringify([{Id:id,Image:image,Name:'/'+name,Config:{Labels:{'dsh-foreman.verification':wrong?'false':'true'}}}])};
      if(args[0]==='rm')return {exitCode:0,stdout:''};
      throw Error('Unexpected');
    };
    await assert.rejects(recoverVerificationContainers(store,cli),/requires attention/);assert(!calls.some(a=>a[0]==='rm'));
    wrong=false;await recoverVerificationContainers(store,cli);assert.deepEqual(calls.at(-1),['rm','-f','-v',id]);
    assert.equal(store.snapshot().verificationContainers[name].status,'removed');
    const count=calls.length;await recoverVerificationContainers(store,cli);assert.equal(calls.length,count);
    assert.equal(store.snapshot().projects.p.denialLimit,3);
  } finally {await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('native reservations survive restart without pretending interruption is cleanup or success',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-native-ledger-'));let store=await JournalStore.open(dir);
  const nativeName='dsh-foreman-native-12345678-1234-1234-1234-123456789abc';
  const directory=path.join(dir,'snapshot'),entry={name:nativeName,backend:'native',directory};
  try {
    await fs.mkdir(directory);await fs.writeFile(path.join(directory,'retained.txt'),'unfinished');
    await store.dispatch({role:'user'},{type:'create',id:'p',objective:'Native',workspace:'D:/example',reviewers:[{id:'r',name:'Review',responsibility:'Quality',criteria:'Pass'}]});
    const recorder=verificationRecorder(store,{backend:'native',project:'p',reference:'sha256:'+'c'.repeat(64),request:{command:'node',args:['--test']}});
    await assert.rejects(recorder({name,image,status:'reserved'}),/backend/);
    await recorder({...entry,status:'reserved'});await recorder({...entry,status:'running'});
    await assert.rejects(recorder({...entry,directory:directory+'-other',status:'removed'}),/ownership/);
    const result={exitCode:0,stdout:'PASS',stderr:'',truncated:false,oomKilled:false};
    await assert.rejects(store.dispatchRuntime({type:'native-verification-result',name:nativeName,result}),/Completed/);
    await store.close();store=await JournalStore.open(dir);
    assert.deepEqual(await recoverNativeVerifications(store),{interrupted:1});
    assert.equal(store.snapshot().verificationRuns[nativeName].status,'interrupted');
    assert.equal(await fs.readFile(path.join(directory,'retained.txt'),'utf8'),'unfinished');
    await assert.rejects(store.dispatchRuntime({type:'native-verification-result',name:nativeName,result}),/Completed/);
    await assert.rejects(store.dispatchRuntime({type:'native-verification-record',entry:{...entry,status:'removed'}}),/lifecycle/);
    assert.deepEqual(await recoverNativeVerifications(store),{interrupted:0});
    assert.equal(store.snapshot().verificationContainers,undefined);
  }finally{await store.close();await fs.rm(dir,{recursive:true,force:true});}
});
