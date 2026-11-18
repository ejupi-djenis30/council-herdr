# Agent workspace and handoff

Council creates `.agent_workspace/<session-id>/` in the target project. The server/CLI working directory determines that project unless a caller explicitly constructs it with another root.

```text
.agent_workspace/<session-id>/
  session.json
  task/                         task, context and criteria
  briefs/                       participant instructions
  artifacts/
    index.jsonl                 artifact metadata/digests
    draft/                      council author proposal
    proposal/                   review author proposal
    review/                     participant reviews
    delegation/                 specialist output
  ballots/round-1/              direct ballots and tally
  validation/                   validation, provisional evidence and next actions
  reports/                      approved deliverables only
```

## Handoff contract

1. The author completes before reviewers launch.
2. The orchestrator prefers a direct proposal file, ingests its exact bytes, computes metadata and records its digest. A direct file can be submitted without author-generated `meta.json`; the orchestrator creates its own integrity record.
3. Reviewers receive the exact proposal and SHA-256 being evaluated. The proposal path in the brief must match the artifact on disk.
4. If direct output is unavailable through the participant's permissions, collect its final screen response and identify it as a screen fallback. Console history is best-effort evidence, not proof of ballot provenance.
5. Count only valid direct ballots from completed participants for authorization. Preserve screen findings without turning quoted votes into endorsements.

## Integrity and ownership

Artifact metadata and the JSONL index record SHA-256 digests. Verification compares current content with the expected digest; missing/unverified or changed proposals cannot authorize promotion. A checksum is not an identity check, signature or immutable ledger.

Writes use temporary files and rename with retries for common Windows locking errors. The persistent-lock copy/unlink fallback is not atomic; do not describe every fallback write as an atomic transaction. Invalid or partially readable ballots must fail validation conservatively.

Each participant has its own output location. The orchestrator owns shared metadata, tally and result promotion. Track terminal addresses independently from artifact role names, retain incomplete agents beyond orchestrator exit and clean up only completed terminals created by the workflow.

A provisional workflow preserves a readable report and next actions under `validation/` and requires a passing validation before promotion to `reports/`. Asynchronous delegation uses a separate versioned `job.json` record under the session directory. The worker records delivery, completion and the terminal's collected output for retrieval with `result`. [Async delegation usage](../README.md#delegate-in-an-existing-herdr-terminal)
