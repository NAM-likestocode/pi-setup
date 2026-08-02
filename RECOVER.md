# Recover this Pi setup on a new system

This repository contains the tracked, safe-to-share part of the Pi setup. It intentionally does **not** contain credentials, conversation sessions, caches, installed package stores, or `node_modules`.

## 1. Install prerequisites

Install:

- Node.js and npm
- Git
- Bash on Windows (Git Bash is sufficient)
- Pi itself, using the normal Pi installation instructions

Do not copy the old Pi installation directory. Install Pi fresh on the new system.

## 2. Clone this repository into Pi's global configuration directory

Pi's default global configuration directory is `~/.pi/agent`.

In Git Bash or another bash shell:

```bash
# If Pi has already created this directory, move it aside first.
if [ -d "$HOME/.pi/agent" ]; then
  mv "$HOME/.pi/agent" "$HOME/.pi/agent.before-pi-setup"
fi

git clone https://github.com/NAM-likestocode/pi-setup.git "$HOME/.pi/agent"
cd "$HOME/.pi/agent"
```

On Windows this is normally:

```text
C:\Users\<your-user>\.pi\agent
```

If `PI_CODING_AGENT_DIR` is set, use that directory instead.

## 3. Restore the installed Pi packages

The package stores are intentionally not in Git. Install the pinned packages listed in `settings.json`:

```bash
pi install git:github.com/MasuRii/pi-image-tools@b8977bbb4f416fd63db7c7c602db6dfe7b17f62c
pi install git:github.com/edlsh/pi-ask-user@1ad2adf7010c4ac5068668b6999bc1eb98a864a7
pi install npm:context-mode@1.0.169
pi install npm:pi-web-access@0.15.0
pi install npm:pi-mcp-adapter@2.15.0
pi install npm:@narumitw/pi-lsp@0.39.0
pi install npm:@braintrust/pi-extension@0.10.0
```

If the package list in `settings.json` has changed, use that list as the source of truth.

To restore the harness development dependencies and run its checks:

```bash
npm install
npm run check
```

## 4. Set up Pi Anywhere (optional)

The `/Anywhere` extension is included in `extensions/anywhere/`. It provides a private phone UI for the active Pi session through Tailscale.

On both the Pi computer and the phone:

1. Install Tailscale.
2. Sign in to the same tailnet.
3. Make sure the Pi computer is connected and has a MagicDNS name.
4. Enable MagicDNS and the tailnet's permission for Tailscale Serve/HTTPS. If approval is required, `/Anywhere` will show an approval link. Do not configure a different Serve route on this device first; Anywhere expects its Serve configuration to be empty.

Check the connection from the Pi shell:

```bash
tailscale status
tailscale status --json
```

The Pi session must be interactive TUI mode; `/Anywhere` does not start from print or RPC mode. The extension binds locally to `127.0.0.1` and uses Tailscale Serve on HTTPS port 443. It refuses to overwrite an existing Tailscale Serve configuration.

The `pi-ask-user` package needs the included compatibility patch so remote questions can be answered from the phone. Apply it after installing the pinned package, only if `/Anywhere` reports that the transport hook is missing:

```bash
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
cd "$PI_AGENT_DIR/git/github.com/edlsh/pi-ask-user"
git apply --check "$PI_AGENT_DIR/extensions/anywhere/pi-ask-user-anywhere.patch"
git apply "$PI_AGENT_DIR/extensions/anywhere/pi-ask-user-anywhere.patch"
```

If the check says the patch is already applied, skip both commands. Run `/reload` after applying it.

Start and pair it:

```text
/reload
/Anywhere
```

Open the one-time pairing link shown in Pi on a Tailscale-connected phone. The phone has the same authority as the local Pi user, so treat the paired phone as a high-privilege device. Use these commands when needed:

```text
/Anywhere status
/Anywhere pair
/Anywhere off
```

Read [`extensions/anywhere/README.md`](extensions/anywhere/README.md) for the complete behavior, security model, pairing details, troubleshooting, and patch notes.

## 5. Authenticate again

Credentials are deliberately not stored in this repository. Start Pi and authenticate again:

```text
/login
```

Also recreate any provider API-key environment variables you used on the old system. Never commit `auth.json` or API keys.

## 6. Restore project instructions

This repository restores the global harness, including its extensions, custom agent Markdown files, themes, settings, keybindings, scripts, patches, and tests.

For each project, also move its own files with the project repository:

- `AGENTS.md` or `CLAUDE.md`
- `.pi/settings.json`
- `.pi/extensions/`
- `.pi/skills/`
- `.pi/prompts/`
- `.pi/themes/`
- `.agents/skills/`

Trust projects again on the new machine with `/trust` or start Pi once with `--approve`.

## 7. Optional data

The following are intentionally excluded:

- `auth.json` — credentials and OAuth tokens
- `sessions/` — conversation history, tied to the original project paths
- `trust.json` — machine-specific absolute paths
- `npm/`, `git/`, and `node_modules/` — reinstallable dependencies
- `models-store.json`, `mcp-cache.json`, and run history — generated caches/state
- `~/.pi/context-mode/` — separate context-mode indexes and session data

If old conversations are needed, copy the session files separately and open one with `pi --session <path>`. If project paths changed, `/resume` may not list them automatically.

After restoring everything, start Pi and run `/reload` so it reloads the copied settings, extensions, agents, themes, and packages.
