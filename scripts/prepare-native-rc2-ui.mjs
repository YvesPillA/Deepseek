// Builds an isolated full web profile for preset and settings inspection.
// No credential is copied; the profile's host never opens the project gate.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectDshRuntime,parseRuntimeYaml,recordFixtureRuntime,copyFixturePlugin} from './dsh-runtime.mjs';
const project=fileURLToPath(new URL('..',import.meta.url));
const requireDsh=selectDshRuntime().requireDsh;
const yaml={parse:text=>parseRuntimeYaml({requireDsh},text)};
const preset=yaml.parse(await fs.readFile(path.join(project,'presets/foreman-next/preset.yml'),'utf8'));
const plugins=yaml.parse(await fs.readFile(path.join(project,'presets/foreman-next/agent.cordis.yml'),'utf8'));
if(!preset?.name || !Array.isArray(plugins) || plugins.length!==1 || plugins[0]?.name!=='dsh-foreman-next/outer')throw Error('Unexpected foreman preset assets');
const root=await fs.mkdtemp('C:/example/foreman-tests/native-rc2-ui-');
const profile=path.join(root,'home/profiles/web');
await fs.mkdir(path.join(profile,'node_modules'),{recursive:true});
await fs.mkdir(path.join(root,'home/sessions'),{recursive:true});
await fs.writeFile(path.join(root,'fixture-marker'),'foreman-native-rc2-ui-offline');
const fixturePlugin=await copyFixturePlugin(project,root);
await recordFixtureRuntime(root);
await fs.symlink(fixturePlugin,path.join(profile,'node_modules/dsh-foreman-next'),'junction');
await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({name:'dsh-profile-web',private:true,
  dependencies:{'dsh-foreman-next':'file:'+fixturePlugin.replaceAll('\\','/')},
  dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}},null,2));
await fs.writeFile(path.join(profile,'cordis.yml'),'[]\n');
const patch=[{insert:[
  {id:'foreman-rc2-offline-guard',name:new URL('./native-rc2-ui-guard.mjs',import.meta.url).href,config:{root}},
  {id:'foreman-next-host',name:'dsh-foreman-next',config:{storageRoot:path.join(root,'foreman-journal'),dshHome:path.join(root,'home'),sessionRoot:path.join(root,'home/sessions')}},
  {id:'preset-foreman-next',name:'@deepseek-ai/dsh-agent-preset',config:{id:'foreman-next',...preset,plugins}},
]}];
await fs.writeFile(path.join(profile,'cordis.patch.yml'),JSON.stringify(patch,null,2));
console.log(root);
