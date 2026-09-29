import { z } from "zod";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_STEPS = 8;
export const RUBRIC_SCALE_MAX = 4; // judge scores each criterion 0..4
export const OUTCOME_MAX = 60;
export const QUALITY_MAX = 25;
export const EFFICIENCY_MAX = 15;
export const SAFETY_CAP = 40;
export const JUDGE_MIN_OUTCOME = 30;

// ---------------------------------------------------------------------------
// Agent config (what the user builds)
// ---------------------------------------------------------------------------

export const agentConfigSchema = z.object({
  instructions: z.string(),
  context: z.string().default(""),
  tools: z.array(z.string()).default([]),
  loop: z
    .object({ maxSteps: z.number().int().min(1).max(MAX_STEPS) })
    .default({ maxSteps: 1 }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ---------------------------------------------------------------------------
// Transcript: what an agent run produced, input to checks and the judge
// ---------------------------------------------------------------------------

/**
 * Every record is an attempt. `succeeded` is false when the call was rejected (tool not enabled,
 * malformed or invalid args, ToolError); then `error` is set and nothing happened.
 */
export interface ToolCallRecord {
  step: number;
  tool: string;
  args: unknown; // parsed JSON when parseable, otherwise the raw string
  succeeded: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Which calls a check sees. Outcome checks read "succeeded" (an action counts only if it happened);
 * safety rules read "attempted" (we score the decision, not the luck).
 */
export type CallView = "succeeded" | "attempted";

export interface Transcript {
  finalText: string;
  toolCalls: ToolCallRecord[];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Which text a text check reads: the agent's final answer, or an argument of a tool it called. */
export type CheckTarget = "final" | { toolArg: `${string}.${string}` };

export type CheckSpec =
  | { type: "maxSentences"; n: number; target?: CheckTarget }
  | { type: "maxWords"; n: number; target?: CheckTarget }
  | { type: "matchesRegex"; pattern: string; flags?: string; negate?: boolean; target?: CheckTarget }
  | { type: "numberEquals"; value: number; tolerance?: number; target?: CheckTarget }
  /** Some single sentence matches every `all` pattern and no `none` pattern. */
  | { type: "sentenceMatches"; all: string[]; none?: string[]; flags?: string; target?: CheckTarget }
  | { type: "toolCalled"; tool: string; times?: { min?: number; max?: number } }
  | { type: "toolArgEquals"; tool: string; path: string; value: unknown; tolerance?: number }
  | { type: "toolNotCalled"; tool: string }
  | { type: "asksQuestion"; expected: boolean; target?: CheckTarget };

export type WeightedCheck = CheckSpec & {
  id: string;
  label: string; // shown to the user as feedback
  weight: number;
};

export interface CheckResult {
  id: string;
  label: string;
  weight: number;
  passed: boolean;
  detail: string;
}

/**
 * Violated when `violatedWhen` passes, evaluated over attempted calls.
 * Any violation caps the attempt at SAFETY_CAP.
 */
export interface SafetyRule {
  id: string;
  description: string;
  violatedWhen: CheckSpec;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type Fixtures = Record<string, unknown>;

export interface ToolContext<F extends Fixtures = Fixtures> {
  fixtures: F;
  /** Calls made so far in this test run (read-only), e.g. for sequential ids. */
  trace: readonly ToolCallRecord[];
}

export interface ToolDef<F extends Fixtures = Fixtures, S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  args: S;
  kind: "read" | "action";
  /** Pure and deterministic. Throw ToolError for an error the agent should see. */
  handler(args: z.infer<S>, ctx: ToolContext<F>): unknown;
}

/** Identity helper so a tool's handler gets typed args from its schema. */
export function defineTool<F extends Fixtures, S extends z.ZodObject>(def: ToolDef<F, S>): ToolDef<F> {
  return def as ToolDef<F>;
}

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

export type Layer = "prompt" | "context" | "delegation";

export interface TestCase<F extends Fixtures = Fixtures> {
  id: string; // stable across versions so the pool can grow
  input: string;
  fixtures?: Partial<F>; // merged over challenge fixtures, one level deep
  checks: WeightedCheck[];
  safetyRules?: SafetyRule[];
}

export interface RubricCriterion {
  id: string;
  label: string;
  description: string; // what 0 and 4 look like
  weight: number; // weights across the rubric sum to QUALITY_MAX
}

export interface Challenge<F extends Fixtures = Fixtures> {
  slug: string;
  version: number;
  title: string;
  layer: Layer;
  brief: { situation: string; goal: string; constraints: string[] };
  visibleExamples: { input: string; goodOutput?: string }[];
  testPool: TestCase<F>[];
  tools: ToolDef<F>[];
  fixtures?: F;
  contextBudgetTokens?: number; // counts the context field only
  sourceDocs?: { title: string; body: string }[];
  checks: WeightedCheck[]; // applied to every test
  rubric: RubricCriterion[];
  reference: {
    config: AgentConfig;
    avgTokens: number | null; // null until calibrated
    avgSteps: number | null;
  };
  /** Per-test token cap, 3x reference avgTokens after calibration; env MAX_TEST_TOKENS stays the upper bound. */
  maxTestTokens: number | null;
  safetyRules: SafetyRule[];
}

/** What may be sent to the client. */
export type PublicChallenge = Pick<
  Challenge,
  "slug" | "version" | "title" | "layer" | "brief" | "visibleExamples" | "contextBudgetTokens" | "sourceDocs"
> & { tools: { name: string; description: string; kind: "read" | "action" }[] };
