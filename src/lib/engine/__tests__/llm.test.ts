import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import {
  AttemptCostExceededError,
  CostMeter,
  createChat,
  estimateCostUsd,
  isRetryable,
  realCostUsd,
  ResponseInterruptedError,
  UpstreamError,
  type ChatParams,
  type SendResult,
} from "../llm";

const okJson = (cost = 0.001) => ({
  model: "fake/model",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi", refusal: null } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost, is_byok: false },
});

const PRICE = { prompt: 1e-6, completion: 2e-6 };

/** A chat() whose transport plays back outcomes: a JSON body, or an error to throw. */
function scriptedChat(outcomes: (object | Error)[]) {
  const sleeps: number[] = [];
  let calls = 0;
  const chat = createChat({
    send: async (): Promise<SendResult> => {
      const next = outcomes[Math.min(calls++, outcomes.length - 1)];
      if (next instanceof Error) throw next;
      return { json: next, generationId: "gen-1" };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    priceFor: async () => PRICE,
  });
  return { chat, sleeps, calls: () => calls };
}

const params = (meter = new CostMeter(1)): ChatParams => ({
  model: "fake/model",
  messages: [{ role: "user", content: "hello there" }],
  maxTokens: 100,
  meter,
});

const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

describe("chat retries", () => {
  it("retries a connection reset and a 5xx with backoff, then succeeds", async () => {
    const { chat, sleeps, calls } = scriptedChat([reset(), new OpenAI.InternalServerError(502, {}, "bad gateway", new Headers()), okJson()]);
    const meter = new CostMeter(1);
    const res = await chat(params(meter));
    assert.equal(res.message.content, "hi");
    assert.equal(calls(), 3);
    assert.deepEqual(sleeps, [500, 1500]);
    assert.equal(meter.spentUsd, 0.001);
  });

  it("gives up after 2 retries", async () => {
    const { chat, calls } = scriptedChat([reset()]);
    await assert.rejects(chat(params()), /ECONNRESET/);
    assert.equal(calls(), 3);
  });

  it("does not retry client errors", async () => {
    const { chat, calls } = scriptedChat([new OpenAI.BadRequestError(400, {}, "bad request", new Headers())]);
    await assert.rejects(chat(params()), OpenAI.BadRequestError);
    assert.equal(calls(), 1);
  });

  it("records an interrupted response as unknown cost with an estimate and the generation id, then retries", async () => {
    const { chat } = scriptedChat([new ResponseInterruptedError("gen-abc", new TypeError("terminated")), okJson(0.002)]);
    const meter = new CostMeter(1);
    const p = params(meter);
    await chat(p);
    const estimate = estimateCostUsd(p, PRICE);
    assert.equal(meter.unknownCostCalls.length, 1);
    assert.equal(meter.unknownCostCalls[0].generationId, "gen-abc");
    assert.equal(meter.unknownCostCalls[0].estimatedUsd, estimate);
    assert.ok(Math.abs(meter.spentUsd - (estimate + 0.002)) < 1e-12);
  });

  it("counts unknown-cost estimates against the attempt ceiling", async () => {
    const { chat } = scriptedChat([new ResponseInterruptedError(null, new Error("socket closed"))]);
    const meter = new CostMeter(0.0001); // smaller than one estimate
    await assert.rejects(chat(params(meter)), AttemptCostExceededError);
    assert.equal(meter.unknownCostCalls.length, 1);
    assert.equal(meter.unknownCostCalls[0].generationId, null);
  });

  it("retries a 200 carrying an upstream error object", async () => {
    const { chat, calls } = scriptedChat([{ error: { message: "provider overloaded" } }, okJson()]);
    await chat(params());
    assert.equal(calls(), 2);
  });
});

describe("isRetryable", () => {
  it("classifies errors", () => {
    assert.equal(isRetryable(reset()), true);
    assert.equal(isRetryable(new TypeError("terminated")), true);
    assert.equal(isRetryable(new OpenAI.APIConnectionError({ message: "down" })), true);
    assert.equal(isRetryable(new OpenAI.InternalServerError(503, {}, "unavailable", new Headers())), true);
    assert.equal(isRetryable(new UpstreamError("x")), true);
    assert.equal(isRetryable(new OpenAI.BadRequestError(400, {}, "bad", new Headers())), false);
    assert.equal(isRetryable(new Error("bug")), false);
  });
});

describe("estimateCostUsd", () => {
  it("prices prompt tokens plus worst-case completion", () => {
    const p = params();
    const est = estimateCostUsd(p, PRICE);
    assert.ok(est > 100 * PRICE.completion); // completion assumed to use all 100 max tokens
    assert.ok(est < 100 * PRICE.completion + 50 * PRICE.prompt);
  });
});

describe("realCostUsd", () => {
  it("uses cost as the full charge without BYOK (upstream repeats it)", () => {
    const usage = { cost: 0.0000456, is_byok: false, cost_details: { upstream_inference_cost: 0.0000456 } };
    assert.equal(realCostUsd(usage), 0.0000456);
  });
  it("adds the upstream provider charge with BYOK", () => {
    assert.equal(realCostUsd({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } }), 0.021);
  });
  it("throws when cost is missing instead of recording 0", () => {
    assert.throws(() => realCostUsd(undefined), /no usage.cost/);
    assert.throws(() => realCostUsd({ prompt_tokens: 10 }), /no usage.cost/);
  });
  it("throws when a BYOK response lacks the upstream cost", () => {
    assert.throws(() => realCostUsd({ cost: 0.001, is_byok: true }), /upstream_inference_cost/);
    assert.throws(
      () => realCostUsd({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: null } }),
      /upstream_inference_cost/,
    );
  });
});

describe("CostMeter", () => {
  const saved = process.env.MAX_ATTEMPT_COST_USD;
  afterEach(() => {
    if (saved === undefined) delete process.env.MAX_ATTEMPT_COST_USD;
    else process.env.MAX_ATTEMPT_COST_USD = saved;
  });

  it("defaults to 0.25 USD", () => {
    delete process.env.MAX_ATTEMPT_COST_USD;
    assert.equal(new CostMeter().ceilingUsd, 0.25);
  });
  it("reads MAX_ATTEMPT_COST_USD", () => {
    process.env.MAX_ATTEMPT_COST_USD = "0.5";
    assert.equal(new CostMeter().ceilingUsd, 0.5);
  });
  it("rejects an invalid MAX_ATTEMPT_COST_USD", () => {
    process.env.MAX_ATTEMPT_COST_USD = "abc";
    assert.throws(() => new CostMeter(), /positive number/);
  });
  it("refuses calls once spend reaches the ceiling", () => {
    const meter = new CostMeter(0.01);
    meter.add(0.006);
    meter.assertBudget();
    meter.add(0.004);
    assert.throws(() => meter.assertBudget(), AttemptCostExceededError);
  });
});
