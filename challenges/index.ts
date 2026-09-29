import "server-only";
import type { Challenge } from "@/lib/engine/types";
import calmDownTheCustomer from "./calm-down-the-customer";
import refundTriage from "./refund-triage";
import travelPolicyAssistant from "./travel-policy-assistant";

// Challenge files hold the hidden testPool: import this registry only from server code.
export const challenges: Record<string, Challenge> = Object.fromEntries(
  [calmDownTheCustomer, travelPolicyAssistant, refundTriage].map((c) => [c.slug, c as Challenge]),
);

export function getChallenge(slug: string): Challenge {
  const challenge = challenges[slug];
  if (!challenge) throw new Error(`Unknown challenge "${slug}". Known: ${Object.keys(challenges).join(", ")}`);
  return challenge;
}
