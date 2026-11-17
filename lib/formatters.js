/**
 * Council Formatter and Prompt Engine
 * Provides structured prompts for roles, Ponytail-inspired simplification,
 * deterministic artifact instructions, voting ballots, and standard report synthesis.
 */

export const ROLE_DEFINITIONS = {
  author: {
    title: 'Primary Author / Implementer',
    description: 'Develops the core proposal, architecture, or code solution according to specifications.',
    instructions: [
      'Focus on delivering a complete, robust, and clean solution for the requested task.',
      'Explain your design choices, key trade-offs, and verification approach.',
      'Highlight any assumptions you had to make.',
      'Save your primary proposal in your deterministic .agent_workspace/ artifacts directory.'
    ]
  },
  reviewer: {
    title: 'Systematic Reviewer',
    description: 'Inspects proposals and implementations for correctness, quality, and maintainability.',
    instructions: [
      'Examine the proposed approach for correctness, logic flaws, and adherence to requirements.',
      'Check testability, maintainability, and clean separation of concerns.',
      'Offer concrete, constructive suggestions for any identified deficiency.',
      'Cast a formal ballot vote (approve, reject, amend) with your score (1-10) and rationale.'
    ]
  },
  skeptic: {
    title: 'Critical Skeptic / Red Teamer',
    description: 'Challenger focused on finding failure modes, edge cases, and hidden pitfalls.',
    instructions: [
      'Aggressively identify failure modes, race conditions, edge cases, and security vulnerabilities.',
      'Challenge unstated assumptions and optimistic expectations.',
      'Ask: "What is the most likely way this will break or degrade in production?"',
      'Cast a formal ballot vote (approve, reject, amend) with concrete risk justifications.'
    ]
  },
  simplifier: {
    title: 'Lazy Genius / Radical Simplifier (Ponytail Protocol)',
    description: 'Enforces "The best code is the code you never wrote" — ruthlessly cuts unnecessary machinery.',
    instructions: [
      'Apply the Ponytail Decision Ladder: Does it need to exist? Can standard library do it? Can it be done in one line?',
      'Eliminate premature abstractions, wrapper factories, and speculative generalizations.',
      'Propose the Simplest Complete Alternative that achieves 100% of the outcome with minimal parts.',
      'Cast a formal ballot vote (approve, reject, amend) with your simplicity score (1-10).'
    ]
  },
  judge: {
    title: 'Synthesizer & Council Representative',
    description: 'Validates ballots, weighs competing evidence, and delivers authoritative, ratified decisions.',
    instructions: [
      'Evaluate all submitted perspectives and ballots with neutral, evidence-based judgment.',
      'Verify quorum and artifact integrity against deterministic SHA-256 digests.',
      'Reconcile disagreements by weighing explicit pros, cons, and user constraints.',
      'Deliver the Representative Validation Report and binding verdict.'
    ]
  }
};

/**
 * Format a comprehensive markdown brief for a council participant.
 */
export function formatParticipantBrief({
  role,
  name,
  agent,
  mode,
  task,
  context = '',
  criteria = '',
  sessionPaths = null
}) {
  const roleDef = ROLE_DEFINITIONS[role] || ROLE_DEFINITIONS.author;

  const lines = [
    `# Council Member Brief: ${name}`,
    `**Role**: ${roleDef.title} (${role})`,
    `**Agent CLI**: ${agent}`,
    `**Collaboration Mode**: ${mode}`,
    '',
    '## Objective',
    task,
    '',
    '## Role Guidelines',
    roleDef.description,
    '',
    ...roleDef.instructions.map(i => `- ${i}`),
    ''
  ];

  if (sessionPaths) {
    lines.push(
      '## Deterministic Workspace Paths (.agent_workspace)',
      `- **Task Inputs**: \`${sessionPaths.taskDir || '.agent_workspace/.../task'}\``,
      `- **Your Artifact Output**: \`${sessionPaths.artifactPath || '.agent_workspace/.../artifacts'}\``,
      `- **Your Ballot Path**: \`${sessionPaths.ballotPath || '.agent_workspace/.../ballots'}\``,
      ''
    );
  }

  if (criteria) {
    lines.push('## Acceptance / Decision Criteria', criteria, '');
  }

  if (context) {
    lines.push('## Project Context & Background', context, '');
  }

  lines.push(
    '## Reporting & Ballot Contract',
    'Structure your final answer clearly:',
    '1. **Summary**: A concise statement of your position or solution.',
    '2. **Detailed Analysis / Code**: Your core work or review.',
    '3. **Risks & Simplifications**: Failure modes (Skeptic) or code savings (Simplifier).',
    '4. **Ballot Vote**: You can cast your formal ballot in one of three ways:',
    '   - Call MCP tool: `council_cast_ballot({ sessionId, voter, role, agent, vote, score, rationale, amendments, targetArtifactSha256 })`',
    '   - Run CLI command: `council cast-ballot --session <sid> --voter <name> --vote <approve|reject|amend> --score <1-10> --rationale "<text>"`',
    '   - Output markers in your final turn: `[VOTE: approve | reject | amend]` | `[SCORE: 1-10]` | `[RATIONALE: concise summary]`'
  );

  return lines.join('\n');
}

