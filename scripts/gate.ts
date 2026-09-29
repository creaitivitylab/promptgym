import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { challenges, getChallenge } from "../challenges";
import { CostMeter, envModel } from "@/lib/engine/llm";
import { scoreAttempt, type AttemptResult } from "@/lib/engine/score";
import type { Challenge } from "@/lib/engine/types";
import { f1, loadConfig, logAttempt, parseReasoning, ROOT, usd } from "./lib/cli";

const JUDGE_RUNS = 3;
const MAX_SPREAD = 1;
const CONFIGS = [
  { name: "reference", ref: "@reference", gate: (t: number) => t >= 85, rule: ">= 85" },
  { name: "decent", ref: "@decent", gate: (t: number) => t >= 50 && t <= 75, rule: "50-75" },
  { name: "lazy", ref: "@lazy", gate: (t: number) => t <= 40, rule: "<= 40" },
] as const;

const USAGE = `Usage: pnpm gate [slug...] [--judge-reasoning minimal|low|medium] [--executor <model>]`;

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
  const judgeReasoning = parseReasoning(values["judge-reasoning"]);
  const executorModel = values.executor ?? envModel("EXECUTOR_MODEL");
  const judgeModel = envModel("JUDGE_MODEL");

  console.log(`# Gate · executor ${executorModel} · judge ${judgeModel} (reasoning ${judgeReasoning}) · ${JUDGE_RUNS} judge runs\n`);
  const summary: Record<string, unknown>[] = [];
  let allPassed = true;
  let gateSpend = 0;

  for (const slug of slugs) {
    const challenge = getChallenge(slug);
    const results = await Promise.all(
      CONFIGS.map(async (c) => {
        const config = loadConfig(challenge, c.ref);
        const result = await scoreAttempt(challenge, config, {
          executorModel,
          judgeModel,
          judgeReasoning,
          judgeRuns: JUDGE_RUNS,
          meter: new CostMeter(new CostMeter().ceilingUsd * JUDGE_RUNS),
          seed: 42,
        });
        logAttempt(result, config, `gate:${c.name}`);
        return result;
      }),
    );
    const passed = printChallenge(challenge, results);
    allPassed &&= passed;
    gateSpend += results.reduce((s, r) => s + r.cost.totalUsd, 0);
    summary.push({
      slug,
      passed,
      configs: Object.fromEntries(
        results.map((r, i) => [
          CONFIGS[i].name,
          { outcome: r.outcome, quality: r.quality, efficiency: r.efficiency.points, total: r.total, capped: r.capped, spread: r.judgeSpread, cost: r.cost },
        ]),
      ),
    });
  }

  console.log(`Gate ${allPassed ? "PASSED" : "FAILED"} · spent ${usd(gateSpend)} on this gate run`);
  const dir = path.join(ROOT, ".data");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gate-${judgeReasoning}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ executorModel, judgeModel, judgeReasoning, summary }, null, 2));
  console.log(`Saved ${path.relative(ROOT, file)}`);
  process.exit(allPassed ? 0 : 1);
}

/** Normal attempt cost: executor plus one judge run (the gate judges every transcript JUDGE_RUNS times). */
const attemptCost = (r: AttemptResult) => r.cost.executorUsd + r.cost.judgeUsd / JUDGE_RUNS;

function printChallenge(challenge: Challenge, results: AttemptResult[]): boolean {
  console.log(`## ${challenge.slug} (v${challenge.version})\n`);
  console.log(`| config | Outcome /60 | Quality /25 | Efficiency /15 | Total | Gate | Cost / attempt |`);
  console.log(`|---|---:|---:|---:|---:|---|---:|`);
  let passed = true;
  results.forEach((r, i) => {
    const c = CONFIGS[i];
    const ok = c.gate(r.total);
    passed &&= ok;
    const quality = r.judgeSkipped ? "skipped" : f1(r.quality);
    const cap = r.capped ? ` (capped, ${f1(r.outcome + r.quality + r.efficiency.points)} uncapped)` : "";
    console.log(`| ${c.name} | ${f1(r.outcome)} | ${quality} | ${f1(r.efficiency.points)} | **${f1(r.total)}**${cap} | ${c.rule} ${ok ? "✅" : "❌"} | ${usd(attemptCost(r))} |`);
  });

  console.log(`\nJudge spread over ${JUDGE_RUNS} runs, in points (largest raw 0-4 spread on a single test):\n`);
  console.log(`| criterion (weight) | ${CONFIGS.map((c) => c.name).join(" | ")} |`);
  console.log(`|---|${CONFIGS.map(() => "---:").join("|")}|`);
  for (const criterion of challenge.rubric) {
    const cells = results.map((r) => {
      const s = r.judgeSpread?.find((x) => x.id === criterion.id);
      if (!s) return "skipped";
      if (s.spread > MAX_SPREAD) passed = false;
      return `${s.spread.toFixed(2)} (${s.maxTestScoreSpread})${s.spread > MAX_SPREAD ? " ❌" : ""}`;
    });
    console.log(`| ${criterion.id} (${criterion.weight}) | ${cells.join(" | ")} |`);
  }
  const avg = results.reduce((s, r) => s + attemptCost(r), 0) / results.length;
  console.log(`\nAverage cost per attempt: ${usd(avg)} · ${passed ? "PASS" : "FAIL"}\n`);
  return passed;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
