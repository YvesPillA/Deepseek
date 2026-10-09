import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {JournalStore} from '../src/store.mjs';
function child(directory) {
  const process=fork(fileURLToPath(new URL('./fixtures/hold-journal.mjs',import.meta.url)),[directory],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let stderr='';process.stderr.on('data',b=>stderr+=b);
  const exited=new Promise(resolve=>process.once('exit',resolve));
  const ready=new Promise((resolve,reject)=>{process.once('message',resolve);process.once('error',reject);process.once('exit',code=>reject(new Error(`Fixture exited ${code}: ${stderr}`)));});
  return {ready,stop:async()=>{if(process.exitCode===null && process.signalCode===null)process.kill();await exited;}};
}
test('Windows kernel writer lock excludes another process, prevents replacement, and recovers after a real crash',{skip:process.platform!=='win32',timeout:10000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-crash-')),first=child(dir);
  try {
    assert.equal((await first.ready).ready,true);
    await assert.rejects(JournalStore.open(dir),/Writer lock exists/);
    await assert.rejects(fs.unlink(path.join(dir,'writer.guard')));
    await first.stop();
    const restored=await JournalStore.open(dir);
    assert.equal(restored.snapshot().revision,1);assert.equal(restored.snapshot().projects.p.reviewers[0].criteria,'Evidence required');await restored.close();
    const a=child(dir),b=child(dir);
    try {
      const outcomes=await Promise.all([a.ready,b.ready]);assert.equal(outcomes.filter(r=>r.ready).length,1);assert.equal(outcomes.filter(r=>r.error?.includes('Writer lock')).length,1);
    } finally {await a.stop();await b.stop();}
  } finally {await first.stop();await fs.rm(dir,{recursive:true,force:true});}
});
test('legacy live or malformed markers are preserved; corrupt journal is not silently repaired',{skip:process.platform!=='win32'},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-lock-validation-')),marker=path.join(dir,'writer.lock');
  try {
    const live=JSON.stringify({pid:process.pid,started:new Date().toISOString()});await fs.writeFile(marker,live);
    await assert.rejects(JournalStore.open(dir),/legacy owner is still alive/);assert.equal(await fs.readFile(marker,'utf8'),live);
    await fs.writeFile(marker,'{broken');await assert.rejects(JournalStore.open(dir),/Malformed writer lock/);
    assert.equal(await fs.readFile(marker,'utf8'),'{broken');
    await fs.writeFile(marker,JSON.stringify({lockProtocol:'win32-file-v1',pid:process.pid}));
    const invalid='{"version":99,"revision":1,"projects":{}}\npartial-tail';await fs.writeFile(path.join(dir,'state.jsonl'),invalid);
    await assert.rejects(JournalStore.open(dir),/Corrupt journal/);assert.equal(await fs.readFile(path.join(dir,'state.jsonl'),'utf8'),invalid);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
