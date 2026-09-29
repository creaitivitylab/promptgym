import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { efficiencyScore } from "../efficiency";

const ref = { avgTokens: 2000, avgSteps: 3 };

describe("efficiencyScore", () => {
  it("gives full points at or below the reference with full outcome", () => {
    assert.deepEqual(efficiencyScore({ avgTokens: 1500, avgSteps: 2 }, ref, 1), {
      points: 15,
      tokenRatio: 1,
      stepRatio: 1,
      calibrated: true,
    });
  });

  it("weights tokens 2/3 and steps 1/3", () => {
    const res = efficiencyScore({ avgTokens: 4000, avgSteps: 6 }, ref, 1);
    assert.equal(res.tokenRatio, 0.5);
    assert.equal(res.stepRatio, 0.5);
    assert.equal(res.points, 7.5);
    assert.ok(Math.abs(efficiencyScore({ avgTokens: 4000, avgSteps: 3 }, ref, 1).points - 10) < 1e-9);
  });

  it("scales by outcome so doing nothing earns nothing", () => {
    assert.equal(efficiencyScore({ avgTokens: 100, avgSteps: 1 }, ref, 0).points, 0);
    assert.equal(efficiencyScore({ avgTokens: 100, avgSteps: 1 }, ref, 0.5).points, 7.5);
  });

  it("treats an uncalibrated reference as ratio 1 and says so", () => {
    const res = efficiencyScore({ avgTokens: 9000, avgSteps: 8 }, { avgTokens: null, avgSteps: null }, 1);
    assert.equal(res.points, 15);
    assert.equal(res.calibrated, false);
  });
});
