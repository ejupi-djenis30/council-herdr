import { createFixturePlane } from '../../herdr/mods/council/runtime/plane-transport-fixture.mjs';
import { createFixturePublisher } from '../../herdr/mods/council/runtime/plane-publication-fixture.mjs';
import { installationId, profile, issueIds, github } from './plane-g1.mjs';
const [project, privateRoot, mode] = process.argv.slice(2);
const target = { instanceId:profile.instanceId, origin:profile.origin, workspaceSlug:profile.workspaceSlug,
  workspaceId:profile.workspaceId, projectKey:profile.projectKey, projectId:profile.projectId,
  itemId:issueIds[0], sequence:12, authorId:profile.principalId };
const operatorId = '159be116-5033-4af6-aabf-3552ddc024e1';
const snapshot = {operationId:'00000000000000000000000000000001',itemRevision:4,linkRevision:1,status:'in_review',
  evidenceUrl:github.pull.html_url,createdAt:1000,expiresAt:301000};
const plane = createFixturePlane(target);
const pub = createFixturePublisher({privateRoot,project,installationId,itemId:'wi-shared',target,registry:github.registry,plane,operatorId,
  readCurrent:()=>({installationId,itemId:'wi-shared',itemRevision:4,linkRevision:1,status:'in_review',target}),
  acknowledgeDirectory:()=>true,now:()=>2000,hook:(point) => { if (mode === 'crash' && point === 'after_start') process.exit(73); }});
const run = async () => {
  try {
    const result = await pub.confirm(snapshot.operationId,{operatorId,approved:true,payloadDigest:pub.payloadDigest(snapshot)});
    if (process.send) process.send({state:result.state,posts:plane.snapshot().posts});
  } catch (e) { if (process.send) process.send({error:e.code,posts:plane.snapshot().posts}); }
  if (process.connected) process.disconnect();
};
if (mode === 'race') { process.send({ready:true}); process.once('message',run); }
else await run();
