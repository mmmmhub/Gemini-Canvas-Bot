---
name: Chromium Path
description: Which Chromium executable works in this Replit environment and why.
---

**Working path:** `/nix/store/gasnw5878924jbw6bql257ll29hkm4fd-chromium-123.0.6312.105/bin/chromium`

**Why it works:** This is a Nix-store wrapper that has all required shared libraries (libglib-2.0, etc.) baked in via Nix's closure system.

**What fails:** The Playwright-downloaded headless Chromium shell at `.cache/ms-playwright/chromium_headless_shell-1228/...` throws `libglib-2.0.so.0: cannot open shared object file` because the Nix environment doesn't have those libs on the system LD path.

**How to apply:** Always pass `executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined` so it falls back to Playwright's auto-detection if the Nix path ever changes.

**If path changes:** Run `find /nix/store -name chromium -type f 2>/dev/null | head -5` to find the new path.
