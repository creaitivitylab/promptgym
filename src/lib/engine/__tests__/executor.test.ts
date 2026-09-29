import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildSystemPrompt, runTest } from "../executor";
import { AttemptCostExceededError, CostMeter, type ChatCompletionMessageParam, type ChatParams, type ChatResult } from "../llm";
import { ToolError } from "../tools";
import { defineTool, type AgentConfig, type Challenge, type TestCase, type ToolCallRecord } from "../types";

type F = { orders: Record<string, { total_usd: number }> };
type Ctx = { fixtures: F; trace: readonly ToolCallRecord[] };

const challenge = {
  fixtures: { orders: { A1: { total_usd: 20 } } },
  tools: [
    defineTool({
      name: "get_order",
      description: "Look up an order",
      kind: "read",
      args: z.object({ order_id: z.string() }),
      handler: (args, ctx: Ctx) => {
        const order = ctx.fixtures.orders[args.order_id];
        if (!order) throw new ToolError("not found");
        return order;
      },
    }),
    defineTool({
      name: "issue_refund",
      description: "Refund",
      kind: "action",
      args: z.object({ order_id: z.string(), amount_usd: z.number() }),
      handler: () => ({ ok: true }),
    }),
  ],
} as unknown as Challenge<F>;

const test: TestCase<F> = { id: "t1", input: "Where is order B2?", fixtures: { orders: { B2: { total_usd: 60 } } }, checks: [] };

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  instructions: "You are a support agent.",
  context: "",
  tools: ["get_order"],
  loop: { maxSteps: 4 },
  ...over,
});

type Reply = { content?: string; calls?: { name: string; args: string }[]; tokens?: number; cost?: number };

/** Fake model that plays back replies and charges the meter like the real chat(). */
function scripted(replies: Reply[]) {
  const seen: ChatCompletionMessageParam[][] = [];
  let i = 0;
  const chatFn = async (params: ChatParams): Promise<ChatResult> => {
    params.meter.assertBudget();
    seen.push(structuredClone(params.messages));
    const r = replies[Math.min(i++, replies.length - 1)];
    const cost = r.cost ?? 0.001;
    params.meter.add(cost);
    return {
      message: {
        role: "assistant",
        content: r.content ?? null,
        refusal: null,
        tool_calls: r.calls?.map((c, n) => ({
          id: `call_${i}_${n}`,
          type: "function" as const,
          function: { name: c.name, arguments: c.args },
        })),
      },
      finishReason: r.calls ? "tool_calls" : "stop",
      model: params.model,
      usage: { promptTokens: (r.tokens ?? 100) - 10, completionTokens: 10, reasoningTokens: 0, totalTokens: r.tokens ?? 100, costUsd: cost },
    };
  };
  return { chatFn, seen };
}

const opts = (chatFn: (p: ChatParams) => Promise<ChatResult>, meter = new CostMeter(1)) => ({
  model: "fake/model",
  meter,
  maxTestTokens: 40_000,
  chatFn,
});

describe("buildSystemPrompt", () => {
  it("appends context under a heading only when present", () => {
    assert.equal(buildSystemPrompt(config()), "You are a support agent.");
    assert.equal(buildSystemPrompt(config({ context: " Policy: 50 USD " })), "You are a support agent.\n\n## Context\n\nPolicy: 50 USD");
  });
});

describe("runTest", () => {
  it("answers in one step without tools", async () => {
    const { chatFn, seen } = scripted([{ content: "It ships tomorrow." }]);
    const run = await runTest(challenge, config({ tools: [] }), test, opts(chatFn));
    assert.equal(run.stopReason, "final");
    assert.equal(run.steps, 1);
    assert.equal(run.transcript.finalText, "It ships tomorrow.");
    assert.deepEqual(seen[0].map((m) => m.role), ["system", "user"]);
  });

  it("runs a tool round against merged fixtures and feeds the result back", async () => {
    const { chatFn, seen } = scripted([
      { content: "Let me check.", calls: [{ name: "get_order", args: '{"order_id":"B2"}' }] },
      { content: "Order B2 totals 60 USD." },
    ]);
    const run = await runTest(challenge, config(), test, opts(chatFn));
    assert.equal(run.stopReason, "final");
    assert.equal(run.steps, 2);
    assert.equal(run.transcript.finalText, "Order B2 totals 60 USD.");
    assert.deepEqual(run.transcript.toolCalls, [
      { step: 1, tool: "get_order", args: { order_id: "B2" }, succeeded: true, result: { total_usd: 60 } },
    ]);
    const second = seen[1];
    assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(second[3].content, '{"total_usd":60}');
    assert.equal(run.totalTokens, 200);
    assert.equal(run.costUsd, 0.002);
  });

  it("records a call to a tool the user didn't enable as a failed attempt", async () => {
    const { chatFn } = scripted([
      { calls: [{ name: "issue_refund", args: '{"order_id":"B2","amount_usd":60}' }] },
      { content: "I can't refund that." },
    ]);
    const run = await runTest(challenge, config(), test, opts(chatFn));
    const [call] = run.transcript.toolCalls;
    assert.equal(call.tool, "issue_refund");
    assert.equal(call.succeeded, false);
    assert.deepEqual(call.args, { order_id: "B2", amount_usd: 60 });
  });

  it("stops at maxSteps and keeps the last non-empty text", async () => {
    const { chatFn } = scripted([
      { content: "Checking A1.", calls: [{ name: "get_order", args: '{"order_id":"A1"}' }] },
      { calls: [{ name: "get_order", args: '{"order_id":"A1"}' }] },
    ]);
    const run = await runTest(challenge, config({ loop: { maxSteps: 2 } }), test, opts(chatFn));
    assert.equal(run.stopReason, "max_steps");
    assert.equal(run.steps, 2);
    assert.equal(run.transcript.toolCalls.length, 2);
    assert.equal(run.transcript.finalText, "Checking A1.");
  });

  it("stops with token_cap once the test exceeds its token cap", async () => {
    const { chatFn } = scripted([{ calls: [{ name: "get_order", args: '{"order_id":"A1"}' }], tokens: 25_000 }]);
    const run = await runTest(challenge, config(), test, opts(chatFn));
    assert.equal(run.stopReason, "token_cap");
    assert.equal(run.steps, 2);
    assert.equal(run.transcript.toolCalls.length, 1); // tools of the capped step are not executed
  });

  it("aborts with AttemptCostExceededError once the attempt ceiling is reached", async () => {
    const meter = new CostMeter(0.01);
    const { chatFn } = scripted([{ calls: [{ name: "get_order", args: '{"order_id":"A1"}' }], cost: 0.006 }]);
    await assert.rejects(runTest(challenge, config(), test, opts(chatFn, meter)), AttemptCostExceededError);
    assert.equal(meter.spentUsd, 0.012);
  });
});
