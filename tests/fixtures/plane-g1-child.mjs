import { createFixtureOperator } from '../../herdr/mods/council/runtime/plane-fixture.mjs';
import { profile, installationId, fixtureTransport } from './plane-g1.mjs';
import { WorkItemStore } from '../../herdr/mods/council/runtime/work-item-store.mjs';
const [project, privateRoot, itemRef] = process.argv.slice(2);
const operator = createFixtureOperator({ project, privateRoot, installationId, profile, transport: fixtureTransport(), itemExists: (root, id) => Boolean(new WorkItemStore(root).read(id, 1)) });
const candidate = await operator.resolve('wi-shared', itemRef);
process.send({ ready: true });
process.once('message', async () => {
  try { process.send({ link: await operator.confirm('wi-shared', candidate.candidateId, candidate.localRef) }); }
  catch (e) { process.send({ error: e.code }); }
  process.disconnect();
});
