import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { judgeTest, judgeUserPrompt } from "../judge";
import { CostMeter, type ChatParams, type ChatResult } from "../llm";
import { defineTool, type Challenge, type Transcript } from "../types";

const challenge = {
  brief: { situation: "Support desk of a homeware store.", goal: "", constraints: [] },
  rubric: [
    { id: "empathy", label: "Empathy", description: "0 = cold, 4 = warm and specific", weight: 15 },
    { id: "clarity", label: "Clarity", description: "0 = confusing, 4 = crisp", weight: 10 },
  ],
  tools: [
    defineTool({ name: "get_order", description: "", kind: "read", args: z.object({ order_id: z.string() }), handler: () => ({}) }),
    defineTool({ name: "send_reply", description: "", kind: "action", args: z.object({ message: z.string() }), handler: () => ({}) }),
  ],
} as unknown as Challenge;

const transcript: Transcript = {
  finalText: "Replied to the customer.",
  toolCalls: [
    { step: 1, tool: "get_order", args: { order_id: "A1" }, succeeded: true, result: { secret_internal: "x" } },
    { step: 2, tool: "send_reply", args: { message: "Sorry, Anna!" }, succeeded: true, result: { ok: true } },
    { step: 2, tool: "issue_refund", args: { amount_usd: 60 }, succeeded: false, error: "not available" },
  ],
};

function fakeJudge(contents: (string | null)[]) {
  const calls: ChatParams[] = [];
  const chatFn = async (params: ChatParams): Promise<ChatResult> => {
    calls.push(params);
    return {
      message: { role: "assistant", content: contents[Math.min(calls.length - 1, contents.length - 1)], refusal: null },
      finishReason: "stop",
      model: params.model,
      usage: { promptTokens: 500, completionTokens: 80, reasoningTokens: 0, totalTokens: 580, costUsd: 0.002 },
    };
  };
  return { chatFn, calls };
}

const valid = JSON.stringify({ empathy: { reason: "Warm.", score: 3 }, clarity: { reason: "Crisp.", score: 4 } });
const opts = (chatFn: (p: ChatParams) => Promise<ChatResult>) => ({ model: "fake/judge", meter: new CostMeter(1), reasoning: "minimal" as const, chatFn });

describe("judgeTest", () => {
  it("scales 0-4 scores to criterion weights", async () => {
    const { chatFn } = fakeJudge([valid]);
    const res = await judgeTest(challenge, "My mug broke.", transcript, opts(chatFn));
    assert.deepEqual(res.criteria.map((c) => [c.id, c.score, c.points]), [["empathy", 3, 11.25], ["clarity", 4, 10]]);
    assert.equal(res.quality, 21.25);
    assert.equal(res.costUsd, 0.002);
  });

  it("sends temperature 0, the reasoning effort and a strict schema requiring every criterion", async () => {
    const { chatFn, calls } = fakeJudge([valid]);
    await judgeTest(challenge, "My mug broke.", transcript, opts(chatFn));
    const [call] = calls;
    assert.equal(call.temperature, 0);
    assert.deepEqual(call.reasoning, { effort: "minimal" });
    const format = call.responseFormat as { type: string; json_schema: { strict: boolean; schema: Record<string, unknown> } };
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assert.deepEqual(format.json_schema.schema.required, ["empathy", "clarity"]);
    assert.equal(format.json_schema.schema.$schema, undefined);
  });

  it("retries once on invalid output", async () => {
    const { chatFn, calls } = fakeJudge(["not json", valid]);
    const res = await judgeTest(challenge, "x", transcript, opts(chatFn));
    assert.equal(calls.length, 2);
    assert.equal(res.costUsd, 0.004);
  });

  it("throws after two invalid outputs", async () => {
    const bad = JSON.stringify({ empathy: { reason: "x", score: 7 }, clarity: { reason: "x", score: 2 } });
    const { chatFn } = fakeJudge([bad, null]);
    await assert.rejects(judgeTest(challenge, "x", transcript, opts(chatFn)), /invalid scores twice/);
  });
});

describe("judgeUserPrompt", () => {
  it("shows input, final answer and action calls only, marking rejected ones", () => {
    const prompt = judgeUserPrompt("My mug broke.", transcript, new Set(["send_reply", "issue_refund"]));
    assert.match(prompt, /<agent_input>\nMy mug broke.\n<\/agent_input>/);
    assert.match(prompt, /- send_reply: \{"message":"Sorry, Anna!"\}/);
    assert.match(prompt, /- issue_refund \(rejected\): \{"amount_usd":60\}/);
    assert.doesNotMatch(prompt, /get_order|secret_internal/);
  });

  it("omits the actions section when the challenge has no action tools", () => {
    const prompt = judgeUserPrompt("My mug broke.", { finalText: "Sorry!", toolCalls: [] }, new Set());
    assert.doesNotMatch(prompt, /agent_actions/);
  });

  it("never contains the user's config", async () => {
    const { chatFn, calls } = fakeJudge([valid]);
    await judgeTest(challenge, "My mug broke.", transcript, opts(chatFn));
    const everything = JSON.stringify(calls[0].messages);
    for (const secret of ["You are a support agent", "## Context"]) assert.equal(everything.includes(secret), false);
  });
});
