import fs from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const approved=new WeakMap();
const nodeFileSystem={promises:fs,lstatSync};
const require=createRequire(import.meta.url);
function archiveFileSystem() {
  // Electron makes app.asar appear to be a virtual directory. Identity,
  // hashing and package-header reads must observe the real archive bytes.
  // A real Electron process must obtain its official unpatched interface;
  // only ordinary Node contract tests use the native Node fallback.
  return process.versions.electron?require('original-fs'):nodeFileSystem;
}
const check=(ok,message)=>{if(!ok)throw Error(message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const inside=(root,target)=>{const rel=path.relative(root,target);return !rel || rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const shape=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const fingerprint=(s,inventory=false)=>JSON.stringify([s.dev,s.ino,s.birthtimeMs,s.isFile(),s.isDirectory(),
  ...(s.isFile()||inventory?[s.size,s.mtimeMs,s.ctimeMs]:[])]);
function relative(value) {
  check(typeof value==='string' && value.length>0 && value.split('/').every(p=>p && !['.','..'].includes(p) &&
    !/[\\:\x00-\x1f<>"|?*]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)),
  'Release plugin file path is invalid');return value;
}

/** Only objects issued here can open readiness. Cheap stat witnesses invalidate a
 * startup approval when any approved file, directory inventory or path changes.
 * Revalidation requires a fresh host read; model-supplied {valid:true} is rejected.
 */
export function isReleaseApprovalValid(value) {
  const witnesses=approved.get(value);if(!witnesses)return false;
  try {for(const [file,expected] of witnesses) {
    const stat=expected.lstatSync(file);if(stat.isSymbolicLink() || fingerprint(stat,expected.inventory)!==expected.stamp){approved.delete(value);return false;}
  }return true;}catch{approved.delete(value);return false;}
}

/** Trusted host-only, read-only release check. Runtime target cannot come from
 * config/receipt: only the actual Electron process supplies resourcesPath.
 * Second-argument overrides are test/host capabilities, never RPC/tool inputs.
 */
export async function verifyReleaseApproval({approvalPath,dshHome,storageRoot,verificationImage,verificationBackend='docker'}={},
  {runtime=()=>({resourcesPath:process.resourcesPath,electron:process.versions.electron}),
    pluginRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')}={}) {
  const witnesses=new Map();
  function observe(file,stat,inventory=false,fileSystem=nodeFileSystem) {
    const previous=witnesses.get(file);
    check(!previous || previous.stamp===fingerprint(stat,previous.inventory),'Release targets changed during validation');
    const mode=inventory||previous?.inventory||false;
    witnesses.set(file,{stamp:fingerprint(stat,mode),inventory:mode,lstatSync:fileSystem.lstatSync});
  }
  async function ordinary(file,kind,fileSystem=nodeFileSystem) {
    const io=fileSystem.promises;
    check(typeof file==='string' && path.isAbsolute(file),'Release paths must be absolute');
    const absolute=path.resolve(file),root=path.parse(absolute).root;
    const parts=path.relative(root,absolute).split(path.sep).filter(Boolean);
    // Only the actual runtime archive may use Electron's archive namespace.
    // Approval, evidence and plugin files must be physical host paths; reject
    // virtual ASAR ancestors before patched stats can hide physical links.
    if(process.versions.electron && fileSystem===nodeFileSystem)
      check(!parts.some(part=>/\.asar$/i.test(part)),'Release protected/plugin paths cannot use Electron virtual archives');
    let cursor=root;
    for(let i=-1;i<parts.length;i++) {
      if(i>=0)cursor=path.join(cursor,parts[i]);
      const stat=await io.lstat(cursor);
      check(!stat.isSymbolicLink(),'Release paths cannot contain links');
      check(i<parts.length-1?stat.isDirectory():kind==='file'?stat.isFile():stat.isDirectory(),'Release path has an unexpected type');
      if(stat.isFile())check(stat.nlink===1,'Release files cannot be hard-linked');
      // Ancestors may host unrelated files; retain their identity and reject
      // later link substitution without invalidating ordinary journal writes.
      observe(cursor,stat,false,fileSystem);
    }
    check(await io.realpath(absolute)===absolute,'Release path resolves to another target');
    return absolute;
  }
  async function bytes(file,max=1024*1024) {
    const absolute=await ordinary(file,'file'),before=witnesses.get(absolute).stamp;
    const stat=await fs.stat(absolute);check(stat.size<=max,'Release record is too large');
    const value=await fs.readFile(absolute);
    check(fingerprint(await fs.lstat(absolute))===before,'Release targets changed during validation');
    return value;
  }
  async function fileHash(file,fileSystem=nodeFileSystem) {
    const io=fileSystem.promises;
    const absolute=await ordinary(file,'file',fileSystem),before=witnesses.get(absolute).stamp;
    const handle=await io.open(absolute,'r');
    try {
      // Read through this opened descriptor so archive bytes and the final
      // identity witness use the same raw file-system interface in Electron.
      const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let position=0;
      for(;;) {
        const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;
        hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;
      }
      check(fingerprint(await io.lstat(absolute))===before,'Release targets changed during validation');return hash.digest('hex');
    } finally {await handle.close();}
  }
  try {
    check(['docker','native'].includes(verificationBackend),'Release verification backend is invalid');
    const info=runtime();check(typeof info?.electron==='string' && !!info.electron &&
      typeof info.resourcesPath==='string' && path.isAbsolute(info.resourcesPath),'Release validation requires the actual Electron host');
    const roots=[];
    for(const root of [dshHome,storageRoot])if(root!==undefined)roots.push(await ordinary(root,'directory'));
    check(roots.length>0,'Protected release storage is required');
    const protectedFile=async file=>{
      check(typeof file==='string' && path.isAbsolute(file) && roots.some(root=>inside(root,path.resolve(file))),
        'Release approval and evidence must be inside protected host storage');
      return ordinary(file,'file');
    };
    await protectedFile(approvalPath);
    const record=JSON.parse((await bytes(approvalPath,512*1024)).toString('utf8'));
    if(verificationBackend==='native') {
      check(shape(record,['version','approved','runtime','plugin','verification','evidence']) &&
        record.version===2 && record.approved===true,'Explicit native release approval v2 is required');
      check(shape(record.verification,['backend','platform','sandbox']) &&
        record.verification.backend==='native' && record.verification.platform==='win32' &&
        record.verification.sandbox==='windows-acl' && process.platform==='win32','Release native verification identity mismatch');
    } else {
      check(shape(record,['version','approved','runtime','plugin','verificationImage','evidence']) &&
        record.version===1 && record.approved===true,'Explicit Docker release approval v1 is required');
      check(/^sha256:[a-f0-9]{64}$/.test(verificationImage??'') && record.verificationImage===verificationImage,'Release verification image mismatch');
    }
    check(shape(record.runtime,['version','buildCommit','asarSha256']) && sha(record.runtime.asarSha256) &&
      /^[a-f0-9]{40}$/.test(record.runtime.buildCommit??''),'Release runtime identity is invalid');
    const archiveFs=archiveFileSystem();
    const archive=path.join(await ordinary(info.resourcesPath,'directory',archiveFs),'app.asar');
    check(await fileHash(archive,archiveFs)===record.runtime.asarSha256,'Release runtime archive hash mismatch');
    // Read only the root package.json from the actual archive, never a sidecar
    // extraction or receipt-supplied version. The asar is already hash-bound.
    const handle=await archiveFs.promises.open(archive,'r');let appPackage;
    try {
      const prefix=Buffer.alloc(16);check((await handle.read(prefix,0,16,0)).bytesRead===16,'Invalid desktop archive');
      const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
      check(headerSize>=8 && headerSize<=32*1024*1024 && jsonSize>0 && jsonSize<=headerSize-8,'Invalid desktop archive header');
      const headerBytes=Buffer.alloc(jsonSize);check((await handle.read(headerBytes,0,jsonSize,16)).bytesRead===jsonSize,'Truncated desktop archive');
      const entry=JSON.parse(headerBytes.toString('utf8')).files?.['package.json'],offset=Number(entry?.offset);
      check(entry && !entry.link && !entry.unpacked && Number.isSafeInteger(entry.size) && entry.size>0 && entry.size<=1024*1024 &&
        Number.isSafeInteger(offset) && offset>=0,'Invalid desktop archive package');
      const contents=Buffer.alloc(entry.size);check((await handle.read(contents,0,entry.size,8+headerSize+offset)).bytesRead===entry.size,'Truncated desktop package');
      appPackage=JSON.parse(contents.toString('utf8'));
    } finally {await handle.close();}
    check(appPackage.version===record.runtime.version && (appPackage.dshBuildCommit??appPackage.buildCommit)===record.runtime.buildCommit,
      'Release runtime version or build mismatch');
    check(shape(record.plugin,['name','version','manifestSha256','files']) && sha(record.plugin.manifestSha256) &&
      Array.isArray(record.plugin.files) && record.plugin.files.length>0 && record.plugin.files.length<=20000,'Release plugin identity is invalid');
    pluginRoot=await ordinary(pluginRoot,'directory');
    const manifestBytes=await bytes(path.join(pluginRoot,'package.json'));
    check(digest(manifestBytes)===record.plugin.manifestSha256,'Release plugin manifest hash mismatch');
    const manifest=JSON.parse(manifestBytes.toString('utf8'));
    check(manifest.name===record.plugin.name && manifest.version===record.plugin.version && Array.isArray(manifest.files),
      'Release plugin manifest identity mismatch');
    const actual=new Set(['package.json']);
    async function inventory(rel) {
      relative(rel);const target=path.join(pluginRoot,...rel.split('/')),stat=await fs.lstat(target);
      check(!stat.isSymbolicLink(),'Release plugin inventory contains a link');
      if(stat.isDirectory()) {
        await ordinary(target,'directory');
        observe(target,stat,true);
        for(const name of (await fs.readdir(target)).sort())await inventory(rel+'/'+name);
      } else {check(stat.isFile(),'Release plugin inventory is not ordinary files');actual.add(rel);check(actual.size<=20000,'Release plugin inventory is too large');}
    }
    for(const entry of manifest.files)await inventory(entry);
    const expected=new Set();
    for(const entry of record.plugin.files) {
      check(shape(entry,['path','sha256']) && sha(entry.sha256),'Release plugin file record is invalid');
      relative(entry.path);check(!expected.has(entry.path) && actual.has(entry.path),'Release plugin inventory mismatch');expected.add(entry.path);
      check(await fileHash(path.join(pluginRoot,...entry.path.split('/')))===entry.sha256,'Release plugin file hash mismatch');
    }
    check(actual.size===expected.size,'Release plugin inventory mismatch');
    const evidenceKinds=['desktopUI','recovery','projectFinal','regression'];
    check(shape(record.evidence,evidenceKinds),'All four release acceptance records are required');
    for(const kind of evidenceKinds) {
      const evidence=record.evidence[kind];check(shape(evidence,['path','sha256']) && sha(evidence.sha256),'Release acceptance record is invalid');
      await protectedFile(evidence.path);check(await fileHash(evidence.path)===evidence.sha256,'Release acceptance evidence hash mismatch');
    }
    const value=Object.freeze({valid:true,blockers:Object.freeze([])});approved.set(value,witnesses);
    check(isReleaseApprovalValid(value),'Release targets changed during validation');return value;
  } catch(error) {
    const message=['ENOENT','EACCES','EPERM'].includes(error?.code)?'Release approval or its acceptance records are unavailable.':
      error instanceof SyntaxError?'Release approval or its target metadata is invalid JSON.':error.message;
    return Object.freeze({valid:false,blockers:Object.freeze([Object.freeze({id:'release-validation',message})])});
  }
}
