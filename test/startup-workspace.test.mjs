import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openApplication} from '../src/application.mjs';
import {UserControl} from '../src/user-control.mjs';

const create=(id,workspace)=>({type:'create',id,workspace,objective:'Deliver a self-contained example document',reviewers:[{id:'visual',name:'Visual',responsibility:'Clear and complete vector artwork',criteria:'Continuous loop'}],patrolEvery:2});
const yes=q=>({answers:[{id:q.questions[0].id,selected:['确认执行']}]});
async function absent(file) {await assert.rejects(fs.lstat(file),e=>e.code==='ENOENT');}
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-startup-'));
  const work=path.join(root,'work'),home=path.join(root,'home'),sessions=path.join(root,'sessions');
  for(const dir of [work,home,sessions])await fs.mkdir(dir);
  const config={storageRoot:path.join(root,'journal'),dshHome:home,sessionRoot:sessions};
  const app=await openApplication(config),controls=[];
  const control=ask=>{
    const outer={id:'outer-'+controls.length},live=new Map([[outer.id,outer]]);
    const user=new UserControl(app.controller,{agents:{get:id=>live.get(id),roots:()=>[...live.values()]},userQuestions:{ask}},{canStart:()=>true});
    const revoke=user.bindRoot(outer);controls.push(user);return {user,outer,revoke,live};
  };
  return {root,work,config,app,control,close:async()=>{
    for(const user of controls)user.close();await app.close();
    assert(path.relative(os.tmpdir(),root).startsWith('foreman-startup-'));
    await fs.rm(root,{recursive:true,force:true});
  }};
}
async function remove(c,id) {for(const type of ['cancel','archive','delete-project'])await c.userCommand({type,project:id});}

test('deleted project releases its parent reservation while history and files survive new child startup and reopen',async()=>{
  const f=await fixture();let reopened;
  try {
    const c=f.app.controller,source=path.join(f.work,'existing.svg');await fs.writeFile(source,'old user source');
    await c.userCommand(create('sample-project',f.work));
    const child=path.join(f.work,'sample-project');
    for(const type of [null,'cancel','archive']) {
      if(type)await c.userCommand({type,project:'sample-project'});
      await assert.rejects(c.prepareUserCommand(create('independent',child)),/overlaps project/);await absent(child);
    }
    await c.userCommand({type:'delete-project',project:'sample-project'});
    const old=c.view('sample-project'),revision=f.app.store.snapshot().revision;
    const ticket=await c.prepareUserCommand(create('sample-project',child));
    assert.equal(ticket.command.id,'sample-project-2');assert.equal(ticket.workspaceWillBeCreated,true);
    assert.equal(f.app.store.snapshot().revision,revision);await absent(child);
    await c.confirmUserCommand(ticket,'foreman-confirm-test');
    assert((await fs.stat(child)).isDirectory());assert.deepEqual(c.view('sample-project'),old);
    assert.equal(await fs.readFile(source,'utf8'),'old user source');
    assert.equal(c.view('sample-project-2').workspace,await fs.realpath(child));
    assert.equal(c.view('sample-project-2').audit[0].command.userApproval.questionId,'foreman-confirm-test');
    await f.app.close();reopened=await openApplication(f.config);
    assert.deepEqual(reopened.controller.view('sample-project'),old);
    assert.equal(reopened.controller.view('sample-project-2').status,'running');
    assert.equal(await fs.readFile(source,'utf8'),'old user source');
  } finally {await reopened?.close();await f.close();}
});

test('native startup card shows actual fresh ID and directory creation; decline leaves filesystem and tombstone unchanged',async()=>{
  const f=await fixture();
  try {
    await f.app.controller.userCommand(create('sample-project',f.work));await remove(f.app.controller,'sample-project');
    const saved=f.app.store.snapshot(),child=path.join(f.work,'sample-project');let approve=false,shown;
    const {user,outer}=f.control(async q=>{
      shown=q;await absent(child);
      assert.match(q.questions[0].detail,/项目ID：sample-project-2/);
      assert.match(q.questions[0].detail,/确认后由宿主创建/);
      return approve?yes(q):{answers:[{id:q.questions[0].id,selected:['返回调整']}]};
    });
    assert.equal((await user.request(outer,create('sample-project',child))).applied,false);
    await absent(child);assert.deepEqual(f.app.store.snapshot(),saved);
    approve=true;const result=await user.request(outer,create('sample-project',child));
    assert.deepEqual(result,{applied:true,project:'sample-project-2'});
    assert((await fs.stat(child)).isDirectory());
    assert.equal(f.app.controller.view(result.project).audit[0].command.userApproval.questionId,shown.questions[0].id);
    assert.deepEqual(f.app.controller.view('sample-project'),saved.projects['sample-project']);
  } finally {await f.close();}
});

test('a confirmation whose fresh ID was occupied fails before creating the proposed directory',async()=>{
  const f=await fixture();
  try {
    const c=f.app.controller;await c.userCommand(create('sample-project',f.work));await remove(c,'sample-project');
    const child=path.join(f.work,'proposal'),other=path.join(f.root,'other');await fs.mkdir(other);
    const first=await c.prepareUserCommand(create('sample-project',child));
    await c.userCommand(create('sample-project-2',other));const saved=f.app.store.snapshot();
    await assert.rejects(c.confirmUserCommand(first,'occupied'),/changed while awaiting/);
    await absent(child);assert.deepEqual(f.app.store.snapshot(),saved);
    const next=await c.prepareUserCommand(create('sample-project',child));
    assert.equal(next.command.id,'sample-project-3');await absent(child);
  } finally {await f.close();}
});

