import "server-only";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export type { ChatCompletionMessage, ChatCompletionMessageParam, ChatCompletionTool };

const DEFAULT_MAX_ATTEMPT_COST_USD = 0.25;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey, timeout: 60_000, maxRetries: 2 });
  }
  return client;
}

export function envModel(name: "EXECUTOR_MODEL" | "JUDGE_MODEL"): string {
  const model = process.env[name];
  if (!model) throw new Error(`${name} is not set`);
  return model;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export class AttemptCostExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(`Attempt cost ceiling reached: spent ${spentUsd.toFixed(4)} USD of ${ceilingUsd.toFixed(2)} USD`);
  }
}

/**
 * Tracks real spend across every LLM call of one attempt (executor and judge).
 * A call is refused once spend has reached the ceiling, so an attempt overshoots by at most one call.
 */
export class CostMeter {
  spentUsd = 0;

  constructor(readonly ceilingUsd: number = maxAttemptCostFromEnv()) {}

  assertBudget(): void {
    if (this.spentUsd >= this.ceilingUsd) throw new AttemptCostExceededError(this.spentUsd, this.ceilingUsd);
  }

  add(costUsd: number): void {
    this.spentUsd += costUsd;
  }
}

function maxAttemptCostFromEnv(): number {
  const raw = process.env.MAX_ATTEMPT_COST_USD;
  if (raw === undefined || raw === "") return DEFAULT_MAX_ATTEMPT_COST_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`MAX_ATTEMPT_COST_USD must be a positive number, got "${raw}"`);
  return value;
}

/** OpenRouter's usage object; `cost` etc. are OpenRouter extensions the SDK doesn't type. */
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: number | null };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Real USD spend of one call. Without BYOK `cost` is the full charge (upstream_inference_cost then
 * repeats it); with BYOK `cost` is only OpenRouter's fee and the provider bills upstream_inference_cost.
 * Throws when the numbers are missing so spend is never undercounted.
 */
export function realCostUsd(usage: OpenRouterUsage | undefined): number {
  if (typeof usage?.cost !== "number") throw new Error("OpenRouter response has no usage.cost");
  if (!usage.is_byok) return usage.cost;
  const upstream = usage.cost_details?.upstream_inference_cost;
  if (typeof upstream !== "number") throw new Error("BYOK response has no usage.cost_details.upstream_inference_cost");
  return usage.cost + upstream;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ChatResult {
  message: ChatCompletionMessage;
  finishReason: string;
  model: string; // as served
  usage: LlmUsage;
}

export interface ChatParams {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  responseFormat?: ChatCompletionCreateParamsNonStreaming["response_format"];
  /** OpenRouter reasoning control, e.g. { effort: "low" } or { enabled: false }. */
  reasoning?: Record<string, unknown>;
  meter: CostMeter;
}

export async function chat(params: ChatParams): Promise<ChatResult> {
  params.meter.assertBudget();

  const body: ChatCompletionCreateParamsNonStreaming & { reasoning?: Record<string, unknown> } = {
    model: params.model,
    messages: params.messages,
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
    ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
  };
  const res = await getClient().chat.completions.create(body);

  const usage = res.usage as OpenRouterUsage | undefined;
  const costUsd = realCostUsd(usage);
  params.meter.add(costUsd);

  const choice = res.choices[0];
  if (!choice) throw new Error(`No choices in response from ${params.model}`);

  return {
    message: choice.message,
    finishReason: choice.finish_reason,
    model: res.model,
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      costUsd,
    },
  };
}
