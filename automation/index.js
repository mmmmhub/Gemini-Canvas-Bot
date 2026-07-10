/**
 * Gemini Canvas Automation Script
 * ─────────────────────────────────────────────────────────────────────────────
 * Automates the Gemini Canvas shared-link UI (NOT the standard Gemini chat).
 * The canvas renders a React app inside a sandboxed iframe; all interactions
 * happen inside that iframe context.
 *
 * Usage:
 *   1. Copy .env.example → .env  and fill in your values
 *   2. Export your Google cookies to cookies.json  (see cookies.example.json)
 *   3. Place your source image at the path set in IMAGE_PATH (default ./input.jpg)
 *   4. cd automation && node index.js
 *
 * Environment variables (all optional – sensible defaults provided):
 *   TARGET_URL          Gemini Canvas shared URL
 *   IMAGE_PATH          Path to the image to upload
 *   PROMPT              Generation prompt text (Arabic or any language)
 *   OUTPUT_COUNT        Number of output images (numeric, default 1)
 *   OUTPUT_DIR          Directory to write result images (default ./output)
 *   COOKIE_STRING       Raw Cookie: header string (alternative to cookies.json)
 *   HEADLESS            "false" to show the browser window
 *   PROCESS_TIMEOUT_MS  Max ms to wait for the download button (default 120000)
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Load .env if present ────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  // Try parent directory .env as fallback
  const parentEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(parentEnv)) require('dotenv').config({ path: parentEnv });
}

// ── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  targetUrl:      process.env.TARGET_URL          || 'https://share.gemini.google/EIt5nvt7wCXV',
  imagePath:      process.env.IMAGE_PATH          || path.join(__dirname, 'input.jpg'),
  prompt:         process.env.PROMPT              || 'A beautiful sunset over the mountains',
  outputCount:    parseInt(process.env.OUTPUT_COUNT || '1', 10),
  outputDir:      process.env.OUTPUT_DIR          || path.join(__dirname, 'output'),
  headless:       process.env.HEADLESS            !== 'false',
  timeoutMs:      parseInt(process.env.PROCESS_TIMEOUT_MS || '120000', 10),
  cookieString:   process.env.COOKIE_STRING       || '',
};

// ── Chromium executable path ────────────────────────────────────────────────
// Prefer the downloaded Playwright headless shell; fall back to system Chromium.
const POSSIBLE_CHROME_PATHS = [
  // Playwright headless-shell downloaded by `npx playwright install chromium`
  path.join(__dirname, '..', '.cache', 'ms-playwright', 'chromium_headless_shell-1228',
            'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  path.join(process.env.HOME || '/root', '.cache', 'ms-playwright',
            'chromium_headless_shell-1228', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  // System Chromium installed via Nix
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/run/current-system/sw/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

function resolveChromiumPath() {
  for (const p of POSSIBLE_CHROME_PATHS) {
    if (fs.existsSync(p)) {
      console.log(`[browser] Using Chromium at: ${p}`);
      return p;
    }
  }
  console.log('[browser] No explicit Chromium path found – letting Playwright auto-detect.');
  return undefined;
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

/**
 * Load cookies from cookies.json if it exists.
 * Returns an array of Playwright-compatible cookie objects.
 */
function loadCookiesFromFile() {
  const cookiesFile = path.join(__dirname, 'cookies.json');
  if (!fs.existsSync(cookiesFile)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
    console.log(`[auth] Loaded ${raw.length} cookies from cookies.json`);
    return raw.map(normaliseCookie);
  } catch (err) {
    console.warn(`[auth] Could not parse cookies.json: ${err.message}`);
    return [];
  }
}

/**
 * Parse a raw "Cookie: …" header string into Playwright cookie objects.
 * Each pair is assumed to belong to .google.com.
 */
