# Pi Visual Planner

The visual planner is a project-local browser canvas that accompanies the normal Pi terminal session. It is loaded globally, but each project keeps its own board.

## Use

1. Run `/canvas` in an interactive Pi session.
2. Add, edit, connect, and arrange cards in the browser.
3. Ask Pi to read the visual planner and suggest changes.
4. Review each Pi proposal in the browser, then accept or reject the full batch.
5. Run `/canvas off` to stop the local server.

Commands:

- `/canvas` or `/canvas open` — start the loopback server and open the board.
- `/canvas status` — show the server state and board path.
- `/canvas off` — stop the server and disable the planner tools.

The browser build must exist before `/canvas` can open:

```bash
cd ~/.pi/agent
npm run planner:build
```

## Storage

The canonical project file is:

```text
<project>/.pi/visual-planner/board.json
```

A readable summary is regenerated alongside it as `board.md`. The JSON file contains stable node and edge ids, positions, the board revision, and the proposal review history. Writes use Pi's shared file-mutation queue and atomic replacement.

## Pi tools and review boundary

The tools become active only while `/canvas` is open:

- `visual_planner_read` reads the current board and revision.
- `visual_planner_propose` validates and stages a batch against that exact revision.

A Pi proposal never changes the nodes or edges directly. Only the browser's **Accept batch** action applies it. Any human board edit makes older pending proposals stale so an outdated preview cannot be accepted accidentally. These two tools are allowed by detailed plan mode because one is read-only and the other only creates a reviewable proposal.

## Security

- The HTTP and WebSocket server binds only to `127.0.0.1` on a random port.
- Each launch creates a 256-bit token. The initial URL exchanges it for an `HttpOnly`, `SameSite=Strict` cookie.
- WebSocket upgrades require the cookie, exact loopback host, and exact same-origin header.
- Request and message sizes are bounded, static paths are contained under the built app directory, and restrictive browser security headers are set.
- The browser API can modify only the current project's fixed planner file. It exposes no shell, arbitrary path, Pi conversation, or remote network listener.
- The server stops on `/canvas off`, reload, session replacement, or Pi shutdown.

## Development and validation

The React/React Flow app lives in `apps/visual-planner/`; the Pi extension and store live in this directory.

```bash
npm run typecheck
npm test
npm run planner:build
```
