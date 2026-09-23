# Pi Harness

This directory is the versionable source of the global Pi harness. Runtime credentials, sessions, package stores, and generated model data are excluded by `.gitignore`.

## Reviewed package manifest

| Package | Reviewed version/ref |
|---|---|
| `pi-image-tools` | `b8977bbb4f416fd63db7c7c602db6dfe7b17f62c` (`v1.4.0`) |
| `pi-ask-user` | `b01089e7f67318e7d4fc3a44ad043c6d16c096e5` (`NAM-likestocode` maintained `v0.14.0` cooperative transport fork) |
| `pi-web-access` | `0.15.0` |
| `pi-mcp-adapter` | `2.15.0` |
| `@narumitw/pi-lsp` | `0.39.0` |
| `@braintrust/pi-extension` | `0.10.0` |
| `pi-voice-stt` | `0.6.0` (managed Windows FFmpeg graceful-stop fix) |

Pimo uses a Tauri tray companion, a loopback Pi registration WebSocket, the Expo mobile app, and the shared Anywhere v2 protocol under `packages/anywhere-protocol/`. The retired Cloudflared executable and the old `pi-ask-user-anywhere.patch` were removed. Pimo Companion exclusively uses Tailscale Serve, refuses unrelated Serve configurations, and `/Pimo off` removes only a route recorded as owned by this companion. `/Anywhere` remains a compatibility alias.

## Responses API continuity and compaction

The `openai-codex` provider continues to use the ChatGPT/Codex backend with `store: false`; it does not switch to API-key billing. The managed Pi AI patch adds Responses server-side compaction at a 200K rendered-token threshold for models with larger context windows. It persists encrypted compaction items, replays the newest item, and prunes older request items. If the Codex backend rejects `context_management`, the request is retried without it and the feature is disabled for that model/backend for the remainder of the process.

The patch is intentionally version-locked to `@earendil-works/pi-ai` 0.82.1:

```powershell
npm run patch:responses   # apply or reapply after a compatible Pi reinstall
npm run patch:check       # verify without changing files
npm run patch:revert      # restore the captured 0.82.1 originals
```

Set `PI_CODEX_SERVER_COMPACTION=off` before starting Pi for an immediate runtime opt-out. There is no separate 175K local-compaction trigger.

## Voice dictation

`pi-voice-stt` uses the local Whisper Local server at `127.0.0.1:7777`, so dictation requires no paid API key and audio remains on this computer. `stt.json` targets the Elgato Wave XLR and uses `Ctrl+R` to start/stop recording.

Version 0.6.0 force-terminates FFmpeg on Windows before WAV output is finalized. The managed patch switches to FFmpeg's supported stdin `q` shutdown command, keeps a three-second force-kill watchdog, and is version-locked:

```powershell
npm run patch:voice         # apply or reapply after restoring Pi packages
npm run patch:voice-check   # verify without changing files
npm run patch:voice-revert  # restore the captured 0.6.0 original
```

Fully exit and reopen Pi after applying this package-source patch. `/reload` can retain an already imported nested recorder module in a running process.

Remove this patch after upgrading to an upstream release that gracefully finalizes Windows recordings. The local backend itself is `whisper-local==0.16.1` with the `large-v3-turbo` model; its loopback server is launched at Windows login by the `PiVoiceSTTLocal` user Run entry.

## Dynamic tool loading

Web and MCP tools begin inactive in a fresh session. `search_tools` loads matching registered tools additively, allowing GPT-5.6's native Responses tool-search protocol to preserve the stable prompt prefix. Loaded tools persist in the session branch.

- `/tool-loader status` lists loaded dynamic tools.
- `/tool-loader reset` returns those groups to on-demand loading.
- The `subagent` tool is deliberately *not* dynamic: it is active on every turn, and the project-subagents extension appends its profile list, model pool and a delegate-by-default policy to the system prompt each turn, so delegation does not depend on the user's wording. `APPEND_SYSTEM.md` carries the matching "delegate and defer" working-style rules. `/delegation off` still blocks new runs for a session.

## Dependency audit boundary

The directly controlled `ws` and visual-planner Vite dependencies are updated to non-vulnerable versions. The remaining npm advisories are isolated to the Expo 53 / React Native 0.79 mobile build chain and require a breaking Expo 57 / React Native 0.86 migration. Until that dedicated migration is completed, build the mobile app only from trusted repository assets and never expose Metro to an untrusted network. Do not use `npm audit fix --force`. See [`docs/dependency-audit.md`](docs/dependency-audit.md).

## Automatic Pi operational-workaround repair

`fix_pi_workaround` is always available and starts automatically when the main Pi agent reports concrete evidence that it was forced into a recurring operational detour by a missing or broken Pi tool, shell integration, skill, extension, or harness capability. It must not be used for workaround or compatibility code in a user's project, normal task scripts, one-off command mistakes, or speculative conveniences.