function parseCookieString(raw) {
  if (!raw || !raw.trim()) return [];

  const cookies = raw.split(';').map(part => {
    const [name, ...rest] = part.trim().split('=');
    return {
      name:     name.trim(),
      value:    rest.join('=').trim(),
      domain:   '.google.com',
      path:     '/',
      httpOnly: false,
      secure:   true,
      sameSite: 'None',
    };
  }).filter(c => c.name && c.value);

  console.log(`[auth] Parsed ${cookies.length} cookies from COOKIE_STRING env var`);
  return cookies;
}

/** Ensure a cookie object has all fields Playwright requires. */
function normaliseCookie(c) {
  return {
    name:     c.name,
    value:    c.value,
    domain:   c.domain   || '.google.com',
    path:     c.path     || '/',
    expires:  c.expires  || -1,
    httpOnly: c.httpOnly ?? false,
    secure:   c.secure   ?? true,
    sameSite: c.sameSite || 'None',
  };
}

// ── Output directory ────────────────────────────────────────────────────────
function ensureOutputDir() {
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    console.log(`[output] Created output directory: ${CONFIG.outputDir}`);
  }
}

// ── Save a base64 data URL to disk ──────────────────────────────────────────
function saveDataUrl(dataUrl, index) {
  // dataUrl format: "data:<mimeType>;base64,<data>"
  const [header, base64Data] = dataUrl.split(',');
  if (!base64Data) throw new Error('Invalid data URL: no base64 payload found.');

  const mimeMatch = header.match(/data:([^;]+)/);
  const mimeType  = mimeMatch ? mimeMatch[1] : 'image/png';
  const ext       = mimeType.split('/')[1]?.replace(/\+.*$/, '') || 'png';

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename  = `result_${timestamp}_${index + 1}.${ext}`;
  const filepath  = path.join(CONFIG.outputDir, filename);

  fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
  console.log(`[output] ✅ Saved: ${filepath}  (${Math.round(base64Data.length * 0.75 / 1024)} KB)`);
  return filepath;
}