/**
 * Format a final Council markdown report including voting tally and representative validation.
 */
export function formatCouncilReport({
  title = 'Council Session Report',
  mode,
  task,
  participants = [],
  findings = {},
  tally = null,
  validation = null,
  synthesis = '',
  verdict = '',
  timestamp = new Date().toISOString()
}) {
  const lines = [
    `# ${title}`,
    `*Session Timestamp: ${timestamp}* | *Mode: ${mode.toUpperCase()}*`,
    '',
    '## Task / Problem Statement',
    task,
    '',
    '## Council Participants',
    '| Terminal Name | Role | Agent | Status |',
    '|---|---|---|---|',
    ...participants.map(p => `| \`${p.name}\` | ${p.role} | ${p.agent} | ${p.status || 'completed'} |`),
    '',
    '## Participant Submissions'
  ];

  for (const p of participants) {
    const finding = findings[p.name] || 'No submission recorded.';
    lines.push(
      `### [${p.role.toUpperCase()}] ${p.name} (${p.agent})`,
      finding,
      ''
    );
  }

  // Voting Tally Section
  if (tally) {
    lines.push(
      '## Council Voting & Ballot Tally',
      `| Metric | Result |`,
      `|---|---|`,
      `| **Total Ballots Cast** | ${tally.castCount} / ${tally.expectedCount} |`,
      `| **Quorum Status** | ${tally.quorumMet ? '✅ Quorum Met' : '⚠️ Quorum Missing'} |`,
      `| **Approvals** | ${tally.approveCount} (${Math.round((tally.approvalRate || 0) * 100)}%) |`,
      `| **Rejections** | ${tally.rejectCount} |`,
      `| **Amendments Requested** | ${tally.amendCount} |`,
      `| **Average Council Score** | ${tally.averageScore} / 10 |`,
      `| **Vote Outcome** | **${tally.passed ? 'PASSED' : 'REJECTED / UNRESOLVED'}** |`,
      ''
    );

    if (tally.dissent && tally.dissent.length > 0) {
      lines.push(
        '### Recorded Dissent & Requested Amendments',
        ...tally.dissent.map(d => `- **${d.voter}**: ${d.rationale}`),
        ''
      );
    }
  }

  // Representative Validation Section
  if (validation) {
    lines.push(
      '## Representative Validation',
      `**Validated by Representative**: \`${validation.representative || 'Representative'}\``,
      `**Validation Status**: **${(validation.verdict || 'VALIDATED').toUpperCase()}**`,
      `**Artifact Integrity**: ${validation.artifactIntegrity ? '✅ SHA-256 Verified' : '⚠️ Unverified'}`,
      '',
      `> ${validation.rationale || 'Decision ratified by representative based on evidence and quorum.'}`,
      ''
    );

    if (validation.conditions && validation.conditions.length > 0) {
      lines.push(
        '### Binding Implementation Conditions',
        ...validation.conditions.map(c => `- ${c}`),
        ''
      );
    }
  }

  if (synthesis) {
    lines.push('## Synthesis & Debate Analysis', synthesis, '');
  }

  if (verdict) {
    lines.push('## Final Council Verdict & Next Actions', verdict, '');
  }

  return lines.join('\n');
}
