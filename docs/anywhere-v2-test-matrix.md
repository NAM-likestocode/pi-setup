# Pimo / Anywhere v2 validation matrix

## Automated checks

| Area | Command | Expected result |
|---|---|---|
| Shared protocol | `npm run protocol:test` | protocol v2 fixtures, version rejection, strict fields, prompt validation pass |
| Harness TypeScript | `npm run typecheck` | pass |
| Harness tests | `npm test` | all Vitest suites pass |
| Desktop frontend | `npm run companion:build` | TypeScript and Vite build pass |
| Mobile TypeScript | `npm run mobile:typecheck` | pass |
| Desktop Rust | `cd apps/anywhere-companion/src-tauri && cargo test && cargo check` | requires Rust/Cargo; run before packaging |

The root `npm run check` also runs the unrelated managed Responses patch check. That check intentionally refuses the installed `@earendil-works/pi-ai` 0.84.1 because the preserved patch is version-locked to 0.82.1. Do not force-apply it to another version.

## Manual/platform checks

Run these with a private build and a test tailnet. Never use a production pairing token in a test report.

1. **Windows tray:** start/quit/autostart, show/re-pair/revoke QR, restart, verify pairing persists until revoke, and drag the frameless window from anywhere in its header. Disconnect one listed session from the desktop window, verify Pi remains running while desktop/mobile remove it, then reconnect it with `/Pimo start`.
2. **macOS tray:** repeat the Windows tray checks and confirm the menu bar item survives window close.
3. **Linux tray:** repeat the tray checks with an AppIndicator-capable desktop.
4. **Tailscale:** confirm MagicDNS, empty Serve status before enable, HTTPS route after enable, and no Funnel route. Add an unrelated Serve handler and verify the companion refuses to overwrite it.
5. **Pairing:** scan once, reject an expired token, reject a reused token, reject a token from another host, and verify that a second phone cannot pair without re-pairing.
6. **Instances:** run two interactive Pi sessions in different projects; switch between them and confirm each transcript remains visible from the in-memory cache, refreshes from its own current branch, opens on the latest 100 chat messages, and pages backward without duplicates. Close one terminal and verify its card disappears within the next five-second app-wide refresh.
7. **Prompt race:** answer an `ask_user` question from the terminal and phone nearly simultaneously; verify exactly one answer is accepted and the loser sees `already_settled`.
8. **Specialist approval:** repeat the race for a specialist approval. Confirm cancel, timeout, and offline-terminal fallback remain usable.
9. **Privacy:** inspect push payloads and event history. They must not contain prompt text, project paths, thinking, raw tool output, images, or arbitrary file contents.
10. **Android:** install the private APK, scan QR, verify Keychain/Keystore persistence, notification permission, 401 re-pair flow, history pagination, chat, prompt answer, and revoke. On a cutout device, confirm the session back bar stays below the system status area and the Chat/All/Activity dock remains fixed while the transcript scrolls.
11. **iOS:** repeat Android checks with Keychain, APNs, background notification behavior, and TestFlight/internal distribution.
12. **Recovery:** stop/restart the companion, suspend/resume Tailscale, disconnect the phone, and verify reconnect/backoff and safe state recovery.

Record OS versions, companion commit, mobile build identifier, Tailscale version, and test-tailnet name. Do not record bearer tokens, pairing fragments, prompt content, or personal project paths.
