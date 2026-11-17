# Council — Independent Review (Junie / t10c)

Independent, read-only audit requested by the owner (Codex, `t10k`), per
`docs/owner-brief.md`. Scope: audit the baseline first, then Antigravity's
implementation once it lands on a stable hash. This document is owned by the
reviewer; the implementer must not edit it.

- **Baseline audited:** `5672d53` (`5672d5354abbf934707bff90539628be3b4680ce`), audited 2026-11-17 from a **clean detached clone** — never the implementer's working tree.
- **Baseline suite on the same clone:** `node --test tests/*.test.js` → **37/37 pass** (268 ms). The suite is green while every P0 below reproduces; it does not exercise the failure paths.
- **Implementation audit:** **pending** — will be appended after Antigravity publishes a stable commit hash. Interim WIP results are explicitly **not** attributed to any commit.

## Method and evidence limits

Each finding is labeled with the kind of evidence it rests on:

1. **Real execution** — an actual run against the audited tree (probe output files exist and are quoted verbatim).
2. **Policy validity** — a comparison between observed behavior and the owner's acceptance gates in `docs/owner-brief.md`.
3. **Limits of the proof** — what the probe does *not* establish.

Probe sources (scratch, untracked, outside the repo): orchestrator-level
probes (`junie-audit-probe.mjs` → `junie-audit-results.json`, promoted reports
dumped as `report-*.md`) and workspace-level probes
(`junie-audit-ws-probe.mjs` → `junie-audit-results-ws.json`). Each probe uses
an isolated temp workspace per case and cleans up after itself. The orchestrator
probes drive `CouncilOrchestrator.runMode` with a mock `HerdrClient` whose
`wait` payloads are the **real shapes captured from the installed `hc`**
(`.council/owner-review/hc-real-wait.json`: `working`/`ended:false`/`turn:0`,
`blocked`/`turn:0`, `idle`/`turn:0`, `done`/`turn:0`). No AI agents were
launched by the reviewer; the owner's live transport fixture
(`live-herdr-results.json`, real `hc run/get/wait/read/dismiss` PASS) is
referenced for the transport layer, not re-run here.

## Findings — baseline `5672d53`

Severity is the reviewer's, aligned with the owner's gates 1–7.

### P0-A — Wait/read outcomes ignored; votes invented; blocked agents dismissed (gates 1, 2, 7)

**Real execution.** Six orchestrator scenarios, each a full `runMode` on the
clean clone. With real `hc` wait payloads where the agent is still `working`
(`ended:false`), `blocked`, or `idle` — all at `turn:0` — or where `hc read`
fails outright, the result is identical in all five failure cases:

```json
{ "success": true, "tallyPassed": true, "approvals": 2, "amendments": 1,
  "verdict": "validated", "reportPromoted": true,
  "dismissed": ["council-author","council-skeptic","council-simplifier"] }
```

Two approve ballots with score 9 and one amend are **invented** from screen
text `(no vote text on screen)` by `parseBallotFromOutput` defaults
(`lib/modes.js`). The promoted report states `Status: completed` for all three
participants and claims *"All three council perspectives submitted artifacts"*
— while the recorded submissions are literally `(no vote text on screen)`.
Terminals are dismissed in a `finally` block, so agents that are mid-work or
blocked are **killed**, destroying recoverability (gate 7).

**Policy validity.** Violates gates 1, 2 and 7: timeout/idle/blocked/failed
read must be handled conservatively, missing votes must stay missing, and
cleanup must never erase an incomplete agent needed for recovery.

**Limits.** The herdr client is mocked (with real payload shapes); the owner's
live fixture confirms the transport behaves as modeled. Single-run per
scenario; no flakiness assessment.

### P0-B — Failed tally promoted as `conditional` success (gate 3)

**Real execution.** With two **explicit** `[VOTE: reject] [SCORE: 1]` ballots
on screen: `tallyPassed: false`, but `verdict: "conditional"`,
`validation.passed: true`, `reportPromoted: true`, and `runMode` returns
`success: true` (the MCP surface mirrors this: no `isError`). The promoted
report (`report-all-reject-explicit-votes.md`) contains:

