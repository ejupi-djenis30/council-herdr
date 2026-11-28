# Research and capability evidence

## Product and baseline

The accepted [product brief](../../docs/herdr-project-product-brief.md) places link-and-post after the local decision lifecycle. It assigns local decisions to Council and title, planning state, priority and human assignees to Plane. The accepted COU-8 tree provides typed lifecycle state, current revision and integrity signals. Publishing a comment keeps this ownership boundary.

## Observations on the configured local instance

Authenticated read-only probes used the existing workspace/project and an existing tracking item. The direct current-user route answered at v1, the alternate v2 identity route did not. The project returned stable IDs, key and a membership-role field. Both scoped exact item and identifier lookup returned stable item/project/workspace IDs and item sequence. A mismatched project was denied, and a request without a key returned 401. Standard work-item and legacy issue comment-list routes returned pagination and scoped comment fields. The standard detail route returned a scoped existing comment whose actor and creator agreed. The observed project was neither archived nor deleted. The list accepted a one-item page request, but a live second page was unavailable in this read-only sample. The current read principal and observed old comment alone cannot prove other-principal behavior. The standard list advertised GET and POST. Route advertisement, project membership and reads do not establish permission to write an internal comment as a future dedicated principal.

Public GitHub repository metadata identified `Ejupi-Labs/council-herdr` as public and returned immutable repository identity. This confirms a usable verifier target for the first profile. Setup uses the observed ID in operator configuration rather than embedding tenant values in code.

No COU-9 publication, fault injection or field mutation was performed on an actual Plane work item during specification. Write/readback fidelity, pagination completeness, key isolation, deployment authorization, installed UI and restart recovery are later acceptance gates. The checked-in vectors are synthetic.

## Decisions and alternatives

| Decision | Reason |
| --- | --- |
| Canonical v1 work-item route and top-level INTERNAL comment | The installed instance supports v1 reads. The standard create documentation accepts `comment_html` and `access`. Deployment requires deployed create/readback proof before enabling. Legacy aliases and v2 are outside the adapter profile. |
| Correlation marker, local single sender and positive receipt reconciliation | A trusted idempotency guarantee is unavailable. External IDs are not part of the v1 wire contract for this feature; current v2 documentation permits duplicates. Empty results and lost acknowledgements cannot authorize retry. |
| Public GitHub evidence only, exact URL and immutable repo ID | Exact provider response identity avoids redirects, namespace drift, query data and accidental disclosure of private repository links. |
| Trusted operator console and private publisher state | Herdr and a worker can share execution credentials. Workspace button clicks, agent input, local actor strings and an ordinary command invocation under a shared principal cannot confer publishing authority. |
| Read-only default and explicit capability gates | API support and an isolated filesystem must be shown for each enabled deployment. Offline use does not require either provider. |

## Primary references

- [Plane v1 API and authentication](https://developers.plane.so/api-reference/introduction), [work-item detail](https://developers.plane.so/api-reference/issue/get-issue-detail) and [identifier lookup](https://developers.plane.so/api-reference/issue/get-issue-sequence-id)
- [Plane v1 list comments](https://developers.plane.so/api-reference/issue-comment/list-issue-comments) and [create comment](https://developers.plane.so/api-reference/issue-comment/add-issue-comment)
- [Plane v2 comment external identity semantics](https://developers.plane.so/api-reference/v2/work-item-comments/overview)
- [GitHub repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository), [pull request details](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) and [commit details](https://docs.github.com/en/rest/commits/commits#get-a-commit)
