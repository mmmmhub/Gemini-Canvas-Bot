---
name: Cookie Normalisation
description: How to handle non-standard sameSite values in cookies.json before Playwright injection.
---

Google session cookies exported from browser extensions use non-standard `sameSite` values that Playwright rejects:

| cookies.json value | Playwright-valid mapping |
|--------------------|--------------------------|
| `no_restriction`   | `None`                   |
| `unspecified`      | `Lax`                    |
| `lax`              | `Lax`                    |
| `strict`           | `Strict`                 |
| `none`             | `None`                   |

**Function to apply:**
```js
function normaliseSameSite(raw) {
  if (!raw) return 'Lax';
  const v = String(raw).toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax') return 'Lax';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return 'Lax'; // 'unspecified' and anything else
}
```

Also: `expirationDate` (Chrome extension format) must be mapped to `expires` for Playwright.

**Cookie file location:** `cookies.json` at the workspace root (`/workspace/cookies.json`). Path from `artifacts/canvas-app/server.js`: `path.join(__dirname, '..', '..', 'cookies.json')`.
