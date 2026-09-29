import { countTokens } from "./tokens";
import type { Challenge, Fixtures } from "./types";

/**
 * Per-test token cap: max(3 x reference avgTokens, 1.5 x (context budget + reference tokens outside the context)).
 * The second term keeps a config that uses the full context budget from hitting the cap. The context is sent
 * on every step, so the reference's context tokens count avgSteps times.
 */
export function tokenCap<F extends Fixtures>(challenge: Challenge<F>, avgTokens: number, avgSteps: number): number {
  const threeX = 3 * avgTokens;
  if (challenge.contextBudgetTokens === undefined) return Math.ceil(threeX);
  const outsideContext = avgTokens - countTokens(challenge.reference.config.context) * avgSteps;
  return Math.ceil(Math.max(threeX, 1.5 * (challenge.contextBudgetTokens + outsideContext)));
}
