# Pi Anywhere

`/Anywhere` creates an authenticated phone UI for the **current main Pi session** over your private Tailscale network.

## Prerequisites and setup

- Install Tailscale on the Pi computer and the phone you will use.
- Sign both devices into the same tailnet.
- Enable MagicDNS and the tailnet's permission for Tailscale Serve/HTTPS. If Serve approval is still required, `/Anywhere` displays the approval link. Do not configure a different Serve route on this device first; Anywhere expects its Serve configuration to be empty.
- Make sure Tailscale is connected before starting Pi. `tailscale status` should work, and the device must have a MagicDNS name.
- Install the pinned `pi-ask-user` package from `settings.json`. This setup includes a compatibility patch at [`pi-ask-user-anywhere.patch`](./pi-ask-user-anywhere.patch). Apply it only if `/Anywhere` reports that the Anywhere transport hook is missing; see the compatibility section below.

Anywhere starts its local HTTP server on an ephemeral `127.0.0.1` port and asks Tailscale to expose it privately as HTTPS on port 443. It refuses to overwrite an existing Tailscale Serve configuration, so resolve or remove another Serve configuration first if startup reports that one already exists.

## Use

1. Run `/reload` after installing or updating the extension and after applying the compatibility patch.
2. In an interactive Pi session, run `/Anywhere`.
3. Open the one-time pairing link shown above the editor on your Tailscale-connected phone.
4. Use the page to chat with Pi or answer its `ask_user` questions.
5. Run `/Anywhere off` to revoke the device and remove the Tailscale Serve route.

Commands:

- `/Anywhere` or `/Anywhere start` — start private HTTPS access and show a pairing link.
- `/Anywhere status` — show whether it is active and paired.
- `/Anywhere pair` — revoke the current device and make a new one-time pairing link.
- `/Anywhere off` — revoke access and remove Anywhere's HTTPS route, even if another Pi instance started it.

## What it does

- Keeps the app server bound to `127.0.0.1`.
- Uses Tailscale Serve to expose it as HTTPS only to devices in your tailnet; there is no public Cloudflare tunnel.
- Uses a 256-bit one-time pairing secret in the URL fragment, so it is not sent in the initial HTTP request.
- Stores the paired browser's device token in local browser storage, so closing/reopening the browser does not require pairing again while Anywhere is running.
- Keeps one active paired device. Pairing a replacement requires an explicit `/Anywhere pair` command at the Pi terminal.
- Sends phone text through `pi.sendUserMessage()` to the active main session. Busy sessions default to a follow-up queue instead of interruption.
- Provides **All**, **Chat**, and **Commands & edits** timeline filters so active work is easy to inspect on a small screen.
- Mirrors user/assistant text created after activation plus a dedicated activity timeline for commands, tools, edited paths, and expandable change previews. Raw tool output and the pre-existing transcript are not mirrored.
- Redacts common secret-shaped command arguments and hides change previews for `.env`, credential JSON, private keys, and certificate files.
- Uses the cooperative `pi-ask-user` hook to bind a remote answer to its exact pending question/tool call.
- Works with the `project-subagents` addon: approvals can be answered from the paired phone, and nested subagent commands/edits appear with the agent name.

## Security model

The paired phone has the same conversational authority as the local Pi user and can see command/edit activity emitted after activation. Treat it as a high-privilege device. Redaction is defense-in-depth, not a guarantee that every possible secret format will be recognized.

Defense layers:

- Tailscale membership and WireGuard encryption restrict network access to your tailnet.
- Tailscale Serve provides HTTPS with your tailnet MagicDNS hostname.
- Cross-instance shutdown removes only Anywhere's HTTPS port 443 handler; it does not reset unrelated Tailscale Serve routes on other ports.
- A per-session, one-time 256-bit pairing secret and a distinct remembered device token protect the application itself.
- The server uses constant-time token comparison, one-device pairing, immediate revocation, request-size limits, separate read/write rate limits, strict Host/Origin checks, and no cookies.
- The page uses `no-store`, CSP, no-referrer, frame-denial, no third-party resources, and text-only DOM rendering.

Do not forward a pairing link, leave the paired browser unlocked, or leave Anywhere running when you do not need it.

## `pi-ask-user` compatibility

This installation includes a small cooperative change in the installed `pi-ask-user` package. The exact patch is saved as [`pi-ask-user-anywhere.patch`](./pi-ask-user-anywhere.patch). It is designed for `pi-ask-user` v0.13.0. Package updates can overwrite the hook; if `/Anywhere` reports that the hook is missing, reapply the patch from the installed `pi-ask-user` package directory and reload Pi.

From Git Bash, after replacing `PI_AGENT_DIR` if you use a custom `PI_CODING_AGENT_DIR`:

```bash
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
cd "$PI_AGENT_DIR/git/github.com/edlsh/pi-ask-user"
git apply --check "$PI_AGENT_DIR/extensions/anywhere/pi-ask-user-anywhere.patch"
git apply "$PI_AGENT_DIR/extensions/anywhere/pi-ask-user-anywhere.patch"
```

Only apply it when the hook is missing. If `git apply --check` says the patch is already applied, skip both commands and run `/reload`.

The regular terminal `ask_user` UI remains unchanged whenever Anywhere is off.
