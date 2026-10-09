// FAILED diagnostic attempt: Windows 1920 prevented opening these endpoints.
// Not an automatic repair; do not run on a healthy Docker installation.
// Run only after stopping Docker Desktop. Remove the two exact transient
// endpoints identified in its startup errors; never walk Docker data folders.
import path from 'node:path';
import koffi from 'koffi';
if(process.platform!=='win32')throw Error('Windows only');
const kernel=koffi.load('kernel32.dll');
const attributes=kernel.func('__stdcall','GetFileAttributesW','uint32',['str16']);
const remove=kernel.func('__stdcall','DeleteFileW','bool',['str16']);
const error=kernel.func('__stdcall','GetLastError','uint32',[]);
const open=kernel.func('__stdcall','CreateFileW','void*',['str16','uint32','uint32','void*','uint32','uint32','void*']);
const ioctl=kernel.func('__stdcall','DeviceIoControl','bool',['void*','uint32','void*','uint32','void*','uint32','void*','void*']);
const setInfo=kernel.func('__stdcall','SetFileInformationByHandle','bool',['void*','int','void*','uint32']);
const close=kernel.func('__stdcall','CloseHandle','bool',['void*']);
for(const relative of ['Docker/run/sailor-ingest.sock','docker-secrets-engine/engine.sock']) {
  const target=path.resolve(process.env.LOCALAPPDATA,relative),flags=attributes(target);
  if(flags===0xffffffff) {const code=error();if([2,3].includes(code)){console.log('Absent: '+target);continue;}throw Error('Cannot inspect endpoint: '+code);}
  if(flags&0x10 || !(flags&0x400))throw Error('Refusing non-socket/non-reparse endpoint: '+target);
  if(!remove(target)) {
    const handle=open(target,0x10080,7,null,3,0x00200000,null);
    if(koffi.address(handle)===(1n<<BigInt(koffi.sizeof('void*')*8))-1n)throw Error('Cannot open socket reparse point: '+error());
    try {
      const data=Buffer.alloc(16384),returned=Buffer.alloc(4);
      if(!ioctl(handle,0x900a8,null,0,data,data.length,returned,null))throw Error('Cannot verify socket tag: '+error());
      if(data.readUInt32LE(0)!==0x80000023)throw Error('Refusing a non-AF_UNIX reparse point');
      if(!setInfo(handle,4,Buffer.from([1]),1))throw Error('Cannot unlink verified socket: '+error());
    } finally {close(handle);}
  }
  console.log('Removed transient endpoint: '+target);
}
