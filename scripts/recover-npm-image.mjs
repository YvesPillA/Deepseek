// HOST-only reconciliation. Never retries a build or removes an image.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {npmProfile,dependencyDockerfile} from '../src/dependency-profile.mjs';
import {recoverDependencyBuild} from '../src/dependency-build.mjs';
import {dockerCli} from '../src/docker-cli.mjs';
const root=await fs.realpath(fileURLToPath(new URL('../artifacts/npm-images/',import.meta.url)));
const supplied=process.argv[2];
if(!supplied||!path.isAbsolute(supplied))throw Error('Pass an absolute generated context directory');
const context=await fs.realpath(supplied);
if(path.dirname(context)!==root || !path.basename(context).startsWith('context-'))throw Error('Only this plugin build context can be recovered');
async function read(name) {
  const target=path.join(context,name),stat=await fs.lstat(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4*1024*1024)throw Error('Expected bounded plain build record');
  return fs.readFile(target,'utf8');
}
const record=JSON.parse(await read('report.json'));
if(path.resolve(record.context)!==context)throw Error('Build context identity mismatch');
const profile=npmProfile(await read('package.json'),await read('package-lock.json'));
if(profile.fingerprint!==record.fingerprint || await read('Dockerfile')!==dependencyDockerfile(record.baseReference,profile))throw Error('Build inputs changed');
const configDirectory=path.join(context,'cli-config');
if(await fs.realpath(configDirectory)!==configDirectory)throw Error('Unexpected CLI config link');
const cli=dockerCli({executable:path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe'),configDirectory});
const ready=await recoverDependencyBuild({cli,record,persist:async report=>{
  const pending=path.join(context,'recovery-'+Date.now()+'.pending'),handle=await fs.open(pending,'wx');
  try {await handle.writeFile(JSON.stringify(report,null,2));await handle.sync();} finally {await handle.close();}
  await fs.rename(pending,path.join(context,'report.json'));
}});
console.log(JSON.stringify(ready,null,2));
