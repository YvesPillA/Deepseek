import fs from 'node:fs/promises';
const root=new URL('../artifacts/npm-fixture/',import.meta.url);await fs.mkdir(root,{recursive:true});
const response=await fetch('https://registry.npmjs.org/is-number/7.0.0');if(!response.ok)throw Error('Registry metadata unavailable');
const metadata=await response.json();
const pkg={name:'foreman-dependency-fixture',version:'1.0.0',private:true,dependencies:{'is-number':'7.0.0'},
  scripts:{postinstall:"node -e \"require('fs').writeFileSync('SCRIPT_RAN','bad')\""}};
const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies,hasInstallScript:true},
  'node_modules/is-number':{version:'7.0.0',resolved:metadata.dist.tarball,integrity:metadata.dist.integrity,engines:metadata.engines}}};
await fs.writeFile(new URL('package.json',root),JSON.stringify(pkg,null,2));await fs.writeFile(new URL('package-lock.json',root),JSON.stringify(lock,null,2));
await fs.writeFile(new URL('test.cjs',root),"const assert=require('node:assert/strict'),fs=require('node:fs');assert.equal(require('is-number')('42'),true);assert(!fs.existsSync('/home/node/foreman-deps/SCRIPT_RAN'));assert(Object.values(require('node:os').networkInterfaces()).flat().every(i=>i.internal));console.log('dependency loaded offline; lifecycle script did not run')");
console.log('Prepared public npm fixture at '+root.pathname);
