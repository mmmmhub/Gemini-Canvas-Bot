---
name: Canvas App Architecture
description: How the Gemini Canvas full-stack web app is structured and why it deviates from the react-vite scaffold.
---

The canvas-app artifact was bootstrapped with `createArtifact('react-vite', ...)` (only available type for a proxied web artifact), then completely replaced with a plain Node.js/Express app.

**Key facts:**
- Entry point: `artifacts/canvas-app/server.js` (CommonJS, no build step)
- `package.json` has no `"type"` field (defaults to CommonJS)
- `dev` script is `node server.js` — NOT Vite
- Static files served from `artifacts/canvas-app/public/`
- Generated images saved to `artifacts/canvas-app/public/generated/<ticketId>.png`
- Port: 18724 (injected by artifact workflow as `$PORT`)
- Prefix: `/canvas-app/` (injected as `$BASE_PATH`)

**Why:** `createArtifact` doesn't support a plain Node.js type, but `react-vite` creates the artifact registration + proxy routing. The Vite scaffold files (src/, vite.config.ts, tsconfig.json) can be safely ignored — the server only uses `server.js` and `public/`.

**Concurrent queue:** Custom `ConcurrentQueue` class in `server.js` — 3 parallel slots, no external dep. ONE shared browser launched at startup; each job opens its own `BrowserContext` and closes it on finish.

**API surface:**
- `POST /canvas-app/api/generate` → `{ ticketId, status, position }`
- `GET  /canvas-app/api/status/:ticketId` → ticket object
- `GET  /canvas-app/api/health` → browser/queue stats

**Why:** Using the existing api-server was considered but rejected — it's TypeScript ESM with a build step, and the automation code is CJS JS. A standalone Express server is simpler and self-contained.
