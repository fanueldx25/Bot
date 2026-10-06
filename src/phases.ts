import type {
  PhaseContext, PhaseOutcome, PlanStep, VerifyResult, Message,
} from './types.js';

/* ================================================================== */
/* EXPLORE — gather context. Read files, list tree, look around.       */
/* ================================================================== */

const EXPLORE_SYSTEM = `You are in the EXPLORE phase of a coding agent.
Your job is to understand the task and the workspace. You may call tools
to read files, list the tree, or run read-only commands. Do not edit anything.

Every turn, reply with a single JSON decision:
{"kind":"tool","reasoning":"...","tool":"<name>","args":{...}}
{"kind":"ready","reasoning":"..."}

Emit {"kind":"ready"} once you have enough context to plan.`;

export async function explorePhase(ctx: PhaseContext): Promise<PhaseOutcome> {
  const files = await ctx.workspace.list();
  const history: string[] = [];

  for (let turn = 0; turn < ctx.budgets.exploreTurnsLeft; turn++) {
    const messages: Message[] = [
      { role: 'system', content: EXPLORE_SYSTEM },
      {
        role: 'user',
        content: [
          `# Task\n${ctx.task}`,
          `# Workspace root\n${ctx.workspace.root}`,
          `# Source files (${files.length})\n${files.join('\n') || '(none)'}`,
          `# Exploration so far\n${history.join('\n\n') || '(nothing yet)'}`,
          `# Available tools\n${ctx.tools.describe()}`,
        ].join('\n\n'),
      },
    ];

    const d = await ctx.ai.json<any>(messages, `{ "kind":"tool|ready", "reasoning":"string", "tool":"string?", "args":{}? }`);

    if (d.reasoning) ctx.emit({ phase: 'EXPLORE', type: 'think', payload: d.reasoning, ts: Date.now() });

    if (d.kind === 'ready') {
      return { next: 'PLAN', reason: d.reasoning ?? 'context gathered' };
    }

    if (d.kind === 'tool' && ctx.tools.has(d.tool)) {
      const res = await ctx.tools.call(d.tool, d.args, { workspace: ctx.workspace });
      ctx.emit({ phase: 'EXPLORE', type: 'tool', payload: { tool: d.tool, args: d.args }, ts: Date.now() });
      ctx.emit({ phase: 'EXPLORE', type: 'observation', payload: res, ts: Date.now() });
      history.push(`[${d.tool}] ${truncate(res.output, 1500)}`);
      continue;
    }

    // Unknown tool or malformed — nudge once and continue
    history.push(`[harness] Ignored invalid decision: ${JSON.stringify(d).slice(0, 200)}`);
  }

  return { next: 'PLAN', reason: 'exploration budget exhausted' };
}

/* ================================================================== */
/* PLAN — produce an ordered list of verifiable steps.                 */
/* ================================================================== */

const PLAN_SYSTEM = `You are in the PLAN phase.
Produce a concrete, ordered plan of 2–8 steps. Every step must be
verifiable (a file write, a command run, or an observable outcome).
Do not include meta-steps like "review" or "think".

Reply as JSON: {"steps":[{"id":"1","description":"...","status":"pending"}]}`;

export async function planPhase(ctx: PhaseContext): Promise<PhaseOutcome> {
  const files = await ctx.workspace.list();
  const out = await ctx.ai.json<{ steps: PlanStep[] }>(
    [
      { role: 'system', content: PLAN_SYSTEM },
      {
        role: 'user',
        content: `# Task\n${ctx.task}\n\n# Files\n${files.join('\n') || '(none)'}\n\n# Exploration\n${truncate(lastAssistant(ctx.transcript), 2000)}`,
      },
    ],
    `{ "steps":[{"id":"string","description":"string","status":"pending"}] }`,
  );

  const plan = (out.steps ?? []).map((s, i) => ({
    id: String(s.id ?? i + 1),
    description: String(s.description ?? ''),
    status: 'pending' as const,
  }));

  ctx.emit({ phase: 'PLAN', type: 'plan', payload: plan, ts: Date.now() });

  if (!plan.length) {
    return { next: 'ABORT', reason: 'planner returned zero steps' };
  }
  return { next: 'EDIT', reason: 'plan ready', plan };
}

/* ================================================================== */
/* EDIT — execute the plan, one tool call at a time.                   */
/* ================================================================== */

const EDIT_SYSTEM = `You are in the EDIT phase of a coding agent.
You are executing ONE step of the plan. You may:
  - call write_file to create/overwrite a file (always full content)
  - call run_command to run a build/test/git command
  - call read_file to re-check a file
  - declare the current step done

Every turn reply with a single JSON decision:
{"kind":"tool","reasoning":"...","tool":"<name>","args":{...}}
{"kind":"step_done","reasoning":"..."}
{"kind":"step_failed","reasoning":"...","reason":"why"}`;

