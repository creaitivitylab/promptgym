import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { challenges, getChallenge } from "../challenges";
import { CostMeter, envModel } from "@/lib/engine/llm";
import { scoreAttempt, type AttemptResult } from "@/lib/engine/score";
import type { AgentConfig, Challenge } from "@/lib/engine/types";
import { f1, loadConfig, logAttempt, parseReasoning, ROOT, usd } from "./lib/cli";

const RUNS = 5; // band is checked on the mean Total of the runs
const MAX_TOTAL_SD = 3; // stability: sample standard deviation of Total
const WARN_TOTAL_RANGE = 8; // max - min above this prints a warning, doesn't fail
const JUDGE_RUNS = 3; // run 1 is judged JUDGE_RUNS times to measure judge spread; runs 2..RUNS once
const MAX_SPREAD = 1;
const CONFIGS = [
  { name: "reference", ref: "@reference", gate: (t: number) => t >= 85, rule: ">= 85" },
  { name: "decent", ref: "@decent", gate: (t: number) => t >= 50 && t <= 75, rule: "50-75" },
  { name: "lazy", ref: "@lazy", gate: (t: number) => t <= 40, rule: "<= 40" },
] as const;

const USAGE = `Usage: pnpm gate [slug...] [--judge-reasoning minimal|low|medium] [--executor <model>]`;

interface Opts {
  executorModel: string;
  judgeModel: string;
  judgeReasoning: ReturnType<typeof parseReasoning>;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "judge-reasoning": { type: "string" }, executor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const slugs = positionals.length ? positionals : Object.keys(challenges);
  const opts: Opts = {
    executorModel: values.executor ?? envModel("EXECUTOR_MODEL"),
    judgeModel: envModel("JUDGE_MODEL"),
    judgeReasoning: parseReasoning(values["judge-reasoning"]),
  };

  console.log(
    `# Gate · executor ${opts.executorModel} · judge ${opts.judgeModel} (reasoning ${opts.judgeReasoning})\n` +
      `${RUNS} runs per config (run 1 judged ${JUDGE_RUNS}x for spread) · pass = mean Total in band, SD of Total <= ${MAX_TOTAL_SD}, judge spread <= ${MAX_SPREAD} · range > ${WARN_TOTAL_RANGE} warns\n`,
  );
  const summary: Record<string, unknown>[] = [];
  let allPassed = true;
  let gateSpend = 0;

  for (const slug of slugs) {
    const challenge = getChallenge(slug);
    const runsPerConfig = await Promise.all(CONFIGS.map((c) => runConfig(challenge, loadConfig(challenge, c.ref), c.name, opts)));
    const passed = printChallenge(challenge, runsPerConfig);
    allPassed &&= passed;
    gateSpend += runsPerConfig.flat().reduce((s, r) => s + r.cost.totalUsd, 0);
    summary.push({
      slug,
      passed,
      configs: Object.fromEntries(
        runsPerConfig.map((runs, i) => [
          CONFIGS[i].name,
          runs.map((r) => ({ outcome: r.outcome, quality: r.quality, efficiency: r.efficiency.points, total: r.total, capped: r.capped, spread: r.judgeSpread, cost: r.cost })),
        ]),
      ),
    });
  }

  console.log(`Gate ${allPassed ? "PASSED" : "FAILED"} · spent ${usd(gateSpend)} on this gate run`);
  const dir = path.join(ROOT, ".data");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gate-${opts.judgeReasoning}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ ...opts, runs: RUNS, summary }, null, 2));
  console.log(`Saved ${path.relative(ROOT, file)}`);
  process.exit(allPassed ? 0 : 1);
}

/** RUNS sequential attempts of one config (sequential to stay clear of rate limits). */
async function runConfig(challenge: Challenge, config: AgentConfig, name: string, opts: Opts): Promise<AttemptResult[]> {
  const results: AttemptResult[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const judgeRuns = run === 1 ? JUDGE_RUNS : 1;
    const result = await scoreAttempt(challenge, config, {
      ...opts,
      judgeRuns,
      meter: new CostMeter(new CostMeter().ceilingUsd * judgeRuns),
    });
    logAttempt(result, config, `gate:${name}:${run}`);
    results.push(result);
  }
  return results;
}

