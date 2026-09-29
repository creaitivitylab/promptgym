import { parseArgs } from "node:util";
import { getChallenge } from "../challenges";
import { AttemptCostExceededError, CostMeter, envModel } from "@/lib/engine/llm";
import { tokenCap } from "@/lib/engine/calibration";
import { ConfigError, scoreAttempt } from "@/lib/engine/score";
import { loadConfig, logAttempt, parseReasoning, printAttempt } from "./lib/cli";

const USAGE = `Usage: pnpm score <slug> <config.json|@reference|@decent|@lazy> [options]
       pnpm score <slug> --calibrate [options]

Options:
  --executor <model>          executor model (default: env EXECUTOR_MODEL)
  --judge-runs <n>            judge the same transcripts n times and report spread (default 1)
  --judge-reasoning <effort>  minimal | low | medium (default: env JUDGE_REASONING or low)
  --calibrate                 run the reference config and print avgTokens, avgSteps, maxTestTokens
  --json                      print the full result as JSON`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      executor: { type: "string" },
      "judge-runs": { type: "string" },
      "judge-reasoning": { type: "string" },
      calibrate: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [slug, configRef] = positionals;
  if (values.help || !slug || (!configRef && !values.calibrate)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const challenge = getChallenge(slug);
  const ref = values.calibrate ? "@reference" : configRef;
  const config = loadConfig(challenge, ref);
  const judgeRuns = Number(values["judge-runs"] ?? 1);
  const meter = new CostMeter(new CostMeter().ceilingUsd * judgeRuns);

  const result = await scoreAttempt(challenge, config, {
    executorModel: values.executor ?? envModel("EXECUTOR_MODEL"),
    judgeModel: envModel("JUDGE_MODEL"),
    judgeReasoning: parseReasoning(values["judge-reasoning"]),
    judgeRuns,
    meter,
  });
  logAttempt(result, config, values.calibrate ? "calibrate" : ref);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${challenge.slug} v${challenge.version} · ${ref} · executor ${result.executorModel} · judge ${result.judgeModel} (${result.judgeReasoning})\n`);
  printAttempt(result);

  if (result.judgeSpread) {
    console.log(`\nJudge spread over ${judgeRuns} runs (points; largest raw 0-4 spread on one test):`);
    for (const c of result.judgeSpread) console.log(`  ${c.id.padEnd(22)} ${c.spread.toFixed(2)}  (${c.maxTestScoreSpread})`);
  }

  if (values.calibrate) {
    const avgTokens = Math.round(result.avgTokens);
    const avgSteps = Math.round(result.avgSteps * 10) / 10;
    console.log(`\nCalibration for challenges/${challenge.slug}.ts:`);
    console.log(`  reference: { ..., avgTokens: ${avgTokens}, avgSteps: ${avgSteps} },`);
    console.log(`  maxTestTokens: ${tokenCap(challenge, result.avgTokens, result.avgSteps)},`);
  }
}

main().catch((err) => {
  if (err instanceof AttemptCostExceededError) {
    console.error(`Attempt aborted: ${err.message}`);
    process.exit(2);
  }
  if (err instanceof ConfigError) {
    console.error(`Invalid config: ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
