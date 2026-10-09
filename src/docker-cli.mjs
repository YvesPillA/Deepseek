import {spawn} from 'node:child_process';
import path from 'node:path';

/** Host-only process adapter. Always targets the local Linux Docker daemon;
 * never inherits Docker contexts, remote endpoints, or model credentials. */
export function dockerCli({executable,configDirectory,platform=process.platform}) {
  if(!path.isAbsolute(executable)||!path.isAbsolute(configDirectory))throw new Error('Absolute Docker executable and private config directory required');
  if(!['win32','linux'].includes(platform))throw new Error('Unsupported Docker host');
  const endpoint=platform==='win32'?'npipe:////./pipe/dockerDesktopLinuxEngine':'unix:///var/run/docker.sock';
  const env={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH','Path'])if(process.env[key])env[key]=process.env[key];
  return (args,{input,signal,maxOutputBytes=1024*1024,timeoutMs=10000}={})=>new Promise((resolve,reject)=>{
    if(!Array.isArray(args)||!args.every(a=>typeof a==='string'&&!a.includes('\0')) ||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>900000 ||
      !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>1024*1024){reject(new Error('Invalid host CLI request'));return;}
    if(signal?.aborted){reject(signal.reason);return;}
    let child,timer,error,total=0,truncated=false;const stdout=[],stderr=[];
    const stop=reason=>{error??=reason;child?.kill();};
    const abort=()=>stop(signal.reason??new Error('Docker operation aborted'));
    try {child=spawn(executable,['--host',endpoint,'--config',configDirectory,...args],{shell:false,windowsHide:true,env,stdio:['pipe','pipe','pipe']});}
    catch(e){reject(e);return;}
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>stop(new Error('Docker operation timed out')),timeoutMs);
    const collect=list=>chunk=>{const keep=Math.max(0,Math.min(chunk.length,maxOutputBytes-total));if(keep)list.push(chunk.subarray(0,keep));total+=keep;if(keep<chunk.length)truncated=true;};
    child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
    child.on('error',e=>{error??=e;});
    child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop(e);});
    child.on('close',(exitCode,exitSignal)=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve({exitCode,signal:exitSignal,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),truncated});
    });
    if(signal?.aborted)abort();
    child.stdin.end(input);
  });
}