// ── Main automation ─────────────────────────────────────────────────────────
async function run() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  Gemini Canvas Automation');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Target URL    : ${CONFIG.targetUrl}`);
  console.log(`  Image path    : ${CONFIG.imagePath}`);
  console.log(`  Prompt        : ${CONFIG.prompt}`);
  console.log(`  Output count  : ${CONFIG.outputCount}`);
  console.log(`  Output dir    : ${CONFIG.outputDir}`);
  console.log(`  Headless      : ${CONFIG.headless}`);
  console.log(`  Timeout       : ${CONFIG.timeoutMs} ms`);
  console.log('══════════════════════════════════════════════════════════\n');

  // Validate image exists before launching the browser
  if (!fs.existsSync(CONFIG.imagePath)) {
    console.error(`[error] Image file not found: ${CONFIG.imagePath}`);
    console.error('        Set IMAGE_PATH in .env or place "input.jpg" next to this script.');
    process.exit(1);
  }

  ensureOutputDir();

  // ── Resolve cookies ───────────────────────────────────────────────────────
  const cookiesFromFile   = loadCookiesFromFile();
  const cookiesFromString = parseCookieString(CONFIG.cookieString);
  // File cookies take precedence; env string cookies fill any gaps
  const allCookies = cookiesFromFile.length > 0 ? cookiesFromFile : cookiesFromString;

  if (allCookies.length === 0) {
    console.warn('[auth] ⚠️  No cookies provided. The page may require authentication.');
    console.warn('           Copy cookies.example.json → cookies.json and fill in your values.');
  }

  // ── Launch browser ────────────────────────────────────────────────────────
  const executablePath = resolveChromiumPath();

  const browser = await chromium.launch({
    headless:       CONFIG.headless,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--no-first-run',
      '--no-zygote',
      '--single-process',             // helps in resource-constrained envs
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',       // needed to access iframe from blob URLs
      '--allow-running-insecure-content',
    ],
  });

  const context = await browser.newContext({
    viewport:          { width: 1280, height: 900 },
    userAgent:         'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                     + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:            'ar-SA',
    timezoneId:        'Asia/Riyadh',
    acceptDownloads:   false,         // we extract data URLs ourselves
    bypassCSP:         true,          // bypass Content-Security-Policy in iframe
    ignoreHTTPSErrors: true,
  });

  // Inject cookies before any navigation
  if (allCookies.length > 0) {
    await context.addCookies(allCookies);
    console.log(`[auth] Injected ${allCookies.length} cookies into browser context.`);
  }

  const page = await context.newPage();

  // Forward browser console messages for debugging
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) {
      console.log(`[browser ${msg.type()}] ${msg.text()}`);
    }
  });

  try {
    // ── Step 1: Navigate to the target URL ─────────────────────────────────
    console.log('\n[step 1] Navigating to target URL…');
    await page.goto(CONFIG.targetUrl, {
      waitUntil: 'networkidle',
      timeout:   60_000,
    });
    console.log('[step 1] Page loaded. Title:', await page.title());

    // Short pause to allow React hydration inside the canvas iframe
    await page.waitForTimeout(3000);

    // ── Step 2: Locate the canvas iframe ──────────────────────────────────
    console.log('\n[step 2] Locating canvas iframe…');
    const iframeHandle = await findCanvasIframe(page);
    if (!iframeHandle) {
      throw new Error(
        'Could not locate the canvas iframe. ' +
        'Check that the URL is valid and authentication cookies are correct.'
      );
    }
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('Could not obtain a Frame reference from the iframe element.');
    console.log('[step 2] ✅ Canvas iframe found. URL:', frame.url());

    // Extra wait for the React app to fully mount
    await frame.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // ── Step 3: Upload image via hidden file input ─────────────────────────
    console.log('\n[step 3] Uploading image via hidden file input…');
    await uploadImageViaHiddenInput(frame, CONFIG.imagePath);
    console.log('[step 3] ✅ Image upload dispatched.');

    // ── Step 4: Fill in the prompt ────────────────────────────────────────
    console.log('\n[step 4] Filling in the prompt…');
    await fillPrompt(frame, CONFIG.prompt);
    console.log('[step 4] ✅ Prompt entered.');

    // ── Step 5: Set output count ──────────────────────────────────────────
    console.log('\n[step 5] Setting output image count to', CONFIG.outputCount);
    await setOutputCount(frame, CONFIG.outputCount);
    console.log('[step 5] ✅ Output count set.');

    // ── Step 6: Click "بدء التحويل" (Start Processing) ───────────────────
    console.log('\n[step 6] Clicking "بدء التحويل"…');
    await clickStartButton(frame);
    console.log('[step 6] ✅ Processing started.');

    // ── Step 7: Wait for completion and the download button ───────────────
    console.log(`\n[step 7] Waiting for processing to complete (timeout: ${CONFIG.timeoutMs} ms)…`);
    await waitForDownloadButton(frame, CONFIG.timeoutMs);
    console.log('[step 7] ✅ Processing complete. Download button is visible.');

    // Short extra wait so all images are rendered
    await page.waitForTimeout(1500);

    // ── Step 8: Extract data URLs from download links ─────────────────────
    console.log('\n[step 8] Extracting result image data URLs…');
    const dataUrls = await extractDownloadDataUrls(frame);
    if (dataUrls.length === 0) {
      throw new Error('No data URLs found in download buttons. The app may have changed its structure.');
    }
    console.log(`[step 8] ✅ Found ${dataUrls.length} result image(s).`);

    // ── Step 9: Save images to disk ───────────────────────────────────────
    console.log('\n[step 9] Saving result images…');
    const savedPaths = [];
    for (let i = 0; i < dataUrls.length; i++) {
      const saved = saveDataUrl(dataUrls[i], i);
      savedPaths.push(saved);
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  ✅ Done! ${savedPaths.length} image(s) saved.`);
    savedPaths.forEach(p => console.log(`     ${p}`));
    console.log('══════════════════════════════════════════════════════════');

  } finally {
    await browser.close();
  }
}

// ── Helper functions ────────────────────────────────────────────────────────

/** Infer a MIME type from a file extension. */
function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.bmp':  'image/bmp',
    '.tiff': 'image/tiff',
    '.tif':  'image/tiff',
    '.svg':  'image/svg+xml',
    '.avif': 'image/avif',
  };
  return map[ext] || 'image/jpeg';
}

/**
 * Locate the canvas iframe with positive structural validation.
 *
 * Rather than picking the largest/first iframe blindly, we confirm the
 * selected frame actually hosts the canvas React app by checking for
 * structural markers (expected DOM elements) before returning it.
 *
 * Strategy:
 *  1. Collect all candidate iframes via ordered selectors.
 *  2. For each candidate, obtain its FrameContext and run a lightweight
 *     structural probe to confirm it is the canvas app.
 *  3. Return the first frame that passes validation.
 *  4. If none pass, fall back to the largest-by-area candidate and warn.
 */
async function findCanvasIframe(page) {
  // Ordered candidate selectors – most specific first
  const candidateSelectors = [
    'iframe[sandbox]',
    'iframe[src^="blob:"]',
    'iframe.canvas-iframe',
    'iframe[title*="canvas" i]',
    'iframe[title*="preview" i]',
    'iframe[title*="app" i]',
    'iframe',
  ];

  // DOM markers that indicate the canvas React app is rendered inside
  const appMarkers = [
    'input[type="file"]',         // file upload input
    'button',                     // any interactive button
    'textarea, input[type="text"], [contenteditable]', // prompt area
    '[class*="app" i], #root, #app, main', // typical React root containers
  ];

  // Collect all unique iframe handles (deduplicate across selectors)
  const seen    = new Set();
  const handles = [];

  for (const sel of candidateSelectors) {
    const els = await page.$(sel);
    for (const el of els) {
      const id = await el.evaluate(e => {
        // Use a composite key: src + className + approximate position
        const r = e.getBoundingClientRect();
        return `${e.src}|${e.className}|${Math.round(r.left)}|${Math.round(r.top)}`;
      }).catch(() => Math.random().toString());

      if (!seen.has(id)) {
        seen.add(id);
        handles.push(el);
      }
    }
  }

  if (handles.length === 0) {
    console.error('[iframe] No iframes found on the page at all.');
    return null;
  }

  console.log(`[iframe] Found ${handles.length} candidate iframe(s). Running structural validation…`);

  // Phase 1: structural validation
  for (const handle of handles) {
    const frame = await handle.contentFrame().catch(() => null);
    if (!frame) continue;

    // Wait briefly for the frame to finish loading
    await frame.waitForLoadState('domcontentloaded').catch(() => {});

    for (const marker of appMarkers) {
      try {
        const el = await frame.$(marker);
        if (el) {
          const box = await handle.boundingBox().catch(() => null);
          const area = box ? Math.round(box.width * box.height) : 0;
          console.log(
            `[iframe] ✅ Validated canvas iframe via marker "${marker}" ` +
            `(area: ${area}px², url: ${frame.url().slice(0, 80)})`
          );
          return handle;
        }
      } catch (_) { /* marker absent – try next */ }
    }
  }

  // Phase 2: fallback – largest visible iframe, with a clear warning
  console.warn(
    '[iframe] ⚠️  No iframe passed structural validation. ' +
    'Falling back to largest-by-area iframe — results may be unreliable.'
  );

  let best     = null;
  let bestArea = 0;

  for (const handle of handles) {
    const box = await handle.boundingBox().catch(() => null);
    if (!box) continue;
    const area = box.width * box.height;
    if (area > bestArea) {
      bestArea = area;
      best     = handle;
    }
  }

  if (best) {
    console.warn(`[iframe] Using fallback iframe (area: ${Math.round(bestArea)}px²). Inspect the page manually if things go wrong.`);
  }
  return best;
}

/**
 * Upload an image by targeting the hidden <input type="file"> element directly.
 * This bypasses the browser's native file-chooser dialog which sandboxed iframes block.
 */
async function uploadImageViaHiddenInput(frame, imagePath) {
  const absoluteImagePath = path.resolve(imagePath);

  // Try multiple selectors for the file input
  const fileInputSelectors = [
    'input[type="file"]',
    'input[accept*="image"]',
    'input[accept*="*"]',
  ];

  let fileInput = null;
  for (const sel of fileInputSelectors) {
    try {
      fileInput = await frame.$(sel);
      if (fileInput) {
        console.log(`[upload] Found file input with selector: ${sel}`);
        break;
      }
    } catch (_) { /* try next */ }
  }

  if (!fileInput) {
    // Last resort: inject the file directly via page.evaluate + DataTransfer.
    // This avoids the Playwright-specific setInputFiles API which requires an
    // ElementHandle (not a plain JSHandle from evaluateHandle).
    console.warn('[upload] Standard file input not found. Trying DataTransfer injection…');

    const fileBytes = fs.readFileSync(absoluteImagePath);
    const base64    = fileBytes.toString('base64');
    const mimeType  = guessMimeType(absoluteImagePath);
    const fileName  = path.basename(absoluteImagePath);

    const injected = await frame.evaluate(
      async ({ base64, mimeType, fileName }) => {
        // Locate file input anywhere in the DOM including shadow roots
        function findFileInput(root) {
          for (const el of root.querySelectorAll('input[type="file"]')) return el;
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
              const found = findFileInput(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }
        const input = findFileInput(document);
        if (!input) return false;

        // Reconstruct the File from base64 inside the page context
        const bytes   = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const file    = new File([bytes], fileName, { type: mimeType });
        const dt      = new DataTransfer();
        dt.items.add(file);
        Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        return true;
      },
      { base64, mimeType, fileName }
    );

    if (!injected) {
      throw new Error(
        'Could not find <input type="file"> in the canvas iframe (including shadow DOM). ' +
        'The app structure may have changed or the iframe is still loading.'
      );
    }

    console.log('[upload] File injected via DataTransfer (shadow DOM path).');
    await frame.waitForTimeout(1500);
    return; // done — skip the setInputFiles call below
  }

  // Use force: true to bypass visibility/enabled checks (the input is hidden by design)
  await fileInput.setInputFiles(absoluteImagePath, { force: true });

  // Wait a moment for the app to process the file selection event
  await frame.waitForTimeout(1500);
}

/**
 * Fill in the prompt text field.
 * Tries textarea first, then generic text inputs, then contenteditable divs.
 */
async function fillPrompt(frame, promptText) {
  const selectors = [
    'textarea',
    'input[type="text"]',
    'input[placeholder]',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '.prompt-input',
    '#prompt',
    '[name="prompt"]',
  ];

  for (const sel of selectors) {
    const el = await frame.$(sel);
    if (!el) continue;

    try {
      const tag = await el.evaluate(e => e.tagName.toLowerCase());
      const isContentEditable = await el.evaluate(e => e.isContentEditable);

      await el.click({ clickCount: 3 }); // select all existing text
      await el.press('Backspace');        // clear it

      if (isContentEditable || tag === 'div' || tag === 'span') {
        await el.evaluate((e, text) => { e.textContent = text; }, promptText);
        // Dispatch input event so React picks up the change
        await el.evaluate(e => e.dispatchEvent(new Event('input', { bubbles: true })));
      } else {
        await el.fill(promptText);
      }

      const value = await el.evaluate(e => e.value || e.textContent);
      if (value && value.trim().length > 0) {
        console.log(`[prompt] Entered prompt via selector: ${sel}`);
        return;
      }
    } catch (_) { /* try next */ }
  }

  throw new Error('Could not locate a prompt text field in the canvas iframe.');
}

/**
 * Set the "Output Images" numerical counter to the desired count.
 */
async function setOutputCount(frame, count) {
  // Look for a numeric input (often a spinner / stepper)
  const numericSelectors = [
    'input[type="number"]',
    'input[inputmode="numeric"]',
    'input[name*="count" i]',
    'input[name*="quantity" i]',
    'input[name*="output" i]',
    'input[placeholder*="عدد" i]',  // Arabic: "number"
    'input[aria-label*="output" i]',
  ];

  for (const sel of numericSelectors) {
    const el = await frame.$(sel);
    if (!el) continue;

    try {
      await el.click({ clickCount: 3 });
      await el.fill(String(count));
      await el.evaluate(e => e.dispatchEvent(new Event('input', { bubbles: true })));
      await el.evaluate(e => e.dispatchEvent(new Event('change', { bubbles: true })));
      console.log(`[count] Set output count via selector: ${sel}`);
      return;
    } catch (_) { /* try next */ }
  }

  // If no numeric input found, look for + / - stepper buttons and click + until target
  const plusSelectors = [
    'button[aria-label*="increase" i]',
    'button[aria-label*="زيادة" i]',   // Arabic: "increase"
    'button:has-text("+")',
    '[data-action="increment"]',
  ];
  for (const sel of plusSelectors) {
    const btn = await frame.$(sel);
    if (!btn) continue;

    // Read current value
    const currentInput = await frame.$('input[type="number"]');
    if (currentInput) {
      const current = parseInt(await currentInput.inputValue() || '1', 10);
      const clicks   = count - current;
      for (let i = 0; i < clicks; i++) await btn.click();
      console.log(`[count] Adjusted output count using stepper button (+${clicks} clicks).`);
      return;
    }
  }

  console.warn('[count] Could not find output count control – proceeding with default.');
}

/**
 * Locate and click the "بدء التحويل" (Start Processing) button.
 */
async function clickStartButton(frame) {
  // Try Arabic text first, then common button patterns
  const startSelectors = [
    // Arabic text buttons
    'button:has-text("بدء التحويل")',
    'button:has-text("بدء")',
    '[role="button"]:has-text("بدء التحويل")',
    // Generic "start / generate / submit" patterns as fallbacks
    'button[type="submit"]',
    'button:has-text("Generate")',
    'button:has-text("Start")',
    'button:has-text("Submit")',
    '.start-button',
    '#start',
    '[data-action="start"]',
  ];

  for (const sel of startSelectors) {
    try {
      const btn = await frame.$(sel);
      if (!btn) continue;

      const isDisabled = await btn.evaluate(el =>
        el.disabled || el.getAttribute('aria-disabled') === 'true'
      );
      if (isDisabled) {
        console.warn(`[start] Button "${sel}" is disabled – skipping.`);
        continue;
      }

      await btn.click();
      console.log(`[start] Clicked start button via selector: ${sel}`);
      return;
    } catch (_) { /* try next */ }
  }

  // Last resort: find ANY button that is not the image upload trigger
  const allButtons = await frame.$$('button:not([disabled])');
  console.warn(`[start] Specific start button not found. Searching ${allButtons.length} buttons by content…`);

  for (const btn of allButtons) {
    const text = await btn.evaluate(el => el.innerText?.trim() || '');
    if (text.includes('بدء') || text.toLowerCase().includes('start') ||
        text.toLowerCase().includes('generate') || text.toLowerCase().includes('convert')) {
      await btn.click();
      console.log(`[start] Clicked button with text: "${text}"`);
      return;
    }
  }

  throw new Error('Could not locate the "بدء التحويل" start button in the canvas iframe.');
}

/**
 * Wait until at least one "تحميل" (Download) button is visible,
 * indicating that processing is complete.
 *
 * Uses multi-match queries ($) so a hidden/stale first element does not
 * cause the loop to miss a visible second element.
 */
async function waitForDownloadButton(frame, timeoutMs) {
  const downloadSelectors = [
    // Arabic "تحميل" = Download
    'a:has-text("تحميل")',
    'button:has-text("تحميل")',
    '[role="button"]:has-text("تحميل")',
    // English fallbacks
    'a[download]',
    'a:has-text("Download")',
    'button:has-text("Download")',
    '.download-button',
    '[data-action="download"]',
    'a[href^="data:"]',
    'a[href^="blob:"]',
  ];

  const startedAt = Date.now();
  const deadline  = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    for (const sel of downloadSelectors) {
      try {
        // Use $ (multi-match) so we check EVERY matching element, not just the first.
        const elements = await frame.$(sel);
        for (const el of elements) {
          try {
            if (await el.isVisible()) {
              process.stdout.write('\n');
              console.log(`[wait] Download element visible via selector: "${sel}"`);
              return el;
            }
          } catch (_) { /* element detached between query and check – skip */ }
        }
      } catch (_) { /* selector not yet in DOM – continue */ }
    }

    // Watch for explicit error states (inform but don't abort – app may recover)
    try {
      const errorEls = await frame.$('[class*="error" i], [class*="alert" i], [role="alert"]');
      for (const el of errorEls) {
        const errText = await el.evaluate(e => e.innerText?.trim()).catch(() => '');
        if (errText) {
          process.stdout.write('\n');
          console.warn(`[wait] UI error indicator: "${errText}"`);
          break;
        }
      }
    } catch (_) { /* ignore */ }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r[wait] Still processing… ${elapsed}s elapsed (timeout: ${timeoutMs / 1000}s)`);
    await frame.waitForTimeout(2000);
  }

  process.stdout.write('\n');
  throw new Error(
    `Timed out after ${timeoutMs / 1000}s waiting for the download button. ` +
    'The canvas app may still be processing or an error occurred.'
  );
}

