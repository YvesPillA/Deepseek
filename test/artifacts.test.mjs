import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ArtifactStore } from '../src/artifacts.mjs';

test('review reads original content after working tree changes; tampering is detected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-artifact-test-'));
  try {
    const workspace=path.join(root,'work'),storage=path.join(root,'artifacts');await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace,'app.js'),'export const result = 1;');
    const artifacts=new ArtifactStore(storage);const first=await artifacts.capture(workspace);
    assert.equal(await artifacts.capture(workspace),first);
    await fs.writeFile(path.join(workspace,'app.js'),'export const result = 2;');
    const second=await artifacts.capture(workspace);assert.notEqual(first,second);
    assert.equal((await artifacts.read(first,'app.js')).toString(),'export const result = 1;');
    await assert.rejects(artifacts.read(first,'../../secret'),/not in reviewed/);
    await fs.writeFile(path.join(storage,first.slice(7),'files','app.js'),'tampered');
    await assert.rejects(artifacts.verify(first),/modified/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('snapshot storage cannot live inside execution workspace and enforces size limits',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-artifact-test-'));
  try {
    await assert.rejects(new ArtifactStore(path.join(root,'snapshots')).capture(root),/separate/);
    const work=path.join(root,'work');await fs.mkdir(work);await fs.writeFile(path.join(work,'big'),'12345');
    await assert.rejects(new ArtifactStore(path.join(root,'store'),{maxBytes:3}).capture(work),/size limit/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
