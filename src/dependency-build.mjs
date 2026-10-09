import {DEPENDENCY_LABEL} from './dependency-profile.mjs';

const check=(ok,message)=>{if(!ok)throw Error(message);};
function identity(record) {
  check(record && /^dsh-foreman-deps:[a-f0-9-]{36}$/.test(record.tag),'Invalid dependency build tag');
  check(/^[a-f0-9]{64}$/.test(record.fingerprint),'Invalid dependency fingerprint');
}
async function inspect(cli,record) {
  const result=await cli(['image','inspect',record.tag],{timeoutMs:10000,maxOutputBytes:65536});
  check(result.exitCode===0,'Prepared image is unavailable; build outcome remains uncertain');
  const images=JSON.parse(result.stdout),image=images[0];
  check(images.length===1 && /^sha256:[a-f0-9]{64}$/.test(image?.Id) &&
    image.Os==='linux' && !(image.Config?.Volumes && Object.keys(image.Config.Volumes).length) &&
    image.Config?.Labels?.[DEPENDENCY_LABEL]===record.fingerprint,'Prepared image identity mismatch');
  return image.Id;
}

// Host-only orchestration. Persist is awaited BEFORE a build can start.
// A CLI timeout does not prove BuildKit stopped: retain an uncertain outcome.
export async function buildDependencies({cli,record,persist,saveLog,signal}) {
  identity(record);
  check(record.status==='prepared','Only a prepared build can start');
  signal?.throwIfAborted();
  const version=await cli(['buildx','version'],{timeoutMs:10000,maxOutputBytes:65536,signal});
  check(version.exitCode===0,'Docker Buildx is required; no legacy fallback');
  const started={...record,status:'building',startedAt:new Date().toISOString(),builder:'default'};
  signal?.throwIfAborted();await persist(started);
  let result;
  try {
    result=await cli(['buildx','build','--builder=default','--load','--progress=plain','--provenance=false',
      '--pull=false','--network=default','--tag',record.tag,record.context],{timeoutMs:600000,maxOutputBytes:1024*1024,signal});
  } catch(error) {
    await persist({...started,status:'uncertain',error:String(error.message).slice(0,2000)});
    throw error;
  }
  await saveLog(result.stdout+'\n'+result.stderr);
  if(result.exitCode!==0) {
    await persist({...started,status:'failed',exitCode:result.exitCode,truncated:result.truncated});
    throw Error('Dependency build failed; see build.log');
  }
  // Retain building if inspect or durable commit fails; recovery never rebuilds.
  const image=await inspect(cli,record);
  const ready={...started,status:'ready',image,completedAt:new Date().toISOString()};
  await persist(ready);return ready;
}

export async function recoverDependencyBuild({cli,record,persist}) {
  identity(record);
  check(['building','uncertain','ready'].includes(record.status),'Build has no recoverable outcome');
  const image=await inspect(cli,record);
  check(!record.image || record.image===image,'Prepared image changed after completion');
  const ready={...record,status:'ready',image,recoveredAt:new Date().toISOString()};
  await persist(ready);return ready;
}
