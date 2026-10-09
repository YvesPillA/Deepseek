import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {apply} from '../scripts/native-rc2-ui-guard.mjs';

test('isolated web fixture blocks model turns and external fetch before network',async()=>{
  const root=await fs.mkdtemp('C:/example/foreman-tests/native-rc2-ui-');
  assert.equal(path.resolve(path.dirname(root)),path.resolve('C:/example/foreman-tests'));
  await fs.writeFile(path.join(root,'fixture-marker'),'foreman-native-rc2-ui-offline');
  let dispose,stream;
  const previous=globalThis.fetch;
  try {
    await apply({inject:()=>{},effect:fn=>{dispose=fn();},on:(name,fn)=>{assert.equal(name,'llm/stream');stream=fn;}},{root});
    await assert.rejects(globalThis.fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST'}),/blocks external fetch/);
    await assert.rejects(async()=>{for await(const _ of stream()){}},/blocks model turns/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'network-guard.json'),'utf8')),
      {modelTurnsBlocked:1,externalFetchesBlocked:1});
  }finally{
    dispose?.();assert.equal(globalThis.fetch,previous);
    await fs.rm(root,{recursive:true,force:true});
  }
});