/**
 * Extract all base64 data: or blob: href values from download anchor elements.
 * For blob URLs, we also try reading the blob contents via page.evaluate.
 */
async function extractDownloadDataUrls(frame) {
  const urls = [];

  // Gather all <a> tags that look like download links
  const anchors = await frame.$$('a[href], a[download], a:has-text("تحميل"), a:has-text("Download")');

  for (const anchor of anchors) {
    try {
      const href = await anchor.evaluate(el => el.href || el.getAttribute('href') || '');

      if (href.startsWith('data:')) {
        urls.push(href);
      } else if (href.startsWith('blob:')) {
        // Read blob URL contents as base64 using a FileReader inside the page
        const dataUrl = await frame.evaluate(async (blobUrl) => {
          const response = await fetch(blobUrl);
          const blob = await response.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror   = reject;
            reader.readAsDataURL(blob);
          });
        }, href);

        if (dataUrl && dataUrl.startsWith('data:')) {
          urls.push(dataUrl);
        }
      }
    } catch (err) {
      console.warn(`[extract] Skipped one anchor: ${err.message}`);
    }
  }

  // Also search for <img> tags whose src is a data: or blob: URL (some apps embed the result)
  if (urls.length === 0) {
    console.warn('[extract] No download links found. Searching for result <img> tags…');
    const resultImages = await frame.$$('img[src^="data:"], img[src^="blob:"]');

    for (const img of resultImages) {
      try {
        const src = await img.evaluate(el => el.src || '');
        if (src.startsWith('data:')) {
          urls.push(src);
        } else if (src.startsWith('blob:')) {
          const dataUrl = await frame.evaluate(async (blobUrl) => {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror   = reject;
              reader.readAsDataURL(blob);
            });
          }, src);

          if (dataUrl && dataUrl.startsWith('data:')) urls.push(dataUrl);
        }
      } catch (err) {
        console.warn(`[extract] Skipped one image: ${err.message}`);
      }
    }
  }

  return urls;
}

// ── Entry point ─────────────────────────────────────────────────────────────
run().catch(err => {
  console.error('\n[fatal]', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
