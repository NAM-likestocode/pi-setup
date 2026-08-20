# Pimo / Anywhere protocol v2

This package is Pimo's compatibility-preserved contract between the Tauri companion, interactive Pi extensions, and the Expo app. Wire identifiers retain the Anywhere name so installed clients continue to pair and upgrade safely.

## Trust boundaries

- Mobile HTTP JSON and internal WebSocket frames are untrusted until runtime validation succeeds.
- Pairing and device bearer tokens are never part of push payloads or logs.
- Pairing bootstrap tokens are carried only in the URI fragment and are consumed once.
- The public API is served through Tailscale HTTPS; the companion's listeners remain loopback-only.

## Versions and channels

`ANYWHERE_PROTOCOL_VERSION` is `2`. Version 1 is intentionally rejected; clients must not silently downgrade.

In-process prompt channels:

- `anywhere:prompt:v2:open`
- `anywhere:prompt:v2:close`
- `anywhere:prompt:v2:probe`

## Pairing URI

```text
pi-anywhere://pair?v=2&host=<host-id>&base=<https-base-url>#<one-time-token>
```

The token after `#` is not sent in the initial navigation request. It expires after ten minutes and is consumed by `POST /api/v2/pair`.

## Public endpoints

All endpoints require protocol version 2. Except `POST /api/v2/pair`, they require the paired device bearer token.

- `POST /api/v2/pair`
- `GET /api/v2/bootstrap`
- `GET /api/v2/instances`
- `GET /api/v2/instances/:id/history`
- `GET /api/v2/instances/:id/state`
- `POST /api/v2/instances/:id/messages`
- `POST /api/v2/instances/:id/prompts/:promptId/answer`
- `PUT /api/v2/device/push-token`
- `DELETE /api/v2/device`

## Internal acknowledgements

The companion forwards `message`, `prompt_answer`, and `command` frames to a registered Pi instance. The instance returns `message_ack`, `prompt_answer_ack`, or `command_result` with the request ID. A prompt answer that loses the settlement race returns `already_settled`.

## Limits

- Request body: 16 KiB.
- Messages and comments: 12,000 characters.
- History page: 1–100 items, default 50.
- Live event ring: 500 events per instance.
- Pairing lifetime: 10 minutes for the bootstrap token; device lifetime is persistent until revocation.
