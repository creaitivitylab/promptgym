import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ToolError, executeToolCall, mergeFixtures, resolveTools, toFunctionTools, toolResultContent } from "../tools";
import { defineTool, type Challenge, type ToolCallRecord } from "../types";

type F = { orders: Record<string, { total_usd: number }> };

const getOrder = defineTool({
  name: "get_order",
  description: "Look up an order",
  kind: "read",
  args: z.object({ order_id: z.string().describe("Order id") }),
  handler: (args, ctx: { fixtures: F; trace: readonly ToolCallRecord[] }) => {
    const order = ctx.fixtures.orders[args.order_id];
    if (!order) throw new ToolError(`Order ${args.order_id} not found`);
    return order;
  },
});

const issueRefund = defineTool({
  name: "issue_refund",
  description: "Refund an order",
  kind: "action",
  args: z.object({ order_id: z.string(), amount_usd: z.number().positive() }),
  handler: (_args, ctx: { fixtures: F; trace: readonly ToolCallRecord[] }) => ({
    ok: true,
    refund_id: `R-${1000 + ctx.trace.length}`,
  }),
});

const buggy = defineTool({
  name: "buggy",
  description: "Handler with a bug",
  kind: "read",
  args: z.object({}),
  handler: () => {
    throw new Error("bug");
  },
});

const challenge = {
  fixtures: { orders: { A1: { total_usd: 20 } } },
  tools: [getOrder, issueRefund, buggy],
} as unknown as Challenge<F>;

function runner(enabledNames: string[]) {
  const enabled = resolveTools(challenge, enabledNames);
  const fixtures = mergeFixtures<F>(challenge.fixtures, { orders: { B2: { total_usd: 820 } } });
  const trace: ToolCallRecord[] = [];
  const call = (name: string, args: string) => {
    const record = executeToolCall(enabled, { name, arguments: args }, { fixtures, trace }, trace.length + 1);
    trace.push(record);
    return record;
  };
  return { call, trace };
}

describe("toFunctionTools", () => {
  it("exports a clean JSON schema without $schema", () => {
    const [tool] = toFunctionTools([getOrder]);
    assert.deepEqual(tool, {
      type: "function",
      function: {
        name: "get_order",
        description: "Look up an order",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string", description: "Order id" } },
          required: ["order_id"],
          additionalProperties: false,
        },
      },
    });
  });
});

describe("mergeFixtures", () => {
  it("merges plain objects one level deep and replaces other values", () => {
    const merged = mergeFixtures<Record<string, unknown>>(
      { orders: { A1: 1 }, flag: true, list: [1] },
      { orders: { B2: 2 }, list: [2] },
    );
    assert.deepEqual(merged, { orders: { A1: 1, B2: 2 }, flag: true, list: [2] });
  });
});

describe("resolveTools", () => {
  it("rejects tools the challenge doesn't offer", () => {
    assert.throws(() => resolveTools(challenge, ["get_order", "nope"]), /doesn't offer: nope/);
  });
});

describe("executeToolCall", () => {
  it("runs a valid call against fixtures", () => {
    const { call } = runner(["get_order"]);
    const r = call("get_order", '{"order_id":"B2"}');
    assert.equal(r.succeeded, true);
    assert.deepEqual(r.result, { total_usd: 820 });
  });

  it("turns ToolError into a failed record the agent sees", () => {
    const { call } = runner(["get_order"]);
    const r = call("get_order", '{"order_id":"Z9"}');
    assert.equal(r.succeeded, false);
    assert.equal(toolResultContent(r), '{"error":"Order Z9 not found"}');
  });

  it("fails malformed JSON and keeps the raw string", () => {
    const { call } = runner(["get_order"]);
    const r = call("get_order", "{order_id:");
    assert.equal(r.succeeded, false);
    assert.equal(r.args, "{order_id:");
    assert.match(r.error!, /not valid JSON/);
  });

  it("fails schema-invalid args and keeps the parsed args", () => {
    const { call } = runner(["issue_refund"]);
    const r = call("issue_refund", '{"order_id":"B2","amount_usd":-5}');
    assert.equal(r.succeeded, false);
    assert.deepEqual(r.args, { order_id: "B2", amount_usd: -5 });
    assert.match(r.error!, /amount_usd/);
  });

  it("fails a call to a tool that isn't enabled but records parsed args", () => {
    const { call } = runner(["get_order"]);
    const r = call("issue_refund", '{"order_id":"B2","amount_usd":820}');
    assert.equal(r.succeeded, false);
    assert.equal(r.tool, "issue_refund");
    assert.deepEqual(r.args, { order_id: "B2", amount_usd: 820 });
    assert.match(r.error!, /not available/);
  });

  it("gives action handlers the trace so far", () => {
    const { call } = runner(["get_order", "issue_refund"]);
    call("get_order", '{"order_id":"B2"}');
    const r = call("issue_refund", '{"order_id":"B2","amount_usd":820}');
    assert.deepEqual(r.result, { ok: true, refund_id: "R-1001" });
  });

  it("rethrows handler bugs instead of hiding them from us", () => {
    const { call } = runner(["buggy"]);
    assert.throws(() => call("buggy", ""), /bug/);
  });
});
