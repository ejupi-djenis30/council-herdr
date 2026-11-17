# Council Voting & Representative Validation

## Ballot Schema (`council.ballot/v1`)

Every participating Council member casts an explicit voting ballot stored at `.agent_workspace/<session-id>/ballots/round-<n>/<voter>.json`:

```json
{
  "$schema": "council.ballot/v1",
  "round": 1,
  "voter": "council-skeptic",
  "role": "skeptic",
  "agent": "codex",
  "vote": "amend",
  "score": 7,
  "rationale": "Solid base, but needs exponential backoff on network failures.",
  "amendments": [
    "Add configurable jitter to retries",
    "Cap retry attempts to 3"
  ],
  "targetArtifactSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "submittedAt": "2026-11-17T12:00:00.000Z"
}
```

## Tally & Quorum Protocol

The orchestrator tallies ballots into `ballots/round-<n>/tally.json`:
- **Quorum Check**: Requires at least 67% (two-thirds) of expected participants to cast ballots.
- **Approval Rate**: Requires at least 60% of cast votes to be `approve`.
- **Recorded Dissent**: Every `reject` or `amend` vote records voter rationale and requested amendments directly into the official record. Dissent is never erased.

## Representative Validation Pipeline

The Council Representative (or elected Judge) reviews the tally and target artifacts before ratifying the decision:

1. **Quorum Verification**: Verifies that sufficient members voted.
2. **Artifact Integrity Verification**: Recalculates the SHA-256 digest of the proposed artifact. If the file was altered after the vote, validation fails.
3. **Validation Verdict**:
   - `validated`: Proposal ratified unconditionally.
   - `conditional`: Proposal approved subject to binding amendments (e.g. addressing Skeptic/Simplifier concerns).
   - `vetoed`: Proposal rejected.
4. **Promotion**: Validated deliverables are promoted to `reports/report.md` and `reports/verdict.json`.
