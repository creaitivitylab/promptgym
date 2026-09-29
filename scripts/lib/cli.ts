import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { JUDGE_REASONING_EFFORTS, type JudgeReasoning } from "@/lib/engine/judge";
import type { AttemptResult } from "@/lib/engine/score";
import { agentConfigSchema, type AgentConfig, type Challenge } from "@/lib/engine/types";

export const ROOT = path.resolve(__dirname, "..", "..");

/** A config path, or @reference / @decent / @lazy for the challenge's own configs. */
export function loadConfig(challenge: Challenge, ref: string): AgentConfig {
  if (ref === "@reference") return agentConfigSchema.parse(challenge.reference.config);
  const file = ref.startsWith("@")
    ? path.join(ROOT, "challenges", "configs", `${challenge.slug}.${ref.slice(1)}.json`)
    : path.resolve(ref);
  return agentConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function parseReasoning(value: string | undefined): JudgeReasoning {
  const effort = value ?? process.env.JUDGE_REASONING ?? "low";
  if (!(JUDGE_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`Judge reasoning must be one of ${JUDGE_REASONING_EFFORTS.join(", ")}, got "${effort}"`);
  }
  return effort as JudgeReasoning;
}

/** Append one line per attempt with its real cost (groundwork for usage_daily). */
export function logAttempt(result: AttemptResult, config: AgentConfig, label: string): void {
  const dir = path.join(ROOT, ".data");
  mkdirSync(dir, { recursive: true });
  const line = {
    at: new Date().toISOString(),
    label,
    challenge: result.challenge,
    configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12),
    executorModel: result.executorModel,
    judgeModel: result.judgeModel,
    judgeReasoning: result.judgeReasoning,
    judgeRuns: result.tests.find((t) => t.judgeRuns.length)?.judgeRuns.length ?? 0,
    outcome: round(result.outcome),
    quality: round(result.quality),
    efficiency: round(result.efficiency.points),
    total: round(result.total),
    capped: result.capped,
    cost: {
      executorUsd: result.cost.executorUsd,
      judgeUsd: result.cost.judgeUsd,
      estimatedUnknownUsd: result.cost.estimatedUnknownUsd,
      totalUsd: result.cost.totalUsd,
    },
    ...(result.cost.costUnknown
      ? { cost_unknown: true, unknownCostCalls: result.cost.unknownCostCalls }
      : {}),
  };
  appendFileSync(path.join(dir, "attempts.jsonl"), JSON.stringify(line) + "\n");
}

export const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
export const f1 = (n: number) => n.toFixed(1);
export const usd = (n: number) => `$${n.toFixed(4)}`;
export const pad = (s: string | number, n: number) => String(s).padEnd(n);
export const lpad = (s: string | number, n: number) => String(s).padStart(n);

export function printAttempt(result: AttemptResult, verbose = true): void {
  for (const t of result.tests) {
    const passed = t.checks.filter((c) => c.passed).length;
    const quality = t.judgeRuns.length ? `Q ${f1(t.quality)}` : "Q -";
    console.log(
      `${pad(t.testId, 26)} ${pad(t.run.stopReason, 9)} ${lpad(t.run.steps, 2)} steps ${lpad(t.run.totalTokens, 6)} tok  ${usd(t.run.costUsd)}  checks ${passed}/${t.checks.length}  ${quality}`,
    );
    if (!verbose) continue;
    for (const c of t.checks.filter((c) => !c.passed)) console.log(`    ✗ ${c.label}: ${c.detail}`);
    for (const v of t.safetyViolations) console.log(`    ⚠ SAFETY ${v.id}: ${v.description} (${v.detail})`);
    for (const j of t.judgeRuns.slice(0, 1)) {
      for (const c of j.criteria) console.log(`    · ${c.id} ${c.score}/4: ${c.reason}`);
    }
  }
  const e = result.efficiency;
  console.log(
    `\nOutcome ${f1(result.outcome)}/60  Quality ${result.judgeSkipped ? "skipped (Outcome < 30)" : `${f1(result.quality)}/25`}  Efficiency ${f1(e.points)}/15` +
      ` (tokens ${f1(result.avgTokens)} ratio ${e.tokenRatio.toFixed(2)}, steps ${f1(result.avgSteps)} ratio ${e.stepRatio.toFixed(2)}${e.calibrated ? "" : ", UNCALIBRATED"})`,
  );
  console.log(`Total ${f1(result.total)}${result.capped ? `  (capped at 40: ${result.safetyViolations.length} safety violation(s))` : ""}`);
  console.log(`Cost ${usd(result.cost.totalUsd)}  (executor ${usd(result.cost.executorUsd)}, judge ${usd(result.cost.judgeUsd)})`);
  for (const c of result.cost.unknownCostCalls) {
    console.log(`  ⚠ cost unknown: ${c.model} ${c.generationId ?? "(no generation id)"}, estimated ${usd(c.estimatedUsd)}: ${c.error}`);
  }
}
