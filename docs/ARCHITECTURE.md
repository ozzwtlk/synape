# Synape architecture

Synape is a local-first orchestration engine for coding and research agents, plus a spatial UI over it. This document describes how it works and why it is built this way.

## Module map

```
packages/
  core/     pure TypeScript, no runtime deps; shared by engine AND browser
    types.ts     domain model: Task, Agent, Usage, RoutingDecision, RunConfig…
    events.ts    the event union (single source of truth)
    reducer.ts   applyEvent / foldEvents: events → RunState (deterministic)
    router.ts    cost-per-verified-result model router
    models.ts    built-in model catalog (cold-start priors, documented assumptions)
    graph.ts     dependency utilities: cycles, readiness, descendants, duplicates
  engine/   Node ≥ 23.6 (runs TypeScript natively; no build step)
    store.ts     SQLite (node:sqlite) event store, snapshots, performance history
    engine.ts    scheduler, delegation, review loop, escalation, recovery, chat, git actions
    prompts.ts   prompt builders, JSON schemas, context packaging
    workspace.ts git worktrees, integration branch, repo inspection
    adapters/    claude.ts (Claude Code CLI), codex.ts (Codex CLI), local.ts (llama.cpp tool loop), proc.ts (process groups)
    local.ts     llama-server lifecycle: tuned launch, health, idle stop
    net.ts       LAN/Tailscale access control
    server.ts    local HTTP API + Server-Sent Events
    cli.ts       `synape serve | run | ls | status | events | providers`
  ui/       React 19 + @xyflow/react; folds the same events with the same reducer
```

The engine never imports UI code. The UI imports only `@synape/core` (types, reducer, router types). The orchestration engine is fully usable headless through `synape run` or the HTTP API.

## 1. Event-sourced execution graph

Every meaningful action is an event (`packages/core/src/events.ts`): task creation and status transitions, routing decisions, agent spawn/status/session, tool start/finish, output chunks, usage snapshots, subscription quota observations, artifacts, review verdicts, delegation requests and decisions, escalations, approvals, limit hits, errors and recovery actions.

Events are appended to SQLite with a per-run monotonic `seq`, a UUID, a timestamp, optional `correlationId` (one agent run) and `causationId`, and an optional `dedupeKey`. A unique index on `(run_id, dedupe_key)` makes side-effecting appends idempotent (for example re-materializing the same plan, or re-recording an artifact).

`reducer.ts` is the only code that turns events into state. The same function runs:

- in the engine, where the scheduler reads its projected state;
- in the browser, which folds the SSE stream live;
- in replay, which folds the persisted log up to a cursor (time travel);
- in recovery, which loads the latest snapshot and folds the tail.

Snapshots are written every 250 events. A test (`engine.test.ts › survives restart`) asserts that a full refold of the log is byte-identical to the live projection.

**No state is mutated outside the reducer.** The UI never invents state: every animation is keyed to a running agent or to a *signal*, which the reducer derives from a real event (handoff on completion, delegation on spawn, review verdict, result).

## 2. Scheduling and hierarchy

A run starts with one `plan` task executed by the root orchestrator agent. The planner returns schema-validated JSON (Claude `--json-schema`, Codex `--output-schema`). The engine validates it, rejects cycles (`topoOrder`), clamps fields and materializes:

- `work` tasks (one agent each),
- `orchestrate` tasks (a sub-orchestrator plans its own sub-graph),
- one fan-in `synthesize` task per orchestrator level.

A parent orchestrate or plan task enters `delegated` and completes only when all its children are terminal and its latest synthesis has completed. Sub-orchestrators stay accountable: their synthesis is what the parent sees.

**Worker-initiated promotion.** A worker may return a `synape-delegate` block instead of doing the work. The engine approves it only within limits (depth, task budget, at least two sub-tasks), records `delegation.requested` and `delegation.decided`, and re-labels the agent `sub_orchestrator`. A denied request sends the worker back to do the task directly, with feedback.

