import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selectDshRuntime,copyFixturePlugin} from '../scripts/dsh-runtime.mjs';
import {safeArchivePath,extractDesktopRuntime} from '../scripts/extract-desktop-runtime.mjs';

test('archive paths reject traversal, Windows aliases, ADS and absolute paths',()=>{
  for(const value of ['../escape','dsh/../../escape','C:/escape','/escape','dsh\\escape','dsh/a:stream','dsh/.. /escape','dsh/CON.txt','dsh/a.'])assert.throws(()=>safeArchivePath('C:/example/foreman-tests/temp',value),/Unsafe/);
  assert.equal(safeArchivePath('C:/example/foreman-tests/temp','dsh/node_modules/a/index.js'),path.resolve('C:/example/foreman-tests/temp/dsh/node_modules/a/index.js'));
});

test('selected runtime loads actual package code and keeps legacy default available',async()=>{
  const runtime=selectDshRuntime();
  const selected=runtime.requireDsh('@deepseek-ai/dsh-agent-loop/package.json');
  assert.equal(selected.version,runtime.version);
  assert.equal(typeof(await runtime.load('dsh-agent-loop')).AgentLoop,'function');
  const legacy=selectDshRuntime({});assert.equal(legacy.version,'0.1.7-rc.2');
});

test('fixture copies its plugin and resolves scope to selected runtime without global relinking',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-runtime-fixture-'));
  try {
    const target=await copyFixturePlugin(path.resolve('.'),root);
    const selected=selectDshRuntime();
    const scope=await fs.realpath(path.join(target,'node_modules/@deepseek-ai/dsh-scope'));
    assert(scope.startsWith(selected.root+path.sep)||scope===path.dirname(selected.requireDsh.resolve('@deepseek-ai/dsh-scope/package.json')));
    assert.equal(JSON.parse(await fs.readFile(path.join(scope,'package.json'))).version,selected.version);
    assert.equal(await fs.readFile(path.join(target,'src/outer-entry.mjs'),'utf8'),await fs.readFile('src/outer-entry.mjs','utf8'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('ASAR extraction preserves packed and actual unpacked bytes plus source build identity',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-asar-fixture-'));
  try {
    const archive=path.join(root,'app.asar');let offset=0;const data=[];
    const entry=value=>{const bytes=Buffer.from(value);const result={size:bytes.length,offset:String(offset)};offset+=bytes.length;data.push(bytes);return result;};
    const header={files:{'package.json':entry(JSON.stringify({dshBuildCommit:'actual-build'})),dsh:{files:{'package.json':entry(JSON.stringify({name:'@deepseek-ai/dsh-desktop-runtime',version:'0.2.0-rc.2'})),'desktop-runtime.json':entry('{}'),node_modules:{files:{native:{files:{'binding.node':{size:6,unpacked:true}}}}}}}}};
    const json=Buffer.from(JSON.stringify(header)),prefix=Buffer.alloc(16);prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(json.length+8,4);prefix.writeUInt32LE(json.length+4,8);prefix.writeUInt32LE(json.length,12);
    await fs.writeFile(archive,Buffer.concat([prefix,json,...data]));
    const unpacked=path.join(archive+'.unpacked','dsh/node_modules/native');await fs.mkdir(unpacked,{recursive:true});await fs.writeFile(path.join(unpacked,'binding.node'),'native');
    const destination=path.join(root,'extracted');const metadata=await extractDesktopRuntime(archive,destination);
    assert.equal(metadata.buildCommit,'actual-build');assert.equal(metadata.version,'0.2.0-rc.2');assert.equal(metadata.sourceSha256.length,64);
    assert.equal(await fs.readFile(path.join(destination,'dsh/node_modules/native/binding.node'),'utf8'),'native');
    await assert.rejects(extractDesktopRuntime(archive,destination),/EEXIST/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
