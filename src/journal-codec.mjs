import {createHash} from 'node:crypto';

const format='foreman-delta-v1';
const check=ok=>{if(!ok)throw Error('Corrupt journal');};
const object=value=>value!==null && typeof value==='object';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const put=(target,key,value)=>Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});

// Diff persisted JSON values, not commands: replay must never generate new IDs,
// timestamps or side effects. Appended audit entries are stored only once.
export function encodeJournal(previous,next) {
  const changes=[];
  function diff(before,after,path) {
    if(before===after)return;
    if(Array.isArray(before) && Array.isArray(after) && after.length>=before.length) {
      for(let i=0;i<before.length;i++)diff(before[i],after[i],[...path,String(i)]);
      if(after.length>before.length)changes.push({op:'append',path,length:before.length,values:after.slice(before.length)});
    } else if(object(before) && object(after) && !Array.isArray(before) && !Array.isArray(after)) {
      for(const key of Object.keys(before))if(!Object.hasOwn(after,key))changes.push({op:'remove',path:[...path,key]});
      for(const key of Object.keys(after)) {
        if(Object.hasOwn(before,key))diff(before[key],after[key],[...path,key]);
        else changes.push({op:'set',path:[...path,key],value:after[key]});
      }
    } else changes.push({op:'set',path,value:after});
  }
  diff(previous,next,[]);
  const body={format,baseRevision:previous.revision,revision:next.revision,changes};
  return {...body,checksum:hash(body)};
}

export function decodeJournal(previous,record,{inPlace=false}={}) {
  const expectedRevision=previous.revision+1;
  let next;
  if(record?.format===format) {
    const {checksum,...body}=record;
    check(checksum===hash(body) && body.baseRevision===previous.revision && body.revision===previous.revision+1 && Array.isArray(body.changes));
    // Only startup replay may mutate its unpublished state. On any error the
    // entire open fails; normal callers keep transactional, detached decoding.
    next=inPlace?previous:structuredClone(previous);
    for(const change of body.changes) {
      check(change && Array.isArray(change.path) && change.path.every(k=>typeof k==='string'));
      let target=next;
      const property=(parent,key)=>{
        check(object(parent));
        if(Array.isArray(parent))check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key)<parent.length);
      };
      const traverse=keys=>{
        for(const key of keys){property(target,key);check(Object.hasOwn(target,key));target=target[key];}
      };
      if(change.op==='append') {
        traverse(change.path);
        check(Array.isArray(target) && target.length===change.length && Array.isArray(change.values));
        for(const value of change.values)target.push(value);
      } else {
        check(change.path.length>0 && ['set','remove'].includes(change.op));
        traverse(change.path.slice(0,-1));
        const key=change.path.at(-1);property(target,key);
        if(change.op==='remove'){check(!Array.isArray(target) && Object.hasOwn(target,key));delete target[key];}
        else {check(Object.hasOwn(change,'value'));put(target,key,change.value);}
      }
    }
    check(next.revision===body.revision);
  } else {
    // Existing full-state journals remain readable; no in-place migration.
    check(record && !Object.hasOwn(record,'format'));
    next=record;
  }
  check(next.version===1 && next.revision===expectedRevision && object(next.projects) && !Array.isArray(next.projects));
  return next;
}

// Bound startup input buffering to one record plus one chunk, rather than
// loading all historical revisions into memory. Only newline commits a record.
export async function replayJournal(file,initial) {
  let state=initial,position=0,committed=0,parts=[];
  for(;;) {
    const buffer=Buffer.alloc(64*1024);
    const {bytesRead}=await file.read(buffer,0,buffer.length,position);
    if(!bytesRead)break;
    let start=0;
    for(let i=0;i<bytesRead;i++)if(buffer[i]===10) {
      parts.push(buffer.subarray(start,i));
      const line=Buffer.concat(parts).toString('utf8');
      if(line.length)state=decodeJournal(state,JSON.parse(line),{inPlace:true});
      committed=position+i+1;parts=[];start=i+1;
    }
    if(start<bytesRead)parts.push(buffer.subarray(start,bytesRead));
    position+=bytesRead;
  }
  if(committed!==position){await file.truncate(committed);await file.sync();}
  return state;
}
