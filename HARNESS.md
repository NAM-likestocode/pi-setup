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

Web, MCP, and project-subagent tools begin inactive in a fresh session. `search_tools` loads matching registered tools additively, allowing GPT-5.6's native Responses tool-search protocol to preserve the stable prompt prefix. Loaded tools persist in the session branch.

- `/tool-loader status` lists loaded dynamic tools.
- `/tool-loader reset` returns those groups to on-demand loading.
- Clear research, review, or broad code-mapping prompts may expose the `subagent` tool; this only makes a specialist available and never starts one.

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
