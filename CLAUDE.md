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

## Milestones
- [x] M0 Setup
- [ ] M1 Scoring engine, CLI only, no UI  ← CURRENT
- [ ] M2 Playable MVP (auth, challenge page, config editor, results) — functional UI only
- [ ] M3 Game layer (XP, levels, streak, daily, leaderboard, public profile)
- [ ] M4 Content (15 challenges, layers 1-3, branches Business/Research/Ops)
- [ ] M5 Stripe, Pro, Model Lab, export to CLAUDE.md/AGENTS.md
- [ ] M6 Design polish + launch

## M1 scope
- Engine: types, executor with simulated tool calling, checks library (maxSentences, maxWords, matchesRegex, numberEquals, toolCalled, toolArgEquals, toolNotCalled, asksQuestion), judge, efficiency, safety cap
- Challenges: calm-down-the-customer (Prompt layer), travel-policy-assistant (Context layer, 1500-token context budget), refund-triage (Delegation layer, tools get_order, get_customer_history, issue_refund, escalate, send_reply)
- CLI: pnpm score <slug> <config.json> prints per-test results, score breakdown and cost in USD
- Gate: reference config >= 85, lazy config ("do your best") <= 40, judge variance <= 1 point per criterion over 3 runs

## Do not
- Touch /var/www/flowguard or /var/www/_archive, or any FlowGuard PM2 process; never use ports 3000/3001
- Upgrade Next.js beyond 14.2.x
- Use npm install or yarn (npm pkg set is fine)
- Read or print .env.local
- Do visual design work before M6
