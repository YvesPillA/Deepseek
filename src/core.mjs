import { randomUUID } from 'node:crypto';

const copy = x => structuredClone(x);
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const text = (x, label) => { check(typeof x === 'string' && x.trim().length > 0 && x.length <= 20000, `Invalid ${label}`); return x.trim(); };
const integer = (x, label) => { check(Number.isSafeInteger(x) && x > 0 && x <= 10000, `Invalid ${label}`); return x; };
const key = x => { text(x, 'id'); check(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(x) && !['constructor','prototype','__proto__'].includes(x), 'Invalid id'); return x; };

export function initialState() {
  return { version: 1, projects: {}, revision: 0 };
}

function definition(raw) {
  return { id: key(raw.id), title: text(raw.title, 'milestone title'), criteria: text(raw.criteria, 'criteria'), deps: [...new Set(raw.deps ?? [])].map(key) };
}
function validateDependencies(p, def) {
  for (const id of def.deps) check(p.milestones[id]?.status !== 'cancelled', `Cancelled dependency: ${id}`);
}
function validateGraph(milestones) {
  const visiting = new Set(), done = new Set();
  function visit(id) {
    check(milestones[id], `Unknown dependency: ${id}`);
    check(!visiting.has(id), 'Milestone dependency cycle');
    if (done.has(id)) return;
    visiting.add(id);
    for (const dep of milestones[id].deps) visit(dep);
    visiting.delete(id); done.add(id);
  }
  Object.keys(milestones).forEach(visit);
}

function notify(p, kind, message, milestone = null) {
  const n={ id: randomUUID(), kind, message, milestone, acknowledged: false };
  p.notifications.push(n);return n;
}
function resolveObsoleteNotifications(p) {
  for(const n of p.notifications)if(!n.resolved && n.kind!=='record') {
    const resolved=['cancelled','delivered'].includes(p.status) ||
      n.kind==='decision' && p.milestones[n.milestone]?.status!=='paused' ||
      n.kind==='delivery' && p.status!=='approved' ||
      n.kind==='fault' && n.round && p.rounds[n.round]?.status!=='faulted';
    if(resolved){n.resolved=true;n.acknowledged=true;}
  }
}
function round(p, kind, milestone, payload) {
  const r = { id: randomUUID(), kind, milestone, payload: copy(payload), status: 'open', votes: {}, faults: {}, attempts: {}, generation: 1 };
  p.rounds[r.id] = r;
  return r;
}
function depsReady(p, m) { return m.deps.every(id => p.milestones[id].status === 'passed'); }
function writable(p, m) { check(m.status === 'work' && depsReady(p, m), 'Milestone is not executable'); }
function activeRound(p, id) { const r = p.rounds[id]; check(r && r.status === 'open', 'Review is not open'); return r; }
function invalidate(p, id, visited = new Set()) {
  if (visited.has(id)) return;
  visited.add(id);
  // Changing any ancestor invalidates dependent approvals, not only scheduling hints.
  for (const m of Object.values(p.milestones)) {
    if (!m.deps.includes(id)) continue;
    if (m.status === 'passed') m.status = 'work';
    for (const r of Object.values(p.rounds)) if (r.milestone === m.id && ['open','faulted'].includes(r.status) && r.kind === 'acceptance') {
      r.status = 'stale';
      if (m.status === 'review') m.status = 'work';
    }
    invalidate(p, m.id, visited);
  }
  for (const r of Object.values(p.rounds)) if (r.kind === 'final' && ['open','faulted'].includes(r.status)) r.status = 'stale';
  if (['approved','final-review'].includes(p.status)) p.status = 'running';
}
function denied(p, m, kind) {
  m.denials++;
  m.status = m.denials >= m.limit ? 'paused' : kind === 'plan' ? 'unplanned' : 'work';
  invalidate(p, m.id);
  if (m.status === 'paused') notify(p, 'decision', `里程碑「${m.title}」累计第 ${m.denials} 轮被否决，需要用户裁决。`, m.id);
}
function settle(p, r) {
  if (!p.reviewers.every(v => Object.hasOwn(r.votes, v.id))) return;
  r.status = 'closed';
  const rejects = Object.values(r.votes).filter(v => !v.pass);
  r.outcome = rejects.length ? 'rejected' : 'passed';
  if (r.kind === 'patrol') return; // Findings only: no veto, no denial count.
  if (r.kind === 'final') {
    if (!rejects.length) { p.status = 'approved'; notify(p, 'delivery', '所有监督者已通过最终验收，可以交付。'); }
    else {
      p.status = 'running';
      const affected = new Set(rejects.flatMap(v => v.affected));
      for (const id of affected) denied(p, p.milestones[id], 'acceptance');
    }
    return;
  }
  const m = p.milestones[r.milestone];
  if (rejects.length) { denied(p, m, r.kind); return; }
  if (r.kind === 'plan' || r.kind === 'change') {
    validateDependencies(p, r.payload.definition);
    validateGraph({ ...p.milestones, [m.id]: r.payload.definition });
    Object.assign(m, r.payload.definition);
    m.planVersion++;
    m.status = 'work';
    if (r.kind === 'change') invalidate(p, m.id);
  } else { m.status = 'passed'; m.acceptedArtifact = r.payload.artifact; }
}

