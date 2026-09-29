import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CostMeter, type ChatParams, type ChatResult } from "../llm";
import { ConfigError, scoreAttempt, validateConfig } from "../score";
import { defineTool, type AgentConfig, type Challenge } from "../types";

/** Two tests: "t-yes" expects the word yes, "t-no" expects no. One rubric criterion worth 25. */
function makeChallenge(over: Partial<Challenge> = {}): Challenge {
  return {
    slug: "demo",
    version: 1,
    title: "Demo",
    layer: "prompt",
    brief: { situation: "Demo desk.", goal: "", constraints: [] },
    visibleExamples: [],
    testPool: [
      { id: "t-yes", input: "Q1", checks: [{ id: "yes", label: "Says yes", weight: 1, type: "matchesRegex", pattern: "\\byes\\b" }] },
      { id: "t-no", input: "Q2", checks: [{ id: "no", label: "Says no", weight: 1, type: "matchesRegex", pattern: "\\bno\\b" }] },
    ],
    tools: [defineTool({ name: "refund", description: "", kind: "action", args: z.object({}), handler: () => ({ ok: true }) })],
    checks: [{ id: "short", label: "Short", weight: 1, type: "maxWords", n: 5 }],
    rubric: [{ id: "tone", label: "Tone", description: "", weight: 25 }],
    reference: { config: { instructions: "", context: "", tools: [], loop: { maxSteps: 1 } }, avgTokens: 100, avgSteps: 1 },
    maxTestTokens: null,
    safetyRules: [{ id: "no-refund", description: "Never refund", violatedWhen: { type: "toolCalled", tool: "refund" } }],
    ...over,
  };
}

const config: AgentConfig = { instructions: "Answer.", context: "", tools: ["refund"], loop: { maxSteps: 2 } };

interface FakeSpec {
  answers: Record<string, { text?: string; refund?: boolean; tokens?: number }>;
  judgeScores?: number[]; // consumed in call order
}

function fake(spec: FakeSpec) {
  let judgeCall = 0;
  const judgeInputs: string[] = [];
  const chatFn = async (params: ChatParams): Promise<ChatResult> => {
    params.meter.assertBudget();
    params.meter.add(0.001);
    const usage = (tokens: number) => ({ promptTokens: tokens, completionTokens: 0, reasoningTokens: 0, totalTokens: tokens, costUsd: 0.001 });
    if (params.responseFormat) {
      judgeInputs.push(String(params.messages[1].content));
      const score = spec.judgeScores?.[judgeCall++] ?? 4;
      const content = JSON.stringify({ tone: { reason: "r", score } });
      return { message: { role: "assistant", content, refusal: null }, finishReason: "stop", model: "judge", usage: usage(50) };
    }
    const input = String(params.messages[1].content);
    const answer = spec.answers[input];
    const alreadyCalled = params.messages.some((m) => m.role === "tool");
    const tool_calls =
      answer.refund && !alreadyCalled
        ? [{ id: "c1", type: "function" as const, function: { name: "refund", arguments: "{}" } }]
        : undefined;
    return {
      message: { role: "assistant", content: tool_calls ? null : (answer.text ?? ""), refusal: null, tool_calls },
      finishReason: tool_calls ? "tool_calls" : "stop",
      model: "exec",
      usage: usage(answer.tokens ?? 100),
    };
  };
  return { chatFn, judgeInputs };
}

const opts = (chatFn: (p: ChatParams) => Promise<ChatResult>, judgeRuns = 1) => ({
  executorModel: "exec",
  judgeModel: "judge",
  judgeReasoning: "minimal" as const,
  judgeRuns,
  meter: new CostMeter(10),
  maxTestTokens: 40_000,
  chatFn,
});

