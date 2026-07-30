# Pi Harness

This directory is the versionable source of the global Pi harness. Runtime credentials, sessions, package stores, and generated model data are excluded by `.gitignore`.

## Reviewed package manifest

| Package | Reviewed version/ref |
|---|---|
| `pi-image-tools` | `b8977bbb4f416fd63db7c7c602db6dfe7b17f62c` (`v1.4.0`) |
| `pi-ask-user` | `1ad2adf7010c4ac5068668b6999bc1eb98a864a7` (`v0.13.0` plus the local Anywhere patch) |
| `context-mode` | `1.0.169` |
| `pi-web-access` | `0.15.0` |
| `pi-mcp-adapter` | `2.15.0` |

The Anywhere compatibility patch is `extensions/anywhere/pi-ask-user-anywhere.patch`, expected SHA-256 `3e3f8f1f41b04169dea175bcc7ad8742170663076ac8288335a45e7e5cc836e3`.

The retired Cloudflared executable was removed because the current Anywhere implementation exclusively uses Tailscale Serve and contains no Cloudflared references.

## Responses API continuity and compaction

The `openai-codex` provider continues to use the ChatGPT/Codex backend with `store: false`; it does not switch to API-key billing. The managed Pi AI patch adds Responses server-side compaction at a 200K rendered-token threshold for models with larger context windows. It persists encrypted compaction items, replays the newest item, and prunes older request items. If the Codex backend rejects `context_management`, the request is retried without it and the feature is disabled for that model/backend for the remainder of the process.

The patch is intentionally version-locked to `@earendil-works/pi-ai` 0.82.1:

```powershell
npm run patch:responses   # apply or reapply after a compatible Pi reinstall
npm run patch:check       # verify without changing files
npm run patch:revert      # restore the captured 0.82.1 originals
```

Set `PI_CODEX_SERVER_COMPACTION=off` before starting Pi for an immediate runtime opt-out. There is no separate 175K local-compaction trigger.

## Dynamic tool loading

Web, context-mode, MCP, and project-subagent tools begin inactive in a fresh session. `search_tools` loads matching registered tools additively, allowing GPT-5.6's native Responses tool-search protocol to preserve the stable prompt prefix. Loaded tools persist in the session branch.

- `/tool-loader status` lists loaded dynamic tools.
- `/tool-loader reset` returns those groups to on-demand loading.
- Explicit delegation prompts activate `subagent`; approval remains mandatory.

## Validation

```powershell
npm install
npm run check
```

Inside Pi, run `/reload`, followed by `/harness-doctor`.

## Safety boundaries

- Project trust is explicitly `ask`.
- Package specs are pinned to reviewed versions or commits.
- Detailed plan mode activates a restricted inspection profile. Tests, builds, scripts, pipelines, redirection, and unreviewed tools remain unavailable until `/plan-implement`.
- Remembered notes are capped per note, per scope, and by total injected context; writes use a temporary file and atomic rename.

## Deferred migration

Central coordination of autopilot, detailed-plan, and delegation workflow state remains a separate migration.
