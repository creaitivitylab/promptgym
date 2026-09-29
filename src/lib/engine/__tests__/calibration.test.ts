import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenCap } from "../calibration";
import { countTokens } from "../tokens";
import type { Challenge } from "../types";

const make = (context: string, contextBudgetTokens?: number) =>
  ({ contextBudgetTokens, reference: { config: { instructions: "", context, tools: [], loop: { maxSteps: 1 } } } }) as unknown as Challenge;

describe("tokenCap", () => {
  it("is 3x reference tokens without a context budget", () => {
    assert.equal(tokenCap(make(""), 3131, 3.8), 9393);
  });

  it("leaves room for a full context budget when 3x would be too tight", () => {
    const context = "policy ".repeat(100);
    const ctx = countTokens(context);
    // 579 total, of which ctx is context: 1.5 x (1500 + 579 - ctx) beats 3 x 579
    assert.equal(tokenCap(make(context, 1500), 579, 1), Math.ceil(1.5 * (1500 + 579 - ctx)));
  });

  it("counts the context once per step", () => {
    const context = "policy ".repeat(100);
    const ctx = countTokens(context);
    assert.equal(tokenCap(make(context, 1500), 2000, 2), Math.max(6000, Math.ceil(1.5 * (1500 + 2000 - 2 * ctx))));
  });

  it("keeps 3x when it is the larger term", () => {
    assert.equal(tokenCap(make("x", 100), 5000, 1), 15000);
  });
});
