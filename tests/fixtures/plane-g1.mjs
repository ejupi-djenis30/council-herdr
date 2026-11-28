export const installationId = 'c0a965ae-f134-4ded-8a66-ab60c366695f';
export const profile = Object.freeze({
  instanceId: '9ae0150d-c566-455e-b991-fac117de3586', instanceLabel: 'Planning', origin: 'http://127.0.0.1:4321',
  workspaceSlug: 'example', workspaceId: '1ed988c2-4fd6-4ade-9720-43b5df90a526',
  projectKey: 'COU', projectId: 'bab52525-0551-4a70-bc63-0e1cf62773b6',
  principalId: '367d4046-9ff7-4d0f-8f05-5d49cb118628', allowedRoles: ['member']
});
export const issueIds = ['93518572-91eb-4f28-bfb4-54016953885a', '4a91b83c-5d1e-431c-be8c-79bdc35bb8fe'];
// Shape fixtures for G1 configuration/grammar only. Online verification belongs to G2.
export const github = {
  registry: { fullName: 'example/council', id: 111111, public: true },
  repository: { id: 111111, full_name: 'example/council', private: false },
  pull: { number: 31, html_url: 'https://github.com/example/council/pull/31', base: { repo: { id: 111111 } } },
  commit: { sha: 'a'.repeat(40), html_url: `https://github.com/example/council/commit/${'a'.repeat(40)}` },
};
export function fixtureTransport(p = profile, mutate = () => {}) {
  const calls = [];
  const state = { calls, posts: 0, planningWrites: 0 };
  state.get = async route => {
    calls.push(['GET', route]);
    const base = `/api/v1/workspaces/${p.workspaceSlug}`;
    let body;
    if (route === '/api/v1/users/me/') body = { id: p.principalId };
    else if (route === `${base}/projects/${p.projectId}/`) body = { id: p.projectId, workspace: p.workspaceId, identifier: p.projectKey, archived_at: null, deleted_at: null, member_role: 'member' };
    else {
      const n = [12, 13].find((seq, i) => route === `${base}/work-items/${p.projectKey}-${seq}/` || route === `${base}/projects/${p.projectId}/work-items/${issueIds[i]}/`);
      if (n) body = { id: issueIds[n - 12], workspace: p.workspaceId, project: p.projectId, sequence_id: n, archived_at: null, deleted_at: null, is_draft: false };
    }
    const response = body ? { status: 200, redirected: false, body } : { status: 404, body: {} };
    mutate(route, response);
    return response;
  };
  return state;
}