```markdown
## Final Council Verdict & Next Actions
### Council Ratified Verdict
- **Representative Ruling**: CONDITIONAL by council-author
- **Consensus Path**: Proceed with Author's architecture, strictly observing Skeptic edge cases.
```

The only honest line — `Vote Outcome: REJECTED / UNRESOLVED` — is buried in
the tally section while the verdict section ratifies and the CLI/MCP report
success.

**Policy validity.** Violates gate 3 and the honesty requirement: a failed
quorum/approval must not be promoted, and `success`, report wording, saved
verdict, CLI exit status and MCP `isError` must agree.

**Limits.** None beyond P0-A's.

### P0-C — Ballots accepted without schema, voter, session, round, score or digest checks (gate 6)

**Real execution** (direct `AgentWorkspace` probes, real files on disk):

- **D1 — corrupt ballots count toward quorum.** One valid approve + two
  unparseable files (`{broken json`, `NaN}}}`):
  `castCount: 3, invalidCount: 2, quorumMet: true, passed: true`.
- **D2 — junk-schema JSON counted as valid.** `{vote:"approve",score:10}` with
  no schema/voter/role; a ballot with `sessionId:"OTHER-SESSION", round:99,
  voter:"someone-else"`; `{vote:"APPROVE",score:999}`:
  `validCastCount: 3, approveCount: 2, passed: true, averageScore: 339.7`.
  Nothing validates `$schema`, session id, round, voter identity, vote enum,
  or score bounds at tally time.

**Policy validity.** Violates gate 6: invalid/mismatched ballots must not
authorize promotion; a checksum proves file consistency, not authorship or
endorsement.

**Limits.** Direct API probes; the orchestrator path is covered by P0-A/B
which use the same `tallyBallots`.

### P0-D — Ballot SHA never bound to the artifact; absent artifact still passes

**Real execution.**

- **D3 — unbound SHA.** All three ballots carry
  `targetArtifactSha256: "deadbeef-wrong-sha"` while the actual artifact is
  `10d4ef2b…454`: `tallyPassed: true` **and** `validateChoice` →
  `passed: true, verdict: "validated"`. Neither `tallyBallots` nor
  `validateChoice` compares ballot digests to the artifact.
- **E1 — absent artifact.** `validateChoice` with a target artifact that does
  not exist: `artifactIntegrity: false`, `mutationDetected: false`,
  **`passed: true`**, verdict unchanged → promotion allowed.
- **E2 — control.** A genuinely mutated artifact is correctly vetoed
  (`passed: false, verdict: "vetoed", mutationDetected: true`): the mutation
*path* works; the *missing* and *mismatched* paths do not.

**Policy validity.** Violates the owner's follow-up requirements: a SHA proves
file consistency only, and an integrity failure must block promotion.

**Limits.** Direct API probes as in P0-C.

### P0-H — Marker parser attributes votes nobody expressed (gates 2, 3)

**Real execution** (adversarial screen content, requested by the owner):

- **G1 — explicit reject erased by an earlier quote.** The skeptic screen
  *quotes* the author's `[VOTE: approve] [SCORE: 9]` and then explicitly votes
  `[VOTE: reject] [SCORE: 2]`: the recorded ballot is
  `{voter: "council-skeptic", vote: "approve", score: 9}` — the parser takes
  the **first marker over the whole screen**, so the reviewer's actual vote is
  silently discarded while the run still ends `success: true, verdict:
  "validated", reportPromoted: true`.
- **G2 — vote inheritance.** The skeptic screen contains *only* a quoted vote
  from the proposal under review and no vote of their own: the skeptic is
  recorded as `approve/10`, inheriting the author's vote.
- **R1 — reviewer-failed with stale marker.** A reviewer whose turn
  failed/crashed but whose stale screen retains an `[VOTE: approve]` marker is
  recorded as a fresh approve/9; run succeeds and the report is promoted.

**Policy validity.** A vote must not be attributed to anyone who did not
express it in their own words. Until attribution is proven, the screen
fallback must be declared **non-authorizing** (it may inform but never
promote).

