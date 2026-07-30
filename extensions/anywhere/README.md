# Pi Anywhere

`/Anywhere` creates an authenticated phone UI for the **current main Pi session** over your private Tailscale network.

## Use

1. Enable **Tailscale Serve** for your tailnet (required once; `/Anywhere` displays an approval link if it is disabled).
2. Run `/reload` after installing/updating the extension.
3. In an interactive Pi session, run `/Anywhere`.
4. Open the one-time pairing link shown above the editor on your Tailscale-connected phone.
5. Use the page to chat with Pi or answer its `ask_user` questions.
6. Run `/Anywhere off` to revoke the device and remove the Tailscale Serve route.

Commands:

- `/Anywhere` or `/Anywhere start` — start private HTTPS access and show a pairing link.
- `/Anywhere status` — show whether it is active and paired.
- `/Anywhere pair` — revoke the current device and make a new one-time pairing link.
- `/Anywhere off` — revoke access and remove the private route.

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
- A per-session, one-time 256-bit pairing secret and a distinct remembered device token protect the application itself.
- The server uses constant-time token comparison, one-device pairing, immediate revocation, request-size limits, separate read/write rate limits, strict Host/Origin checks, and no cookies.
- The page uses `no-store`, CSP, no-referrer, frame-denial, no third-party resources, and text-only DOM rendering.

Do not forward a pairing link, leave the paired browser unlocked, or leave Anywhere running when you do not need it.

## `pi-ask-user` compatibility

This installation includes a small cooperative change in the installed `pi-ask-user` package. The exact patch is saved as [`pi-ask-user-anywhere.patch`](./pi-ask-user-anywhere.patch). It is designed for `pi-ask-user` v0.13.0. Package updates can overwrite the hook; if `/Anywhere` reports that the hook is missing, reapply the patch from the `pi-ask-user` package directory and reload Pi:

```powershell
git apply C:\Users\Fool\.pi\agent\extensions\anywhere\pi-ask-user-anywhere.patch
```

The regular terminal `ask_user` UI remains unchanged whenever Anywhere is off.
