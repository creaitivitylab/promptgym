import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateChallenge } from "../validate";
import type { Challenge, WeightedCheck } from "../types";

const check = (id: string, weight: number): WeightedCheck => ({ id, label: id, weight, type: "maxWords", n: 100 });

const make = (global: WeightedCheck[], perTest: WeightedCheck[]) =>
  ({ slug: "demo", checks: global, testPool: [{ id: "t-1", input: "x", checks: perTest }] }) as unknown as Challenge;

describe("validateChallenge: check weight share", () => {
  it("accepts checks at exactly 25%", () => {
    assert.deepEqual(validateChallenge(make([check("a", 1), check("b", 1)], [check("c", 1), check("d", 1)])), []);
    assert.deepEqual(validateChallenge(make([check("a", 1)], [check("big", 2), check("c", 1), check("d", 1), check("e", 1), check("f", 1), check("g", 1)])), []);
  });

  it("rejects a check above 25% with a clear message", () => {
    const errors = validateChallenge(make([check("short", 1)], [check("amount", 3), check("rule", 1), check("usd", 1)]));
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0],
      'demo / test "t-1": check "amount" carries 50% of the test\'s check weight (3 of 6); the maximum is 25%. ' +
        "Add checks or rebalance weights: coarse checks make scores unstable between runs.",
    );
  });

  it("counts challenge-level checks against each test", () => {
    const errors = validateChallenge(make([check("global", 2)], [check("a", 1), check("b", 1), check("c", 1)]));
    assert.match(errors[0], /check "global" carries 40%/);
  });

  it("flags every offending check in a test with fewer than 4 checks", () => {
    assert.equal(validateChallenge(make([], [check("a", 1), check("b", 1), check("c", 1)])).length, 3);
  });
});
