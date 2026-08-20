# Pi Setup

This repository contains the personal configuration and custom extensions used by Pi, the terminal coding agent.

It is intended to make the setup reproducible on another system. Start with [`RECOVER.md`](RECOVER.md) for restore instructions.

## Included

- `settings.json` — Pi defaults, theme, model, trust behavior, and package list
- `stt.json` — local, no-cost voice dictation configuration
- `keybindings.json` — custom keyboard shortcuts
- `APPEND_SYSTEM.md` — additional system instructions and communication preferences
- `extensions/` — custom Pi extensions, tools, workflows, and integrations, including guarded automatic repair of Pi's own recurring operational workarounds
- `packages/anywhere-protocol/` — Pimo's versioned Anywhere v2 protocol and validators
- `apps/anywhere-companion/` — Pimo Companion, a Tauri 2 desktop tray app
- `apps/anywhere-mobile/` — Pimo for Android/iPhone
- `apps/visual-planner/` and `extensions/visual-planner/` — local browser canvas with review-only Pi proposals
- `agents/` — specialist agent Markdown files used by the harness
- `themes/` — custom terminal themes
- `patches/` — documented local patches
- `scripts/` — maintenance and validation scripts
- `tests/` — extension, protocol, and harness tests
- `HARNESS.md` and `pi-lsp.json` — harness and language-server configuration
- `package.json` and `package-lock.json` — workspace and development dependencies

## Pimo

Pimo Companion is the machine-level authority for the Pimo mobile app. Interactive Pi sessions register with its loopback WebSocket, and the companion exposes a private HTTPS API through Tailscale Serve. The app pairs once by QR, lists all active TUI sessions, loads bounded current-branch history, sends messages, and answers pending questions. Existing technical identifiers continue to use the Anywhere v2 name for upgrade compatibility.

Pi traffic never uses a public relay or Tailscale Funnel. Expo Push receives only a generic “Pi needs your answer” notification. Persistent device pairing remains high privilege and is revoked with `/Pimo off`, `/Pimo pair`, or the mobile Settings screen.

Read [`extensions/anywhere/README.md`](extensions/anywhere/README.md) for requirements, installation, commands, security, private builds, and troubleshooting. The validation matrix is [`docs/anywhere-v2-test-matrix.md`](docs/anywhere-v2-test-matrix.md). The new-system procedure is in [`RECOVER.md`](RECOVER.md).

## Visual planner

Run `/canvas` to open a project-local planning and mind-map canvas beside the normal Pi terminal. You can create and connect goal, idea, question, decision, task, and file cards. Pi can read the board and stage a batch of changes, but the browser must accept the batch before the board changes. Boards are saved under `<project>/.pi/visual-planner/` as canonical JSON plus readable Markdown.

The server is loopback-only, token-protected, and active only while the canvas is open. Build the browser app with `npm run planner:build`. Full usage and security details are in [`extensions/visual-planner/README.md`](extensions/visual-planner/README.md).

## Dependency audit

The directly controlled `ws` and Vite dependencies are patched. The Expo 53 / React Native 0.79 mobile build chain still has npm advisories whose offered remediation requires a breaking framework migration. See [`docs/dependency-audit.md`](docs/dependency-audit.md) for the exact status, current safety boundary, and required follow-up. Do not run `npm audit fix --force`.

## Packages

`settings.json` records Pi packages and immutable refs. The `pi-ask-user` dependency is pinned to the maintained fork commit `b01089e7f67318e7d4fc3a44ad043c6d16c096e5`; do not apply the removed v1 post-install patch. `pi-voice-stt` is pinned to `0.6.0` and uses the documented managed Windows capture fix in `scripts/pi-voice-stt-windows-patch.mjs` until upstream ships graceful FFmpeg shutdown.

## Automatic Pi self-repair

When the main Pi agent itself is forced into a recurring operational detour because its global tools or harness lack a direct capability, the always-active `fix_pi_workaround` tool starts a scoped child automatically. The child stages a supported extension, tool, configuration, or skill fix; cannot touch project code, installed Pi packages, dirty files, or its own safety boundary; and applies changes only after typecheck and tests pass. See [`HARNESS.md`](HARNESS.md#automatic-pi-operational-workaround-repair).

## Deliberately excluded

This repository does not contain:

- `auth.json` or API keys
- saved conversations in `sessions/`
- project trust state
- installed package stores (`npm/` and `git/`)
- `node_modules/`
- Expo/Tauri signing credentials and generated installers
- generated caches, model catalogs, MCP state, or run history

These files are sensitive, machine-specific, or reproducible. Authenticate again on a new system and reinstall packages instead of copying them.

## Scope

This is the **global Pi harness**. Project-specific instructions and resources should remain with their individual project repositories, including `AGENTS.md`, `.pi/`, and `.agents/skills/`.
