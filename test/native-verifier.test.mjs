import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {NativeVerifier} from '../src/native-verifier.mjs';

const actual=process.env.DSH_TEST_INSTALL??'C:/example/dsh-runtime';
const load=async name=>import(pathToFileURL(createRequire(path.join(actual,'package.json')).resolve(name)).href);
const request=(args,timeoutMs=12000,command='node')=>({command,args,timeoutMs});
const input=(command,files=[])=>Buffer.from(JSON.stringify({...command,files}));

test('actual Windows native sandbox/subprocess verify snapshots without Docker or a model', {skip:process.platform!=='win32',timeout:100000}, async t=>{
  const {Context}=await load('@deepseek-ai/cordis'),{LocalSandboxProvider}=await load('@deepseek-ai/dsh-sandbox-local'),{LocalSubprocessRuntime}=await load('@deepseek-ai/dsh-subprocess-local');
  const ctx=new Context(),fibers=[],root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-native-smoke-'));
  const protectedRoot=path.join(root,'protected');await fs.mkdir(protectedRoot);await fs.writeFile(path.join(protectedRoot,'sentinel.txt'),'protected');
  const snapshots=path.join(root,'snapshots');await fs.mkdir(snapshots);
  const report={apiInstall:actual,platform:process.platform,node:process.versions.node,electron:process.versions.electron??null,requests:0,dockerCalls:0,
    ambientDummyKeysPresent:['FOREMAN_TEST_SECRET','DEEPSEEK_API_KEY','DSH_SESSION_ID'].map(key=>Object.hasOwn(process.env,key)),phases:[]};
  let backend;
  try {
    for(const plugin of [LocalSubprocessRuntime,LocalSandboxProvider]){const fiber=ctx.plugin(plugin,{});fibers.push(fiber);await fiber;}
    backend=new NativeVerifier({sandbox:ctx.sandbox,subprocess:ctx.subprocess,protectedRoots:[protectedRoot],snapshotParent:snapshots});
    const run=async(command,files=[],signal)=>{
      const records=[];const result=await backend.run(input(command,files),command,{signal,recordOwnership:async entry=>records.push(entry)});
      assert.deepEqual(records.map(r=>r.status),['reserved','running','removed']);
      assert(records.every(r=>r.backend==='native' && r.directory===records[0].directory));
      await assert.rejects(fs.lstat(records[0].directory),{code:'ENOENT'});return result;
    };
    await t.test('startup uses the bundled runtime and partial Windows confinement',async()=>{
      report.capabilities=await backend.probe();assert.equal(report.capabilities.backend,'native');assert.equal(report.capabilities.enforcement,'partial');
      report.phases.push({phase:'probe',passed:true});
    });
    await t.test('success reads byte-copied project files and discards generated files',async()=>{
      const command=request(['-e','const fs=require("fs");process.stdout.write(fs.readFileSync("nested/input.txt","utf8"));fs.writeFileSync("generated.txt","discard")']);
      const result=await run(command,[{path:'nested/input.txt',base64:Buffer.from('SNAPSHOT PASS').toString('base64')}]);
      assert.equal(result.exitCode,0);assert.equal(result.stdout,'SNAPSHOT PASS');assert.equal(result.truncated,false);report.phases.push({phase:'success',passed:true,exitCode:result.exitCode});
    });
    await t.test('ambient non-basic environment facts and test-harness context do not reach commands',async()=>{
      const envName='FOREMAN_NATIVE_AMBIENT_SENTINEL';assert.equal(Object.hasOwn(process.env,envName),false);process.env[envName]='not-for-project';
      try {
        const result=await run(request(['-e','const names=["FOREMAN_NATIVE_AMBIENT_SENTINEL","DEEPSEEK_API_KEY","FOREMAN_TEST_SECRET","DSH_SESSION_ID","NODE_OPTIONS","NODE_TEST_CONTEXT"];process.stdout.write(JSON.stringify(names.map(name=>Object.hasOwn(process.env,name))));']));
        assert.equal(result.exitCode,0);assert.deepEqual(JSON.parse(result.stdout),Array(6).fill(false));report.phases.push({phase:'environment-whitelist',passed:true});
      } finally {delete process.env[envName];}
    });
    await t.test('general Windows command and nonzero outcomes remain authoritative',async()=>{
      const result=await run(request(['/d','/c','echo WINDOWS COMMAND'],12000,'cmd'));assert.equal(result.exitCode,0);assert.match(result.stdout,/WINDOWS COMMAND/);
      const failed=await run(request(['-e','process.stderr.write("expected failure");process.exit(7)']));assert.equal(failed.exitCode,7);assert.match(failed.stderr,/expected failure/);
      report.phases.push({phase:'windows-command-and-failure',passed:true,exitCode:failed.exitCode});
    });
    await t.test('Node tests use isolation none because confined pipe grandchildren are unsupported',async()=>{
      const files=[{path:'sum.test.mjs',base64:Buffer.from('import test from "node:test";import assert from "node:assert/strict";test("sum",()=>assert.equal(2+3,5));').toString('base64')}];
      const piped=await run(request(['--test','sum.test.mjs']),files);assert.notEqual(piped.exitCode,0);assert.match(piped.stdout+piped.stderr,/EPERM|EACCES/);
      const direct=await run(request(['--test','--test-isolation=none','sum.test.mjs']),files);assert.equal(direct.exitCode,0);assert.match(direct.stdout,/pass 1/);
      report.phases.push({phase:'node-test-compatibility',passed:true,defaultIsolationExitCode:piped.exitCode,isolationNoneExitCode:direct.exitCode});
    });
    await t.test('outside write/delete and linking a protected file fail',async()=>{
      const protectedFile=path.join(protectedRoot,'sentinel.txt'),script='const fs=require("fs");let denied=0;for(const f of [()=>fs.writeFileSync(process.argv[1],"tampered"),()=>fs.unlinkSync(process.argv[1]),()=>fs.linkSync(process.argv[1],"alias")]){try{f()}catch(e){if(["EPERM","EACCES"].includes(e.code))denied++;else throw e}}process.stdout.write(String(denied));process.exit(denied===3?0:9)';
      const result=await run(request(['-e',script,protectedFile]));assert.equal(result.exitCode,0);assert.equal(result.stdout,'3');assert.equal(await fs.readFile(protectedFile,'utf8'),'protected');
      report.phases.push({phase:'protected-write-delete-hardlink-denied',passed:true});
    });
    await t.test('output is bounded and truncation is retained',async()=>{
      const result=await run(request(['-e','process.stdout.write("x".repeat(1200000))']));assert.equal(result.exitCode,0);assert(result.truncated);assert(Buffer.byteLength(result.stdout)<=524288);
      report.phases.push({phase:'bounded-output',passed:true});
    });
    await t.test('timeout joins the managed Job before marking snapshot removed',async()=>{
      const result=await run(request(['-e','setInterval(()=>{},1000)'],150));assert.equal(result.exitCode,124);assert.match(result.stderr,/timed out/);
      report.phases.push({phase:'timeout',passed:true,exitCode:result.exitCode});
    });
    await t.test('a successful parent exit also terminates its surviving grandchild',async()=>{
      const code='const child=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(child.pid));process.exit(0)';
      const result=await run(request(['-e',code]));assert.equal(result.exitCode,0);const pid=Number(result.stdout);assert(Number.isSafeInteger(pid)&&pid>0);
      assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');report.phases.push({phase:'grandchild-job-cleanup',passed:true});
    });
    await t.test('cancellation removes the snapshot and returns no success',async()=>{
      const abort=new AbortController(),records=[],command=request(['-e','setInterval(()=>{},1000)']);
      const pending=backend.run(input(command),command,{signal:abort.signal,recordOwnership:async entry=>{records.push(entry);if(entry.status==='running')setTimeout(()=>abort.abort(Error('test cancellation')),100);}});
      await assert.rejects(pending,/test cancellation/);assert.equal(records.at(-1).status,'removed');await assert.rejects(fs.lstat(records[0].directory),{code:'ENOENT'});
      report.phases.push({phase:'cancellation',passed:true});
    });
    await t.test('snapshot traversal/case aliases and cleanup broad paths fail closed',async()=>{
      for(const files of [[{path:'../protected/sentinel.txt',base64:'eA=='}],[{path:'a',base64:'eA=='},{path:'A',base64:'eQ=='}],[{path:'CON.txt',base64:'eA=='}]])await assert.rejects(backend.run(input(request([]),files),request([]),{recordOwnership:async()=>{}}),/Unsafe|Duplicate/);
      const unsafe=new NativeVerifier({sandbox:ctx.sandbox,subprocess:ctx.subprocess,protectedRoots:[protectedRoot],snapshotParent:protectedRoot});
      await assert.rejects(unsafe.run(input(request([])),request([]),{recordOwnership:async()=>{}}),/inside protected storage/);await unsafe.close();
      await assert.rejects(backend.run(input(request([])),request([]),{project:'p',recordOwnership:async()=>{}}),/Trusted/);
      await assert.rejects(backend.run(input(request([])),request([]),{project:'p',workspaceRoot:root,recordOwnership:async()=>{}}),/real project workspace/);
      assert.equal(await fs.readFile(path.join(protectedRoot,'sentinel.txt'),'utf8'),'protected');report.phases.push({phase:'invalid-input-cleanup-boundary',passed:true});
    });
    await t.test('close cancels and joins active verification before returning',async()=>{
      let running;const started=new Promise(resolve=>running=resolve),records=[],command=request(['-e','setInterval(()=>{},1000)']);
      const pending=backend.run(input(command),command,{recordOwnership:async entry=>{records.push(entry);if(entry.status==='running')running();}});
      const rejected=assert.rejects(pending,/shutting down/);await started;await backend.close();await rejected;
      assert.equal(records.at(-1).status,'removed');await assert.rejects(fs.lstat(records[0].directory),{code:'ENOENT'});
      await assert.rejects(backend.run(input(command),command),/closed/);report.phases.push({phase:'close',passed:true});
    });
  } finally {
    await backend?.close();for(const fiber of fibers.reverse())await fiber.dispose();
    await fs.rm(root,{recursive:true,force:true});
    if(process.env.FOREMAN_NATIVE_SMOKE_REPORT)await fs.writeFile(process.env.FOREMAN_NATIVE_SMOKE_REPORT,JSON.stringify(report,null,2)+'\n');
  }
});

