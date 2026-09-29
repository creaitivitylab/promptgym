# PromptGym — Claude Code Context

## Product
Gamified training for delegating work to AI agents. Audience: non-developer knowledge workers. UI in English.
Core loop: user gets a brief → configures an agent (Instructions, Context, Tools, Loop) → agent runs on 5 hidden test cases with simulated tools → score → feedback + XP.
Score = Outcome 0-60 (deterministic checks in code) + Quality 0-25 (LLM judge with rubric) + Efficiency 0-15 (tokens/steps vs reference solution). Safety rule violation caps total at 40.

## Stack
- Next.js 14.2.x App Router, TypeScript strict, Tailwind
- Supabase Auth + Postgres via supabase-js; SQL migrations in supabase/migrations
- OpenRouter via openai SDK (baseURL https://openrouter.ai/api/v1); models from env EXECUTOR_MODEL (cheap) and JUDGE_MODEL (stronger)
- pnpm only, dev/prod port 3010

## Architecture rules
- All AI calls are server-only, in src/lib/engine/
- Challenges are files: challenges/<slug>.ts, typed by src/lib/engine/types.ts (brief, visibleExamples, testPool, checks, rubric, reference, safetyRules, version)
- testPool never reaches the client
- Judge sees only agent input and output, never the user's instructions
- Tools are simulated over fixture data; nothing real is ever sent
- Executor: temperature 0, max 8 steps per test, token cap per run
- Skip the judge call when Outcome < 30
- Every table gets explicit RLS policies in the same migration
- Log real cost per attempt (for usage_daily later)

## Engine decisions (M1)
- Executor seed per test: FNV-1a over "slug/testId" (`testSeed` in executor.ts). OpenAI's seed is best effort (3-5 distinct outputs in 5 runs at temperature 0), so `pnpm gate` runs each config 5 times: band on the mean Total, SD of Total <= 3, range > 8 warns
- Re-run the full `pnpm gate` after any change to EXECUTOR_MODEL, JUDGE_MODEL, judge reasoning, check logic or scoring formulas. Decent configs should sit near the middle of their band (50-75), not at the edges; give them clear, deterministic flaws far from any check boundary (e.g. a missing policy section), not borderline ones
- Network: up to 2 retries (500/1500 ms) on connection resets, 5xx and interrupted bodies. An interrupted body is logged `cost_unknown: true` with its generation id and a worst-case token estimate that counts against the ceiling
- Judge: Sonnet 5.5 cannot disable reasoning (HTTP 400); default effort `low` (same cost as `minimal`, half the spread). Strict JSON schema, 0-4 per criterion, reason before score
- Cost accounting: real cost = `usage.cost`, plus `cost_details.upstream_inference_cost` only when `is_byok` (for non-BYOK it repeats `cost`). Missing numbers throw, never record 0. `MAX_ATTEMPT_COST_USD` (default 0.25) aborts an attempt
- Per-test token cap: max(3 x reference avgTokens, 1.5 x (context budget + reference tokens outside the context)), stored on the challenge after `pnpm score <slug> --calibrate`; env `MAX_TEST_TOKENS` is the global upper bound. Exceeding it zeroes only that test
- Tool calls: every trace entry is an attempt with `succeeded`. Outcome checks (toolCalled, toolArgEquals, tool-arg text) read succeeded calls; safety rules read attempted calls (we score the decision, not the luck); toolNotCalled always reads attempted calls
- Efficiency is scaled by Outcome/60 so doing nothing earns nothing
- Check weight rule: no single check (challenge-level + test-level combined) may carry more than 25% of a test's total check weight, so every test needs at least 4 checks. Enforced by `validateChallenge` (validate.ts) in the challenge tests. Why: coarse checks cause score instability, because the executor isn't deterministic and one borderline flip of a heavy check swung the Total by 3-6 points between runs. Split an important outcome over several checks instead of weighting one check heavily
- Measured cost per attempt (executor + one judge run, gate 2026-09-29): calm-down 0.017 USD, travel-policy 0.015 USD, refund-triage 0.031 USD on average; judged attempts 0.021-0.032 USD (judge is 75-90% of it), attempts with Outcome < 30 skip the judge at ~0.001 USD. A full `pnpm gate` run costs ~1.30 USD

## Milestones
- [x] M0 Setup
- [x] M1 Scoring engine, CLI only, no UI
- [ ] M2 Playable MVP (auth, challenge page, config editor, results) — functional UI only ← CURRENT
- [ ] M3 Game layer (XP, levels, streak, daily, leaderboard, public profile)
- [ ] M4 Content (15 challenges, layers 1-3, branches Business/Research/Ops)
- [ ] M5 Stripe, Pro, Model Lab, export to CLAUDE.md/AGENTS.md
- [ ] M6 Design polish + launch

## M1 scope
- Engine: types, executor with simulated tool calling, checks library (maxSentences, maxWords, matchesRegex, numberEquals, toolCalled, toolArgEquals, toolNotCalled, asksQuestion), judge, efficiency, safety cap
- Challenges: calm-down-the-customer (Prompt layer), travel-policy-assistant (Context layer, 1500-token context budget), refund-triage (Delegation layer, tools get_order, get_customer_history, issue_refund, escalate, send_reply)
- CLI: pnpm score <slug> <config.json> prints per-test results, score breakdown and cost in USD
- Gate: reference config >= 85, lazy config ("do your best") <= 40, judge variance <= 1 point per criterion over 3 runs

## M2 scope
- Result cache: identical config hash + challenge version + executor model returns the stored attempt result instead of re-running. Players must not be able to re-roll the same config for a better score.

## Do not
- Touch /var/www/flowguard or /var/www/_archive, or any FlowGuard PM2 process; never use ports 3000/3001
- Upgrade Next.js beyond 14.2.x
- Use npm install or yarn (npm pkg set is fine)
- Read or print .env.local
- Do visual design work before M6
