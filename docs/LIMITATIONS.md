# Known limitations

These are the current, honest boundaries of Synape v0.1.

## Providers

- Only Claude Code and Codex adapters exist. The adapter interface (`packages/engine/src/adapters/types.ts`) is small, but local or other API-backed models have not been implemented yet.
- Model availability within a provider is not probed per model. If a catalog model is not available on your plan, its first call fails as a *provider error*: the router excludes it for that task and moves on, but it is not removed from the catalog.
- Codex reports no cost and no quota information, so neither is shown. Claude's subscription windows are known only after a Claude agent has run in the session.
- Context utilization is exact for Claude (largest single request vs. the reported window). Codex reports only cumulative turn usage, so its context ring is not shown.
- Agents cannot receive messages mid-turn (the CLIs run in print/exec mode). Questions to a running agent must wait until it finishes, and course corrections go through the orchestrator.

## Orchestration

- Catalog skill priors and Resource-Unit weights are hand-set assumptions. They converge to observed behaviour only after a number of runs per (model, category).
- Duplicate detection is lexical (Jaccard over words). Paraphrased duplicates can slip through.
- A failed dependency fails its dependants (synthesis still runs over what settled). Automatic re-planning around failures happens only through follow-up instructions.
- Write tasks in non-git workspaces are serialized rather than isolated.
- Merge conflicts between parallel worktrees are detected and reported, and the branch is preserved, but they are not resolved automatically.

## Interface

- Layouts are computed rather than force-simulated. Very large runs (hundreds of tasks) stay responsive, but get dense in Orbit, where Flow plus cluster collapsing reads better.
- Replay folds from the start of the log when moving backwards. This is instant for thousands of events and slower for very long runs.
- No authentication beyond the local token, by design: Synape is a single-user local tool. Do not expose the port.

## Not yet built

- Desktop packaging (the web UI runs in any browser).
- A built-in interactive terminal (agent output and tool calls are shown read-only).
- Per-task budget editing from the UI (budgets are set per run).
