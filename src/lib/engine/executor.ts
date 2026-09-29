import "server-only";
import { chat, type ChatCompletionMessageParam, type ChatParams, type ChatResult, type CostMeter } from "./llm";
import { executeToolCall, mergeFixtures, resolveTools, toFunctionTools, toolResultContent } from "./tools";
import { MAX_STEPS, type AgentConfig, type Challenge, type Fixtures, type TestCase, type ToolCallRecord, type Transcript } from "./types";

const DEFAULT_MAX_TEST_TOKENS = 40_000;
const MAX_OUTPUT_TOKENS_PER_STEP = 1024;

export interface ExecutorOptions {
  model: string;
  meter: CostMeter;
  /** Global upper bound; defaults to env MAX_TEST_TOKENS, then DEFAULT_MAX_TEST_TOKENS. The challenge's cap applies when lower. */
  maxTestTokens?: number;
  seed?: number;
  chatFn?: (params: ChatParams) => Promise<ChatResult>; // injectable for tests
}

/**
 * final: the agent answered without calling a tool.
 * max_steps: the agent still wanted to call tools when the step limit hit.
 * token_cap: the test exceeded its token cap; the scorer fails this test only.
 */
export type StopReason = "final" | "max_steps" | "token_cap";

export interface TestRun {
  testId: string;
  transcript: Transcript;
  steps: number; // model calls
  stopReason: StopReason;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** Stable per-test seed (FNV-1a over "slug/testId"), so reruns of a test send the same seed. */
export function testSeed(slug: string, testId: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${slug}/${testId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0x7fffffff;
}

export function buildSystemPrompt(config: AgentConfig): string {
  const context = config.context.trim();
  return context ? `${config.instructions.trim()}\n\n## Context\n\n${context}` : config.instructions.trim();
}

/**
 * Run the agent on one test case against simulated tools. Temperature 0.
 * AttemptCostExceededError from the meter propagates: it aborts the whole attempt.
 */
export async function runTest<F extends Fixtures>(
  challenge: Challenge<F>,
  config: AgentConfig,
  test: TestCase<F>,
  opts: ExecutorOptions,
): Promise<TestRun> {
  const callModel = opts.chatFn ?? chat;
  const maxTestTokens = Math.min(challenge.maxTestTokens ?? Infinity, opts.maxTestTokens ?? maxTestTokensFromEnv());
  const maxSteps = Math.min(config.loop.maxSteps, MAX_STEPS);
  const enabled = resolveTools(challenge, config.tools);
  const tools = toFunctionTools(enabled);
  const fixtures = mergeFixtures(challenge.fixtures, test.fixtures);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(config) },
    { role: "user", content: test.input },
  ];
  const toolCalls: ToolCallRecord[] = [];
  const run: TestRun = {
    testId: test.id,
    transcript: { finalText: "", toolCalls },
    steps: 0,
    stopReason: "max_steps",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  for (let step = 1; step <= maxSteps; step++) {
    const res = await callModel({
      model: opts.model,
      messages,
      tools,
      temperature: 0,
      seed: opts.seed,
      maxTokens: MAX_OUTPUT_TOKENS_PER_STEP,
      meter: opts.meter,
    });
    run.steps = step;
    run.promptTokens += res.usage.promptTokens;
    run.completionTokens += res.usage.completionTokens;
    run.totalTokens += res.usage.totalTokens;
    run.costUsd += res.usage.costUsd;

    const content = res.message.content ?? "";
    if (content.trim()) run.transcript.finalText = content;

    if (run.totalTokens > maxTestTokens) {
      run.stopReason = "token_cap";
      break;
    }

    const requested = res.message.tool_calls ?? [];
    if (requested.length === 0) {
      run.transcript.finalText = content;
      run.stopReason = "final";
      break;
    }

    messages.push({ role: "assistant", content: res.message.content, tool_calls: requested });
    for (const call of requested) {
      const record =
        call.type === "function"
          ? executeToolCall(enabled, call.function, { fixtures, trace: toolCalls }, step)
          : { step, tool: call.custom.name, args: call.custom.input, succeeded: false, error: "Unsupported tool type." };
      toolCalls.push(record);
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResultContent(record) });
    }
  }

  return run;
}

function maxTestTokensFromEnv(): number {
  const raw = process.env.MAX_TEST_TOKENS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_TEST_TOKENS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`MAX_TEST_TOKENS must be a positive integer, got "${raw}"`);
  return value;
}
