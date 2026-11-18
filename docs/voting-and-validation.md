# Voting and validation

Council's reliability milestone supports `council`, `review` and `delegate`. This document describes the voting modes; delegation completion does not require a council ballot.

## What can authorize

Only a valid direct ballot from an expected participant whose turn completed successfully can authorize promotion. A ballot must match the session, voter, round and exact proposal digest. Its vote and score must be valid. Corrupt, malformed, mismatched or unbound ballots cannot satisfy authorizing quorum.

The current workflows use quorum ratio 0.67 and approval threshold 0.6. Quorum uses valid direct ballots, not the number of files present. Any invalid ballot prevents a passing tally. Rejection and recorded amendments remain visible. A failed tally cannot be converted into conditional approval.

Screen text and vote markers are informational. A quoted author's vote is not a reviewer's endorsement. Screen-only evidence leaves the result provisional, with `success: false`, `status: provisional` and `authorized: false`. Preserve its report and next actions under `validation/`; do not promote it to `reports/`.

## Direct ballot

The `council.ballot/v1` record includes the session ID, round, voter, role, agent, vote, score, rationale, amendments, targetArtifactSha256 and submission time. For example:

```json
{
  "$schema": "council.ballot/v1",
  "sessionId": "council-example",
  "round": 1,
  "voter": "council-skeptic",
  "role": "skeptic",
  "agent": "codex",
  "vote": "amend",
  "score": 7,
  "rationale": "Bound the connection timeout before approval",
  "amendments": ["Cap retries at three"],
  "targetArtifactSha256": "<exact proposal digest from the review brief>"
}
```

The placeholder digest must be replaced with the actual SHA-256 supplied in the review brief.

Use the MCP tool `council_cast_ballot` or the CLI from the target project:

```powershell
node C:/path/to/council-herdr/bin/council.js cast-ballot --session <session-id-or-directory> --voter council-skeptic --role skeptic --agent codex --vote amend --score 7 --rationale "Bound the connection timeout" --amendments "Cap retries at three" --target-sha <proposal-sha256>
```

When submitting from a different working directory, use the explicit session directory. Plain session IDs resolve under that process's `.agent_workspace/`; a directory name collision in the current project does not change that resolution. Casting after a workflow returns does not automatically rerun validation or promotion. Multi-round revision/resumption is not implemented by this command.

A read-only participant may lack a permitted direct-write channel. It should return its final response normally and leave the result provisional, rather than bypass its sandbox or invent an endorsement.

## Validation and reports

Validation checks the direct tally and re-reads the proposal's content digest. A missing or modified artifact cannot pass. Authoring a ballot is not itself approval; execution status, quorum, approval threshold and artifact checks still apply.

These are mechanical checks. The representative election record is bookkeeping, not an agent synthesis turn, signature or proof of authorship. SHA-256 detects content differences at verification time; it does not establish who wrote or endorsed a file.

Approved results go to `reports/`. Provisional and unsuccessful results retain their evidence and next actions under `validation/`; the returned outcome and persisted record must agree. CLI/MCP failure signaling must remain honest about unauthorized or incomplete outcomes.
