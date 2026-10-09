import test from 'node:test';
import assert from 'node:assert/strict';
import {npmProfile,profileFromFiles,dependencyDockerfile} from '../src/dependency-profile.mjs';
const pkg={name:'fixture',version:'1.0.0',dependencies:{example:'1.0.0'}};
const lock={lockfileVersion:3,packages:{'':{dependencies:pkg.dependencies},'node_modules/example':{version:'1.0.0',resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-'+'a'.repeat(86)+'=='}}};
test('dependency profile binds exact manifests and generates a fixed script-disabled build',()=>{
  const p=npmProfile(JSON.stringify(pkg),JSON.stringify(lock));
  assert.notEqual(p.fingerprint,npmProfile(JSON.stringify({...pkg,description:'changed'}),JSON.stringify(lock)).fingerprint);
  const dockerfile=dependencyDockerfile('node@sha256:'+'a'.repeat(64),p);
  assert(dockerfile.includes('--ignore-scripts'));assert(dockerfile.includes('USER node'));assert(!dockerfile.includes('COPY . '));
  assert.throws(()=>dependencyDockerfile('node:latest',p),/Pinned/);
});
test('linked, scripted, credentialed, remote or unlocked dependencies fail closed',()=>{
  for(const change of [{link:true},{hasInstallScript:true},{resolved:'https://user:password@registry.npmjs.org/x'},{resolved:'http://registry.npmjs.org/x'},{resolved:'https://example.com/x'},{integrity:'sha1-abc'}]) {
    const changed=structuredClone(lock);Object.assign(changed.packages['node_modules/example'],change);
    assert.throws(()=>npmProfile(JSON.stringify(pkg),JSON.stringify(changed)));
  }
  assert.throws(()=>npmProfile(JSON.stringify({...pkg,workspaces:['x']}),JSON.stringify(lock)),/Workspaces/);
  assert.throws(()=>npmProfile(JSON.stringify({...pkg,dependencies:{example:'2.0.0'}}),JSON.stringify(lock)),/differ/);
  assert.throws(()=>profileFromFiles([{path:'package.json',base64:Buffer.from(JSON.stringify(pkg)).toString('base64')}]),/lock/);
  assert.equal(profileFromFiles([]),null);
});
