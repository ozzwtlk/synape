# Security model

Synape runs coding agents with real tool access on your machine. This document states what it protects against, how, and what it does not cover.

## Threats considered

1. **Prompt injection** from repository files, papers, web pages, tool output or other agents' messages.
2. **Agents exceeding their mandate**: writing outside their workspace, escalating permissions, spawning without bound.
3. **Other local web pages** driving the Synape API (CSRF, DNS rebinding).
4. **Credential exposure.**
5. **Unapproved publication** of private code or research.

## Controls

**Credentials.** Synape never reads, copies, stores or prints provider or git credentials. It invokes the official `claude` and `codex` CLIs, which use your existing login. `git` and `gh` use your configured credential helpers. Remote URLs shown in the UI have any embedded `user:token@` stripped.

**Untrusted content is data.** Every prompt fences external material (objectives, dependency results, reports, diffs, reviewer input) in `<untrusted>` tags, and the system prompt instructs agents not to follow instructions found inside them. More importantly, *the engine never executes free text*. The only agent outputs that change orchestration state are schema-validated JSON (plans, verdicts) and the `synape-delegate` block. All of these are clamped (enumerations, ranges, max counts), cycle-checked and bounded by limits before use. A malicious plan can at most request tasks, and those tasks inherit the run's permission ceiling.

**Permissions.** Tool access per level is enforced by the providers' own mechanisms. For Claude that is the `--tools` allowlist plus `--permission-mode dontAsk` (anything not allowed is denied, not prompted). For Codex it is OS-level sandboxing (`read-only` / `workspace-write`, network off unless granted, `/tmp` and `$TMPDIR` not writable). A task requesting more than the run ceiling blocks until you approve it in the chat.

**Isolation.** In git repositories, writers work in dedicated worktrees under `~/.local/share/synape/worktrees`, never in your checkout. The boundary audit reports any change to your checkout that happens during a run. Non-git workspaces serialize writers.

**Bounded autonomy.** Limits on delegation depth, concurrent agents, agents per task, total agents, tasks, retries, timeouts and tokens are enforced in the scheduler, and every hit is logged as an event.

**Local API.** The server binds to all interfaces but only answers loopback, private-LAN and Tailscale peers (others get 403). Non-loopback clients must present a persistent access token (`?token=` once, exchanged for an HttpOnly SameSite=Lax cookie, or `Authorization: Bearer`). Loopback clients must use a localhost, IP-literal or `*.ts.net` `Host` (DNS rebinding). `--host 127.0.0.1` restores loopback-only. The local model server (llama.cpp) is always bound to `127.0.0.1`. It sends no CORS headers, and every mutating request needs a per-process random token in `x-synape-token` plus `Content-Type: application/json` (cross-site forms cannot set either). The token is served at `/api/bootstrap`, which other origins cannot read. Artifact downloads are resolved through the run state and never from a client-supplied path. The directory browser is confined to `$HOME`.

**Rendering.** Agent output is rendered as markdown sanitized by DOMPurify (no scripts, styles, forms or images).

**Publication.** Merging into your branch, pushing and opening pull requests are approval-gated actions, executed only after you approve each request. Synape never changes repository visibility.

## Known limitations

- Read-level Claude agents can read any file the `Read` tool can reach inside the working directory and the `--add-dir` directories. Codex `read-only` sandboxes allow reading the whole filesystem. Treat "read" as "may read local files", not as confidentiality between projects.
- Agents at `execute` level run arbitrary shell commands inside their sandbox and worktree. Claude's Bash tool is not OS-sandboxed by Synape, so only grant `execute` to runs on code you are willing to let an agent operate on.
- Prompt-injection defenses reduce but cannot eliminate the risk that an agent is misled within its permitted actions. Independent review and the boundary audit are detection layers, not guarantees.
- The token protects against other websites, not against other local users or processes running as you.
- Synape does not inspect what providers do with prompts. Content sent to an agent is sent to that provider under your account's terms.

## Reporting

Please report vulnerabilities privately through a GitHub security advisory on the repository rather than a public issue.
