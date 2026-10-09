import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installLocal,rollbackLocal} from '../scripts/install-local.mjs';
test('installation verifies release, preserves profile bytes and rollback refuses later edits',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-install-')),release=path.join(home,'release'),receipt=path.join(home,'receipt.json');
  try {
    for(const dir of ['profiles/web','profiles/node_modules','.agent-presets','release/src','release/presets/foreman-next'])await fs.mkdir(path.join(home,dir),{recursive:true});
    const original='# Existing plugin configuration\n- insert: []\n';const patch=path.join(home,'profiles/web/cordis.patch.yml');await fs.writeFile(patch,original);
    const files=[];for(const [name,bytes] of [['src/host.mjs','export const name="test";'],['presets/foreman-next/preset.yml','name: 新工头模式\n']]){await fs.writeFile(path.join(release,name),bytes);files.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex')});}
    await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify({name:'dsh-foreman-next',installed:false,files}));
    await assert.rejects(installLocal({home,release,receipt,hostOptions:{storageRoot:'outside'}}),/Unexpected host options/);
    assert.equal(await fs.readFile(patch,'utf8'),original);
    const result=await installLocal({home,release,receipt,hostOptions:{scheduler:{agentOptions:{provider:'deepseek-official',model:'deepseek-flash'}}}});assert.equal(result.readyForProjects,false);assert((await fs.readFile(patch,'utf8')).startsWith(original));
    assert((await fs.readFile(patch,'utf8')).includes('deepseek-official'));
    const after=await fs.readFile(patch);await fs.appendFile(patch,'# User change\n');
    await assert.rejects(rollbackLocal(receipt),/changed/);assert((await fs.readFile(patch,'utf8')).endsWith('# User change\n'));
    await fs.writeFile(patch,after);await rollbackLocal(receipt);assert.equal(await fs.readFile(patch,'utf8'),original);
    await assert.rejects(fs.stat(result.moduleRoot),/ENOENT/);await assert.rejects(fs.stat(result.presetRoot),/ENOENT/);
  }finally{await fs.rm(home,{recursive:true,force:true});}
});
