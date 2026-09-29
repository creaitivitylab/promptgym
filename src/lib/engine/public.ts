import type { Challenge, Fixtures, PublicChallenge } from "./types";

/** The only shape of a challenge that may reach the client: no tests, checks, fixtures, reference or rules. */
export function toPublicChallenge<F extends Fixtures>(challenge: Challenge<F>): PublicChallenge {
  return {
    slug: challenge.slug,
    version: challenge.version,
    title: challenge.title,
    layer: challenge.layer,
    brief: challenge.brief,
    visibleExamples: challenge.visibleExamples,
    contextBudgetTokens: challenge.contextBudgetTokens,
    sourceDocs: challenge.sourceDocs,
    tools: challenge.tools.map((t) => ({ name: t.name, description: t.description, kind: t.kind })),
  };
}
