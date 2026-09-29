import type { Challenge, WeightedCheck } from "@/lib/engine/types";

/**
 * Promises of compensation. Matches "we'll refund you", "I'll send you a replacement",
 * "your refund has been processed"; not "I can't offer a refund" or "a teammate will check whether we can refund".
 */
export const PROMISES_COMPENSATION = [
  String.raw`\b(?:we|i)(?:'ll| will| have| 've| are going to| am going to)\s+(?:\w+\s+)?(?:refund|replac|reimburs|compensat)\w*`,
  String.raw`(?<!(?:\b(?:not|cannot|unable to|whether|if)|n't)\s+(?:\S+\s+){0,3})\b(?:send|give|issue|offer|arrang|process)\w*\s+(?:you\s+)?(?:a|an|the|your|some)?\s*(?:full\s+|partial\s+)?(?:refund|replacement|voucher|discount|credit|compensation|money back)`,
  String.raw`\b(?:refund|replacement|voucher|discount|credit|compensation)\s+(?:is|has been|will be)\s+(?:on (?:its|the) way|issued|processed|approved|sent|arranged)`,
].join("|");

const mentionsOrder = (orderNumber: string): WeightedCheck => ({
  id: "mentions-order",
  label: `Mentions the order number ${orderNumber}`,
  weight: 2,
  type: "matchesRegex",
  pattern: orderNumber,
});

const doesNotReaskOrder: WeightedCheck = {
  id: "no-reask-order",
  label: "Doesn't ask for an order number the customer already gave",
  weight: 1,
  type: "matchesRegex",
  pattern: String.raw`(?:share|send|provide|reply with|give|confirm)[^.?!]*order (?:number|#|no\.?|id|reference)`,
  negate: true,
};

const asksForOrder: WeightedCheck[] = [
  {
    id: "asks-order",
    label: "Asks for the order number",
    weight: 1,
    type: "matchesRegex",
    pattern: String.raw`order (?:number|#|no\.?|id|reference)`,
  },
  { id: "asks-question", label: "Ends with a question the customer can answer", weight: 1, type: "asksQuestion", expected: true },
];

const greets = (name: string): WeightedCheck => ({
  id: "greets-by-name",
  label: `Greets the customer as ${name}`,
  weight: 1,
  type: "matchesRegex",
  pattern: String.raw`^\W*(?:hi|hello|dear|hey)?\s*${name}\b`,
});

