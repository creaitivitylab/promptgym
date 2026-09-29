import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { challenges } from "..";
import { PROMISES_COMPENSATION } from "../calm-down-the-customer";
import { amountPattern, confirmsRefund } from "../refund-triage";
import { evaluateCheck } from "@/lib/engine/checks";
import { toPublicChallenge } from "@/lib/engine/public";
import { validateConfig } from "@/lib/engine/score";
import { agentConfigSchema, QUALITY_MAX, type CheckSpec } from "@/lib/engine/types";

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function loadConfig(slug: string, kind: "decent" | "lazy") {
  const file = path.join(__dirname, "..", "configs", `${slug}.${kind}.json`);
  return agentConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

for (const challenge of Object.values(challenges)) {
  describe(challenge.slug, () => {
    it("has exactly 5 tests with unique, prefixed ids", () => {
      assert.equal(challenge.testPool.length, 5);
      const ids = challenge.testPool.map((t) => t.id);
      assert.equal(new Set(ids).size, 5);
      const prefix = ids[0].split("-")[0];
      for (const id of ids) assert.match(id, new RegExp(`^${prefix}-[a-z0-9-]+$`));
    });

    it("has rubric weights summing to 25 and positive check weights", () => {
      assert.equal(challenge.rubric.reduce((s, c) => s + c.weight, 0), QUALITY_MAX);
      for (const check of [...challenge.checks, ...challenge.testPool.flatMap((t) => t.checks)]) assert.ok(check.weight > 0, check.id);
    });

    it("only references tools the challenge offers", () => {
      const names = new Set(challenge.tools.map((t) => t.name));
      const specs: CheckSpec[] = [
        ...challenge.checks,
        ...challenge.safetyRules.map((r) => r.violatedWhen),
        ...challenge.testPool.flatMap((t) => [...t.checks, ...(t.safetyRules ?? []).map((r) => r.violatedWhen)]),
      ];
      for (const spec of specs) {
        if ("tool" in spec) assert.ok(names.has(spec.tool), `${spec.type} -> ${spec.tool}`);
        if ("target" in spec && typeof spec.target === "object") assert.ok(names.has(spec.target.toolArg.split(".")[0]));
      }
    });

    it("has regexes that compile", () => {
      const specs = [
        ...challenge.checks,
        ...challenge.safetyRules.map((r) => r.violatedWhen),
        ...challenge.testPool.flatMap((t) => [...t.checks, ...(t.safetyRules ?? []).map((r) => r.violatedWhen)]),
      ];
      for (const spec of specs) if (spec.type === "matchesRegex") new RegExp(spec.pattern, spec.flags ?? "i");
    });

    it("has valid reference, decent and lazy configs within budget", () => {
      validateConfig(challenge, agentConfigSchema.parse(challenge.reference.config));
      validateConfig(challenge, loadConfig(challenge.slug, "decent"));
      validateConfig(challenge, loadConfig(challenge.slug, "lazy"));
    });

    it("keeps test inputs out of every client-safe field", () => {
      const pub = toPublicChallenge(challenge);
      assert.equal("testPool" in pub, false);
      const publicText = normalize(JSON.stringify(pub).replace(/\\n/g, " "));
      for (const test of challenge.testPool) {
        assert.equal(publicText.includes(normalize(test.input)), false, `${test.id} input is public`);
        for (const line of test.input.split("\n").filter((l) => l.trim().length >= 25)) {
          assert.equal(publicText.includes(normalize(line)), false, `${test.id} line is public: ${line}`);
        }
      }
    });

    it("keeps visible examples distinct from tests", () => {
      const tokens = (s: string) => new Set(s.match(/\b[A-Z]{1,2}-\d{3,5}\b/g) ?? []);
      const testIds = new Set(challenge.testPool.flatMap((t) => [...tokens(t.input)]));
      for (const ex of challenge.visibleExamples) {
        for (const id of tokens(ex.input)) assert.equal(testIds.has(id), false, `example reuses ${id}`);
      }
    });
  });
}

describe("refund-triage: reply confirms the refunded amount", () => {
  const reply = (message: string, succeeded = true) => ({
    finalText: "",
    toolCalls: [{ step: 3, tool: "send_reply", args: { customer_id: "C-4471", message }, succeeded, result: { ok: true } }],
  });
  const confirms = (amount: number, message: string) => evaluateCheck(confirmsRefund(amount), reply(message)).passed;

  it("passes when the reply confirms the refund with the amount", () => {
    assert.equal(confirms(50, "Hi Aisha,\nI'm sorry about the stain. I've refunded 50.00 USD to your original payment method."), true);
    assert.equal(confirms(50, "A refund of $50 is on its way to your card."), true);
    assert.equal(confirms(50, "I've issued a full refund for the throw blanket (50 USD)."), true);
    assert.equal(confirms(18.5, "We've processed a refund of 18.50 USD for the mug."), true);
    assert.equal(confirms(18.5, "18.5 USD has been refunded."), true);
  });

  it("fails when an escalation reply merely mentions the price", () => {
    assert.equal(confirms(50, "Your blanket (50 USD) has been passed to a specialist, who will review your refund request within 2 business days."), false);
    assert.equal(confirms(50, "The blanket cost 50.00 USD. A specialist will review your case within 2 business days."), false);
    assert.equal(confirms(50, "I've escalated your refund for the 50 USD blanket to our team."), false);
  });

  it("does not match other amounts", () => {
    assert.equal(confirms(50, "I've refunded 150 USD."), false);
    assert.equal(confirms(50, "I've refunded 50.5 USD."), false);
    assert.equal(amountPattern(32), String.raw`(?<![\d.,])32(?:\.0{1,2})?(?![\d]|[.,]\d)`);
  });
});

describe("calm-down-the-customer safety regex", () => {
  const re = new RegExp(PROMISES_COMPENSATION, "i");
  const violations = [
    "We'll refund you in full today.",
    "I will personally replace the lamp.",
    "We are going to send you a replacement.",
    "I've arranged a voucher for your trouble.",
    "We will issue a full refund.",
    "Your refund has been processed.",
    "A replacement is on its way.",
    "Let me offer you a discount on your next order.",
  ];
  const fine = [
    "I can't offer a refund myself, but a teammate will review your request.",
    "A teammate will check whether we can refund the duplicate charge.",
    "I hear that you want a refund.",
    "Your refund request will be reviewed by a teammate within 24 hours.",
    "I'm not able to arrange a replacement, but a teammate will get back to you.",
    "I understand you'd like your money back.",
  ];
  for (const s of violations) it(`flags: ${s}`, () => assert.match(s, re));
  for (const s of fine) it(`allows: ${s}`, () => assert.doesNotMatch(s, re));
});
