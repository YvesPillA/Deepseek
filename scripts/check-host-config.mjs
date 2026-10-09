// Read-only checks against DSH; all generated state stays in a new scratch root.
// Does not mount agents, start a scheduler, call a model or modify the live journal.
import fs from 'node:fs/promises';
import path from 'node:path';
import {openApplication} from '../src/application.mjs';

const [file]=process.argv.slice(2);
if(!file || process.argv.length!==3)throw Error('Usage: check-host-config.mjs CONFIG_JSON');
const config=JSON.parse(await fs.readFile(file,'utf8'));
const root=await fs.mkdtemp(path.resolve('artifacts/host-config-check-'));
const builds=path.join(root,'dependency-builds');await fs.mkdir(builds);
const app=await openApplication({...config,storageRoot:path.join(root,'journal'),
  verification:{...config.verification,dependencyBuildRoot:builds}});
try {
  const result={scratchRoot:root,applicationAssembled:true,filePipelineConfigured:app.filePipelineConfigured,
    verificationConfigured:!!app.verification,dependencyApprovalConfigured:!!app.dependencies,
    dependencyProvisioningConfigured:!!app.provisioner,liveConfigurationChanged:false,modelCalls:0,
    limits:['Uses scratch journal and build directory; live target directories not provisioned.',
      'No agent/model authentication, real UI, command execution or dependency build tested.']};
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await app.close();}
