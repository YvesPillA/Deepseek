import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionMonitor} from '../src/execution-monitor.mjs';
import {EXECUTION_PROTOCOL} from '../src/execution-scheduler.mjs';

test('execution monitor recognizes a finished turn from a snapshot-only rc.2 session',async()=>{
  const messageId='task-message';
  const events=[
    {type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:messageId}]}},
    {type:'turn/start',data:{turn:1}},
    {type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
    {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
  ];
  const agent={status:'idle',session:{snapshotEvents:()=>events}};
  const job={id:'job',status:'delivered',project:'p',recipient:'executor',messageId,
    subject:{protocol:EXECUTION_PROTOCOL,task:'t',milestone:'m',configVersion:1,planVersion:1,taskAttempt:1}};
  const state={outbox:{job},projects:{p:{status:'running',configVersion:1,
    milestones:{m:{status:'work',planVersion:1,deps:[]}},tasks:{t:{status:'running',assigned:'executor',milestone:'m',configVersion:1,planVersion:1,attempt:1}}}}};
  const faults=[];
  const monitor=new ExecutionMonitor({snapshot:()=>state},{executionFaultIfCurrent:async(a,details,retire)=>{faults.push({a,details});await retire();}},
    {lookup:()=>agent,retire:()=>faults.push('retired')});
  await monitor.poll();
  assert.equal(faults.length,2);assert.equal(faults[0].a,agent);
  assert.equal(faults[0].details.task,'t');assert.match(faults[0].details.error,/结束/);
  assert.equal(faults[1],'retired');
});
