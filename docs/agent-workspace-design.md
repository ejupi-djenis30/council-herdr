# Deterministic Agent Workspace & Artifact Exchange

## Architecture

Council v2.0 enforces a strict deterministic file and artifact exchange protocol under `.agent_workspace/<session-id>/`. This eliminates brittle terminal screen-scraping and guarantees that every proposal, critique, review, ballot, and decision is cryptographically indexed and auditable.

```text
.agent_workspace/<session-id>/
├── session.json                             # Canonical session manifest (mode, task hash, participants)
├── task/
│   ├── task.md                              # Authoritative user task / problem statement
│   ├── context.md                           # Background context and code snippets
│   └── criteria.md                          # Constraints and acceptance criteria
├── briefs/
│   ├── <agent-name>.md                      # Deterministic per-agent launch briefs
├── artifacts/
│   ├── index.jsonl                          # Append-only ledger of all produced artifacts (SHA-256)
│   ├── draft/<agent-name>/artifact.md       # Initial author proposals
│   ├── review/<agent-name>/artifact.md      # Peer reviews and critiques
│   └── verdict/<agent-name>/artifact.md     # Synthesis and final implementations
├── ballots/
│   └── round-<n>/
│       ├── <agent-name>.json                # Standardized council.ballot/v1 voting ballots
│       └── tally.json                       # Computed voting tally (quorum, approvals, dissent)
├── validation/
│   ├── representative.json                  # Signed representative validation record
│   └── report.md                            # Comprehensive validation audit report
├── transcripts/
│   └── <agent-name>.log                     # Execution stdout and screen dumps
└── reports/
    ├── report.md                            # Final ratified markdown deliverable
    └── verdict.json                         # Structured outcome metadata
```

## Guarantees

1. **Deterministic Naming**: All agent names and session paths are normalized to lowercase `[a-z0-9-]`.
2. **Atomic Writes**: Every artifact and JSON file is written to a temporary file first (`*.tmp`) before renaming, preventing partial reads across concurrent Herdr processes.
3. **SHA-256 Integrity Verification**: Every written artifact has its SHA-256 digest recorded in `meta.json` and `artifacts/index.jsonl`. During voting and representative validation, the target artifact's digest is verified.
4. **Isolated Ownership**: Agents write exclusively to their own subdirectories under `artifacts/<phase>/<name>/` and `ballots/round-<n>/<name>.json`. The orchestrator manages shared ledgers.
