# Pimo

Pimo connects its private mobile app to every interactive Pi session on one computer. The internal transport remains the Anywhere v2 protocol so existing installs and pairings stay compatible.

## Architecture

- `apps/anywhere-companion/` is the Pimo Companion Tauri 2 tray application for Windows, macOS, and Linux.
- The companion owns the loopback HTTP API, internal Pi WebSocket registry, persistent pairing, Tailscale Serve, and generic Expo Push alerts.
- `extensions/anywhere/` is a lightweight Pi instance client. It does not bind a public port or run Tailscale.
- `apps/anywhere-mobile/` is the Pimo Expo/React Native app for Android and iPhone.
- `packages/anywhere-protocol/` contains the versioned v2 DTOs and runtime validators.

All Pi data travels through the computer's private Tailscale HTTPS address. Expo Push receives only a generic notification saying that Pi needs an answer; it never receives prompt text, project names, paths, or conversation data.

## Requirements

- Node.js 22 or newer for the Pi harness.
- Tailscale installed and signed in on the computer.
- Tailscale MagicDNS enabled and Tailscale Serve/HTTPS permitted for the tailnet.
- The Tauri companion running in the system tray.
- A private Android APK or iOS internal build of the mobile app.

Pimo Companion refuses to overwrite an unrelated Tailscale Serve configuration. It persists the exact loopback port of the route it created and will clean up a route after restart only when the current Serve handler exactly matches that ownership record. Resolve any other Serve configuration before enabling Pimo.

## Pair a phone

1. Start Pimo Companion and verify its tray icon is active.
2. Start Pi in interactive TUI mode.
3. Run `/reload` after installing or updating this harness.
4. Run `/Pimo` to connect the Pi session, then choose **Show pairing QR** in Pimo Companion.
5. Open **Pimo** on the phone and scan the QR.
6. Choose an active Pi session from the list.

The QR token is a 256-bit one-time secret in the URI fragment. It expires after ten minutes and is consumed once. The resulting device pairing survives restarts until explicitly revoked.

Commands:

- `/Pimo` or `/Pimo start` — connect or reconnect this Pi session to Pimo Companion.
- `/Pimo status` — show this Pi instance's connection state.
- `/Pimo pair` — direct you to the one-time QR in Pimo Companion.
- `/Pimo off` — revoke the phone, disable access, and remove only the Serve route owned by this companion.

`/Anywhere` remains a legacy alias so existing workflows do not break.

The desktop window lists live Pi sessions. **Disconnect** removes only that session's remote bridge; Pi and its terminal keep running, and `/Pimo start` reconnects it. The tray menu provides pairing, re-pair, enable/disable, diagnostics, and quit actions. Closing the tray window hides it; quitting Pimo Companion does not revoke pairing.

## Mobile behavior

The app can:

- list every connected interactive Pi session;
- load bounded user/assistant text from the current active branch;
- show redacted commands, edits, and specialist activity created live;
- send idle, follow-up, or steering messages;
- answer `ask_user` questions and specialist approvals;
- register an Expo Push token after pairing;
- revoke the current phone from Settings. If the companion cannot confirm revocation, the app retains the local credential and shows an error so the user can retry rather than falsely reporting a disconnect.

The first valid terminal or phone answer wins. A losing answer receives `already_settled`, and the other UI is closed or marked as answered elsewhere.

## Security model

The paired phone has the same conversational authority as the local Pi user. Treat it as a high-privilege device.

- Tailscale membership and WireGuard protect network access.
- The companion binds both servers to loopback; only Tailscale Serve exposes the public HTTPS route.
- Funnel and public relay access are not used.
- Pairing and device bearer tokens are stored only as SHA-256 digests on the computer.
- Device authentication uses a bearer header, constant-time digest comparison, size limits, and read/write rate limits.
- The app stores the device credential in iOS Keychain/Android Keystore through `expo-secure-store` and clears it only after remote revocation succeeds (or when the server has already rejected it as invalid).
- The app never stores credentials in AsyncStorage, URLs after pairing, logs, or notification payloads.
- Thinking, raw tool output, images, full session trees, and arbitrary file browsing are excluded.
- Commands and edits continue through the existing redaction and sensitive-file preview rules.

Persistent pairing should be revoked with `/Pimo off` or the mobile Settings screen when the phone is lost or no longer trusted.

## Development and private builds

Install harness dependencies from the repository root:

```bash
npm install
npm run typecheck
npm test
npm run companion:build
npm run mobile:typecheck
```

Build private mobile artifacts after configuring a real EAS project ID in `apps/anywhere-mobile/app.json`:

```bash
cd apps/anywhere-mobile
npx eas build --profile android-internal --platform android
npx eas build --profile ios-internal --platform ios
```

Build Tauri installers with Rust, Cargo, and platform signing tools installed:

```bash
cd apps/anywhere-companion
npx tauri build
```

No signing credentials, EAS credentials, or generated build output belong in Git.

## Protocol and fork

Protocol v2 is intentionally incompatible with the old browser/v1 transport. The pinned package is the maintained fork:

```text
git:github.com/NAM-likestocode/pi-ask-user@b01089e7f67318e7d4fc3a44ad043c6d16c096e5
```

It keeps the native terminal UI open while exposing the same prompt to Pimo's authenticated bridge. Do not apply a post-install patch. Package updates must move the pinned fork commit deliberately and rerun the cooperative race tests.
