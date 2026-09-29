import type { Challenge, Fixtures } from "./types";

/** No single check may carry more than this share of a test's total check weight (challenge-level + test-level). */
export const MAX_CHECK_WEIGHT_SHARE = 0.25;

/**
 * Structural rules every challenge must follow. Returns human-readable errors (empty when valid).
 * Coarse checks make scores unstable: when one check is a large share of a test, a single borderline
 * flip of the executor's output swings the Total by several points between runs.
 */
export function validateChallenge<F extends Fixtures>(challenge: Challenge<F>): string[] {
  const errors: string[] = [];
  for (const test of challenge.testPool) {
    const checks = [...challenge.checks, ...test.checks];
    const total = checks.reduce((sum, c) => sum + c.weight, 0);
    for (const check of checks) {
      const share = total > 0 ? check.weight / total : 1;
      if (share > MAX_CHECK_WEIGHT_SHARE + 1e-9) {
        errors.push(
          `${challenge.slug} / test "${test.id}": check "${check.id}" carries ${Math.round(share * 100)}% of the test's check weight ` +
            `(${check.weight} of ${total}); the maximum is ${MAX_CHECK_WEIGHT_SHARE * 100}%. ` +
            `Add checks or rebalance weights: coarse checks make scores unstable between runs.`,
        );
      }
    }
  }
  return errors;
}
