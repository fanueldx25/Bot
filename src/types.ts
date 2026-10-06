export type Phase =
  | 'EXPLORE'
  | 'PLAN'
  | 'EDIT'
  | 'VERIFY'
  | 'RECOVER'
  | 'COMPLETE';

export type Role = 'system' | 'user' | 'assistant';
export interface Message { role: Role; content: string }

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; output: string }[];
  summary: string;
}

/** Everything a phase handler needs to make a decision. */
export interface PhaseContext {
  task: string;
  workspace: Workspace;
  ai: AIClient;
  tools: ToolRegistry;
  transcript: Message[];
  plan: PlanStep[];
  currentStepIndex: number;
  lastEdits: string[];
  lastVerify: VerifyResult | null;
  lastRecovery: { attempt: number; diagnosis: string } | null;
  budgets: {
    exploreTurnsLeft: number;
    editTurnsLeft: number;
    recoverAttemptsLeft: number;
    totalStepsLeft: number;
  };
  emit: (event: EngineEvent) => void;
}

/** The six phases each return exactly one of these. */
export type PhaseOutcome =
  | { next: 'PLAN';              reason: string }
  | { next: 'EDIT';              reason: string; plan?: PlanStep[] }
  | { next: 'VERIFY';            reason: string }
  | { next: 'RECOVER';           reason: string; diagnosis: string }
  | { next: 'EXPLORE';           reason: string }
  | { next: 'COMPLETE';          reason: string; summary: string }
  | { next: 'ABORT';             reason: string };

export interface EngineEvent {
  ts: number;
  phase: Phase;
  type:
    | 'enter'
    | 'exit'
    | 'think'
    | 'tool'
    | 'observation'
    | 'plan'
    | 'verify'
    | 'recover'
    | 'guard'
    | 'done';
  payload?: unknown;
}

export interface EngineResult {
  ok: boolean;
  finalPhase: Phase;
  summary: string;
  plan: PlanStep[];
  transcript: Message[];
  events: EngineEvent[];
  elapsedMs: number;
}

/* ------------------------------------------------------------------ */
/* Collaborator interfaces (so the engine stays testable)              */
/* ------------------------------------------------------------------ */

export interface Workspace {
  readonly root: string;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(): Promise<string[]>;
  snapshot(): Promise<Record<string, string>>;
}

export interface AIClient {
  model: string;
  complete(messages: Message[]): Promise<string>;
  json<T>(messages: Message[], shapeHint: string): Promise<T>;
}

export interface ToolResult { ok: boolean; output: string; }
export interface Tool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(args: any, ctx: { workspace: Workspace }): Promise<ToolResult>;
}
export interface ToolRegistry {
  has(name: string): boolean;
  describe(): string;
  call(name: string, args: any, ctx: { workspace: Workspace }): Promise<ToolResult>;
}