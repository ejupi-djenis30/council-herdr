import { github } from './plane-g1.mjs';
import { createGitHubVerifier } from '../../herdr/mods/council/runtime/plane-github.mjs';

export function githubFixture(options = {}) {
  const calls=[];
  const state={ calls, mutate:options.mutate ?? (()=>{}), fail:null };
  const request=async args => {
    calls.push({method:args.method,origin:args.origin,path:args.path});
    if (state.fail) throw Error('fixture-private-error');
    const root=`/repos/${github.registry.fullName}`;
    let body;
    if (args.path === root) body=structuredClone(github.repository);
    else if (args.path === `${root}/pulls/31`) body=structuredClone(github.pull);
    else if (args.path === `${root}/commits/${github.commit.sha}`) body=structuredClone(github.commit);
    const response={status:body ? 200 : 404, redirected:false, body:Buffer.from(JSON.stringify(body ?? {}))};
    await state.mutate(args,response);
    return response;
  };
  state.verifier=createGitHubVerifier({registry:github.registry,request,...options.verifierOptions});
  return state;
}
