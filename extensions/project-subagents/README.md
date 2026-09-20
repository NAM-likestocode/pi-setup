# Subagents

Delegate bounded tasks to isolated child Pi processes that run **in the background**, in parallel, and can delegate further themselves.

## Default behavior

- The `subagent` tool returns immediately; the child's report is delivered to the session as a follow-up message beginning with `[Subagent "<name>" …]` when it finishes. The parent keeps working meanwhile. Use `mode: "wait"` to block instead.
- Up to `maxConcurrent` (default 4) children run at once; children load this extension too, so they can delegate up to `maxDepth` (default 2) levels deep.
- **No approval prompt** by default (`approval: "never"`). Set `"approval": "always"` in `~/.pi/agent/subagents.json` to restore the confirm dialog (local TUI and Pi Anywhere).
- The built-in `worker` profile is always available: read, bash, edit, write, grep, find, ls, plus web tools when `pi-web-access` is installed. Named specialists load from `~/.pi/agent/agents/*.md` and `<project>/.pi/agents/*.md`.
- Any call may override `tools`, `model`, `thinking`, add `instructions`, set `cwd`, and give the run a `name`.
- Profiles use their own frontmatter `model` / `thinking`; without one they **inherit the parent session's**. The old global policy is opt-in via `enforceModel` / `enforceThinking`.
- Each child's full `--mode json` event stream is written to `<transcriptDir>/<runId>.jsonl` (default `~/.local/state/pi/subagents/`), bracketed by `subagent_start` / `subagent_exit` lines. Front-ends (pi-desk) tail these to show live transcripts.
- Children run with `--no-extensions` plus: provider auth packages (auto-detected `*-auth` packages, so subscription auth keeps working), this extension (for nesting), and the web extension when the profile has the `web` capability.
- The parent remains responsible for checking important claims: reports say so explicitly.

## Model pool

`models` in `subagents.json` lists the models children may run on. The parent picks one **per task**
by its `label` (the `use` text is shown to it as guidance); an omitted or out-of-pool model becomes the
first entry. If the chosen provider has no configured auth in the session, the next pool entry is
used and the tool result says so. Current pool: `opus` (`anthropic/claude-opus-5`, xhigh) for
hands-on implementation, `luna` (`openai-codex/gpt-5.6-luna`, max) for deep reasoning, review and
research. Leave `models` empty to go back to per-profile / inherited models.

## `~/.pi/agent/subagents.json`

All keys optional:

```json
{
  "approval": "never",
  "defaultModel": "inherit",
  "defaultThinking": "inherit",
  "models": [
    { "label": "opus", "id": "anthropic/claude-opus-5", "thinking": "xhigh", "use": "implementation, editing, running tests" },
    { "label": "luna", "id": "openai-codex/gpt-5.6-luna", "thinking": "max", "use": "deep analysis, review, research" }
  ],
  "enforceModel": "openai-codex/gpt-5.6-sol",
  "enforceThinking": "xhigh",
  "maxConcurrent": 4,
  "maxDepth": 2,
  "defaultMode": "background",
  "transcriptDir": "~/.local/state/pi/subagents",
  "childExtensions": ["~/.pi/agent/npm/node_modules/@gotgenes/pi-anthropic-auth/src/index.ts"],
  "extraChildExtensions": [{ "path": "~/.pi/agent/extensions/some-extension.ts", "tools": ["some_tool"] }]
}
```

`childExtensions` replaces the auto-detected auth list when given. `extraChildExtensions` is appended to it for harness extensions children should also load (plain path strings are accepted too); each entry lists the tools it registers, because children start with a strict `--tools` allowlist. Missing files are skipped.

Other extensions can inspect or stop runs over the event bus: `pi-subagents:query:v1` with `{ runId, reply }` answers with the run's details, and `pi-subagents:stop:v1` with `{ runId, reply }` aborts a running child.

## Tool parameters

| Parameter | Meaning |
|---|---|
| `task` (required) | Self-contained task with paths, commands and acceptance criteria. The child does not see the conversation. |
| `reason` (required) | One sentence on why delegating is worthwhile. |
| `agent` | Profile: `worker` (default) or a named specialist. |
| `name` | Label for the run (status bar, reports, pi-desk). |
| `mode` | `background` (default) or `wait`. |
| `model` | Pool label (`opus` / `luna`) chosen per task; `provider/id` when no pool is configured. |
| `tools`, `thinking`, `instructions`, `cwd` | Per-run overrides. |

## Commands

- `/subagents` — policy, profiles, recent runs.
- `/subagents stop <id|all>` — cancel running children.
- `/subagents report <id>` — re-inject a run's report into the session.

## Named specialists

| Specialist | Use when | Access |
|---|---|---|
| `scout` | Relevant code is spread across an unfamiliar or broad area | Read-only project files |
| `researcher` | A decision genuinely needs several current or authoritative web sources | Network research only |
| `reviewer` | A larger or riskier change benefits from an independent check | Read-only project files |

Their frontmatter currently pins `openai-codex/gpt-5.6-sol`; remove the `model:` line to inherit the parent's model instead. Definitions marked `automatic: true` and `scope: pi-harness` (`agents/workaround-fixer.md`) are excluded from discovery; `extensions/auto-workaround-fixer/` runs that one itself and still uses `ENFORCED_SUBAGENT_MODEL`.

## Define a project specialist

Create `<project>/.pi/agents/domain-expert.md`:

```markdown
---
name: domain-expert
description: Explains this project's billing rules and edge cases
tools: read, grep, find, ls
---

Answer only the delegated billing question. Cite the relevant project files.
```

Project specialists are explicit-request only and cannot request extra child capabilities. A project cannot redefine `worker` or a user specialist.

## Anywhere integration

Lifecycle and tool activity are still emitted on the dashboard channel (commands, changed paths, success/failure; secrets redacted, raw output not mirrored). The remote approval prompt is used only when `approval` is `"always"`.