test('native backend refuses provider fallback and missing enforcement before project execution',{skip:process.platform!=='win32'},async()=>{
  let spawns=0;
  const subprocess={resolveExecutable:async command=>command,selectContainmentMode:()=> 'fallback',spawn:()=>{spawns++;throw Error('must not spawn');}};
  const backend=new NativeVerifier({sandbox:{confine:async()=>{throw Error('must not confine');}},subprocess,protectedRoots:[process.cwd()]});
  await assert.rejects(backend.probe(),/weaker fallbacks/);assert.equal(spawns,0);await backend.close();
});

test('runner cleanup diagnostics and replaced snapshot roots never produce successful evidence',{skip:process.platform!=='win32'},async t=>{
  for(const replacement of [false,true])await t.test(replacement?'junction root is refused before deletion':'exit zero plus runner cleanup diagnostic fails',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-native-cleanup-')),protectedRoot=path.join(root,'protected'),snapshots=path.join(root,'snapshots');
    await fs.mkdir(protectedRoot);await fs.mkdir(snapshots);await fs.writeFile(path.join(protectedRoot,'sentinel'),'keep');
    const records=[];let link;
    const sandbox={confine:async argv=>({argv:['official-test-runner',...argv],enforcement:'partial'})};
    const subprocess={resolveExecutable:async command=>command,selectContainmentMode:()=> 'windows-job',spawn:spec=>{
      const done=(async()=>{if(replacement){await fs.rename(spec.cwd,spec.cwd+'.moved');await fs.symlink(protectedRoot,spec.cwd,'junction');link=spec.cwd;}return {exitCode:0};})();
      return {done,waitForExit:async()=>{await done;},terminate:async()=>{},collected:{stdout:{readFrom:()=>({text:'',lossy:false})},stderr:{readFrom:()=>({text:replacement?'':'windows-acl-run: cleanup: failed to remove private temp',lossy:false})}}};
    }};
    const backend=new NativeVerifier({sandbox,subprocess,protectedRoots:[protectedRoot],snapshotParent:snapshots});
    try {
      const command=request([]);await assert.rejects(backend.run(input(command),command,{recordOwnership:async record=>records.push(record)}),replacement?/replaced/:/could not clean/);
      assert.equal(records.at(-1).status,replacement?'running':'removed');assert.equal(await fs.readFile(path.join(protectedRoot,'sentinel'),'utf8'),'keep');
    } finally {await backend.close();if(link)await fs.unlink(link);await fs.rm(root,{recursive:true,force:true});}
  });
});
