import { EFFICIENCY_MAX } from "./types";

const TOKEN_WEIGHT = 2 / 3;
const STEP_WEIGHT = 1 / 3;

export interface EfficiencyResult {
  points: number; // 0..EFFICIENCY_MAX
  tokenRatio: number; // min(1, reference / actual)
  stepRatio: number;
  calibrated: boolean; // false while the challenge's reference numbers are null (ratios then count as 1)
}

/**
 * EFFICIENCY_MAX x (2/3 token ratio + 1/3 step ratio) x outcome fraction.
 * Scaling by outcome keeps an agent that does nothing from collecting efficiency points.
 */
export function efficiencyScore(
  actual: { avgTokens: number; avgSteps: number },
  reference: { avgTokens: number | null; avgSteps: number | null },
  outcomeFraction: number,
): EfficiencyResult {
  const calibrated = reference.avgTokens !== null && reference.avgSteps !== null;
  const tokenRatio = ratio(reference.avgTokens, actual.avgTokens);
  const stepRatio = ratio(reference.avgSteps, actual.avgSteps);
  const points = EFFICIENCY_MAX * (TOKEN_WEIGHT * tokenRatio + STEP_WEIGHT * stepRatio) * clamp01(outcomeFraction);
  return { points, tokenRatio, stepRatio, calibrated };
}

function ratio(reference: number | null, actual: number): number {
  if (reference === null || actual <= 0) return 1;
  return Math.min(1, reference / actual);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