test('revoking the outer agent while reading the native card leaves the missing directory absent',async()=>{
  const f=await fixture();let answer,shown;
  try {
    const child=path.join(f.work,'unconfirmed'),{user,outer,revoke}=f.control(q=>{shown=q;return new Promise(r=>answer=r);});
    const pending=user.request(outer,create('p',child)),rejected=assert.rejects(pending,/disposed/);
    while(!shown)await new Promise(r=>setImmediate(r));await absent(child);
    revoke();await rejected;answer(yes(shown));await new Promise(r=>setImmediate(r));
    await absent(child);assert.equal(f.app.store.snapshot().revision,0);
  } finally {await f.close();}
});

test('a deleted 80-character project ID gets a bounded new identity without changing an active duplicate',async()=>{
  const f=await fixture();
  try {
    const c=f.app.controller,id='p'.repeat(80);await c.userCommand(create(id,f.work));await remove(c,id);
    const child=path.join(f.work,'new'),ticket=await c.prepareUserCommand(create(id,child));
    assert.equal(ticket.command.id,'p'.repeat(78)+'-2');assert.equal(ticket.command.id.length,80);
    await c.confirmUserCommand(ticket,'long-id');
    const independent=path.join(f.root,'other');await fs.mkdir(independent);
    await assert.rejects(c.prepareUserCommand(create(ticket.command.id,independent)),/already exists/);
    assert.equal(c.view(id).deleted,true);assert.equal(c.view(ticket.command.id).status,'running');
  } finally {await f.close();}
});

test('fresh IDs skip deleted history and occupied suffixes without recycling their runtime identities',async()=>{
  const f=await fixture();
  try {
    const c=f.app.controller;await c.userCommand(create('p',f.work));await remove(c,'p');
    await c.userCommand(create('p',f.work));assert.equal(c.view('p-2').status,'running');await remove(c,'p-2');
    const other=path.join(f.root,'other');await fs.mkdir(other);await c.userCommand(create('p-3',other));
    const saved=f.app.store.snapshot(),child=path.join(f.work,'new');
    const ticket=await c.prepareUserCommand(create('p',child));assert.equal(ticket.command.id,'p-4');
    await absent(child);await c.confirmUserCommand(ticket,'historical-suffix');
    for(const id of ['p','p-2','p-3'])assert.deepEqual(c.view(id),saved.projects[id]);
    assert.equal(c.view('p-4').status,'running');assert.equal(c.view('p-4').configVersion,1);
  } finally {await f.close();}
});

test('old executor remains bound to its deleted project and cannot write into a reused workspace',async()=>{
  const f=await fixture();
  try {
    const c=f.app.controller;await c.userCommand(create('p',f.work));
    const coordinator={id:'old-coordinator'},reviewer={id:'old-reviewer'},executor={id:'old-executor'};
    c.bind(coordinator,{role:'coordinator',project:'p',configVersion:1});c.bind(reviewer,{role:'reviewer',project:'p',reviewer:'visual'});
    await c.modelCommand(coordinator,{type:'propose',definition:{id:'m',title:'Animation',criteria:'Loop',deps:[]}});
    const round=Object.values(c.view('p').rounds)[0];await c.modelCommand(reviewer,{type:'vote',round:round.id,generation:1,pass:true,findings:'Agreed'});
    await c.modelCommand(coordinator,{type:'task',milestone:'m',id:'t',title:'Draw',instructions:'Implement'});
    c.bind(executor,{role:'executor',project:'p',task:'t',configVersion:1,planVersion:1,taskAttempt:1});await c.assign(coordinator,executor,'t');
    const first=await f.app.files.run(executor,{action:'write',path:'sample.svg',text:'keep user file',expectedHash:null});
    const cancelled=c.userCommand({type:'cancel',project:'p'});
    // This write was accepted into the queue while cancel had not yet settled.
    // Its ownership must be rechecked when it actually reaches the barrier.
    const queued=f.app.files.run(executor,{action:'write',path:'queued.svg',text:'old in-flight write',expectedHash:null});
    const refused=assert.rejects(queued,/not executable|control authorization has expired/);await cancelled;await refused;await absent(path.join(f.work,'queued.svg'));
    for(const type of ['archive','delete-project'])await c.userCommand({type,project:'p'});const old=c.view('p');
    const next=await c.prepareUserCommand(create('p',f.work));assert.equal(next.workspaceWillBeCreated,false);
    await c.confirmUserCommand(next,'reuse-existing');assert.equal(c.identity(executor).project,'p');
    const commands=[{action:'write',path:'sample.svg',text:'obsolete overwrite',expectedHash:first.hash},
      {action:'write',path:'new.svg',text:'obsolete create',expectedHash:null},
      {action:'delete',path:'sample.svg',expectedHash:first.hash}];
    for(const command of commands)await assert.rejects(f.app.files.run(executor,command),/not executable|control authorization has expired/);
    await assert.rejects(c.modelCommand(executor,{type:'complete',task:'t',result:'obsolete'}),/record is deleted/);
    assert.deepEqual(c.view('p'),old);assert.equal(c.view('p-2').status,'running');
    assert.equal(await fs.readFile(path.join(f.work,'sample.svg'),'utf8'),'keep user file');await absent(path.join(f.work,'new.svg'));
  } finally {await f.close();}
});
