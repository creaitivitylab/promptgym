import type { Challenge, WeightedCheck } from "@/lib/engine/types";
import { NORTHWIND_TRAVEL_POLICY } from "./sources/northwind-travel-policy";

const USD: WeightedCheck = { id: "usd", label: "Gives the amount in USD", weight: 1, type: "matchesRegex", pattern: String.raw`\bUSD\b|\$|dollars?` };

const NO_QUESTION: WeightedCheck = {
  id: "no-question",
  label: "Answers without asking back (the question has what's needed)",
  weight: 1,
  type: "asksQuestion",
  expected: false,
};

const challenge: Challenge = {
  slug: "travel-policy-assistant",
  version: 1,
  title: "Travel policy assistant",
  layer: "context",
  brief: {
    situation:
      "Employees at Northwind Analytics keep asking Finance the same travel questions. An AI assistant will answer them in chat, based on the company's travel and expense policy.",
    goal: "Give the assistant the knowledge it needs through the Context field, and instructions on how to answer.",
    constraints: [
      "The Context field has a budget of 1,500 tokens. The full policy doesn't fit, so decide what the assistant really needs.",
      "Answers must give the exact amount from the policy, in USD, including any rule that changes it for the situation asked about.",
      "Employees read answers on their phones: keep each answer under 80 words.",
      "If a question is missing information needed for an exact answer (for example the destination city), ask for it instead of guessing.",
      "Never tell an employee they can skip a required approval.",
    ],
  },
  visibleExamples: [
    {
      input: "What's the nightly hotel cap in Chicago?",
      goodOutput:
        "230 USD per night, including taxes and fees (Chicago is a Tier 2 city). If you book the official conference hotel through the room block, you can go up to 15% above that.",
    },
    {
      input: "I submitted my expense report 40 days after my trip. Will I still be reimbursed?",
      goodOutput:
        "Yes, but reports submitted 31 to 60 days after the trip need your manager's sign-off with a short reason for the delay. After 60 days, expenses aren't reimbursed.",
    },
  ],
  sourceDocs: [{ title: "Northwind Analytics — Travel & Expense Policy (rev. 2026.2)", body: NORTHWIND_TRAVEL_POLICY }],
  contextBudgetTokens: 1500,
  // Every test has at least 4 checks and the answer itself is 2 of 8 weight: no single check above 25% (validate.ts).
  testPool: [
    {
      id: "tpa-tokyo-hotel",
      input: "I'm heading to Tokyo for a 3-night client workshop. What's the most I can pay per night for the hotel?",
      checks: [
        { id: "amount", label: "States the Tokyo cap of 320 USD", weight: 2, type: "numberEquals", value: 320 },
        { id: "rule-tier", label: "Names the rule: Tokyo is a Tier 1 city", weight: 1, type: "matchesRegex", pattern: String.raw`tier\s*(?:1|one)\b` },
        {
          id: "no-conference-exception",
          label: "Doesn't add the conference-hotel exception (it's a client workshop)",
          weight: 1,
          type: "matchesRegex",
          pattern: String.raw`conference|15\s?%`,
          negate: true,
        },
        USD,
        NO_QUESTION,
      ],
    },
    {
      id: "tpa-denver-departure-day",
      input: "I fly to Denver Monday morning and come back Wednesday evening. What's my meal allowance for Monday?",
      checks: [
        { id: "amount", label: "Gives 41.25 USD (75% of the Tier 3 per diem)", weight: 2, type: "numberEquals", value: 41.25 },
        { id: "rule-75", label: "Names the rule: 75% on the departure day", weight: 1, type: "matchesRegex", pattern: String.raw`75\s?%|75 percent|three[- ]quarters` },
        { id: "rule-tier", label: "Names the rule: Denver is Tier 3", weight: 1, type: "matchesRegex", pattern: String.raw`tier\s*(?:3|three)\b` },
        USD,
        NO_QUESTION,
      ],
    },
    {
      id: "tpa-albany-mileage",
      input: "I'll drive my own car to the Albany office, 140 miles each way. How much can I claim for mileage?",
      checks: [
        { id: "amount", label: "Gives 179.20 USD (280 miles x 0.64 USD)", weight: 2, type: "numberEquals", value: 179.2 },
        { id: "rule-round-trip", label: "Names the rule: the round trip counts (280 miles)", weight: 1, type: "matchesRegex", pattern: String.raw`round[- ]trip|\b280\b|both ways` },
        { id: "rule-rate", label: "Names the rate: 0.64 USD per mile", weight: 1, type: "numberEquals", value: 0.64 },
        USD,
        NO_QUESTION,
      ],
    },
    {
      id: "tpa-singapore-business",
      input: "My flight to Singapore is 13 hours nonstop. Can I book business class?",
      checks: [
        { id: "allowed", label: "Says business class is allowed", weight: 2, type: "matchesRegex", pattern: String.raw`\byes\b|allowed|eligible|you can book|can fly business` },
        { id: "needs-approval", label: "Says the manager must approve", weight: 2, type: "matchesRegex", pattern: String.raw`manager[^.]*approv|approv[^.]*manager` },
        { id: "in-advance", label: "Says approval comes before booking", weight: 1, type: "matchesRegex", pattern: String.raw`advance|before (?:you )?book|beforehand|prior|first` },
        { id: "rule-10h", label: "Names the rule: flights over 10 hours", weight: 1, type: "matchesRegex", pattern: String.raw`(?:over|more than|longer than|above|exceeds?)\s+10\s*(?:hours|h)\b|10\+\s*hours` },
        NO_QUESTION,
      ],
      safetyRules: [
        {
          id: "no-skipping-approval",
          description: "Told the employee no approval is needed for business class",
          violatedWhen: {
            type: "matchesRegex",
            pattern: String.raw`no (?:approval|sign-off) (?:is )?(?:needed|required)|without (?:any |an )?approval|(?:don't|do not|won't) need (?:any |an )?approval`,
          },
        },
      ],
    },
    {
      id: "tpa-hotel-no-city",
      input: "What's my hotel limit for my trip next week?",
      checks: [
        {
          id: "asks-destination",
          label: "Asks where the trip goes",
          weight: 2,
          type: "sentenceMatches",
          // A question or a request ("Please tell me the city") in the same sentence as the destination.
          all: [
            String.raw`\?|\b(?:please|could you|can you|would you|let me know|tell me|share|provide|which|what)\b`,
            String.raw`\b(?:city|where|destination|location|travel(?:l)?ing to|going to|headed)\b`,
          ],
        },
        { id: "depends-on-city", label: "Explains that the limit depends on the city", weight: 1, type: "matchesRegex", pattern: String.raw`depend|vary|varies|based on|tier` },
        { id: "one-question", label: "Asks one question, not several", weight: 1, type: "matchesRegex", pattern: String.raw`\?[^?]*\?`, negate: true },
        { id: "short-clarification", label: "Keeps the clarifying reply short", weight: 1, type: "maxWords", n: 40 },
        {
          id: "no-guess",
          label: "Doesn't state a single limit as the answer",
          weight: 1,
          type: "matchesRegex",
          pattern: String.raw`(?:your|the) (?:hotel )?(?:limit|cap) (?:is|will be) (?:\$|usd )?\d`,
          negate: true,
        },
      ],
    },
  ],
  tools: [],
  checks: [
    { id: "max-words", label: "Under 80 words", weight: 1, type: "maxWords", n: 80 },
    {
      id: "no-deflect",
      label: "Answers from the policy instead of sending the employee elsewhere",
      weight: 1,
      type: "matchesRegex",
      pattern: String.raw`check (?:with )?(?:your|the) (?:company'?s? )?(?:travel )?(?:policy|finance|hr)|consult (?:your|the)|I (?:don't|do not) have (?:access|information|details)|varies by company`,
      negate: true,
    },
  ],
  rubric: [
    {
      id: "direct",
      label: "Direct answer",
      description:
        "0 = dodges, hedges or buries the answer; 2 = the answer is there but after preamble; 4 = the first sentence gives the answer (amount or yes/no), or asks the single clarifying question needed.",
      weight: 10,
    },
    {
      id: "relevant-conditions",
      label: "Right conditions, nothing more",
      description:
        "0 = misses a condition that changes the answer, or piles on unrelated rules; 2 = includes the key condition plus noise; 4 = mentions exactly the conditions or next steps that matter for this question.",
      weight: 8,
    },
    {
      id: "plain-language",
      label: "Plain language",
      description: "0 = jargon, section numbers without meaning, or confusing math; 2 = understandable but clunky; 4 = short, plain sentences a busy employee gets at a glance.",
      weight: 7,
    },
  ],
  reference: {
    config: {
      instructions: `You answer Northwind Analytics employees' travel and expense questions, using only the policy in the context.

- Start with the answer: the exact amount in USD, or yes/no. Show the math in one short clause when you calculate something.
- Name the rule you applied (for example "Tokyo is Tier 1", "75% on your departure day", "280 miles round trip", "flights over 10 hours").
- Apply every rule that changes the number for the situation (city tier, departure/return day, round trip).
- Mention a required approval or condition only when it applies to the question; leave out exceptions that don't apply.
- If you need information the question doesn't give (for example the destination city), say the answer depends on it and ask one short question instead of guessing. Otherwise don't end with a question.
- Never say an approval can be skipped.
- Under 80 words.`,
      context: `NORTHWIND TRAVEL POLICY (all amounts USD)

City tiers
- Tier 1: New York City, San Francisco, Boston, London, Zurich, Tokyo, Singapore, Sydney
- Tier 2: Chicago, Seattle, Los Angeles, Washington DC, Toronto, Berlin, Paris, Amsterdam, Madrid, Dublin
- Tier 3: every other location

Hotels (per night, incl. taxes/fees): Tier 1 320, Tier 2 230, Tier 3 160. Conference hotel via room block: up to 15% above cap. Rentals OK if under cap.

Meals per diem (no receipts): Tier 1 95/day, Tier 2 75/day, Tier 3 55/day. Departure day and return day: 75% of the per diem. Provided meals deducted: breakfast 15, lunch 20, dinner 35. Client meals on receipts up to 120 per person; client events over 500 total need director approval in advance.

Flights (longest segment): under 6h economy; 6-10h premium economy; over 10h business class allowed with manager approval in advance. Seat selection up to 40 per flight, Wi-Fi up to 30 per trip, one checked bag. Train instead of flying if under 4h door to door.

Personal car: 0.64 per mile of actual round-trip distance, instead of fuel. Tolls/parking with receipts; fines never.

Trip approval: domestic up to 3,000 total = manager; over 3,000 or any international = manager + director.

Expense reports: within 30 days of trip end; 31-60 days needs manager sign-off with a reason; over 60 days not reimbursed. Receipt for any expense of 25 or more.

Not reimbursed: minibar, movies, gym/spa, upgrades, first class flights, extra travel insurance, family members' costs.`,
      tools: [],
      loop: { maxSteps: 1 },
    },
    avgTokens: 654,
    avgSteps: 1,
  },
  maxTestTokens: 2634,
  safetyRules: [],
};

export default challenge;
