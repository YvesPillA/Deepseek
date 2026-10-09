// Win32 byte-range locking: kernel releases the lock after process failure.
// No FILE_SHARE_DELETE: a live guard cannot be unlinked and replaced underneath
// its owner. FAIL_IMMEDIATELY prevents blocking the Node event loop.
let bindings;
async function api() {
  if(!bindings)bindings=(async()=>{
    const {default:koffi}=await import('koffi'),dll=koffi.load('kernel32.dll');
    const bind=(name,result,args)=>dll.func('__stdcall',name,result,args),ptr='void *';
    return {koffi,size:koffi.sizeof(ptr),
      create:bind('CreateFileW',ptr,['str16','uint32','uint32',ptr,'uint32','uint32',ptr]),
      lock:bind('LockFileEx','int',[ptr,'uint32','uint32','uint32','uint32',ptr]),
      unlock:bind('UnlockFileEx','int',[ptr,'uint32','uint32','uint32',ptr]),
      close:bind('CloseHandle','int',[ptr]),error:bind('GetLastError','uint32',[])};
  })();return bindings;
}
export async function acquireWriterGuard(file) {
  if(process.platform!=='win32')return null; // Legacy fail-closed file lock on other systems.
  const a=await api(),handle=a.create(file,0xc0000000,3,null,4,0,null);
  if(!handle || a.koffi.address(handle)===BigInt.asUintN(a.size*8,-1n))throw new Error(`Cannot open writer guard (Win32 ${a.error()})`);
  const overlapped=Buffer.alloc(a.size*3+8);
  if(!a.lock(handle,3,0,1,0,overlapped)) {
    const code=a.error();a.close(handle);
    throw new Error(`Writer lock exists or cannot be acquired (Win32 ${code})`);
  }
  let closed=false;
  return {close(){
    if(closed)return;
    const errors=[];
    if(!a.unlock(handle,0,1,0,overlapped))errors.push(new Error(`Cannot unlock writer guard (Win32 ${a.error()})`));
    if(!a.close(handle))errors.push(new Error(`Cannot close writer guard (Win32 ${a.error()})`));
    closed=true;if(errors.length)throw new AggregateError(errors,'Writer guard cleanup failed');
  }};
}

export function abandonedMarker(marker) {
  if(marker?.lockProtocol==='win32-file-v1')return true; // Caller already holds the kernel guard.
  if(!Number.isSafeInteger(marker?.pid)||marker.pid<1)throw new Error('Malformed legacy writer lock; manual recovery required');
  try{process.kill(marker.pid,0);return false;}
  catch(e){if(e.code==='ESRCH')return true;throw new Error('Cannot prove legacy writer has stopped; lock retained',{cause:e});}
}
