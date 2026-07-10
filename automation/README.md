# Gemini Canvas Automation

A Playwright-based Node.js script that automates the **Gemini Canvas** shared-link UI.

> **Important:** This targets the Canvas preview URL (a sandboxed React app rendered inside an iframe), **not** the standard Gemini chat interface.

---

## Quick Start

### 1 — Install dependencies

```bash
cd automation
npm install
```

Playwright will download the Chromium headless shell automatically during the first run (or run `npm run install-browsers` explicitly).

---

### 2 — Provide authentication cookies

The Canvas URL requires a logged-in Google session. Export your cookies using one of two methods:

#### Method A — `cookies.json` (recommended)

1. In Chrome, open DevTools → Application → Cookies → `google.com`
2. Copy the key session cookies (`__Secure-1PSID`, `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PAPISID`)
3. Copy `cookies.example.json` → `cookies.json` and fill in the values

> 🔐 `cookies.json` is in `.gitignore` and will never be committed.

#### Method B — Raw cookie string in `.env`

1. In DevTools → Network, copy the `Cookie:` header value from any request to `google.com`
2. Set it as `COOKIE_STRING=...` in your `.env` file

---

### 3 — Configure the run

Copy `.env.example` → `.env` and edit:

| Variable | Default | Description |
|---|---|---|
| `TARGET_URL` | Gemini Canvas link | The shared Canvas URL |
| `IMAGE_PATH` | `./input.jpg` | Source image to upload |
| `PROMPT` | (english example) | Generation prompt |
| `OUTPUT_COUNT` | `1` | Number of output images |
| `OUTPUT_DIR` | `./output` | Where to save results |
| `HEADLESS` | `true` | Set `false` to watch the browser |
| `PROCESS_TIMEOUT_MS` | `120000` | Max wait for completion (ms) |

---

### 4 — Place your input image

Put the image you want to process at `automation/input.jpg` (or change `IMAGE_PATH`).

---

### 5 — Run

```bash
cd automation
node index.js
```

Results are saved to `automation/output/result_<timestamp>_1.png`.

---

## How it works

1. **Launches Chromium headlessly** (no visible window by default)
2. **Injects your Google session cookies** into the browser context
3. **Navigates** to the Gemini Canvas URL and waits for full load
4. **Finds the sandboxed iframe** that hosts the React canvas app
5. **Uploads the image** directly to the hidden `<input type="file">` (bypasses the iframe sandbox that blocks file-chooser dialogs)
6. **Fills in the prompt** and sets the output count
7. **Clicks "بدء التحويل"** (Start Processing)
8. **Polls for the "تحميل" (Download) button** to appear
9. **Extracts the `data:` URL** from the download link's `href`
10. **Saves the image** to disk using Node.js `fs` (no browser download dialogs needed)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Image file not found` | Set `IMAGE_PATH` in `.env` to the absolute path of your source image |
| Page loads but iframe not found | The Canvas may have changed its structure; try `HEADLESS=false` to watch what happens |
| Timed out waiting for download | Increase `PROCESS_TIMEOUT_MS`; the model may be slow on some prompts |
| Authentication errors / redirect to login | Your session cookies have expired; re-export them from a browser |
| `ENOENT: chromium` | Run `npm run install-browsers` once before the first run |

---

## Replit — System Libraries (replit.nix)

If you see errors like `error while loading shared libraries: libnss3.so`, your Replit environment needs Chromium's system dependencies. Add the following to your `replit.nix`:

```nix
{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.chromium
    pkgs.playwright-driver
    pkgs.nss
    pkgs.nspr
    pkgs.atk
    pkgs.at-spi2-atk
    pkgs.at-spi2-core
    pkgs.gtk3
    pkgs.glib
    pkgs.mesa
    pkgs.libdrm
    pkgs.libGL
    pkgs.vulkan-loader
    pkgs.libgbm
    pkgs.xorg.libX11
    pkgs.xorg.libxcb
    pkgs.xorg.libXcomposite
    pkgs.xorg.libXcursor
    pkgs.xorg.libXdamage
    pkgs.xorg.libXext
    pkgs.xorg.libXfixes
    pkgs.xorg.libXi
    pkgs.xorg.libXrandr
    pkgs.xorg.libXrender
    pkgs.xorg.libXtst
    pkgs.fontconfig
    pkgs.freetype
    pkgs.pango
    pkgs.cairo
    pkgs.harfbuzz
    pkgs.libjpeg
    pkgs.libpng
    pkgs.libwebp
    pkgs.openjpeg
    pkgs.alsa-lib
    pkgs.pulseaudio
    pkgs.dbus
    pkgs.expat
    pkgs.cups
    pkgs.libuuid
    pkgs.zlib
  ];

  env = {
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD    = "1";
    DISPLAY                             = ":99";
  };
}
```

---

## File structure

```
automation/
├── index.js                # Main automation script
├── package.json            # Dependencies
├── .env.example            # Configuration template
├── .env                    # Your local config (gitignored)
├── cookies.example.json    # Cookie format reference
├── cookies.json            # Your session cookies (gitignored)
├── input.jpg               # Source image to process (you provide this)
└── output/                 # Generated images are saved here
```