/** Pure transition boundary. Actor is supplied by trusted host, never parsed from model arguments.
 * Host MUST enforce agent roles, scope confirmation and artifact snapshots before calling.
 */
export function transition(previous, actor, command) {
  const s = copy(previous);
  check(s.version === 1, 'Unsupported state version');
  check(actor && ['user','coordinator','executor','reviewer'].includes(actor.role), 'Unknown actor');
  const kind = command.type;
  const user = () => check(actor.role === 'user', 'User authorization required');
  const manager = () => check(actor.role === 'coordinator', 'Execution coordinator required');
  if (kind === 'create') {
    user();
    const id = key(command.id); check(!s.projects[id], 'Project already exists');
    check(Array.isArray(command.reviewers) && command.reviewers.length > 0 && command.reviewers.length <= 20, 'Need 1–20 reviewers');
    const reviewers = command.reviewers.map(r => ({ id: key(r.id), name: text(r.name, 'reviewer name'), responsibility: text(r.responsibility, 'responsibility'), criteria: text(r.criteria, 'review criteria') }));
    check(new Set(reviewers.map(r => r.id)).size === reviewers.length, 'Duplicate reviewer');
    s.projects[id] = { id, objective: text(command.objective, 'objective'), workspace: text(command.workspace, 'workspace'), status: 'running', reviewers, configVersion: 1,
      denialLimit: integer(command.denialLimit ?? 3, 'denial limit'), patrolEvery: integer(command.patrolEvery ?? 3, 'patrol interval'), faultRetries: integer(command.faultRetries ?? 3, 'fault retries'),
      milestones: {}, tasks: {}, rounds: {}, completions: 0, nextPatrol: command.patrolEvery ?? 3, notifications: [], audit: [] };
  } else {
    key(command.project); const p = s.projects[command.project]; check(p, 'Unknown project');
    check(actor.role === 'user' || actor.project === p.id, 'Cross-project access denied');
    check(p.deleted!==true,'Project record is deleted');
    if(kind==='delete-project') {
      user();check(['cancelled','delivered'].includes(p.status),'Only cancelled or delivered projects can be deleted');
      check(p.archived===true,'Archive the project before deleting its record');
      // Keep the v1 journal history and ID reservation. This is a list tombstone,
      // never filesystem deletion or removal of an outer conversation.
      p.deleted=true;p.deletedAt=new Date().toISOString();p.archiveVersion=(p.archiveVersion??0)+1;
    } else if(['archive','unarchive'].includes(kind)) {
      user();check(['cancelled','delivered'].includes(p.status),'Only cancelled or delivered projects can be archived or restored');
      check(kind==='archive'?p.archived!==true:p.archived===true,kind==='archive'?'Project is already archived':'Project is not archived');
      p.archived=kind==='archive';p.archiveVersion=(p.archiveVersion??0)+1;
      if(p.archived)p.archivedAt=new Date().toISOString();
    } else {
    check(p.archived!==true,'Project is archived; restore its display first');
    check(!['cancelled','delivered'].includes(p.status), 'Project is closed');
    const m = command.milestone ? p.milestones[command.milestone] : null;
    if (kind === 'propose') {
      manager(); check(p.status === 'running', 'Project is not running');
      const def = definition(command.definition);
      validateDependencies(p, def);
      const existing = p.milestones[def.id];
      if (existing) {
        check(['work','unplanned'].includes(existing.status), 'Milestone cannot be changed now');
        check(!Object.values(p.tasks).some(t => t.milestone === def.id && t.status === 'running'), 'Wait for running tasks before changing plan');
      }
      // A proposal cannot rewrite its goal silently: host collects explicit user approval for scope changes.
      const candidate = { ...p.milestones, [def.id]: def }; validateGraph(candidate);
      // Reserve both current and proposed edges: pending proposals may pass or fail
      // independently, so checking only the latest proposal misses interleaved cycles.
      const reserved = copy(p.milestones);
      for (const pending of Object.values(p.rounds)) {
        if (!['open','faulted'].includes(pending.status) || !['plan','change'].includes(pending.kind)) continue;
        const proposed = pending.payload.definition;
        reserved[proposed.id].deps = [...new Set([...reserved[proposed.id].deps, ...proposed.deps])];
      }
      reserved[def.id] = { ...def, deps: [...new Set([...(reserved[def.id]?.deps ?? []), ...def.deps])] };
      validateGraph(reserved);
      const current = existing ?? { ...def, status: 'unplanned', denials: 0, limit: p.denialLimit, planVersion: 0 };
      p.milestones[def.id] = current;
      const type = current.planVersion ? 'change' : 'plan';
      current.status = 'review';
      round(p, type, def.id, { definition: def, configVersion: p.configVersion });
    } else if (kind === 'task') {
      manager(); check(m, 'Unknown milestone'); writable(p, m);
      const id = key(command.id); check(!p.tasks[id], 'Task already exists');
      p.tasks[id] = { id, milestone: m.id, planVersion:m.planVersion, configVersion:p.configVersion, attempt:1, failures:[], title: text(command.title, 'task title'), instructions: text(command.instructions, 'task instructions'), status: 'pending', assigned: null, result: null };
    } else if (kind === 'assign') {
      manager(); const t = p.tasks[command.task]; check(t && t.status === 'pending', 'Task is not pending'); writable(p, p.milestones[t.milestone]);
      check(t.planVersion===p.milestones[t.milestone].planVersion && t.configVersion===p.configVersion,'Task belongs to an obsolete plan or configuration');
      t.assigned = text(command.agentId, 'executor id'); t.status = 'running';
    } else if (kind === 'complete') {
      check(actor.role === 'executor', 'Executor required');
      const t = p.tasks[command.task]; check(t && t.assigned === actor.id, 'Task ownership mismatch');
      check((actor.taskAttempt??1)===(t.attempt??1),'Stale task attempt');
      check(t.planVersion===p.milestones[t.milestone].planVersion && t.configVersion===p.configVersion,'Task belongs to an obsolete plan or configuration');
      if (t.status !== 'completed') {
        check(!t.dependencyWait,'Task is waiting for dependency approval; do not claim completion');
        check(t.status === 'running', 'Task is not running'); writable(p, p.milestones[t.milestone]);
        t.result = text(command.result, 'task result'); t.status = 'completed'; p.completions++;
        if (p.completions >= p.nextPatrol) {
          round(p, 'patrol', null, { completions: p.completions, task: t.id, ...(command.artifact?{artifact:text(command.artifact,'trusted patrol snapshot')}:{}) }); p.nextPatrol += p.patrolEvery;
        }
      }
    } else if (kind === 'task-fault') {
      check(actor.role==='executor','Executor required');
      const t=p.tasks[command.task];
      check(t?.status==='running' && t.assigned===actor.id && (t.attempt??1)===command.taskAttempt && (actor.taskAttempt??1)===command.taskAttempt,'Stale task failure');
      check(t.configVersion===p.configVersion && t.planVersion===p.milestones[t.milestone].planVersion,'Task version has expired');
      t.status='failed';t.failures??=[];
      t.failures.push({attempt:command.taskAttempt,agentId:actor.id,error:text(command.error,'task error')});
      // Technical failure belongs to the coordinator, never to review denial counts.
    } else if (kind === 'retry-task') {
      manager();const t=p.tasks[command.task];check(t?.status==='failed','Only failed tasks can retry');
      check(!t.dependencyWait,'Task is waiting for dependency approval; do not retry yet');
      writable(p,p.milestones[t.milestone]);
      check(t.configVersion===p.configVersion && t.planVersion===p.milestones[t.milestone].planVersion,'Task version has expired');
      text(command.reason,'retry reason');
      t.attempt=integer((t.attempt??1)+1,'task attempt');t.status='pending';t.assigned=null;t.result=null;
    } else if (kind === 'submit') {
      manager(); check(m, 'Unknown milestone'); writable(p, m);
      const tasks = Object.values(p.tasks).filter(t => t.milestone === m.id && t.planVersion===m.planVersion && t.configVersion===p.configVersion);
      check(tasks.length > 0 && tasks.every(t => t.status === 'completed'), 'All milestone tasks must complete before review');
      check(!Object.values(p.rounds).some(r => r.kind === 'patrol' && ['open','faulted'].includes(r.status)), 'Await pending patrol findings');
      const artifact = text(command.artifact, 'trusted artifact snapshot');
      m.status = 'review'; round(p, 'acceptance', m.id, { artifact, planVersion: m.planVersion, configVersion: p.configVersion });
    } else if (kind === 'final') {
      manager(); check(p.status === 'running', 'Project is not running');
      const all = Object.values(p.milestones).filter(m => m.status !== 'cancelled');
      check(all.length && all.every(m => m.status === 'passed'), 'Every milestone must pass');
      check(!Object.values(p.rounds).some(r => ['open','faulted'].includes(r.status)), 'Await all reviews');
      round(p, 'final', null, { artifact: text(command.artifact, 'trusted final snapshot'), milestones: all.map(m => ({id:m.id,planVersion:m.planVersion,artifact:m.acceptedArtifact})) });
      p.status = 'final-review';
    } else if (kind === 'vote') {
      check(actor.role === 'reviewer' && p.reviewers.some(r => r.id === actor.reviewer), 'Reviewer required');
      const r = activeRound(p, command.round);
      check(command.generation === r.generation, 'Stale review generation');
      check(!Object.hasOwn(r.votes, actor.reviewer), 'Reviewer has already voted');
      check(typeof command.pass === 'boolean', 'Verdict must be boolean');
      const affected = [...new Set(command.affected ?? [])];
      if (r.kind === 'final' && !command.pass) check(affected.length > 0 && affected.every(id => p.milestones[id]?.status === 'passed'), 'Final rejection must identify existing passed milestones');
      r.votes[actor.reviewer] = { pass: command.pass, findings: text(command.findings, 'review evidence'), affected };
      settle(p, r);
    } else if (kind === 'review-fault') {
      check(actor.role === 'reviewer' && p.reviewers.some(r => r.id === actor.reviewer), 'Reviewer required');
      const r = activeRound(p, command.round); check(command.generation === r.generation, 'Stale review generation');
      check(!r.votes[actor.reviewer], 'Review already submitted');
      const attempt = integer(command.attempt, 'attempt');
      check(attempt === (r.attempts[actor.reviewer] ?? 0) + 1, 'Duplicate or out-of-order failure');
      r.attempts[actor.reviewer] = attempt;
      r.faults[actor.reviewer] = text(command.error, 'review error');
      // Initial failed attempt + N automatic retries. Failures never become votes.
      if (attempt > p.faultRetries) { r.status = 'faulted'; notify(p, 'fault', '监督者重试后仍失败，相关审查已暂停。', r.milestone).round=r.id; }
    } else if (kind === 'resume-review') {
      user(); const r = p.rounds[command.round]; check(r?.status === 'faulted', 'Review is not faulted');
      r.status = 'open'; r.generation++; r.attempts = {}; r.faults = {}; // Existing authenticated votes remain valid for the same artifact.
    } else if (kind === 'extend') {
      user(); check(m?.status === 'paused', 'Milestone is not paused');
      m.limit += integer(command.additional, 'additional rounds'); m.status = m.planVersion ? 'work' : 'unplanned';
      notify(p, 'record', `用户追加 ${command.additional} 次审查机会。`, m.id);
    } else if (kind === 'cancel-milestone') {
      user(); check(m, 'Unknown milestone');
      check(!Object.values(p.tasks).some(t => t.status === 'running'), 'Quiesce running tasks before cancellation');
      check(!Object.values(p.milestones).some(other => other.deps.includes(m.id) && other.status !== 'cancelled'), 'Resolve dependent milestones before cancellation');
      check(!Object.values(p.rounds).some(r => r.milestone !== m.id && ['open','faulted'].includes(r.status) && ['plan','change'].includes(r.kind) && r.payload.definition.deps.includes(m.id)), 'Resolve pending dependent plans before cancellation');
      m.status = 'cancelled';
      for (const r of Object.values(p.rounds)) if (r.milestone === m.id && ['open','faulted'].includes(r.status)) r.status = 'stale';
      invalidate(p, m.id);
    } else if (kind === 'configure') {
      user();
      check(!Object.values(p.tasks).some(t => t.status === 'running'), 'Quiesce running tasks before changing locked rules');
      if (command.objective !== undefined) p.objective = text(command.objective, 'objective');
      if (command.reviewers !== undefined) {
        check(Array.isArray(command.reviewers) && command.reviewers.length > 0 && command.reviewers.length <= 20, 'Need 1–20 reviewers');
        const reviewers = command.reviewers.map(r => ({id:key(r.id),name:text(r.name,'name'),responsibility:text(r.responsibility,'responsibility'),criteria:text(r.criteria,'criteria')}));
        check(new Set(reviewers.map(r => r.id)).size === reviewers.length, 'Duplicate reviewer');
        p.reviewers = reviewers;
      }
      p.configVersion++;
      for (const r of Object.values(p.rounds)) if (['open','faulted'].includes(r.status)) r.status = 'stale';
      for (const m of Object.values(p.milestones)) if (!['paused','cancelled'].includes(m.status)) m.status = m.planVersion ? 'work' : 'unplanned';
      p.status = 'running';
      notify(p, 'record', '用户修改了开局规则，旧验收失效，需要重新审查。');
    } else if(kind === 'resume-coordinator') {
      user();check(p.status==='running','Project is not running');
      text(command.reason,'coordinator recovery reason');
      const n=p.notifications.find(n=>n.id===command.notification && n.kind==='fault' && !n.resolved);
      const incident=Object.entries(s.runtimeIncidents??{}).find(([key,value])=>key.startsWith(`${p.id}:stalled:coordinator:`) && value.notificationId===n?.id && value.message!==null);
      check(n && incident,'An active coordinator-stall notification is required');
      p.coordinatorWake=(p.coordinatorWake??0)+1;
      p.coordinatorRecovery={notification:command.notification,reason:command.reason};
      incident[1].message=null;n.resolved=true;n.acknowledged=true;
    } else if (kind === 'cancel') { user(); p.status = 'cancelled'; }
    else if (kind === 'ack') { user(); const n = p.notifications.find(n => n.id === command.notification); check(n, 'Unknown notification'); n.acknowledged = true; }
    else if (kind === 'deliver') { user(); check(p.status === 'approved', 'Final approval is required'); p.status = 'delivered'; }
    else throw new Error(`Unsupported command: ${kind}`);
    }
  }
  const p = s.projects[command.project ?? command.id];
  resolveObsoleteNotifications(p);
  p.audit.push({ id: randomUUID(), time: new Date().toISOString(), actor: actor.role, actorId: actor.id ?? 'user', command: copy(command) });
  s.revision++;
  return s;
}

export function projectView(state, id) {
  const p = copy(state.projects[id]); check(p, 'Unknown project');
  for (const m of Object.values(p.milestones)) m.blockedBy = m.deps.filter(id => p.milestones[id].status !== 'passed');
  return p;
}
