import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';

// DSH_RUNTIME_ROOT accepts either an extracted desktop dsh directory or the
// installed CLI package directory. Defaults preserve the 0.1.7 test lane.
export function selectDshRuntime(env=process.env) {
  const root=path.resolve(env.DSH_RUNTIME_ROOT??env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh');
  const packageFile=path.join(root,'package.json');
  const pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
  if(!['@deepseek-ai/dsh','@deepseek-ai/dsh-desktop-runtime'].includes(pkg.name))throw Error('Expected DSH runtime package');
  const requireDsh=createRequire(packageFile);
  const cli=path.join(path.dirname(requireDsh.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js');
  if(!fs.statSync(cli).isFile())throw Error('Missing DSH CLI');
  return {root,packageFile,version:pkg.version,cli,requireDsh,load:async name=>import(pathToFileURL(requireDsh.resolve(name.startsWith('@')?name:'@deepseek-ai/'+name)).href)};
}
export function parseRuntimeYaml(runtime,text) {return runtime.requireDsh('js-yaml').load(text);}
export function modelProfilePatch(env=process.env) {return env.DSH_MODEL_PROFILE_PATCH??'C:/example/dsh/home/profiles/web/cordis.patch.yml';}
export async function recordFixtureRuntime(root,runtime=selectDshRuntime()) {
  await fs.promises.writeFile(path.join(root,'fixture-runtime.json'),JSON.stringify({root:runtime.root,version:runtime.version,cli:runtime.cli},null,2)+'\n');
}
export async function copyFixturePlugin(project,root,runtime=selectDshRuntime()) {
  const target=path.join(root,'fixture-plugin');await fs.promises.mkdir(target);
  for(const item of ['package.json','src','client','presets'])await fs.promises.cp(path.join(project,item),path.join(target,item),{recursive:true});
  const packages=path.join(target,'node_modules');await fs.promises.mkdir(path.join(packages,'@deepseek-ai'),{recursive:true});
  for(const name of ['@deepseek-ai/dsh-scope','react','koffi']) {
    let source;
    try{
      source=path.dirname(runtime.requireDsh.resolve(name));
      while(!fs.existsSync(path.join(source,'package.json'))||JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).name!==name) {
        const parent=path.dirname(source);if(parent===source)throw Error('Missing runtime peer: '+name);source=parent;
      }
    }
    catch(error){if(name==='react'&&error.code==='MODULE_NOT_FOUND')continue;throw error;}
    await fs.promises.symlink(source,path.join(packages,...name.split('/')),'junction');
  }
  return target;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {root,packageFile,version,cli}=selectDshRuntime();console.log(JSON.stringify({root,packageFile,version,cli}));
}
