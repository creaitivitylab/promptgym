import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AttemptCostExceededError, CostMeter, realCostUsd } from "../llm";

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
