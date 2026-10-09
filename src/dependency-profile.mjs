import {createHash} from 'node:crypto';
const check=(ok,message)=>{if(!ok)throw Error(message);};
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
export const DEPENDENCY_LABEL='dsh-foreman.npm-profile';
export const DEPENDENCY_DIRECTORY='/home/node/foreman-deps/node_modules';
export function npmProfile(packageJson,lockJson) {
  check(typeof packageJson==='string' && typeof lockJson==='string' && packageJson.length+lockJson.length<=4*1024*1024,'Bounded npm manifests required');
  const pkg=JSON.parse(packageJson),lock=JSON.parse(lockJson);
  check(plain(pkg) && plain(lock) && lock.lockfileVersion===3 && plain(lock.packages) && plain(lock.packages['']),'npm lockfile version 3 required');
  check(!pkg.workspaces && !pkg.overrides && !pkg.bundleDependencies && !pkg.bundledDependencies,'Workspaces, overrides and bundled dependencies are not supported yet');
  for(const [key,item] of Object.entries(lock.packages)) {
    check(plain(item),'Invalid locked package');
    for(const group of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) {
      for(const value of Object.values(item[group]??{}))check(typeof value==='string' && !/(?:file:|link:|git|https?:|workspace:)/i.test(value),'Only registry dependency specifications supported');
    }
    if(key==='')continue;
    check(key.startsWith('node_modules/') && key.split('/').every(p=>p && !['.','..'].includes(p) && !/[\\:\x00-\x1f]/.test(p)),'Unsafe dependency path');
    check(!item.link && !item.inBundle && !item.hasInstallScript,'Linked, bundled or install-script dependencies require a different provisioning profile');
    const url=new URL(item.resolved);
    check(url.protocol==='https:' && url.hostname==='registry.npmjs.org' && !url.port && !url.username && !url.password && !url.search && !url.hash,'Only locked public npm registry tarballs are supported');
    check(typeof item.integrity==='string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity),'SHA-512 package integrity required');
  }
  for(const group of ['dependencies','devDependencies','optionalDependencies']) {
    const entries=pkg[group]??{};check(plain(entries),'Invalid dependency group');
    for(const value of Object.values(entries))check(typeof value==='string' && !/(?:file:|link:|git|https?:|workspace:)/i.test(value),'Only registry dependency specifications supported');
    const canonical=o=>JSON.stringify(Object.entries(o??{}).sort(([a],[b])=>a.localeCompare(b)));
    check(canonical(entries)===canonical(lock.packages[''][group]),'Package and lock dependency declarations differ');
  }
  const fingerprint=createHash('sha256').update(JSON.stringify([packageJson,lockJson])).digest('hex');
  return {fingerprint,packageJson,lockJson};
}
export function profileFromFiles(files) {
  const p=files.find(f=>f.path==='package.json'),l=files.find(f=>f.path==='package-lock.json');
  if(!p)return null;
  const packageJson=Buffer.from(p.base64,'base64').toString('utf8'),pkg=JSON.parse(packageJson);
  if(!l) {
    check(!['dependencies','devDependencies','optionalDependencies'].some(k=>Object.keys(pkg[k]??{}).length),'Dependencies require package-lock.json and a prepared image');
    return null;
  }
  return npmProfile(packageJson,Buffer.from(l.base64,'base64').toString('utf8'));
}
export function dependencyDockerfile(baseReference,profile) {
  check(/^node@sha256:[a-f0-9]{64}$/.test(baseReference),'Pinned official Node base reference required');
  check(/^[a-f0-9]{64}$/.test(profile.fingerprint),'Invalid profile fingerprint');
  return ['FROM '+baseReference,'USER node','RUN mkdir -p /home/node/foreman-deps','WORKDIR /home/node/foreman-deps',
    'COPY --chown=node:node package.json package-lock.json ./',
    'RUN npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --cache=/tmp/npm-cache && rm -rf /tmp/npm-cache',
    'LABEL '+DEPENDENCY_LABEL+'='+profile.fingerprint,''].join('\n');
}