const uncapped = (r: AttemptResult) => r.outcome + r.quality + r.efficiency.points;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Sample standard deviation (n - 1). */
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
/** Normal attempt cost: executor plus one judge run. */
const attemptCost = (r: AttemptResult) => {
  const judgeRuns = r.tests.find((t) => t.judgeRuns.length)?.judgeRuns.length || 1;
  return r.cost.executorUsd + r.cost.judgeUsd / judgeRuns + r.cost.estimatedUnknownUsd;
};

function printChallenge(challenge: Challenge, runsPerConfig: AttemptResult[][]): boolean {
  console.log(`## ${challenge.slug} (v${challenge.version})\n`);
  console.log(`| config | Outcome /60 | Quality /25 | Efficiency /15 | Total (mean) | SD | Range | Gate | Stable | Cost / attempt |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|---|---|---:|`);
  let passed = true;
  const notes: string[] = [];

  runsPerConfig.forEach((runs, i) => {
    const c = CONFIGS[i];
    const totals = runs.map((r) => r.total);
    const meanTotal = mean(totals);
    const deviation = sd(totals);
    const range = Math.max(...totals) - Math.min(...totals);
    const inBand = c.gate(meanTotal);
    const viaCap = runs.some((r) => r.capped) && inBand && !c.gate(mean(runs.map(uncapped)));
    const stable = deviation <= MAX_TOTAL_SD;
    passed &&= inBand && stable;

    const quality = runs.every((r) => r.judgeSkipped) ? "skipped" : f1(mean(runs.map((r) => r.quality)));
    const gate = `${c.rule} ${inBand ? "✅" : "❌"}${viaCap ? " **passes via safety cap**" : ""}`;
    console.log(
      `| ${c.name} | ${f1(mean(runs.map((r) => r.outcome)))} | ${quality} | ${f1(mean(runs.map((r) => r.efficiency.points)))} | ` +
        `**${f1(meanTotal)}** | ${deviation.toFixed(2)} | ${f1(Math.min(...totals))}-${f1(Math.max(...totals))} (Δ${f1(range)})${range > WARN_TOTAL_RANGE ? " ⚠️" : ""} | ` +
        `${gate} | ${stable ? "✅" : "❌"} | ${usd(mean(runs.map(attemptCost)))} |`,
    );
    const perRun = runs.map((r) => (r.capped ? `${f1(r.total)} (capped, ${f1(uncapped(r))} uncapped)` : f1(r.total)));
    notes.push(`- ${c.name} totals: ${perRun.join(", ")}`);
    if (range > WARN_TOTAL_RANGE) notes.push(`  ⚠️ warning: ${c.name} Total range ${f1(range)} > ${WARN_TOTAL_RANGE} (not a failure)`);
    const unknown = runs.flatMap((r) => r.cost.unknownCostCalls);
    if (unknown.length) notes.push(`  ⚠️ ${c.name}: ${unknown.length} call(s) with unknown cost, estimated ${usd(unknown.reduce((a, u) => a + u.estimatedUsd, 0))}`);
  });
  console.log(`\n${notes.join("\n")}`);

  console.log(`\nJudge spread over ${JUDGE_RUNS} judge runs of run 1, in points (largest raw 0-4 spread on a single test):\n`);
  console.log(`| criterion (weight) | ${CONFIGS.map((c) => c.name).join(" | ")} |`);
  console.log(`|---|${CONFIGS.map(() => "---:").join("|")}|`);
  for (const criterion of challenge.rubric) {
    const cells = runsPerConfig.map((runs) => {
      const s = runs[0].judgeSpread?.find((x) => x.id === criterion.id);
      if (!s) return "skipped";
      if (s.spread > MAX_SPREAD) passed = false;
      return `${s.spread.toFixed(2)} (${s.maxTestScoreSpread})${s.spread > MAX_SPREAD ? " ❌" : ""}`;
    });
    console.log(`| ${criterion.id} (${criterion.weight}) | ${cells.join(" | ")} |`);
  }

  const avg = mean(runsPerConfig.flat().map(attemptCost));
  console.log(`\nAverage cost per attempt: ${usd(avg)} · ${passed ? "PASS" : "FAIL"}\n`);
  return passed;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
