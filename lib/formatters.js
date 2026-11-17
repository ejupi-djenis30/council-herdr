/**
 * Council Formatter and Prompt Engine
 * Provides structured prompts for roles and standard report synthesis.
 */

export const ROLE_DEFINITIONS = {
  author: {
    title: 'Primary Author / Implementer',
    description: 'Develops the core proposal, architecture, or code solution according to specifications.',
    instructions: [
      'Focus on delivering a complete, robust, and clean solution for the requested task.',
      'Explain your design choices, key trade-offs, and verification approach.',
      'Highlight any assumptions you had to make.'
    ]
  },
  reviewer: {
    title: 'Systematic Reviewer',
    description: 'Inspects proposals and implementations for correctness, quality, and maintainability.',
    instructions: [
      'Examine the proposed approach for correctness, logic flaws, and adherence to requirements.',
      'Check testability, maintainability, and clean separation of concerns.',
      'Offer concrete, constructive suggestions for any identified deficiency.'
    ]
  },
  skeptic: {
    title: 'Critical Skeptic / Red Teamer',
    description: 'Challenger focused on finding failure modes, edge cases, and hidden pitfalls.',
    instructions: [
      'Aggressively identify failure modes, race conditions, edge cases, and security vulnerabilities.',
      'Challenge unstated assumptions and optimistic expectations.',
      'Ask: "What is the most likely way this will break or degrade in production?"'
    ]
  },
  simplifier: {
    title: 'Lazy Genius / Radical Simplifier',
    description: 'Ruthlessly eliminates unnecessary machinery, abstractions, and complexity.',
    instructions: [
      'Identify accidental complexity, speculative generalizations, and unneeded abstractions.',
      'Propose the simplest complete alternative that achieves the exact same user goals.',
      'Ask: "Can we achieve 95% of the outcome with half the moving parts?"'
    ]
  },
  judge: {
    title: 'Synthesizer / Council Judge',
    description: 'Weighs competing proposals and critiques to establish balanced consensus and clear decisions.',
    instructions: [
      'Evaluate all submitted perspectives with neutral, evidence-based judgment.',
      'Reconcile disagreements by weighing explicit pros, cons, and user constraints.',
      'Deliver an authoritative, actionable decision with concrete next steps.'
    ]
  }
};

/**
 * Format a comprehensive markdown brief for a council participant.
 */
export function formatParticipantBrief({ role, name, agent, mode, task, context = '', criteria = '' }) {
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

  if (criteria) {
    lines.push('## Acceptance / Decision Criteria', criteria, '');
  }

  if (context) {
    lines.push('## Project Context & Background', context, '');
  }

  lines.push(
    '## Reporting Contract',
    'Structure your final answer clearly:',
    '1. **Summary**: A concise statement of your position or solution.',
    '2. **Detailed Analysis / Code**: Your core work or review.',
    '3. **Risks & Open Questions**: Crucial caveats for the Council.',
    '4. **Verdict / Recommendation**: Clear next step.'
  );

  return lines.join('\n');
}

/**
 * Format a final Council markdown report.
 */
export function formatCouncilReport({
  title = 'Council Session Report',
  mode,
  task,
  participants = [],
  findings = {},
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

  if (synthesis) {
    lines.push('## Synthesis & Debate Analysis', synthesis, '');
  }

  if (verdict) {
    lines.push('## Final Council Verdict & Next Actions', verdict, '');
  }

  return lines.join('\n');
}