const challenge: Challenge = {
  slug: "calm-down-the-customer",
  version: 1,
  title: "Calm down the customer",
  layer: "prompt",
  brief: {
    situation:
      "You run customer support at Brightline, an online homeware store. Angry emails arrive faster than the team can answer them. An AI agent will draft the first reply to each upset customer; a teammate follows up afterwards.",
    goal: "Write instructions so the agent's first replies calm customers down and follow Brightline's rules.",
    constraints: [
      "At most 4 sentences, plus the sign-off.",
      "Sign off exactly as: Mia, Brightline Support",
      "Tell the customer a teammate will get back to them within 24 hours.",
      "If the customer gives an order number, mention it. If they don't, ask for it.",
      "Greet the customer by first name when they sign with one.",
      "Never promise a refund, replacement, voucher or any other compensation. Only a teammate can approve that. Breaking this caps your score at 40.",
      "Avoid the words 'unfortunately' and 'inconvenience'. Customers find them robotic.",
    ],
  },
  visibleExamples: [
    {
      input:
        "Subject: Cracked blender jug\n\nI waited two weeks for this blender and the jug arrived cracked. Order BL-31877. Honestly not impressed.\n\nSara",
      goodOutput:
        "Hi Sara,\nI'm sorry your blender jug arrived cracked, especially after a two-week wait for order BL-31877. Thank you for telling us right away. A teammate will get back to you within 24 hours.\nMia, Brightline Support",
    },
    {
      input: "WHERE IS MY RUG??? You said 3-5 days, it's been 12. This is ridiculous.",
      goodOutput:
        "I'm sorry your rug still hasn't arrived; twelve days is far longer than the 3-5 days we promised. Could you reply with your order number so we can track it down? A teammate will get back to you within 24 hours.\nMia, Brightline Support",
    },
  ],
  testPool: [
    {
      id: "cdc-late-sofa",
      input:
        "Subject: Sofa delivery - third missed slot\n\nThis is the third time your courier hasn't shown up for my sofa delivery. I took a day off work AGAIN. Order BL-48213. I want a full refund and I want it today.\n\nTomas",
      checks: [mentionsOrder("BL-48213"), doesNotReaskOrder, greets("Tomas")],
    },
    {
      id: "cdc-wrong-color",
      input:
        "I ordered NAVY curtains and got bright ORANGE ones. Do you people even read orders?? I'm hosting a dinner on Saturday and now my living room looks like a pumpkin.\n\n- Priya",
      checks: [...asksForOrder, greets("Priya")],
    },
    {
      id: "cdc-rude-agent",
      input:
        "I called your hotline yesterday about my broken lamp (order BL-50977) and the agent literally laughed and hung up on me. I'm about to post this everywhere. Fix this.\n\nGrace Olsen",
      checks: [mentionsOrder("BL-50977"), doesNotReaskOrder, greets("Grace")],
    },
    {
      id: "cdc-double-charge",
      input: "You charged my card twice for the same order. 2 x $249. I need that money back NOW or I'm calling my bank.\n\nJ.",
      checks: [...asksForOrder],
    },
    {
      id: "cdc-missing-screws",
      input:
        "Wow. Great job. The bookshelf I waited three weeks for came without the screws. Order BL-39120. Do you even care about your customers?\n\nDaniel",
      checks: [mentionsOrder("BL-39120"), doesNotReaskOrder, greets("Daniel")],
    },
  ],
  tools: [],
  checks: [
    { id: "max-sentences", label: "At most 4 sentences plus the sign-off", weight: 2, type: "maxSentences", n: 5 },
    { id: "sign-off", label: "Signs off as Mia, Brightline Support", weight: 2, type: "matchesRegex", pattern: String.raw`Mia,?\s+Brightline Support` },
    { id: "24-hours", label: "Promises a follow-up within 24 hours", weight: 2, type: "matchesRegex", pattern: String.raw`(?:24|twenty-four) hours` },
    { id: "no-cliches", label: "Avoids 'unfortunately' and 'inconvenience'", weight: 1, type: "matchesRegex", pattern: "unfortunate|inconvenien", negate: true },
  ],
  rubric: [
    {
      id: "acknowledges",
      label: "Acknowledges the specific problem",
      description:
        "Names the customer's specific problem and how it affected them. 0 = generic apology or ignores the problem; 2 = names the problem but not why it matters to them; 4 = names the specific problem and its impact (for example a lost day off or an event at stake) sincerely.",
      weight: 10,
    },
    {
      id: "tone",
      label: "Calm, warm tone",
      description:
        "0 = defensive, blaming, sarcastic or groveling; 2 = polite but stiff or scripted; 4 = sounds like a composed, caring person who takes the customer seriously without mirroring their anger.",
      weight: 8,
    },
    {
      id: "clarity",
      label: "Clear and easy to read",
      description:
        "0 = confusing, rambling or no next step; 2 = understandable but wordy or the next step is vague; 4 = short plain sentences and an unambiguous next step.",
      weight: 7,
    },
  ],
  reference: {
    config: {
      instructions: `You write the first reply to upset Brightline customers. A teammate follows up later.

Rules:
1. If the customer signed with a name, start with "Hi <first name>," on its own line. Otherwise start directly.
2. First sentence: apologize for their specific problem and name how it affected them, using details from their message.
3. If they gave an order number (format BL-12345), mention it and don't ask for it. If not, ask them to reply with their order number.
4. Say that a teammate will get back to them within 24 hours.
5. At most 4 sentences before the sign-off. Plain, calm, warm language. Don't argue, don't blame anyone, no sarcasm.
6. Never promise or offer a refund, replacement, voucher, discount or any compensation, and don't speculate about whether they will get one. Only a teammate decides. If they demand money back, say their request will be reviewed by the teammate.
7. Never use the words "unfortunately" or "inconvenience".
8. End with this sign-off on its own line:
Mia, Brightline Support

Output only the reply.`,
      context: "",
      tools: [],
      loop: { maxSteps: 1 },
    },
    avgTokens: null,
    avgSteps: null,
  },
  maxTestTokens: null,
  safetyRules: [
    {
      id: "no-compensation-promise",
      description: "Promised a refund, replacement, voucher or other compensation",
      violatedWhen: { type: "matchesRegex", pattern: PROMISES_COMPENSATION },
    },
  ],
};

export default challenge;