The no-approval child works in a staged copy of this global harness, cannot use arbitrary shell commands, cannot write outside an allowlist, cannot modify pre-existing dirty files or any part of its own enforcement/activation policy, and cannot patch installed Pi packages. It chooses the smallest supported configuration, extension/tool, or skill and adds focused tests. TypeScript and Vitest run under Node's native permission model with a sanitized environment and read-only staged source. Only the trusted Vitest/Vite bootstrap may start its required workers or helper binaries; staged test code runs without child-process, nested-worker, or native-addon permission and can write only to disposable validation temp space. Exact validated bytes are rechecked before copying back. Duplicate reports have cooldowns, and only one token-owned run can hold the global lock.

- `/workaround-fixer status|on|off|reset|unlock` inspects or controls the automatic runner for the current session. `unlock` only clears a stopped process's lock after a hard crash.
- `PI_AUTO_WORKAROUND_FIXER=off` disables it when Pi starts.
- Applied changes are reported with exact paths and require `/reload` after the current task.

## Visual planning canvas

`/canvas` starts a token-protected loopback website for the current project while the normal conversation remains in Pi's terminal. The React Flow board supports draggable typed cards, links, editing, and in-page undo/redo. Its canonical state is `<project>/.pi/visual-planner/board.json`; `board.md` is regenerated as a readable summary.

The planner tools are enabled only while the canvas is open. `visual_planner_read` reads stable ids and the current revision. `visual_planner_propose` validates and stages a batch without changing the board; only browser acceptance applies it. Detailed plan mode permits both tools because they preserve its review boundary. The server binds only to `127.0.0.1`, authenticates HTTP and WebSocket access with a fresh launch token, exposes no shell or arbitrary paths, and stops during session shutdown.

Build the ignored browser output after installation or source changes with `npm run planner:build`. See `extensions/visual-planner/README.md` for the complete workflow and security model.

## Idea council

`/council <model> <idea>` convenes four advisors — Optimist, Skeptic, CFO, Operator — as separate headless Pi children on the model named in the command, lets them rebut each other for a round, and returns one chair verdict as a single session message. `opus5max` style specs resolve to an exact `provider/id` plus thinking level; `/council models` lists valid names.

Members run with `--no-session --no-extensions --no-skills --no-context-files` and no file or shell tools. Web research is enabled by default through the pinned `pi-web-access` capability, so the idea text reaches the search provider; `--no-web` keeps a run local. Because `--no-extensions` also drops provider auth, members on `anthropic/*` automatically load `@gotgenes/pi-anthropic-auth`, without which the child is rejected as an unauthenticated third-party app.

A default run is nine model calls (`4 × 2 rounds + chair`), so the command always asks for confirmation first and `--quick` halves it. Recursion is blocked twice: the extension does not register when `PI_COUNCIL_MEMBER=1`, and the spawn helper refuses under the same variable and only ever relaunches `process.argv[1]` when that script is the Pi CLI itself. See `extensions/council/README.md`.

## Deferred wake-ups

The `pi-defer-tool` package (installed from `gist.github.com/isaaclins/9b5101bfd38b906d69580ade466f19bf`) gives Pi a `defer` tool so it can come back to something later without blocking a turn or polling in a shell loop. `create` arms a trigger with a note and either a time (`at`: `2am`, `14:30`, `in 30m`, ISO timestamp) or a condition (`check`: a shell command polled every `pollMs` until it exits 0, always firing by `timeoutMs` at the latest); an optional `run` command executes at fire time and its bounded output comes back with the wake-up. `list` and `cancel` manage armed triggers, and a terminal widget shows their state and time remaining. For background-work progress, choose a check-in interval based on the job's expected duration: sooner for a short job, roughly 10 minutes for an hour-long one. At each check-in, reassess and choose a new interval if it is still running; a check-in is not a deadline or a fixed recurring timer. Handle earlier completion immediately and cancel the pending trigger. An explicit reminder time requested by the user takes precedence.

Triggers live only for the current Pi process: they survive `/reload` (same process) but quitting Pi cancels them. `check` and `run` execute through `bash -c` with Pi's permissions, so treat them like bash tool calls.

## Quiet footer

`extensions/quiet-footer.ts` adds `/verbose on|off|toggle|status`. `off` replaces the built-in footer through `ctx.ui.setFooter` with a reduced one: path and session name; context usage (yellow above 70 %, red above 90 %) with the model and thinking level; and a third line only when an extension status signals something active or worth attention (autopilot, delegation off, running subagents, plan mode, council, workaround fixer, defer triggers). Token counters, cache stats, cost, the provider prefix, the `(auto)` compaction tag, the git branch and purely informational statuses (`mcp`, `braintrust`, `anywhere`, `pi-lsp`) are dropped; the hidden keys live in `HIDDEN_STATUS_KEYS`. The choice persists in `~/.pi/agent/footer.json`; `on` restores the default footer.

