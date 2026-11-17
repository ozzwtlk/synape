# Workflows

Synape is objective-driven: you describe what you want, and the orchestrator decides the graph. The patterns below show how to steer it.

## Software: audit, fix, test, verify

```
Audit the library in this workspace. Find correctness bugs (compare each function against its
docstring and standard definitions), fix them, and add a pytest file covering the fixed behaviour
including edge cases. Verify the fixes independently.
```

Ceiling: `execute`. A typical graph has a read-only audit (cross-checked), parallel fix and test tasks in separate worktrees, an execution-based verification, and a synthesis. Verified branches are merged into `synape/<run>`. Use *Git → Merge run branch* when you are satisfied.

## Explicit workstreams (sub-orchestrators)

Ask for the structure you want, and the planner will create `orchestrate` tasks, each run by its own sub-orchestrator:

```
Organize the work as two independent workstreams, each managed by its own sub-orchestrator:
(A) documentation … (B) robustness …
```

Depth is bounded by `limits.maxDepth`. At the limit, orchestrate requests are downgraded to worker tasks, and the downgrade is logged as a `limit.hit` event.

## Research: literature review and independent verification

Example instruction:

> Here is my project. Survey the relevant literature in `references/` and on the web, determine which of our results are new, which overlap with prior work and which are already established, compare our key numbers quantitatively with published values, implement any calculations needed to check them, and cross-check every major conclusion independently. Keep exact citations. It is acceptable to conclude that nothing is new.

Recommended settings:

| Setting | Value | Why |
|---|---|---|
| Workspace | the project directory (ideally a git repo) | Agents read the material; new code goes to worktrees |
| Extra dirs | any shared tool or data installations | Readable by all agents |
| Ceiling | `execute` (approve `network` per task) | Web search is approval-gated |
| Max depth | 2 | Root, workstream sub-orchestrators, workers |
| Quality bias | 0.7 | Raises the success bar for derivations and claims |
| Token budget | sized to your subscription windows | The run pauses at the budget and asks |

What the engine does with it:

- **Workstreams.** Extracting facts from documents is routine, so it goes to light models in parallel. Novelty assessment, derivations, numerical work and validation become sub-orchestrated workstreams when they are large.
- **Model allocation.** Extraction goes to tier-1 models. Derivations (`reasoning`, high complexity and criticality) go to tier-3/4 models. Numerical code goes to coding-strong Codex models. Reviews always go to the other family.
- **Verification.** Novelty claims, derivations and numerical results are marked `crosscheck`: an independent model re-derives or recomputes them and compares. Prompts require preserved equations, units, assumptions and exact citations, and forbid invented references.
- **Negative results.** Planning and synthesis prompts state explicitly that "nothing new can be claimed" is an acceptable outcome. Unresolved reviewer disagreement is kept, labelled UNVERIFIED, and reported separately in the final synthesis.
- **Reproducibility.** Every report, diff, plan and verdict is an artifact on disk. Every routing decision, tool call and verdict is in the event log, replayable at any point.

**Privacy note.** Running this sends your documents to the providers you enable, under your accounts. Nothing is published anywhere by Synape.

## Follow-ups during a run

Type into *Command* at any time. The orchestrator re-plans: it adds tasks (with dependencies on existing ones), cancels obsolete unfinished tasks, and replies. New work feeds into the final synthesis. If the run had already completed, it is reopened and a new synthesis revision is produced.

## Asking an individual agent

Select a node, tick *Ask … directly*, and type. The question is answered by resuming that agent's own session in read-only mode, so it remembers what it did. The answer appears in the chat and is attributed to the agent.
