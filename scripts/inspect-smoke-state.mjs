// Read-only status; never opens a writer or truncates a partial journal tail.
import fs from 'node:fs/promises';
import path from 'node:path';
import {initialState} from '../src/core.mjs';
import {decodeJournal} from '../src/journal-codec.mjs';
const root=await fs.realpath(process.argv[2]);
if(path.dirname(root)!==path.resolve('C:/example/foreman-tests')||! /^(native-model-ui|foreman-model-smoke|native-ui-smoke)-[\w-]+$/.test(path.basename(root)))throw Error('Isolated smoke root required');
let state=initialState();const lines=(await fs.readFile(path.join(root,'journal/state.jsonl'),'utf8')).split('\n');lines.pop();
for(const line of lines)if(line)state=decodeJournal(state,JSON.parse(line),{inPlace:true});
console.log(JSON.stringify({revision:state.revision,projects:Object.values(state.projects).map(p=>({id:p.id,status:p.status,
  milestones:Object.values(p.milestones).map(m=>({id:m.id,status:m.status,denials:m.denials})),
  tasks:Object.values(p.tasks).map(t=>({id:t.id,status:t.status,attempt:t.attempt})),
  rounds:Object.values(p.rounds).filter(r=>r.status!=='closed').map(r=>({id:r.id,kind:r.kind,status:r.status,generation:r.generation,votes:Object.keys(r.votes),faults:r.faults})),
  notifications:p.notifications.filter(n=>!n.resolved&&!n.acknowledged),lastAudit:p.audit.slice(-3).map(a=>({actor:a.actor,type:a.command.type}))})),
  verification:state.verificationRuns},null,2));
