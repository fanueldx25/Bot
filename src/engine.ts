import type {
  AIClient, EngineEvent, EngineResult, Message, Phase, PhaseContext, PhaseOutcome,
  PlanStep, ToolRegistry, VerifyResult, Workspace,
} from './types.js';
import {
  completePhase, editPhase, explorePhase, planPhase, recoverPhase, verifyPhase,
  type Verifier,
} from './phases.js';

/** The ONLY legal transitions. The engine will refuse anything else. */
const TRANSITIONS: Record<Phase, Phase[]> = {
  EXPLORE:  ['PLAN', 'ABORT'],
  PLAN:     ['EDIT', 'ABORT'],
  EDIT:     ['VERIFY', 'RECOVER', 'ABORT'],
  VERIFY:   ['EDIT', 'RECOVER', 'COMPLETE', 'ABORT'],
  RECOVER:  ['EDIT', 'PLAN', 'EXPLORE', 'ABORT'],
  COMPLETE: [],
};

export interface EngineOptions {
  ai: AIClient;
  workspace: Workspace;
  tools: ToolRegistry;
  verifiers?: Verifier[];
  maxTotalSteps?: number;
  maxExploreTurns?: number;
  maxEditTurns?: number;
  maxRecoverAttempts?: number;
  onEvent?: (e: EngineEvent) => void;
}

export class Engine {
  private events: EngineEvent[] = [];
  private transcript: Message[] = [];
  private plan: PlanStep[] = [];
  private currentStepIndex = 0;
  private lastEdits: string[] = [];
  private lastVerify: VerifyResult | null = null;
  private lastRecovery: { attempt: number; diagnosis: string } | null = null;

  constructor(private opts: EngineOptions) {}

  async run(task: string): Promise<EngineResult> {
    const started = Date.now();
    this.transcript = [{ role: 'user', content: task }];

    const budgets = {
      exploreTurnsLeft: this.opts.maxExploreTurns ?? 8,
      editTurnsLeft:    this.opts.maxEditTurns ?? 6,
      recoverAttemptsLeft: this.opts.maxRecoverAttempts ?? 3,
      totalStepsLeft:   this.opts.maxTotalSteps ?? 40,
    };

    let phase: Phase = 'EXPLORE';
    let summary = '';
    let ok = false;

    while (budgets.totalStepsLeft-- > 0) {
      this.emit({ phase, type: 'enter', ts: Date.now() });

      const ctx: PhaseContext = {
        task,
        workspace: this.opts.workspace,
        ai: this.opts.ai,
        tools: this.opts.tools,
        transcript: this.transcript,
        plan: this.plan,
        currentStepIndex: this.currentStepIndex,
        lastEdits: this.lastEdits,
        lastVerify: this.lastVerify,
        lastRecovery: this.lastRecovery,
        budgets: { ...budgets },
        emit: (e) => this.emit(e),
      };

      let outcome: PhaseOutcome;
      try {
        outcome = await this.runPhase(phase, ctx);
      } catch (err) {
        outcome = { next: 'ABORT', reason: `phase ${phase} threw: ${(err as Error).message}` };
      }

      this.emit({ phase, type: 'exit', payload: outcome, ts: Date.now() });

      // --- Guard: legal transition? ---
      const allowed = TRANSITIONS[phase];
      if (!allowed.includes(outcome.next as Phase)) {
        this.emit({
          phase, type: 'guard',
          payload: { blocked: outcome.next, allowed },
          ts: Date.now(),
        });
        outcome = { next: 'ABORT', reason: `illegal transition ${phase} → ${outcome.next}` };
      }

      // --- Apply outcome side effects ---
      if (outcome.next === 'EDIT' && 'plan' in outcome && outcome.plan) {
        this.plan = outcome.plan;
        this.currentStepIndex = 0;
      }
      if (phase === 'EDIT') {
        // advance the plan cursor if the current step is done
        const cur = this.plan[this.currentStepIndex];
        if (cur?.status === 'done') this.currentStepIndex++;
      }
      if (phase === 'VERIFY') {
        // verifyPhase already emitted; capture for RECOVER
        this.lastVerify = this.buildVerifyResultFromEvents();
      }
      if (phase === 'RECOVER') {
        const attempt = (this.lastRecovery?.attempt ?? 0) + 1;
        this.lastRecovery = { attempt, diagnosis: JSON.stringify(outcome).slice(0, 500) };
        budgets.recoverAttemptsLeft--;
      }
      if (outcome.next === 'EXPLORE') {
        this.plan = [];
        this.currentStepIndex = 0;
      }
      if (outcome.next === 'COMPLETE') {
        summary = outcome.summary;
        ok = true;
      }
      if (outcome.next === 'ABORT') {
        summary = outcome.reason;
        ok = false;
      }

      this.transcript.push({
        role: 'assistant',
        content: `[${phase}] → ${outcome.next}: ${outcome.reason}`,
      });

      phase = outcome.next as Phase;
      if (phase === 'COMPLETE' || phase === 'ABORT') break;

      // Reset per-phase budgets that should refresh each cycle.
      if (phase === 'EDIT') budgets.editTurnsLeft = this.opts.maxEditTurns ?? 6;
      if (phase === 'EXPLORE') budgets.exploreTurnsLeft = this.opts.maxExploreTurns ?? 8;
    }

    this.emit({ phase, type: 'done', payload: { ok, summary }, ts: Date.now() });

    return {
      ok,
      finalPhase: phase,
      summary,
      plan: this.plan,
      transcript: this.transcript,
      events: this.events,
      elapsedMs: Date.now() - started,
    };
  }

  private async runPhase(phase: Phase, ctx: PhaseContext): Promise<PhaseOutcome> {
    switch (phase) {
      case 'EXPLORE':  return explorePhase(ctx);
      case 'PLAN':     return planPhase(ctx);
      case 'EDIT':     return editPhase(ctx);
      case 'VERIFY':   return verifyPhase(ctx, this.opts.verifiers);
      case 'RECOVER':  return recoverPhase(ctx);
      case 'COMPLETE': return completePhase(ctx);
    }
  }

  /** Pull the last VERIFY event(s) into a VerifyResult for RECOVER to read. */
  private buildVerifyResultFromEvents(): VerifyResult {
    const checks = this.events
      .filter(e => e.phase === 'VERIFY' && e.type === 'verify')
      .slice(-10)
      .map((e: any) => ({
        name: e.payload.name,
        ok: e.payload.ok,
        output: e.payload.output,
      }));
    const ok = checks.length > 0 && checks.every(c => c.ok);
    return { ok, checks, summary: ok ? 'all passed' : 'one or more failed' };
  }

  private emit(e: EngineEvent) {
    this.events.push(e);
    this.opts.onEvent?.(e);
  }
}