// Node parent: wait for actual Electron's complete test report, then remove
// only this runner's disposable fixtures after ASAR handles have been closed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

assert.equal(process.versions.electron,undefined,'Run this parent with ordinary Node');
const executable=process.argv[2];
assert(executable&&path.isAbsolute(executable),'Supply the absolute installed Electron executable path');
const cwd=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-electron-suite-'));
try {
  const child=spawn(executable,['--test','test/release-approval.test.mjs'],{cwd,windowsHide:true,
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ELECTRON_RELEASE_TEST_TEMP:root},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',data=>{stdout+=data;process.stdout.write(data);});
  child.stderr.on('data',data=>{stderr+=data;process.stderr.write(data);});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0,'Actual Electron regression process must exit successfully');
  const combined=stdout+stderr;
  assert.match(combined,/tests 8/,'Require the complete test runner summary');
  assert.match(combined,/pass 8/);assert.match(combined,/fail 0/);assert.match(combined,/skipped 0/);
  console.log('ELECTRON_RELEASE_CONTRACT_COMPLETE: 8/8 passed; no GUI or user installation writes');
} finally {
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('foreman-electron-suite-'));
  await fs.rm(root,{recursive:true,force:true});
}
