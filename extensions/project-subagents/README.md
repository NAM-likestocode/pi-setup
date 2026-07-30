# Project Subagents

A deliberately manual Pi subagent runner that works with Pi Anywhere.

## Safety and scope

- The main Pi agent starts a child only through the `subagent` tool.
- Every run requires approval **before** the child process is spawned. If Pi Anywhere is paired, the approval appears on the dashboard; otherwise it appears in Pi's TUI.
- Agents are loaded only from the nearest trusted `<project>/.pi/agents/` directory.
- No global agents, sample reviewers, workflow prompts, chains, automatic reviews, or background follow-up jobs are included.
- Only one child can run at a time.
- Child sessions are ephemeral and extension discovery is disabled. Their available tools are explicitly declared by the project agent file; supported tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.

## Define a project agent

Create `<project>/.pi/agents/implementer.md`:

```markdown
---
name: implementer
description: Implements a narrowly specified change in this project
# Omit tools for the read-only default: read, grep, find, ls
tools: read, grep, find, ls, bash, edit, write
# model and thinking are optional; otherwise the main session settings are used
# model: openai-codex/gpt-5.6-sol
# thinking: high
---

Follow this project's AGENTS.md and existing conventions.
Implement only the delegated task. Run focused checks for files you change.
Do not add unrelated cleanup or review work.
```

The filename is not important, but `name`, `description`, and a non-empty instruction body are required.

## Use

Ask the main Pi agent explicitly, for example:

> Use the implementer subagent to add validation to the import endpoint.

The main agent selects `implementer`, proposes the exact task, and waits for approval. Run `/subagents` to list valid agents and configuration issues.

## Anywhere integration

The addon emits a small activity protocol over Pi's extension event bus. Anywhere displays:

- subagent approval and lifecycle;
- commands run by the main or child agent;
- edited/written paths and expandable change previews;
- success or failure state.

Raw tool output is not mirrored. Secret-shaped command values are redacted, and change previews are hidden for common sensitive files such as `.env`, credential JSON, private keys, and certificates.
