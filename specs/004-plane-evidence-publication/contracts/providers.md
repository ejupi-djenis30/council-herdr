# Provider protocol

## Admission and trust

The deployment profile explicitly pins the canonical Plane origin, workspace slug and UUID, project key and UUID, expected API principal UUID and allowed project role values confirmed in that deployment. Origin registration is operator-admin only. The initial deployment may use literal loopback HTTP with a pinned port and controlled local listener. A registered HTTPS origin requires valid TLS and independent deployment acceptance. The publisher takes no base URL, credential, route, headers or proxy from a request, repository, worker environment or discovery response. Ignore ambient proxy settings on this transport. Reject redirects on all requests, disable POST retries in the client and verify that the deployed intermediary does not replay POST. Apply a 10 second request deadline, disable body growth beyond 1 MiB of decoded JSON per response, and bound the full pre-Start check and reconcile runs to 60 seconds each. Reject pagination cursors over 1,024 bytes and treat exhausted budgets as unverified. Plane/GitHub provider bodies and URLs from error responses never become diagnostics. The protected key is sent only in `X-API-Key` to this Plane origin. Enroll a dedicated non-admin integration principal with the narrowest available project rights and exclusive custody of its key; gate enablement on an authorized dedicated-item write/read and forbidden-target test. Rotation uses the same expected principal. A change of principal or origin never migrates pending operations.

The trusted installed publisher reads its own pinned config and journal. In the initial Windows profile it runs interactively as a dedicated enrolled OS operator principal in a separately authenticated Windows session. Workflows and workers run under a distinct principal and cannot write the published executable, its runtime, profile, credential store or private journal, or send input to its trusted console. Only a fixed installed entry point, trusted runtime and pinned code may access the protected publisher role. Protect the session against untrusted desktop input and agent execution; test this with real distinct principals. If both surfaces share a principal/session or any enforced boundary is unproven, the sender stays disabled. A command-line actor, terminal bit, preview digest, environment flag or renderer event is insufficient. Keep the dedicated Plane key within the publisher credential boundary and redact transport errors. Normal CLI/MCP, model prompts and the Workspace never receive it. The separate COU-6 synthetic pilot supplies neither a credential nor publishing authority.

## Plane reads

All paths below begin at the exact profile origin. Encode validated individual path components. Accept canonical lowercase dashed UUIDs, strict registered slugs/project keys, and positive safe sequence numbers. Resolve the project key plus decimal sequence in the selected profile, or a canonical item UUID. Inspect only allowlisted fields from JSON.

| When | GET relative to origin | Required checks |
| --- | --- | --- |
| Scope and writer authorization | `/api/v1/users/me/` | `id` equals expected API principal for authenticated actions. |
| Scoped project | `/api/v1/workspaces/{slug}/projects/{projectUuid}/` | Exact project `id`, workspace UUID and project key `identifier`; active and undeleted; authenticated membership and allowed role from the accepted profile. |
| Human item identifier | `/api/v1/workspaces/{slug}/work-items/{projectKey}-{sequence}/` | Exact project/workspace/sequence; use returned UUID only for the next scoped read. |
| Exact item | `/api/v1/workspaces/{slug}/projects/{projectUuid}/work-items/{itemUuid}/` | Exact workspace, project, item UUID and expected sequence; `archived_at` and `deleted_at` null and `is_draft` false. |
| Reconcile | The comment collection below or its `{commentUuid}/` detail | Verify principal and original current scope first. Validate collection/detail body identities and exact receipt. |

Recheck active project/item and principal when resolving, at trusted confirmation before Start and during recovery. Binding is to UUIDs and sequence, never a lookup by name on recovery. An authorization, scope or identity failure before Start stops the operation; after Start it cannot settle it. Slug/key changes are reported as conflicts, with no routing fallback.

## GitHub verification

The only input forms are `https://github.com/{owner}/{repo}/pull/{positiveDecimal}` and `https://github.com/{owner}/{repo}/commit/{40LowerHex}`. Require the exact canonical slugs from the operator-admin registry. Reject whitespace, user info, alternate host, explicit ports, query, fragment, escapes, trailing slash, extra segments, short hashes and noncanonical numeric forms. The only verifier origin is `https://api.github.com`, with no Plane credential and no redirects. GET `/repos/{owner}/{repo}` verifies exact public slug and configured numeric repository ID. Then GET `/repos/{owner}/{repo}/pulls/{number}` or `/repos/{owner}/{repo}/commits/{sha}`. Require exact `html_url` equality and PR number plus base repo ID, or exact full commit SHA from the verified repository route. Reject unverified, unavailable, rate-limited, moved and private evidence. Verification attests the reference and repository identity; the operator asserts relevance to this work item. Verify online for preview and again before Start.

## Write and receipt

The only permitted external effect is one HTTPS or registered literal-loopback HTTP `POST` to:

    /api/v1/workspaces/{slug}/projects/{projectUuid}/work-items/{itemUuid}/comments/

Use an exact UTF-8 JSON body with these two keys, in this order for digesting. Serialize compact JSON. The example URL and operation are synthetic; the three paragraphs contain no whitespace outside the shown literals. The text URL has no HTML metacharacters under the URL grammar.

```json
{"access":"INTERNAL","comment_html":"<p>Council status: in_review</p><p>Evidence: https://github.com/example/council/pull/31</p><p>Council publication: 000000000000000000000000000000a1</p>"}
```

No external IDs, attachments, parent, mention, model content (prompt/transcript/results), title, free text, paths, key, credentials, work-item ref or revision are sent in the body. Never issue a planning field mutation or change an existing comment. INTERNAL has the deployment's verified Plane visibility semantics; verify intended audience in the dedicated-item gate.

A receipt is proof only if a returned or re-read comment has a valid UUID, exact workspace/project/issue identity, expected dedicated author in both `actor` and `created_by`, INTERNAL visibility, null parent/deleted_at/edited_at, no attachments and exact three semantic fields, including the correlation ref. Use an allowlisted parsing grammar that consumes the entire body. Start with the byte-exact rendering above; adopt only explicitly fixture-tested and deployment-observed harmless normalization, such as the evidence URL auto-linked as the exact canonical href and displayed text with no other attributes. No arbitrary HTML reconstruction or output. Normalize validated fields back to the generated bytes for the receipt digest. A successful HTTP status alone is insufficient. GET the scoped comment detail before committing a positive receipt, including when the POST provides a candidate UUID. An error, malformed response, failed readback or storage failure after Start leaves the operation uncertain.

Recovery uses bounded GET requests on the original target. A stored candidate ID from the actual POST response may seed a detail lookup. A direct positive receipt whose candidate ID was obtained in that POST response can settle immediately after scoped readback. Otherwise a pagination search must establish one unambiguous hit in the bounded completed scan and re-read it by ID. Only `per_page=50` and a bounded opaque `cursor` are permitted query parameters. Follow `next_page_results` with the next cursor as one percent-encoded parameter on the same route. Never follow a URL from the response. Limit to 10 pages, detect loops, malformed/repeated rows, overflow, scope mismatch and inconsistent page metadata. An incomplete scan, conflicting, edited or foreign marker, multiple hits or zero hits yields no receipt and zero sends. Use a stabilized deployment marker/route check with second-page match and visibility tests before enabling. A user can request another bounded scan later; no “send again”, inferred absence or force-settlement is available.
