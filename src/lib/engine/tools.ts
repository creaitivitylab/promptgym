import { z } from "zod";
import type { Challenge, Fixtures, ToolCallRecord, ToolContext, ToolDef } from "./types";

/** An error the agent should see as the tool's result (not found, not allowed, ...). */
export class ToolError extends Error {}

/** OpenAI-compatible function tool definition. */
export interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toFunctionTools<F extends Fixtures>(defs: ToolDef<F>[]): FunctionTool[] {
  return defs.map((def) => {
    const parameters = z.toJSONSchema(def.args) as Record<string, unknown>;
    delete parameters.$schema;
    return { type: "function", function: { name: def.name, description: def.description, parameters } };
  });
}

/** Merge per-test fixtures over challenge fixtures. Plain objects merge one level deep; everything else is replaced. */
export function mergeFixtures<F extends Fixtures>(base: F | undefined, override: Partial<F> | undefined): F {
  const merged: Fixtures = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(override ?? {})) {
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return merged as F;
}

/** The challenge tools the config enables. Throws on names the challenge doesn't offer. */
export function resolveTools<F extends Fixtures>(challenge: Challenge<F>, enabled: string[]): ToolDef<F>[] {
  const unknown = enabled.filter((name) => !challenge.tools.some((t) => t.name === name));
  if (unknown.length > 0) {
    throw new Error(`Config enables tools this challenge doesn't offer: ${unknown.join(", ")}`);
  }
  return challenge.tools.filter((t) => enabled.includes(t.name));
}

/**
 * Run one tool call the model requested against simulated tools. Never touches anything real.
 * Agent mistakes (unknown tool, malformed or invalid args, ToolError) become an `error` on the record;
 * any other exception is a bug in a handler and is rethrown.
 */
export function executeToolCall<F extends Fixtures>(
  enabled: ToolDef<F>[],
  call: { name: string; arguments: string },
  ctx: ToolContext<F>,
  step: number,
): ToolCallRecord {
  const def = enabled.find((t) => t.name === call.name);
  if (!def) {
    return { step, tool: call.name, args: call.arguments, error: `Tool "${call.name}" is not available.` };
  }

  let raw: unknown;
  try {
    raw = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return { step, tool: def.name, args: call.arguments, error: "Arguments are not valid JSON." };
  }

  const parsed = def.args.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { step, tool: def.name, args: raw, error: `Invalid arguments: ${issues}` };
  }

  try {
    return { step, tool: def.name, args: parsed.data, result: def.handler(parsed.data, ctx) };
  } catch (err) {
    if (err instanceof ToolError) return { step, tool: def.name, args: parsed.data, error: err.message };
    throw err;
  }
}

/** Content of the tool message sent back to the model. */
export function toolResultContent(record: ToolCallRecord): string {
  return JSON.stringify(record.error !== undefined ? { error: record.error } : (record.result ?? { ok: true }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
