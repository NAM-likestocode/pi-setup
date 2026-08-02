# Pi Setup

This repository contains the personal configuration and custom extensions used by Pi, the terminal coding agent.

It is intended to make the setup reproducible on another system. Start with [`RECOVER.md`](RECOVER.md) for restore instructions.

## Included

- `settings.json` — Pi defaults, theme, model, trust behavior, and package list
- `keybindings.json` — custom keyboard shortcuts
- `APPEND_SYSTEM.md` — additional system instructions and communication preferences
- `extensions/` — custom Pi extensions, tools, workflows, and integrations
- `agents/` — specialist agent Markdown files used by the harness
- `themes/` — custom terminal themes
- `patches/` — documented local patches
- `scripts/` — maintenance and validation scripts
- `tests/` — extension and harness tests
- `HARNESS.md` and `pi-lsp.json` — harness and language-server configuration
- `package.json` and `package-lock.json` — development dependencies for checking the harness

## Packages

`settings.json` records the Pi packages and pinned versions used by this setup. Their installed files are not vendored here; restore them with the commands in [`RECOVER.md`](RECOVER.md).

## Deliberately excluded

This repository does not contain:

- `auth.json` or API keys
- saved conversations in `sessions/`
- project trust state
- installed package stores (`npm/` and `git/`)
- `node_modules/`
- generated caches, model catalogs, MCP state, or run history

These files are either sensitive, machine-specific, or reproducible. Authenticate again on the new system and reinstall the packages instead of copying them.

## Scope

This is the **global Pi harness**. Project-specific instructions and resources should remain with their individual project repositories, including `AGENTS.md`, `.pi/`, and `.agents/skills/`.
