# Automatic Pi Workaround Fixer

This extension repairs only recurring operational detours experienced by the main Pi agent itself. It does not repair workaround, compatibility, fallback, or temporary code in user projects.

## Trigger

`fix_pi_workaround` is always active. The main agent must call it automatically, without asking first, after it has concrete evidence that a missing or broken Pi tool, shell integration, skill, extension, or global-harness capability forced a detour that repeats or is required every time.

Examples in scope:

- repeatedly writing and launching a helper script because the available shell tool cannot perform the operation directly;
- manually converting the same data or path shape because a Pi tool lacks a supported input;
- repeating a multi-command harness ritual that should be a focused Pi tool or skill.

Examples out of scope:

- compatibility shims, fallbacks, or temporary fixes in a user's project;
- a normal script that is part of the requested deliverable;
- a one-off typo, wrong command, or agent mistake;
- speculative convenience with no observed detour.

There is deliberately no keyword or tool-pattern scanner. The main model supplies the semantic scope decision and concrete evidence, then the child independently rejects an unproven or out-of-scope report. This avoids treating ordinary project work as Pi self-repair.

## Automatic run

1. Acquire one global lock and apply a cooldown to duplicate reports.
2. Copy Git-visible harness source into a temporary staged workspace.
3. Mark every pre-existing dirty or untracked path read-only.
4. Start an isolated `openai-codex/gpt-5.6-sol` child at `xhigh` thinking without approval.
5. Allow reads only from the staged harness and installed Pi/package documentation or source.
6. Allow writes only to reviewed harness locations. The child cannot edit any part of the automatic fixer, its agent definition, or `APPEND_SYSTEM.md` activation policy.
7. Provide web research plus `harness_check`; do not provide arbitrary shell execution.
8. Reject deletions, out-of-scope paths, more than 24 changed files, or more than 2 MiB of changed content.
9. Run TypeScript and Vitest under Node's native permission model with a sanitized environment and source read-only. The trusted Vitest/Vite bootstrap may launch required workers and helper binaries, but staged test code receives no child-process, nested-worker, or native-addon permission and may write only to a disposable temp directory. Process-spawning hardware integration tests are excluded from this automatic gate and remain part of the normal manual harness suite.
10. Verify validation did not alter staged bytes, recheck real target hashes, apply through Pi's file-mutation queue, and roll back if an apply step fails.

The real user project and installed Pi/package stores are never writable. Applied changes are reported with exact paths and take effect after `/reload`.

## Controls

```text
/workaround-fixer status
/workaround-fixer on
/workaround-fixer off
/workaround-fixer reset
/workaround-fixer unlock
```

`off` lasts for the current session. Set `PI_AUTO_WORKAROUND_FIXER=off` before starting Pi for a process-level opt-out. `reset` clears duplicate-report cooldown history; it does not revert harness changes. `unlock` removes a lock only after verifying that its recorded Pi process has stopped; use it only after a hard process crash.

Runtime history and the global lock live under `~/.pi/agent/state/`, which is excluded from Git.
