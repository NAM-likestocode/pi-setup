# Recover this Pi setup on a new system

This repository contains the tracked, safe-to-share Pi harness, Pimo's Anywhere protocol, Tauri companion source, and Expo mobile source. Credentials, sessions, package stores, signing keys, and generated builds are intentionally excluded.

## 1. Install prerequisites

Install:

- Node.js 22 or newer and npm
- Git
- Pi itself
- Rust/Cargo and platform build tools for the Tauri companion
- JDK 17 plus the Android SDK/NDK for local Android release validation
- Tailscale on the computer and phone
- An Apple Developer account for durable iOS internal builds

Do not copy the old Pi installation directory. Install Pi fresh.

## 2. Clone the harness

```bash
if [ -d "$HOME/.pi/agent" ]; then
  mv "$HOME/.pi/agent" "$HOME/.pi/agent.before-pi-setup"
fi

git clone https://github.com/NAM-likestocode/pi-setup.git "$HOME/.pi/agent"
cd "$HOME/.pi/agent"
npm install
npm run planner:build
```

On Windows the default path is `C:\Users\<your-user>\.pi\agent`. If `PI_CODING_AGENT_DIR` is set, use that directory instead.

## 3. Restore Pi packages

The package list in `settings.json` is the source of truth. The Anywhere question transport is pinned to this maintained fork and full commit:

```text
git:github.com/NAM-likestocode/pi-ask-user@b01089e7f67318e7d4fc3a44ad043c6d16c096e5
```

Install/update packages with Pi's normal package command or let Pi restore the pinned list. Do not apply the removed `pi-ask-user-anywhere.patch`.

On Windows, restore the version-locked `pi-voice-stt` WAV-finalization fix after package installation:

```bash
npm run patch:voice
```

Fully exit and reopen Pi after applying it; an in-process `/reload` can retain the old nested recorder module.

For no-cost local dictation, install `whisper-local==0.16.1`, select the model recorded in `HARNESS.md`, and launch `whisper-local --serve --serve-host 127.0.0.1 --serve-port 7777` at login. Adjust the DirectShow microphone name in `stt.json` if the restored computer uses another device.

Authenticate again with `/login` and recreate provider environment variables. Never commit `auth.json` or API keys.

A root-level `npm audit` currently reports the documented Expo/React Native mobile build-chain advisories. Read [`docs/dependency-audit.md`](docs/dependency-audit.md) and do not run `npm audit fix --force`; the offered fix is a breaking framework migration.

## 4. Install Pimo Companion

From `apps/anywhere-companion/`:

```bash
npm install
npx tauri build
```

Install the resulting private package for the current desktop platform:

- Windows: signed or unsigned internal NSIS installer
- macOS: internal DMG, signed/notarized when credentials are available
- Linux: AppImage or deb package with a tray/AppIndicator-capable desktop

Start Pimo Companion once. It stays in the system tray, starts its loopback servers, writes a protected rendezvous file, and tries to enable Tailscale Serve only when the Serve configuration is empty.

Enable autostart from the tray menu if desired. Closing the window hides it; use **Quit Pimo** to stop it. Quitting does not revoke pairing.

## 5. Configure Tailscale

On both the computer and phone:

1. Install Tailscale.
2. Sign in to the same tailnet.
3. Enable MagicDNS.
4. Allow Tailscale Serve/HTTPS for the tailnet.
5. Ensure no unrelated Serve handler occupies HTTPS port 443 on the computer.

Verify on the computer:

```bash
tailscale status
tailscale status --json
```

Pimo never enables Funnel or a public relay. If another Serve configuration exists, resolve it before enabling the companion; it will not overwrite that service.

## 6. Build and install the private mobile app

Set a real private EAS project ID in `apps/anywhere-mobile/app.json`, then run:

```bash
cd apps/anywhere-mobile
npm install
npx eas build --profile android-internal --platform android
npx eas build --profile ios-internal --platform ios
```

Install the Android APK or iOS internal/TestFlight build. The app stores the paired device credential only in Android Keystore/iOS Keychain through `expo-secure-store`.

## 7. Pair and use Pimo

Start an interactive Pi TUI session. The Pi extension automatically registers with Pimo Companion. Then run:

```text
/reload
/Pimo
```

Open the pairing QR in Pimo Companion and scan it from the Pimo mobile app. Pairing is computer-wide rather than session-specific and survives restarts until explicitly revoked.

Commands:

- `/Pimo` or `/Pimo start` — connect or reconnect this Pi session.
- `/Pimo status` — show this Pi instance's connection state.
- `/Pimo pair` — direct you to the one-time QR in Pimo Companion.
- `/Pimo off` — revoke the phone, disable external access, and remove only the Serve route owned by this companion.

`/Anywhere` remains a legacy alias for compatibility.

The app lists all active interactive TUI Pi sessions, loads bounded current-branch user/assistant history, shows redacted live activity, sends messages, and answers questions or specialist approvals. The first valid terminal or app answer wins.

## 8. Use the visual planner

The browser assets were built in step 2. Start an interactive Pi session in any project, then run:

```text
/reload
/canvas
```

The board is saved in that project under `.pi/visual-planner/`. Pi can stage changes, but they remain unapplied until accepted in the browser. Use `/canvas status` to see the board path and `/canvas off` to stop its loopback server.

## 9. Validate the installation

```bash
cd ~/.pi/agent
npm run typecheck
npm test
npm run planner:build
npm run companion:build
npm run mobile:typecheck
```

Rust checks require Cargo and are run from the companion directory:

```bash
cd apps/anywhere-companion/src-tauri
cargo test
cargo check
```

Run `/reload` after changing the harness extensions or installing a new pinned Pi package.

## 10. Project instructions and optional data

Project-specific files remain with each project repository:

- `AGENTS.md` or `CLAUDE.md`
- `.pi/settings.json`
- `.pi/extensions/`, `.pi/skills/`, `.pi/prompts/`, `.pi/themes/`
- `.agents/skills/`

Do not copy these machine-specific or sensitive paths into Git:

- `auth.json`, provider keys, and push/signing credentials
- `sessions/`, `trust.json`, model caches, MCP state, and run history
- `npm/`, `git/`, and `node_modules/`
- Expo/Tauri generated output and installers
