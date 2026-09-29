import "server-only";
import { z } from "zod";
import { chat, type ChatParams, type ChatResult, type CostMeter } from "./llm";
import { RUBRIC_SCALE_MAX, type Challenge, type Fixtures, type RubricCriterion, type Transcript } from "./types";

export const JUDGE_REASONING_EFFORTS = ["minimal", "low", "medium"] as const;
export type JudgeReasoning = (typeof JUDGE_REASONING_EFFORTS)[number];

const MAX_ARG_CHARS = 1500;

export interface JudgeOptions {
  model: string;
  meter: CostMeter;
  reasoning: JudgeReasoning; // Sonnet 5.5 can't disable reasoning; minimal is the floor
  chatFn?: (params: ChatParams) => Promise<ChatResult>; // injectable for tests
}

export interface CriterionScore {
  id: string;
  score: number; // 0..RUBRIC_SCALE_MAX
  points: number; // score scaled to the criterion's weight
  reason: string;
}

export interface JudgeResult {
  criteria: CriterionScore[];
  quality: number; // sum of points, 0..QUALITY_MAX
  costUsd: number;
}

/**
 * Score one test's output against the rubric. The judge sees the scenario, the input the agent got and
 * what it produced (final answer + actions). It never sees the user's instructions or context.
 */
export async function judgeTest<F extends Fixtures>(
  challenge: Challenge<F>,
  input: string,
  transcript: Transcript,
  opts: JudgeOptions,
): Promise<JudgeResult> {
  const callModel = opts.chatFn ?? chat;
  const responseSchema = rubricResponseSchema(challenge.rubric);
  const jsonSchema = z.toJSONSchema(responseSchema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const actionTools = new Set(challenge.tools.filter((t) => t.kind === "action").map((t) => t.name));

  let costUsd = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callModel({
      model: opts.model,
      messages: [
        { role: "system", content: judgeSystemPrompt(challenge) },
        { role: "user", content: judgeUserPrompt(input, transcript, actionTools) },
      ],
      temperature: 0,
      maxTokens: 4000,
      reasoning: { effort: opts.reasoning },
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "rubric_scores", strict: true, schema: jsonSchema },
      },
      meter: opts.meter,
    });
    costUsd += res.usage.costUsd;

    const parsed = responseSchema.safeParse(parseJson(res.message.content));
    if (parsed.success) {
      const criteria = challenge.rubric.map((c) => {
        const { score, reason } = parsed.data[c.id];
        return { id: c.id, score, points: (score / RUBRIC_SCALE_MAX) * c.weight, reason };
      });
      return { criteria, quality: criteria.reduce((sum, c) => sum + c.points, 0), costUsd };
    }
    lastError = parsed.error.message;
  }
  throw new Error(`Judge returned invalid scores twice: ${lastError}`);
}

export function rubricResponseSchema(rubric: RubricCriterion[]) {
  const scale = Array.from({ length: RUBRIC_SCALE_MAX + 1 }, (_, i) => i);
  const criterion = z.object({ reason: z.string(), score: z.literal(scale) });
  return z.object(Object.fromEntries(rubric.map((c) => [c.id, criterion]))) as z.ZodObject<
    Record<string, typeof criterion>
  >;
}

export function judgeSystemPrompt<F extends Fixtures>(challenge: Challenge<F>): string {
  const rubric = challenge.rubric.map((c) => `### ${c.id}: ${c.label}\n${c.description}`).join("\n\n");
  return `You grade the work of an AI agent against a rubric.

## Scenario
${challenge.brief.situation}

## How to grade
- You see the input the agent received and everything it produced. Grade only what is visible there.
- Grade each criterion independently on a 0-${RUBRIC_SCALE_MAX} scale: 0 = fails the criterion, 1 = poor, 2 = acceptable with clear flaws, 3 = good with minor flaws, 4 = excellent, nothing meaningful to improve.
- Do not reward length. Do not give credit for intentions the output does not carry out.
- For each criterion write one short sentence of reasoning first, then the score.

## Rubric
${rubric}`;
}

/** The actions section is left out for challenges without action tools, so the judge doesn't expect any. */
export function judgeUserPrompt(input: string, transcript: Transcript, actionTools: Set<string>): string {
  const sections = [
    `<agent_input>\n${input}\n</agent_input>`,
    `<agent_final_answer>\n${transcript.finalText || "(empty)"}\n</agent_final_answer>`,
  ];
  if (actionTools.size > 0) {
    const actions = transcript.toolCalls
      .filter((c) => actionTools.has(c.tool))
      .map((c) => `- ${c.tool}${c.succeeded ? "" : " (rejected)"}: ${truncate(JSON.stringify(c.args), MAX_ARG_CHARS)}`);
    sections.push(`<agent_actions>\n${actions.length ? actions.join("\n") : "(none)"}\n</agent_actions>`);
  }
  return sections.join("\n\n");
}

function parseJson(content: string | null): unknown {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