export async function editPhase(ctx: PhaseContext): Promise<PhaseOutcome> {
  // Initialize the current step as in_progress
  const step = ctx.plan[ctx.currentStepIndex];
  if (!step) return { next: 'VERIFY', reason: 'no steps left to edit' };
  step.status = 'in_progress';

  const edits: string[] = [];

  for (let turn = 0; turn < ctx.budgets.editTurnsLeft; turn++) {
    const messages: Message[] = [
      { role: 'system', content: EDIT_SYSTEM },
      {
        role: 'user',
        content: [
          `# Task\n${ctx.task}`,
          `# Full plan\n${fmtPlan(ctx.plan)}`,
          `# Current step\n${step.id}. ${step.description}`,
          `# Edits made this step\n${edits.join('\n') || '(none)'}`,
          `# Available tools\n${ctx.tools.describe()}`,
        ].join('\n\n'),
      },
    ];

    const d = await ctx.ai.json<any>(
      messages,
      `{ "kind":"tool|step_done|step_failed", "reasoning":"string", "tool":"string?", "args":{}?, "reason":"string?" }`,
    );

    if (d.reasoning) ctx.emit({ phase: 'EDIT', type: 'think', payload: d.reasoning, ts: Date.now() });

    if (d.kind === 'step_done') {
      step.status = 'done';
      ctx.emit({ phase: 'EDIT', type: 'observation', payload: { step: step.id, status: 'done' }, ts: Date.now() });
      return { next: 'VERIFY', reason: `step ${step.id} done: ${d.reasoning ?? ''}` };
    }

    if (d.kind === 'step_failed') {
      step.status = 'failed';
      return {
        next: 'RECOVER',
        reason: d.reason ?? 'step failed',
        diagnosis: d.reasoning ?? 'step failed during edit',
      };
    }

    if (d.kind === 'tool' && ctx.tools.has(d.tool)) {
      const res = await ctx.tools.call(d.tool, d.args, { workspace: ctx.workspace });
      ctx.emit({ phase: 'EDIT', type: 'tool', payload: { tool: d.tool, args: d.args }, ts: Date.now() });
      ctx.emit({ phase: 'EDIT', type: 'observation', payload: res, ts: Date.now() });

      if (d.tool === 'write_file' && d.args?.path) edits.push(`wrote ${d.args.path}`);
      else if (d.tool === 'run_command') edits.push(`ran ${d.args?.command} ${(d.args?.args ?? []).join(' ')}`);

      if (!res.ok) {
        // A failing tool during edit is a recoverable signal, not a hard stop.
        step.status = 'failed';
        return {
          next: 'RECOVER',
          reason: `tool ${d.tool} failed during step ${step.id}`,
          diagnosis: truncate(res.output, 1200),
        };
      }
      continue;
    }

    edits.push(`[harness] ignored invalid decision: ${JSON.stringify(d).slice(0, 160)}`);
  }

  step.status = 'failed';
  return {
    next: 'RECOVER',
    reason: `edit budget exhausted on step ${step.id}`,
    diagnosis: 'the model used all edit turns without declaring the step done',
  };
}

/* ================================================================== */
/* VERIFY — run ground-truth checks. Not model-judged.                 */
/* ================================================================== */

export interface Verifier {
  name: string;
  run(ctx: PhaseContext): Promise<{ ok: boolean; output: string }>;
}

export const defaultVerifiers: Verifier[] = [
  {
    name: 'typecheck',
    async run({ workspace, tools }) {
      if (!(await workspace.exists('tsconfig.json'))) {
        return { ok: true, output: '(skipped: no tsconfig.json)' };
      }
      const r = await tools.call('run_command', { command: 'npx', args: ['--no-install', 'tsc', '--noEmit'] }, { workspace });
      return { ok: r.ok, output: r.output };
    },
  },
  {
    name: 'tests',
    async run({ workspace, tools }) {
      if (!(await workspace.exists('package.json'))) {
        return { ok: true, output: '(skipped: no package.json)' };
      }
      const pkg = JSON.parse(await workspace.read('package.json'));
      if (!pkg.scripts?.test) {
        return { ok: true, output: '(skipped: no test script)' };
      }
      const r = await tools.call('run_command', { command: 'npm', args: ['test', '--silent'] }, { workspace });
      return { ok: r.ok, output: r.output };
    },
  },
];