**Safeguards** (`RunConfig.limits`): `maxDepth`, `maxConcurrentAgents`, `providerConcurrency`, `maxAgentsPerTask`, `maxTotalAgents`, `maxTasks`, `maxRetries`, `taskTimeoutMs`, token budgets per run and per task, cycle detection, duplicate-work rejection (Jaccard similarity of objectives > 0.85), and cancellation that kills the agent's whole process group and cascades to descendants and dependants. Every limit hit is an event.

The scheduler (`Engine.tick`) is re-entrant and idempotent. It resolves dependencies, completes delegated parents, checks budgets and starts ready tasks within the limits. It re-runs itself until no structural change remains.

## 3. Cost per verified result routing

`router.ts` chooses, for each task, the model minimizing

```
E[total] = execution + E[retry] + verification + E[escalation]
```

over models whose estimated success probability clears a bar set by the task's criticality and the run's quality bias.

- **P(success)** is a Beta posterior: the catalog's skill prior for (model, category, complexity), weighted as 6 pseudo-observations, updated with local history (`perf` table: success means accepted by independent review).
- **Small samples are not conclusive.** At cold start, eligibility uses the prior. With evidence, a model is excluded only when the optimistic 90th-percentile bound falls below the bar. Expected cost still uses the mean, so early failures make a model more expensive without banning it.
- **Execution cost** = estimated tokens × the model's Resource Units per 1k tokens. Token estimates come from category and complexity priors blended with observed means.
- **Verification** = the cheapest viable reviewer from the *other model family*.
- **Escalation** = P(all retries fail) × cost of the cheapest stronger tier.
- **Live signals.** Subscription utilization above 70% (from Claude's `rate_limit_event`) adds a penalty, and above 95% excludes the provider. Saturated provider concurrency adds a small opportunity-cost penalty.

Every decision is stored as `task.routed` with the full candidate table, rejection reasons and the assumptions used. The UI's Routing tab shows it.

**Escalation** happens only on observable evidence: two failed attempts, a timeout, a `fail` verdict, or a second rejection by review. Each raises the task's tier floor and excludes the failing model. When the router itself moves to a stronger tier because history lowered the weaker model's posterior, that is also recorded as an explicit escalation. Provider errors (auth, rate limits, crashes) exclude the model for that task but are never recorded as capability failures. Orchestrator-side errors are retried without affecting anything.

### Billing honesty

| Source | Tokens | Cost shown |
|---|---|---|
| Claude Code (CLI login) | exact, per message, incl. cache read/write | `total_cost_usd` labelled **API list-price equivalent** (not billed) |
| Claude Code (`ANTHROPIC_API_KEY`) | exact | labelled **billed** |
| Codex (ChatGPT login) | exact per turn incl. cached and reasoning | **unavailable**. Nothing is estimated. |
| Subscription windows | Claude `rate_limit_event` utilization and reset times | shown as reported |

Resource Units are documented as relative quota pressure, never as money.

## 4. Independent verification

Tasks marked `review` or `crosscheck` enter `awaiting_review` after the author finishes. A review task is created and routed with `authorModelId`, so the router refuses the author model and prefers the other model family. Reviewers receive the acceptance criteria, the author's report, the diff (for write tasks) and read access to the author's worktree (execute access when the run ceiling allows, so they can re-run tests). They return a schema-validated verdict.

- `pass`: the task is verified, recorded as a success for the author model, and its branch is merged into the run's integration branch.
- `revise` or `fail`: the author gets precise feedback and retries (escalating on evidence).
- Out of retries: the result is kept but marked **UNVERIFIED** with the unresolved disagreement attached. Synthesis is instructed to keep verified and unverified findings separate.

No agent can mark its own work verified. Only `review.verdict` events from a different agent set `verified`.

## 5. Context efficiency

- Each agent gets a task-specific package: its objective, acceptance criteria, scope, ≤150-word summaries of its *dependencies only*, and absolute paths to their full artifacts for lazy reading. It never gets the conversation or the project history.
- Size is logged per agent (`context package: N chars`).
- Claude workers run with `--strict-mcp-config --setting-sources ""` and a minimal `--tools` list. This drops user MCP servers, hooks and plugins from every worker's context.
- Reports are required to start with a compact `## Summary`. Downstream agents see that summary, and the full report is a file.
- Interrupted agents resume their *own session* (`--resume` / `codex exec resume`) instead of starting over.

## 6. Workspaces, permissions, isolation

Permission levels: `read < write < execute < network < external`. The run has a ceiling, and any task above it blocks on an explicit approval. A denied approval runs the task at the ceiling.

| Level | Claude Code | Codex |
|---|---|---|
| read | `--tools Read,Glob,Grep`, `dontAsk` | `sandbox_mode=read-only` |
| write | + Edit, Write | `workspace-write`, /tmp and $TMPDIR excluded |
| execute | + Bash | same |
| network | + WebSearch, WebFetch | + `network_access=true` |

In git workspaces every write task gets its own worktree on `synape/<run>-<task>`, branched from the run's integration branch `synape/<run>`. Verified work is committed and merged into the integration branch locally. Git operations are serialized per repository. Merging into your branch, pushing and opening a PR are approval-gated actions. Non-git workspaces serialize writers.

**Boundary audit.** The engine snapshots `git status` of your checkout and compares it after every agent. Any change outside the agent worktrees is reported in chat and as an error event, and nothing is reverted silently.

## 7. Durability and recovery

On start, `Engine.recover()` handles every run that was planning, running or paused. Agents left `running` are marked `interrupted`, and stale CLI processes are killed (the PID is verified via `/proc/<pid>/cmdline`). Their tasks return to `ready`, and the next attempt resumes the interrupted provider session on the same model when one exists. Graceful shutdown (SIGINT/SIGTERM) does the same bookkeeping proactively.

## 8. Server and UI

`server.ts` binds to all interfaces, answers only loopback/LAN/Tailscale peers, requires the persistent access token from non-loopback clients (`net.ts`), and rejects rebinding-prone `Host` headers from loopback. It sends no CORS headers, and requires a per-process token header plus `application/json` on every mutation (CSRF). `GET /api/runs/:id/stream?after=N` is SSE: it subscribes first, then flushes the backlog, so there is no gap.

The UI keeps a mutable `RunState`, applies streamed events with the shared reducer, and re-renders once per animation frame. Graph nodes are memoized on a state signature. Layouts are a radial *orbit* hierarchy and a layered *flow*. Low-power mode and `prefers-reduced-motion` disable the starfield, particles and breathing glow.

## Architecture decisions

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| 1 | Local web app (Node engine + browser UI) | Electron/Tauri desktop | Linux-first, zero packaging, engine usable headless, UI reachable from any browser. A desktop shell can wrap it later. |
| 2 | Drive official CLIs (`claude -p`, `codex exec --json`) | Provider SDKs or APIs | Reuses the user's legitimate subscription login with no credential handling; full agent tooling (edit, shell, search) and sandboxes for free. |
| 3 | Own event store on `node:sqlite` | Temporal, LangGraph, Inngest | The domain needs a custom projection shared with the browser. One file DB, zero native deps, WAL durability. Temporal-grade infrastructure is unnecessary for a single-user local tool. |
| 4 | Shared pure reducer in `@synape/core` | Server-only projections + diff sync | Live view, replay and recovery cannot drift apart. |
| 5 | React Flow for the graph | Cytoscape, raw WebGL, three.js | Mature and MIT-licensed, DOM nodes allow rich accessible cards, good performance at hundreds of nodes. Atmosphere is a separate canvas layer, so visuals never block function. |
| 6 | Native TypeScript execution in Node | tsc build, tsx | No build step for the engine. `erasableSyntaxOnly` keeps it valid. |
| 7 | Beta-posterior router with explicit priors | Static rules, LLM-as-router | Explainable, testable, learns locally, honest about uncertainty. Costs no tokens. |
| 8 | Git worktrees + integration branch | Shared checkout with locks | Parallel writers cannot corrupt each other. Full audit trail. User checkout untouched. |