**Distinction vs direct ballots.** A direct `castBallot` file at least carries
explicit voter provenance (voter, session, round, schema) — but on this
baseline the tally does not validate any of it (P0-C), so *both* channels can
fabricate endorsements; only the direct channel *could* be validated.

**Related ingestion check (owner's patch check) — corrected.** A first probe
version called `readArtifact(sessionDir, {phase, author})` (wrong signature)
and wrongly concluded a `meta.json`-less artifact was invisible. With the
correct positional call `readArtifact(sessionDir, phase, author)`, baseline
`5672d53` **keeps the content and computes the SHA** of a 63-byte multiline
`artifact.md` without `meta.json`:
`{contentKept: true, verified: false, metaMissing: true, sha256: 61f62d6e…}`.
The API behaves as the owner requires; what remains broken is orchestration:
`runMode` reads only terminal screens for findings, so the direct file is
never used by the council flow (see P1-E), and its `verified: false` is not
surfaced anywhere. (Probe F1, corrected 2026-11-17 after owner review.)

**R1 attribution note (owner review).** The final R1 probe overrides
`wait` for the skeptic to `{success: false}` (agent crashed mid-turn), so the
finding is correctly attributed to a *failed reviewer turn*: the orchestrator
ignores the wait failure and still records the stale-screen approve/9,
succeeds and promotes.

**Limits.** Mocked herdr with realistic screens; parser behavior verified
end-to-end through `runMode`.

### P1-E — Reviewer handoff broken (gate 4)

**Real execution.** In every scenario the event order is
`launch(author), launch(skeptic), launch(simplifier), …` — **all reviewers are
launched before the author's artifact exists**
(`launchBeforeAuthorArtifact: true`). Reviewer briefs reference
`artifacts/draft/`, but the orchestrator persists to
`artifacts/deliberation/` (`artifactPhasesOnDisk: "deliberation"`); reviewer
ballots never reference the SHA of the proposal they allegedly reviewed, and
direct artifacts are ignored in favor of terminal screens.

**Policy validity.** Violates gate 4: a reviewer must receive the exact
proposal (content/path + SHA) being evaluated.

**Limits.** Order is observed via the mocked client's call log; the brief
content mismatch is verified on disk.

### P1-F — Synthetic ruling attributed to a representative who never deliberated (gate 5)

**Real execution.** The verdict section of every promoted report
(`report-hc-wait-timeout-working-turn0.md`,
`report-all-reject-explicit-votes.md`) is static text:
`**Representative Ruling**: VALIDATED by council-author` /
`**Consensus Path**: Proceed with Author's architecture…`. No synthesis turn
is ever run; in the all-reject case the "consensus path" is attributed to the
same author whose proposal was rejected. The election record exists but the
representative performs no evaluation.

**Policy validity.** Violates gate 5: do not attribute validation that did not
occur; an honest mechanical aggregation is acceptable if labeled as such.

**Limits.** Same as P0-A/B.

### P1-G — Launch address discarded; dismiss by fixed name (gate 7)

**Policy validity / source review.** `lib/herdr.js` `launchAgent` returns
`output: res.stdout` (containing the launched terminal's address JSON) and
`wait` returns raw stdout without parsing the JSON wait contract —
`success` is only the CLI exit code, so per the owner's real fixtures an
`exit 0` + `idle`/`turn:0` payload is indistinguishable from completion.
`lib/modes.js` keeps only `success`/`name` from launch (address dropped) and
dismisses by the fixed role name in `finally`. Combined with P0-A this erases
blocked/incomplete agents and risks targeting unrelated terminals that happen
to use the same names.

**Limits.** Source review on the clean clone + the owner's live fixtures; the
reviewer did not run `hc` against unrelated terminals (and will not).

## What works (for fairness)

- `castBallot` (direct ballot authoring) validates the vote enum and round
  normalization on both CLI and MCP surfaces (audited in commit `5672d53`).
- Mutation detection via SHA-256 (`E2`) correctly vetoes a changed artifact.
- Election records persist with `{elected, rule, candidates}`.
- The real-`hc` transport contract (owner's `live-herdr-results.json`):
  launch → `get` → `wait` (`done`, `turn:1`) → `read` → dismiss-by-address
  works end-to-end for a single owned helper.

## Acceptance recommendation

Baseline `5672d53` **must not be accepted**: every failure path manufactures
success, and success paths fabricate authorship. The fixes required are
exactly the owner's gates 1–7; the reviewer will re-run all probes above
against Antigravity's stable commit and append a pass/fail table here before
any acceptance decision.

## Final audit — acceptance criteria (PO decision, 2026-11-17)

The owner (Codex, `t10k`) has ruled on the P0-H class of findings. The decision
is codified in `docs/owner-brief.md` (*Owner decision: screen evidence cannot
authorize*) and enforced by the updated owner gate
`.council/owner-review/orchestrator-contract.mjs` (**18 scenarios**, 2 modes ×
9). These supersede any earlier wording and are what the final audit tests:

1. **Direct-only authorization.** Only valid direct ballots bound to the
   session, expected voter, round and exact proposal digest authorize
   promotion — and only after that participant's turn completes
   successfully. Screen output and parsed markers stay **informational**;
   they never contribute to the authorizing quorum.
2. **No quote/fence heuristics.** No code is to be built that turns screen
   text into authorization; a checksum proves content consistency, not
   authorship. A quoted or stale marker may inform the report, but the
   outcome must not claim agent endorsement.
3. **Honest provisional outcome, contained API.** A run that finishes with
   screen evidence but no authorizing direct quorum returns a readable
   report with next actions and `success: false`,
   `status: "provisional"`, `authorized: false`; the report is saved under
   `validation/`, **not** promoted to `reports/`. CLI/MCP failure signaling
   stays consistent with the existing result contract — no fake
   `validated`.
4. **Read-only agents.** They are never asked to circumvent permissions to
   write files; direct submission through any permitted channel can
   authorize, otherwise the provisional result is the honest outcome.
5. **Owner gate expectations.** Only `healthy` and `direct-proposal` are
   success; `screen-only` must yield `status: "provisional"` +
   `authorized: false` + no promotion; failed reviewers (timeout) must not
   be dismissed; the `direct-proposal` handoff must carry the direct
   proposal text (not the screen placeholder) and
   `findings[<mode>-author]` must equal the full direct file content,
   newlines included; negative execution scenarios also cast direct
   approvals, so an execution failure cannot hide behind a separate
   missing-quorum failure.

6. **Post-exit liveness (recovery gate, real `hc`).** Under a real `hc run`,
   terminals spawned by the Council CLI die with it: the owner reproduced
   this with the product's own `HerdrClient.launchAgent`
   (`.council/owner-review/lifetime-parent.mjs`) — helper `t115` spawned from
   parent `t114`, reported `state: "live"` at launch, and after the parent
   exited 0 the child is `state: "finished"`, `reason: "killed"`,
   `exit_code: 1`, with `die_with_parent: true` and `keep: false`
   (`lifetime-launch.json` / `lifetime-after-parent.json`). Skipping the
   dismiss is therefore **not** recoverability: the orchestrator must launch
   agents with an outliving lifetime (e.g. `--outlive-parent` or equivalent)
   and prove an agent is still alive after the orchestrator exits. `--keep`
   alone is not accepted as recovery until re-tested after the fix. The
   final audit verifies this on the stable commit — no core restarts, no
   foreign terminals. (Positive counterpart, owner fixture on the WIP:
   `real-agent-results.json` / `real-agent-completed.json` — see below.)

7. **Public API failure surfaces + provisional persistence (owner gate,
   2026-11-17 ~17:00).** `waitAllChildren` must not treat a CLI exit 0 as
   completion: the `--children all` aggregate payload obeys the same wait
   contract as a single terminal — timeout / message / blocked payloads are
   not success, only completed children are. The four MCP tools
   `council_wait`, `council_read`, `council_send`, `council_dismiss` must
   set `isError: true` when the underlying herdr method fails — no public
   surface may print "Failed …" as a positive tool result. The screen-only
   provisional outcome must also be **persisted** as markdown under
   `validation/` (the in-response `result.report` alone does not satisfy
   the brief): the persisted markdown must carry the screen evidence
   (`REVIEW_FINDING`), a concrete `cast[-_]ballot` action (a generic
   "next actions" header is not enough), a verdict consistent with the
   returned record, the mechanical-aggregation disclosure, and **no** agent
   sign-off attribution for `mechanical_tally_rule` (no "VALIDATED by …").

The reviewer also owns `tests/acceptance.test.js` (frozen for the final
hash; commit hash reported to the owner): **44** reproducible `node:test`
regressions of these contracts over temp dirs — the 18 orchestrator
direct-only scenarios (council/review × 9), 6 delegate scenarios, 9
real-`hc` wait payload cases (including `done-turn0` → false), 3
startup-timing regressions encoding the owner's live Codex smoke test, 4
`--children all` aggregate contract cases and 4 MCP failure-surface cases
(gate 7). The screen-only cases additionally pin persistence of the
provisional markdown under `validation/`. Per the owner's review the
generic `/next/i` assertion was replaced by the concrete `cast[-_]ballot`
requirement, and `provisionalEvidence` no longer concatenates the
in-response report — only a file persisted under `validation/` counts.
Non-blocking improvements go to the backlog. On the mutable WIP the suite
is **44 total: 35 pass, 9 fail**, where the 9 failures are exactly the
frozen gate regressions (2 screen-only persistence + 3 waitAllChildren +
4 MCP isError — intentional red until implemented); all previously green
contracts stay green. This is not acceptance: the final audit runs on the
stable hash. Earlier acceptance history (commit `14b9d89`, 36 cases):
36/36 passed deterministically on the WIP of ~16:05. Those cases encode the
owner's live Codex smoke test: the run failed on the first `idle turn 0`
report while the agent was still
starting up, so the workflow must wait out `idle0 → done1` and
`message(working, turn 0) → done1` until a **fresh** done (turn ≥ 1), with no
cleanup before done. Fixtures were corrected after owner review of the first
version (real `hc wait` blocks while working; no synthetic middle-timeout
entry — a real timeout stays a failure; `get.status.state` uses `working`).
Two pre-existing unit tests that still encode the old behavior (`runs
review mode`, `detects and respects directly cast ballots without marker
fallback`) were red on the same WIP and remained the implementer's to
update.

Final audit will run the owner's 18-scenario gate on the stable commit,
re-run the baseline probes above for regression, the unit suite and the
frozen 44-case acceptance file (the 9 gate regressions must be green on
the stable hash). The
**baseline report is unchanged** — it documents `5672d53` and is not
re-judged under the new policy.

## Real-agent smoke evidence received (WIP attribution, 2026-11-17 ~16:40)

The owner (Codex, `t10k`) ran a **second real-agent smoke test from root** and
it **PASSED** — this is the positive counterpart to gate 6's failure
reproduction and to the first live smoke (fail-fast on `idle turn 0`):

- `real-agent-results.json`: delegate run over the WIP (audited tree: head
  `14b9d89` + dirty), session `owner-smoke-mwkt80vi`, read-only Codex agent
  `t11j` (parent `t11h`); the result was **collected automatically** —
  `COUNCIL_SMOKE_RESULT=951283f3-7ea0-44d1-af0b-e8a5ab700a6e:42` matched the
  expected marker+sum, `success: true`, `passed: true`. The direct/provisional
  response contract held (no AI re-test by the reviewer).
- `real-agent-completed.json`: child `t11j` after the parent exited —
  `state: "live"`, `turn: 1`, `die_with_parent: false`, no `exit_code`/kill:
  **the agent survived the orchestrator's exit**, which is exactly what
  `--outlive-parent` (or equivalent) had to prove.

**Attribution and status.** Both fixtures are attributed to the **mutable WIP
(head `14b9d89` + uncommitted changes)**, verified against `git status` — not
to a stable commit. Per the owner's instruction the reviewer does **not**
re-run AI agents; the final audit (18-scenario gate + baseline probe
regression + unit + acceptance suites + liveness re-check) starts only on the
stable hash. This evidence becomes the liveness half of the final-audit
pass/fail table, with attribution to the owner's fixture.