export async function verifyPhase(
  ctx: PhaseContext,
  verifiers: Verifier[] = defaultVerifiers,
): Promise<PhaseOutcome> {
  const checks: VerifyResult['checks'] = [];

  for (const v of verifiers) {
    const r = await v.run(ctx);
    checks.push({ name: v.name, ok: r.ok, output: r.output });
    ctx.emit({ phase: 'VERIFY', type: 'verify', payload: { name: v.name, ok: r.ok, output: r.output }, ts: Date.now() });
  }

  const allOk = checks.every(c => c.ok);
  const failed = checks.filter(c => !c.ok).map(c => c.name).join(', ');
  const result: VerifyResult = {
    ok: allOk,
    checks,
    summary: allOk ? 'all checks passed' : `failed: ${failed}`,
  };

  if (allOk) {
    // All plan steps done?
    const allDone = ctx.plan.every(s => s.status === 'done');
    if (allDone) {
      return { next: 'COMPLETE', reason: 'verification passed' };
    }
    // Verification passed but plan has pending steps → keep editing.
    return { next: 'EDIT', reason: 'verification passed, plan has remaining steps' };
  }

  return {
    next: 'RECOVER',
    reason: `verification failed: ${failed}`,
    diagnosis: checks.filter(c => !c.ok).map(c => `[${c.name}]\n${truncate(c.output, 1200)}`).join('\n\n'),
  };
}

/* ================================================================== */
/* RECOVER — diagnose failure, pick a repair path.                     */
/* ================================================================== */

const RECOVER_SYSTEM = `You are in the RECOVER phase.
A verification failed. You must pick exactly one repair strategy:
  - "fix"       — apply a targeted edit (usually one file). Go back to EDIT.
  - "replan"    — the plan was wrong. Propose a fresh plan.
  - "reexplore" — you lack context. Go back to EXPLORE.
  - "abort"     — the task is blocked or impossible.

Reply as JSON:
{"strategy":"fix|replan|reexplore|abort","reasoning":"short diagnosis","plan":[] (only when strategy=replan)}`;

export async function recoverPhase(ctx: PhaseContext): Promise<PhaseOutcome> {
  if (ctx.budgets.recoverAttemptsLeft <= 0) {
    return { next: 'ABORT', reason: 'recovery attempts exhausted' };
  }

  const failure = ctx.lastVerify?.checks.filter(c => !c.ok).map(c => `[${c.name}]\n${truncate(c.output, 1500)}`).join('\n\n')
    ?? ctx.lastRecovery?.diagnosis
    ?? 'unknown failure';

  const out = await ctx.ai.json<any>(
    [
      { role: 'system', content: RECOVER_SYSTEM },
      {
        role: 'user',
        content: [
          `# Task\n${ctx.task}`,
          `# Plan\n${fmtPlan(ctx.plan)}`,
          `# Failure\n${failure}`,
          `# Recent edits\n${ctx.lastEdits.join('\n') || '(none)'}`,
          `# Recovery attempt\n${(ctx.lastRecovery?.attempt ?? 0) + 1}`,
        ].join('\n\n'),
      },
    ],
    `{ "strategy":"fix|replan|reexplore|abort", "reasoning":"string", "plan":[]? }`,
  );

  ctx.emit({ phase: 'RECOVER', type: 'recover', payload: out, ts: Date.now() });

  switch (out.strategy) {
    case 'fix':
      // Mark the current step back to in_progress so EDIT will retry it.
      const step = ctx.plan[ctx.currentStepIndex];
      if (step) step.status = 'in_progress';
      return { next: 'EDIT', reason: out.reasoning ?? 'targeted fix', plan: ctx.plan };
    case 'replan':
      const fresh = (out.plan ?? []).map((s: any, i: number) => ({
        id: String(s.id ?? i + 1),
        description: String(s.description ?? ''),
        status: 'pending' as const,
      }));
      return { next: 'EDIT', reason: out.reasoning ?? 'replanned', plan: fresh };
    case 'reexplore':
      return { next: 'EXPLORE', reason: out.reasoning ?? 'need more context' };
    case 'abort':
    default:
      return { next: 'ABORT', reason: out.reasoning ?? 'recovery chose to abort' };
  }
}

/* ================================================================== */
/* COMPLETE — terminal. Summarize what shipped.                        */
/* ================================================================== */

const COMPLETE_SYSTEM = `You are in the COMPLETE phase.
Summarize what was accomplished in 3–5 sentences: what files were
created or changed, what verification passed, and any caveats.
Keep it tight — no bullet points, no code blocks, no JSON.`;

export async function completePhase(ctx: PhaseContext): Promise<PhaseOutcome> {
  const summary = await ctx.ai.complete([
    { role: 'system', content: COMPLETE_SYSTEM },
    { role: 'user', content: `Task: ${ctx.task}\n\nPlan:\n${fmtPlan(ctx.plan)}\n\nEdits:\n${ctx.lastEdits.join('\n')}` },
  ]);
  return { next: 'COMPLETE', reason: 'done', summary: summary.trim() };
}

/* ============================ helpers ============================= */

function fmtPlan(plan: PlanStep[]): string {
  return plan.map(s => `[${s.status === 'done' ? 'x' : s.status === 'failed' ? '!' : ' '}] ${s.id}. ${s.description}`).join('\n') || '(empty)';
}
function truncate(s: string, n: number) { return s.length <= n ? s : s.slice(0, n) + '…'; }
function lastAssistant(msgs: Message[]) { return [...msgs].reverse().find(m => m.role === 'assistant')?.content ?? ''; }