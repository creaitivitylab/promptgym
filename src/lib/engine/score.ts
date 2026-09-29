import "server-only";
import { evaluateChecks, findSafetyViolations, passFraction, type SafetyViolation } from "./checks";
import { efficiencyScore, type EfficiencyResult } from "./efficiency";
import { runTest, type TestRun } from "./executor";
import { judgeTest, type JudgeReasoning, type JudgeResult } from "./judge";
import type { ChatParams, ChatResult, CostMeter } from "./llm";
import { countTokens } from "./tokens";
import { resolveTools } from "./tools";
import {
  JUDGE_MIN_OUTCOME,
  OUTCOME_MAX,
  SAFETY_CAP,
  type AgentConfig,
  type Challenge,
  type CheckResult,
  type Fixtures,
} from "./types";

/** The config can't be run as given (context over budget, unknown tools). */
export class ConfigError extends Error {}

export interface ScoreOptions {
  executorModel: string;
  judgeModel: string;
  judgeReasoning: JudgeReasoning;
  /** >1 re-judges the same transcripts to measure judge spread; quality is the mean. */
  judgeRuns?: number;
  meter: CostMeter;
  seed?: number;
  maxTestTokens?: number;
  chatFn?: (params: ChatParams) => Promise<ChatResult>; // injectable for tests
}

export interface TestResult {
  testId: string;
  run: TestRun;
  checks: CheckResult[];
  outcomeFraction: number; // 0 when the test hit its token cap
  safetyViolations: SafetyViolation[];
  judgeRuns: JudgeResult[]; // empty when not judged
  quality: number; // mean over judge runs; 0 when not judged
}

export interface CriterionSpread {
  id: string;
  label: string;
  runs: number[]; // mean points per run over judged tests
  spread: number; // max - min of runs, in points
  maxTestScoreSpread: number; // largest max - min of the raw 0-4 score on any single test
}

export interface AttemptResult {
  challenge: { slug: string; version: number };
  executorModel: string;
  judgeModel: string;
  judgeReasoning: JudgeReasoning;
  tests: TestResult[];
  outcome: number;
  quality: number;
  efficiency: EfficiencyResult;
  judgeSkipped: boolean;
  safetyViolations: (SafetyViolation & { testId: string })[];
  capped: boolean;
  total: number;
  avgTokens: number;
  avgSteps: number;
  judgeSpread: CriterionSpread[] | null; // when judgeRuns > 1 and the judge ran
  cost: { executorUsd: number; judgeUsd: number; totalUsd: number };
}

export function validateConfig<F extends Fixtures>(challenge: Challenge<F>, config: AgentConfig): void {
  try {
    resolveTools(challenge, config.tools);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  if (challenge.contextBudgetTokens !== undefined) {
    const used = countTokens(config.context);
    if (used > challenge.contextBudgetTokens) {
      throw new ConfigError(`Context uses ${used} tokens, budget is ${challenge.contextBudgetTokens}`);
    }
  }
}

/**
 * Score one attempt: run every test, apply checks and safety rules, judge if Outcome >= 30,
 * compute efficiency and the safety cap. AttemptCostExceededError propagates (attempt aborted).
 */
export async function scoreAttempt<F extends Fixtures>(
  challenge: Challenge<F>,
  config: AgentConfig,
  opts: ScoreOptions,
): Promise<AttemptResult> {
  validateConfig(challenge, config);
  const judgeRuns = Math.max(1, opts.judgeRuns ?? 1);
  const tests = challenge.testPool;

  const runs = await settleAll(
    tests.map((test) =>
      runTest(challenge, config, test, {
        model: opts.executorModel,
        meter: opts.meter,
        seed: opts.seed,
        maxTestTokens: opts.maxTestTokens,
        chatFn: opts.chatFn,
      }),
    ),
  );

  const results: TestResult[] = tests.map((test, i) => {
    const run = runs[i];
    const checks = evaluateChecks([...challenge.checks, ...test.checks], run.transcript);
    return {
      testId: test.id,
      run,
      checks,
      outcomeFraction: run.stopReason === "token_cap" ? 0 : passFraction(checks),
      safetyViolations: findSafetyViolations([...challenge.safetyRules, ...(test.safetyRules ?? [])], run.transcript),
      judgeRuns: [],
      quality: 0,
    };
  });

  const outcome = mean(results.map((r) => r.outcomeFraction)) * OUTCOME_MAX;
  const judgeSkipped = outcome < JUDGE_MIN_OUTCOME;

  if (!judgeSkipped) {
    const judged = results.filter((r) => r.run.stopReason !== "token_cap");
    const verdicts = await settleAll(
      judged.flatMap((r) => {
        const input = tests.find((t) => t.id === r.testId)!.input;
        return Array.from({ length: judgeRuns }, () =>
          judgeTest(challenge, input, r.run.transcript, {
            model: opts.judgeModel,
            meter: opts.meter,
            reasoning: opts.judgeReasoning,
            chatFn: opts.chatFn,
          }),
        );
      }),
    );
    judged.forEach((r, i) => {
      r.judgeRuns = verdicts.slice(i * judgeRuns, (i + 1) * judgeRuns);
      r.quality = mean(r.judgeRuns.map((j) => j.quality));
    });
  }

  const quality = mean(results.map((r) => r.quality));
  const avgTokens = mean(results.map((r) => r.run.totalTokens));
  const avgSteps = mean(results.map((r) => r.run.steps));
  const efficiency = efficiencyScore({ avgTokens, avgSteps }, challenge.reference, outcome / OUTCOME_MAX);

  const safetyViolations = results.flatMap((r) => r.safetyViolations.map((v) => ({ ...v, testId: r.testId })));
  const capped = safetyViolations.length > 0;
  const uncapped = outcome + quality + efficiency.points;

  const executorUsd = sum(results.map((r) => r.run.costUsd));
  const judgeUsd = sum(results.flatMap((r) => r.judgeRuns.map((j) => j.costUsd)));

  return {
    challenge: { slug: challenge.slug, version: challenge.version },
    executorModel: opts.executorModel,
    judgeModel: opts.judgeModel,
    judgeReasoning: opts.judgeReasoning,
    tests: results,
    outcome,
    quality,
    efficiency,
    judgeSkipped,
    safetyViolations,
    capped,
    total: capped ? Math.min(uncapped, SAFETY_CAP) : uncapped,
    avgTokens,
    avgSteps,
    judgeSpread: judgeRuns > 1 && !judgeSkipped ? judgeSpread(challenge, results, judgeRuns) : null,
    cost: { executorUsd, judgeUsd, totalUsd: executorUsd + judgeUsd },
  };
}

function judgeSpread<F extends Fixtures>(challenge: Challenge<F>, results: TestResult[], judgeRuns: number): CriterionSpread[] {
  const judged = results.filter((r) => r.judgeRuns.length === judgeRuns);
  return challenge.rubric.map((criterion) => {
    const pick = (j: JudgeResult) => j.criteria.find((c) => c.id === criterion.id)!;
    const runs = Array.from({ length: judgeRuns }, (_, k) => mean(judged.map((r) => pick(r.judgeRuns[k]).points)));
    const perTest = judged.map((r) => {
      const scores = r.judgeRuns.map((j) => pick(j).score);
      return Math.max(...scores) - Math.min(...scores);
    });
    return {
      id: criterion.id,
      label: criterion.label,
      runs,
      spread: Math.max(...runs) - Math.min(...runs),
      maxTestScoreSpread: perTest.length ? Math.max(...perTest) : 0,
    };
  });
}

/** Like Promise.all, but waits for every promise before rethrowing the first error. */
async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}
