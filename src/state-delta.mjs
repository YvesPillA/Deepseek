import {createHash,randomUUID} from 'node:crypto';

// A cursor is an ephemeral performance hint, never an authorization token.
// Object paths are arrays of literal keys; arrays are replaced atomically.
function changes(before,after,path=[],result=[]) {
  if(JSON.stringify(before)===JSON.stringify(after))return result;
  const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
  if(object(before) && object(after)) {
    for(const key of Object.keys(before))if(!Object.hasOwn(after,key))result.push({op:'remove',path:[...path,key]});
    for(const key of Object.keys(after)) {
      if(!Object.hasOwn(before,key))result.push({op:'set',path:[...path,key],value:after[key]});
      else changes(before[key],after[key],[...path,key],result);
    }
  } else result.push({op:'set',path,value:after});
  return result;
}

export function createStateDelta({maxEntries=4,maxBytes=1048576}={}) {
  if(!Number.isSafeInteger(maxEntries) || maxEntries<1 || !Number.isSafeInteger(maxBytes) || maxBytes<1)throw new Error('Invalid state delta cache bounds');
  let namespace=randomUUID();const cache=new Map();let bytes=0;
  const read=(value,sinceCursor)=>{
    // Serialize first: detached JSON values exactly match the full wire response.
    const text=JSON.stringify(value),current=JSON.parse(text),size=Buffer.byteLength(text);
    const cursor=createHash('sha256').update(namespace).update(text).digest('hex');
    const baseline=cache.get(sinceCursor);
    const full={...current,_read:{format:'foreman-state-delta-v1',full:true,cursor}};
    let response=full;
    if(baseline) {
      const delta={_read:{format:'foreman-state-delta-v1',full:false,baseCursor:sinceCursor,cursor},changes:changes(baseline.value,current)};
      // Large changes cost less as a full baseline and are easier to recover.
      if(JSON.stringify(delta).length<JSON.stringify(full).length)response=delta;
    }
    if(!cache.has(cursor) && size<=maxBytes) {
      while(cache.size>=maxEntries || bytes+size>maxBytes) {
        const oldest=cache.keys().next().value;bytes-=cache.get(oldest).size;cache.delete(oldest);
      }
      cache.set(cursor,{value:current,size});bytes+=size;
    }
    return response;
  };
  read.clear=()=>{cache.clear();bytes=0;namespace=randomUUID();};
  return read;
}
