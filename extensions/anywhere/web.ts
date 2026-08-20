export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Pimo</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <main>
    <p class="eyebrow">PIMO PRIVATE LINK</p>
    <h1>Use the private mobile app</h1>
    <p>This address belongs to Pimo Companion. Open Pimo on your phone and scan the QR code shown in the desktop app.</p>
    <p class="muted">The legacy browser chat is not available. Pi data stays on the private Tailscale network.</p>
  </main>
</body>
</html>`;

export const PAGE_CSS = `:root { color-scheme: dark; font-family: system-ui, sans-serif; color: #edf1ff; background: #0b1020; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top, #1d2d59, #0b1020 32rem); }
main { width: min(32rem, calc(100% - 2rem)); padding: 1.5rem; border: 1px solid #2d416d; border-radius: 16px; background: #141d34; line-height: 1.6; }
.eyebrow { color: #73a5ff; font-size: .75rem; font-weight: 800; letter-spacing: .16em; }
.muted { color: #9daaca; }
`;

export const PAGE_JS = "";
