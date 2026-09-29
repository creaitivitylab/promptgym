import "server-only";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { countTokens } from "./tokens";

export type { ChatCompletionMessage, ChatCompletionMessageParam, ChatCompletionTool };

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_ATTEMPT_COST_USD = 0.25;
const RETRY_DELAYS_MS = [500, 1500]; // up to 2 retries
const DEFAULT_MAX_TOKENS_FOR_ESTIMATE = 4096;
// Fallback price when a model's price can't be looked up: deliberately high so an estimate never undercounts.
const FALLBACK_PRICE_PER_TOKEN = { prompt: 10 / 1e6, completion: 50 / 1e6 };

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    // Retries are handled in chat() so interrupted responses can be accounted for.
    client = new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey, timeout: 60_000, maxRetries: 0 });
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

/** A call whose response died mid-way: it may have been billed, but we never saw usage.cost. */
export interface UnknownCostCall {
  model: string;
  generationId: string | null; // look up real cost later via GET /api/v1/generation?id=
  estimatedUsd: number; // token-based, worst case completion
  error: string;
}

/**
 * Tracks spend across every LLM call of one attempt (executor and judge): real costs, plus token-based
 * estimates for calls whose cost is unknown. A call is refused once spend has reached the ceiling,
 * so an attempt overshoots by at most one call per concurrent test.
 */
export class CostMeter {
  spentUsd = 0;
  readonly unknownCostCalls: UnknownCostCall[] = [];

  constructor(readonly ceilingUsd: number = maxAttemptCostFromEnv()) {}

  assertBudget(): void {
    if (this.spentUsd >= this.ceilingUsd) throw new AttemptCostExceededError(this.spentUsd, this.ceilingUsd);
  }

  add(costUsd: number): void {
    this.spentUsd += costUsd;
  }

  addUnknown(call: UnknownCostCall): void {
    this.unknownCostCalls.push(call);
    this.spentUsd += call.estimatedUsd;
  }

  get estimatedUnknownUsd(): number {
    return this.unknownCostCalls.reduce((sum, c) => sum + c.estimatedUsd, 0);
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

export interface PricePerToken {
  prompt: number;
  completion: number;
}

let priceCache: Promise<Map<string, PricePerToken>> | null = null;

/** Per-token USD price from OpenRouter's public model list (cached per process); fallback price if unknown. */
export async function openRouterPrice(model: string): Promise<PricePerToken> {
  priceCache ??= fetch(`${OPENROUTER_BASE_URL}/models`)
    .then((res) => res.json() as Promise<{ data: { id: string; pricing: { prompt: string; completion: string } }[] }>)
    .then(({ data }) => new Map(data.map((m) => [m.id, { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) }])))
    .catch(() => {
      priceCache = null; // retry the lookup next time
      return new Map<string, PricePerToken>();
    });
  return (await priceCache).get(model) ?? FALLBACK_PRICE_PER_TOKEN;
}

/** Worst-case estimate for a call whose usage we never saw: full prompt, completion up to max tokens. */
export function estimateCostUsd(params: Pick<ChatParams, "messages" | "tools" | "maxTokens">, price: PricePerToken): number {
  const promptTokens = countTokens(JSON.stringify(params.messages) + JSON.stringify(params.tools ?? []));
  const completionTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS_FOR_ESTIMATE;
  return promptTokens * price.prompt + completionTokens * price.completion;
}

// ---------------------------------------------------------------------------
// Transport and retries
// ---------------------------------------------------------------------------

/** Headers arrived (so the request was accepted and may be billed) but the body failed to arrive. */
export class ResponseInterruptedError extends Error {
  constructor(
    readonly generationId: string | null,
    cause: unknown,
  ) {
    super(`Response interrupted mid-way${generationId ? ` (${generationId})` : ""}: ${errorMessage(cause)}`);
  }
}

/** OpenRouter answered 200 with an error object instead of a completion (provider failed mid-generation). */
export class UpstreamError extends Error {}

const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/** Connection resets and 5xx are retried; client errors (4xx) and bugs are not. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ResponseInterruptedError || err instanceof UpstreamError) return true;
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (err instanceof OpenAI.APIError) return typeof err.status === "number" && err.status >= 500;
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  if (e?.code && RETRYABLE_CODES.has(e.code)) return true;
  if (e?.cause?.code && RETRYABLE_CODES.has(e.cause.code)) return true;
  return err instanceof TypeError && e?.message === "terminated";
}

export interface SendResult {
  json: unknown;
  generationId: string | null;
}

async function openRouterSend(body: ChatCompletionCreateParamsNonStreaming): Promise<SendResult> {
  const response = await getClient().chat.completions.create(body).asResponse(); // non-2xx throws APIError
  const generationId = response.headers.get("x-generation-id");
  try {
    return { json: await response.json(), generationId };
  } catch (err) {
    throw new ResponseInterruptedError(generationId, err);
  }
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
  /** OpenRouter reasoning control, e.g. { effort: "low" }. */
  reasoning?: Record<string, unknown>;
  meter: CostMeter;
}

export interface ChatDeps {
  send: (body: ChatCompletionCreateParamsNonStreaming) => Promise<SendResult>;
  sleep: (ms: number) => Promise<void>;
  priceFor: (model: string) => Promise<PricePerToken>;
}

/**
 * Build a chat function. Retries connection resets, 5xx and interrupted responses up to 2 times with
 * backoff. An interrupted response is recorded on the meter as an unknown-cost call with a token-based
 * estimate (and the generation id, when the headers carried one) before retrying.
 */
export function createChat(deps: ChatDeps) {
  return async function chat(params: ChatParams): Promise<ChatResult> {
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

    for (let attempt = 0; ; attempt++) {
      params.meter.assertBudget();
      try {
        const { json } = await deps.send(body);
        return toChatResult(json, params);
      } catch (err) {
        if (err instanceof ResponseInterruptedError) {
          const estimatedUsd = estimateCostUsd(params, await deps.priceFor(params.model));
          params.meter.addUnknown({ model: params.model, generationId: err.generationId, estimatedUsd, error: err.message });
        }
        if (attempt >= RETRY_DELAYS_MS.length || !isRetryable(err)) throw err;
        await deps.sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  };
}

function toChatResult(json: unknown, params: ChatParams): ChatResult {
  const res = json as Partial<ChatCompletion> & { error?: { message?: string }; usage?: OpenRouterUsage };
  if (res.error && !res.choices?.length) {
    // Billed only if usage says so; otherwise nothing was charged.
    if (typeof res.usage?.cost === "number") params.meter.add(realCostUsd(res.usage));
    throw new UpstreamError(`Upstream error from ${params.model}: ${res.error.message ?? "unknown"}`);
  }

  const usage = res.usage;
  const costUsd = realCostUsd(usage);
  params.meter.add(costUsd);

  const choice = res.choices?.[0];
  if (!choice) throw new Error(`No choices in response from ${params.model}`);

  return {
    message: choice.message,
    finishReason: choice.finish_reason,
    model: res.model ?? params.model,
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      costUsd,
    },
  };
}

export const chat = createChat({
  send: openRouterSend,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  priceFor: openRouterPrice,
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
