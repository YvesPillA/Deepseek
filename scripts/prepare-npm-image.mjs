// Explicit HOST provisioning, never exposed as an execution-agent tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {npmProfile,dependencyDockerfile} from '../src/dependency-profile.mjs';
import {dockerCli} from '../src/docker-cli.mjs';
import {buildDependencies} from '../src/dependency-build.mjs';
const [workspace,baseReference]=process.argv.slice(2);
if(!workspace || !path.isAbsolute(workspace))throw Error('Pass an absolute project directory and pinned node@sha256 base');
async function manifest(name) {
  const target=path.join(workspace,name),stat=await fs.lstat(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4*1024*1024)throw Error('Manifest must be a bounded plain file');
  return fs.readFile(target,'utf8');
}
const profile=npmProfile(await manifest('package.json'),await manifest('package-lock.json'));
const dockerfile=dependencyDockerfile(baseReference,profile);
const root=fileURLToPath(new URL('../artifacts/npm-images/',import.meta.url));await fs.mkdir(root,{recursive:true});
const context=await fs.mkdtemp(path.join(root,'context-')),configDirectory=path.join(context,'cli-config');await fs.mkdir(configDirectory,{recursive:true});
await fs.writeFile(path.join(context,'package.json'),profile.packageJson);
await fs.writeFile(path.join(context,'package-lock.json'),profile.lockJson);
await fs.writeFile(path.join(context,'Dockerfile'),dockerfile);
await fs.writeFile(path.join(context,'.dockerignore'),'*\n!Dockerfile\n!package.json\n!package-lock.json\n');
const resources=path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources');
await fs.access(path.join(resources,'cli-plugins/docker-buildx.exe'));
await fs.writeFile(path.join(configDirectory,'config.json'),JSON.stringify({cliPluginsExtraDirs:[path.join(resources,'cli-plugins')]}));
const cli=dockerCli({executable:path.join(resources,'bin/docker.exe'),configDirectory});
const tag='dsh-foreman-deps:'+randomUUID();
async function persist(report) {
  const pending=path.join(context,'report.pending'),handle=await fs.open(pending,'w');
  try {await handle.writeFile(JSON.stringify(report,null,2));await handle.sync();} finally {await handle.close();}
  await fs.rename(pending,path.join(context,'report.json'));
}
const record={status:'prepared',tag,baseReference,fingerprint:profile.fingerprint,context,workspace,configDirectory};
await persist(record);
console.log('Provisioning exact manifest profile '+profile.fingerprint+' (scripts disabled).');
const report=await buildDependencies({cli,record,persist,saveLog:log=>fs.writeFile(path.join(context,'build.log'),log)});
console.log(JSON.stringify(report,null,2));