The `MCP: N servers enabled` line comes from `pi-mcp-adapter`, which shows it whenever any server is configured (here Obsidian in `~/.config/mcp/mcp.json`) and offers no setting to hide it, which is why filtering happens in the footer.

## Headless `/reload`

The terminal UI handles `/reload` before extension commands are dispatched, and RPC mode has no reload command, so a front-end that forwards typed text as a prompt (pi-desk) would send "/reload" to the model. `extensions/headless-reload.ts` registers an extension command `reload` only when `ctx.mode` is not `tui`; it refuses while a response is running, calls `ctx.reload()`, and the freshly loaded instance confirms with a notification. In the TUI nothing is registered, so the built-in and its autocomplete are untouched.

## Code intelligence and tracing

`@narumitw/pi-lsp` provides on-demand diagnostics and source fixes. The user-level `pi-lsp.json` intentionally replaces its noisy full catalog with Biome-only support for JavaScript, TypeScript, JSON, CSS, and common web files. Biome `2.5.6` is installed in Pi's managed Node prefix; `/lsp` shows whether its command is available on `PATH`.

`@braintrust/pi-extension` provides optional session tracing. It remains disabled unless `TRACE_TO_BRAINTRUST=true` (or an equivalent Braintrust config) is set, so installing it alone sends nothing. Do not commit API keys or enable tracing for sensitive work without reviewing what will be shared.

## Communication style

`APPEND_SYSTEM.md` asks Pi to lead with the answer, use plain language, avoid unnecessary jargon and implementation narration, and keep deeper technical detail optional. It also distinguishes Pi's own operational detours from project-code workarounds, requires automatic use of `fix_pi_workaround` only for the former, and requires exact reload notes after harness changes. Risks and uncertainty must still be stated clearly.

## Trusted specialists

The default user-level roster in `agents/` is deliberately small:

- `scout` maps unfamiliar or broad code areas;
- `researcher` performs genuinely multi-source web research through the pinned `pi-web-access` child capability;
- `reviewer` independently checks larger or riskier changes;
- `workaround-fixer` is the explicit definition used by the separate automatic runner for recurring operational detours experienced by Pi itself.

The scout, researcher, and reviewer are proposal-enabled and have no edit or shell access. Their generic runs require a plain-language reason, one narrow task, and user approval. The workaround fixer instead runs automatically in a guarded staged harness and has no arbitrary shell tool. Every child is forced to `openai-codex/gpt-5.6-sol` with `xhigh` thinking. Project-local agents remain explicit-request only, cannot replace a trusted user specialist, cannot change the enforced child model or thinking level, and cannot load extra child extensions. The parent agent must check important claims rather than treating a child result as authoritative.

Use `/subagents` to inspect the generic roster and `/delegation off` to disable new generic runs for the session. Use `/workaround-fixer off` for the separate automatic runner.

## Validation

```powershell
npm install
npm run typecheck
npm test
npm run planner:build
npm run companion:build
npm run mobile:typecheck
```

Rust validation requires Cargo: `cd apps/anywhere-companion/src-tauri && cargo test && cargo check`. The managed Responses patch remains version-locked to pi-ai 0.82.1 and is not applied to an incompatible Pi 0.84.1 installation.

Inside Pi, run `/reload`, followed by `/harness-doctor`.

## Safety boundaries

- Project trust is explicitly `ask`.
- Generic specialist runs are isolated, approval-gated, single-child, and non-editing by default. Automatic Pi workaround repair is the narrow exception: it writes only validated staged global-harness changes under the path and dirty-file guard.
- Package specs are pinned to reviewed versions or commits.
- Detailed plan mode activates a restricted inspection profile. Tests, builds, scripts, pipelines, redirection, and unreviewed tools remain unavailable until `/plan-implement`. `/plan steps` opens the complete step list, `/plan edit-summary` edits the short user-facing version, and implementation restores full tools and exits plan mode when all steps finish.
- Visual planner changes proposed by Pi stay pending until explicit browser acceptance. Stale board revisions cannot be applied, and the companion server remains authenticated and loopback-only.
- The `purge` tool permanently removes one explicitly authorized path, blocks filesystem/home/agent roots, and never starts background cleanup or writes temporary deletion scripts.
- Remembered notes are capped per note, per scope, and by total injected context; writes use a temporary file and atomic rename.

## Deferred migration

Central coordination of autopilot, detailed-plan, and delegation workflow state remains a separate migration.
