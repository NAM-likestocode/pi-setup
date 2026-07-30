# Trusted Specialists

A small, approval-gated Pi specialist runner that works with Pi Anywhere.

## Default behavior

- Trusted user specialists load from `~/.pi/agent/agents/`.
- A trusted project may add explicit-use specialists in the nearest `<project>/.pi/agents/` directory.
- Project specialists cannot replace a user specialist with the same name.
- Pi may **propose** a user specialist only when a bounded investigation or independent review is likely to be worth the extra coordination.
- Every run shows the reason, exact task, prompt source, access level, and tools before asking for approval.
- Only one child can run at a time. There are no chains, swarms, background follow-ups, or automatic editing.
- Every child run is forced to `openai-codex/gpt-5.6-sol` with `xhigh` thinking, including project-defined specialists.
- The parent Pi agent remains responsible for checking important claims and for the final answer.

## Default roster

| Specialist | Use when | Access |
|---|---|---|
| `scout` | Relevant code is spread across an unfamiliar or broad area | Read-only project files |
| `researcher` | A decision genuinely needs several current or authoritative web sources | Network research only |
| `reviewer` | A larger or riskier change benefits from an independent check | Read-only project files |
| `workaround-fixer` | Pi would otherwise introduce a workaround and needs the supported root-cause fix first | Read-only project files plus web research |

Do not use a specialist for simple questions, routine commands, single-file work, work already understood, or ritual review. The exception is a proposed workaround: use `workaround-fixer` first under the normal approval gate, then have the parent verify and implement the clean fix.

## Child isolation

Each run starts an ephemeral Pi process with:

- no session;
- no normal extension discovery;
- no skills or prompt templates;
- only the tools declared by the specialist;
- only approved child capabilities. Currently, the built-in `web` capability maps to the pinned `pi-web-access` extension for trusted user specialists.

Supported built-in tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. The default roster intentionally has no editing or shell access. Agent-level model or thinking settings cannot override the enforced `gpt-5.6-sol`/`xhigh` policy.

## Define an explicit project specialist

Create `<project>/.pi/agents/domain-expert.md`:

```markdown
---
name: domain-expert
description: Explains this project's billing rules and edge cases
tools: read, grep, find, ls
model: openai-codex/gpt-5.6-sol
thinking: xhigh
---

Answer only the delegated billing question. Cite the relevant project files.
Keep the result short and identify uncertainty clearly.
```

Project specialists are always explicit-request only, even if their frontmatter says `activation: propose`. They cannot request extra child extensions.

Run `/subagents` to list the current roster, access levels, and configuration issues. Use `/delegation off` to disable new runs for the session.

## Anywhere integration

The extension sends approval and lifecycle status to Pi Anywhere. The dashboard shows commands, changed paths, and success or failure while redacting secret-shaped values and hiding previews for common sensitive files. Raw tool output is not mirrored.