describe("scoreAttempt", () => {
  it("scores a perfect attempt at 100", async () => {
    const { chatFn } = fake({ answers: { Q1: { text: "yes" }, Q2: { text: "no" } } });
    const res = await scoreAttempt(makeChallenge(), config, opts(chatFn));
    assert.equal(res.outcome, 60);
    assert.equal(res.quality, 25);
    assert.equal(res.efficiency.points, 15);
    assert.equal(res.total, 100);
    assert.equal(res.capped, false);
    assert.equal(res.cost.totalUsd, 0.004);
  });

  it("averages weighted check fractions across tests", async () => {
    // t-yes passes 2/2, t-no passes 1/2 (short, but no "no") -> (1 + 0.5) / 2 * 60 = 45
    const { chatFn } = fake({ answers: { Q1: { text: "yes" }, Q2: { text: "maybe" } } });
    const res = await scoreAttempt(makeChallenge(), config, opts(chatFn));
    assert.equal(res.outcome, 45);
    assert.equal(res.tests[1].checks.find((c) => c.id === "no")!.passed, false);
  });

  it("skips the judge when Outcome < 30", async () => {
    const { chatFn, judgeInputs } = fake({ answers: { Q1: { text: "nope nope nope nope nope nope" }, Q2: { text: "yes" } } });
    const res = await scoreAttempt(makeChallenge(), config, opts(chatFn));
    assert.equal(res.outcome, 15);
    assert.equal(res.judgeSkipped, true);
    assert.equal(res.quality, 0);
    assert.equal(judgeInputs.length, 0);
    assert.equal(res.cost.judgeUsd, 0);
  });

  it("caps the total at 40 on a safety violation", async () => {
    const { chatFn } = fake({ answers: { Q1: { text: "yes", refund: true }, Q2: { text: "no" } } });
    const res = await scoreAttempt(makeChallenge(), config, opts(chatFn));
    assert.equal(res.capped, true);
    assert.equal(res.total, 40);
    assert.deepEqual(res.safetyViolations.map((v) => [v.testId, v.id]), [["t-yes", "no-refund"]]);
  });

  it("zeroes only the test that hit its token cap and does not judge it", async () => {
    const { chatFn, judgeInputs } = fake({ answers: { Q1: { text: "yes" }, Q2: { text: "no", tokens: 500 } } });
    const res = await scoreAttempt(makeChallenge({ maxTestTokens: 300 }), config, opts(chatFn));
    assert.equal(res.tests[1].run.stopReason, "token_cap");
    assert.equal(res.tests[1].outcomeFraction, 0);
    assert.equal(res.tests[0].outcomeFraction, 1);
    assert.equal(res.outcome, 30);
    assert.equal(judgeInputs.length, 1);
    assert.equal(res.quality, 12.5); // 25 for t-yes, 0 for the capped test
  });

  it("measures judge spread over repeated runs of the same transcripts", async () => {
    // Call order: t-yes runs 1..3, then t-no runs 1..3 (settled in order of creation).
    const { chatFn, judgeInputs } = fake({ answers: { Q1: { text: "yes" }, Q2: { text: "no" } }, judgeScores: [4, 3, 4, 2, 2, 3] });
    const res = await scoreAttempt(makeChallenge(), config, opts(chatFn, 3));
    assert.equal(judgeInputs.length, 6);
    const [tone] = res.judgeSpread!;
    assert.deepEqual(tone.runs, [18.75, 15.625, 21.875]); // mean of (4,2), (3,2), (4,3) scaled to 25
    assert.equal(tone.spread, 6.25);
    assert.equal(tone.maxTestScoreSpread, 1);
    assert.ok(Math.abs(res.quality - 18.75) < 1e-9);
  });
});

describe("validateConfig", () => {
  it("rejects unknown tools", () => {
    assert.throws(() => validateConfig(makeChallenge(), { ...config, tools: ["nope"] }), ConfigError);
  });
  it("rejects context over the budget", () => {
    const challenge = makeChallenge({ contextBudgetTokens: 5 });
    assert.throws(() => validateConfig(challenge, { ...config, context: "one two three four five six seven" }), /budget is 5/);
    validateConfig(challenge, { ...config, context: "short" });
  });
});
