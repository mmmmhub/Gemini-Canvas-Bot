/**
 * Gemini Canvas – Text-to-Image Generation Automation
 * ─────────────────────────────────────────────────────────────────────────────
 * Targets the Canvas shared-link app that generates images from a text prompt.
 *
 * UI flow this script automates (all steps happen inside the sandboxed iframe):
 *   1. Wait for Canvas to fully load and render
 *   2. Type the Arabic/English prompt into the main textarea
 *   3. Set the image count in the "العدد:" numeric field
 *   4. Click "توليد الآن"
 *   5. Wait for thumbnail grid to appear (generation complete)
 *   6. Click the first thumbnail to open the full-size view
 *   7. Click "تحميل" (Download) and save the file to disk
 *
 * Usage:
 *   cd automation
 *   node generate.js
 *
 * Configuration (automation/.env or shell environment):
 *   TARGET_URL          Gemini Canvas shared URL (default: the provided link)
 *   PROMPT              Arabic or English image prompt
 *   IMAGE_COUNT         Number of images to generate (1–10, default 1)
 *   OUTPUT_DIR          Directory to save downloaded images (default ./output)
 *   HEADLESS            "false" to watch the browser window (default true)
 *   CANVAS_LOAD_MS      Extra wait after page load for Canvas JS to boot (default 8000)
 *   GENERATION_TIMEOUT  Max ms to wait for thumbnails to appear (default 180000)
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Load .env ───────────────────────────────────────────────────────────────
for (const p of [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
]) {
  if (fs.existsSync(p)) { require('dotenv').config({ path: p }); break; }
}

// ── Configuration ───────────────────────────────────────────────────────────
const CFG = {
  targetUrl:         process.env.TARGET_URL           || 'https://share.gemini.google/EIt5nvt7wCXV',
  prompt:            process.env.PROMPT               || 'مدينة مستقبلية في الفضاء الخارجي',
  imageCount:        Math.min(10, Math.max(1, parseInt(process.env.IMAGE_COUNT || '1', 10))),
  outputDir:         process.env.OUTPUT_DIR           || path.join(__dirname, 'output'),
  headless:          process.env.HEADLESS             !== 'false',
  canvasLoadMs:      parseInt(process.env.CANVAS_LOAD_MS         || '8000',   10),
  generationTimeout: parseInt(process.env.GENERATION_TIMEOUT     || '180000', 10),
};

// ── Arabic UI text constants (exact strings used in the Canvas app) ─────────
const UI = {
  promptPlaceholder: 'ما الذي تود رسمه؟',          // partial match is enough
  countLabel:        'العدد:',
  generateButton:    'توليد الآن',
  downloadButton:    'تحميل',
};

// ── Chromium resolution ─────────────────────────────────────────────────────
function resolveChromium() {
  const candidates = [
    // Playwright headless-shell (downloaded by `npx playwright install chromium`)
    path.join(__dirname, '..', '.cache', 'ms-playwright',
      'chromium_headless_shell-1228', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    path.join(process.env.HOME || '/root', '.cache', 'ms-playwright',
      'chromium_headless_shell-1228', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/run/current-system/sw/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) { log('browser', `Chromium → ${p}`); return p; }
  }
  log('browser', 'No explicit path — letting Playwright auto-detect.');
  return undefined;
}

// ── Cookie helpers ──────────────────────────────────────────────────────────
function loadCookies() {
  const file = path.join(__dirname, 'cookies.json');
  if (!fs.existsSync(file)) {
    if (process.env.COOKIE_STRING) return parseCookieString(process.env.COOKIE_STRING);
    log('auth', '⚠️  No cookies.json and no COOKIE_STRING — proceeding unauthenticated.');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    log('auth', `Loaded ${raw.length} cookies from cookies.json`);
    return raw.map(c => ({
      name:     c.name,
      value:    c.value,
      domain:   c.domain   || '.google.com',
      path:     c.path     || '/',
      expires:  c.expires  ?? -1,
      httpOnly: c.httpOnly ?? false,
      secure:   c.secure   ?? true,
      sameSite: c.sameSite || 'None',
    }));
  } catch (e) {
    log('auth', `Could not parse cookies.json: ${e.message}`);
    return [];
  }
}

function parseCookieString(raw) {
  return raw.split(';').map(p => {
    const [name, ...rest] = p.trim().split('=');
    return { name: name.trim(), value: rest.join('=').trim(),
             domain: '.google.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' };
  }).filter(c => c.name && c.value);
}

// ── Utilities ───────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [${tag.padEnd(8)}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Save a data: or blob: URL to disk.
 * blobUrl is evaluated inside `frame` if it starts with blob:.
 */
async function saveResult(frame, srcOrDataUrl, index) {
  let dataUrl = srcOrDataUrl;

  if (srcOrDataUrl.startsWith('blob:')) {
    dataUrl = await frame.evaluate(async (url) => {
      const res  = await fetch(url);
      const blob = await res.blob();
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.onerror   = rej;
        r.readAsDataURL(blob);
      });
    }, srcOrDataUrl);
  }

  if (!dataUrl || !dataUrl.startsWith('data:')) {
    throw new Error(`Unexpected image source: ${String(srcOrDataUrl).slice(0, 80)}`);
  }

  const [header, b64] = dataUrl.split(',');
  const mime  = (header.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const ext   = mime.split('/')[1]?.replace(/\+.*$/, '') || 'png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file  = path.join(CFG.outputDir, `generated_${stamp}_${index + 1}.${ext}`);

  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  log('output', `✅ Saved ${Math.round(b64.length * 0.75 / 1024)} KB → ${file}`);
  return file;
}

// ── Canvas iframe discovery ─────────────────────────────────────────────────
/**
 * Find the iframe that hosts the Canvas React app.
 * Validates structurally by probing for the prompt textarea before accepting.
 */
async function findCanvasFrame(page) {
  log('iframe', 'Searching for canvas iframe…');

  // Give the page a moment to render iframes
  await sleep(2000);

  const selectors = ['iframe[sandbox]', 'iframe[src^="blob:"]', 'iframe'];

  for (let attempt = 0; attempt < 3; attempt++) {
    const seen    = new Map(); // dedup by position key
    const handles = [];

    for (const sel of selectors) {
      for (const el of await page.$$(sel)) {
        const key = await el.evaluate(e => {
          const r = e.getBoundingClientRect();
          return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`;
        }).catch(() => Math.random().toString());
        if (!seen.has(key)) { seen.set(key, true); handles.push(el); }
      }
    }

    log('iframe', `Attempt ${attempt + 1}: found ${handles.length} candidate iframe(s)`);

    for (const handle of handles) {
      const frame = await handle.contentFrame().catch(() => null);
      if (!frame) continue;

      await frame.waitForLoadState('domcontentloaded').catch(() => {});

      // Structural validation: look for the prompt textarea
      try {
        const el = await frame.$(`textarea, input[type="text"], [contenteditable]`);
        if (el) {
          const box = await handle.boundingBox().catch(() => null);
          log('iframe', `✅ Validated canvas frame (area: ${Math.round((box?.width || 0) * (box?.height || 0))}px²)`);
          return { handle, frame };
        }
      } catch (_) {}
    }

    log('iframe', 'No validated frame yet — waiting 3s before retry…');
    await sleep(3000);
  }

  // Absolute fallback: largest iframe by area
  log('iframe', '⚠️  Validation failed. Using largest iframe as fallback.');
  const all = await page.$$('iframe');
  let best = null, bestArea = 0;
  for (const h of all) {
    const b = await h.boundingBox().catch(() => null);
    if (!b) continue;
    const a = b.width * b.height;
    if (a > bestArea) { bestArea = a; best = h; }
  }
  if (!best) throw new Error('No iframes found on the page at all.');
  return { handle: best, frame: await best.contentFrame() };
}

// ── Step implementations ────────────────────────────────────────────────────

/**
 * STEP 1 — Type the prompt into the main textarea.
 * Targets the element with placeholder containing UI.promptPlaceholder.
 */
async function stepEnterPrompt(frame, promptText) {
  log('prompt', `Typing: "${promptText}"`);

  const selectors = [
    // Exact placeholder match (partial)
    `textarea[placeholder*="${UI.promptPlaceholder}"]`,
    `input[placeholder*="${UI.promptPlaceholder}"]`,
    // Fallback: any textarea / contenteditable
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[type="text"]',
  ];

  for (const sel of selectors) {
    const el = await frame.$(sel).catch(() => null);
    if (!el) continue;

    // Triple-click to select all existing content, then replace
    await el.click({ clickCount: 3 });
    await sleep(200);
    await el.press('Control+a');
    await el.press('Backspace');
    await sleep(100);

    const tag             = await el.evaluate(e => e.tagName.toLowerCase());
    const isContentEditable = await el.evaluate(e => e.isContentEditable);

    if (isContentEditable || tag === 'div' || tag === 'span') {
      await el.evaluate((e, t) => {
        e.textContent = t;
        e.dispatchEvent(new Event('input',  { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }, promptText);
    } else {
      await el.fill(promptText);
    }

    // Verify the text landed
    const actual = await el.evaluate(e => e.value || e.textContent || '');
    if (actual.trim().length > 0) {
      log('prompt', `✅ Prompt entered via "${sel}"`);
      return;
    }
  }

  throw new Error(`Could not locate the prompt field (placeholder: "${UI.promptPlaceholder}")`);
}

/**
 * STEP 2 — Set the image count in the "العدد:" numeric field.
 * Treats the field as a plain text/number input (not a dropdown).
 */
async function stepSetImageCount(frame, count) {
  log('count', `Setting image count to ${count}`);

  // Strategy A: find the label "العدد:" and locate the sibling/nearby input
  const inputFromLabel = await frame.evaluate((labelText) => {
    // Walk all elements looking for one whose text contains the label
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes(labelText)) {
        const parent = node.parentElement;
        // Search siblings and parent's siblings for an input
        const container = parent.closest('div, form, section, label') || parent.parentElement;
        if (container) {
          const inp = container.querySelector('input[type="number"], input[type="text"], input');
          if (inp) { inp.focus(); return true; }
        }
      }
    }
    return false;
  }, UI.countLabel);

  if (inputFromLabel) {
    // Now find the focused input and set its value
    const focused = await frame.$(':focus');
    if (focused) {
      await setInputValue(frame, focused, String(count));
      log('count', '✅ Count set via label proximity');
      return;
    }
  }

  // Strategy B: direct numeric input selectors
  const numSelectors = [
    'input[type="number"]',
    'input[inputmode="numeric"]',
    `input[aria-label*="العدد" i]`,
    `input[name*="count" i]`,
    `input[name*="عدد" i]`,
    `input[placeholder*="عدد" i]`,
  ];

  for (const sel of numSelectors) {
    const el = await frame.$(sel).catch(() => null);
    if (!el) continue;
    await setInputValue(frame, el, String(count));
    log('count', `✅ Count set via selector "${sel}"`);
    return;
  }

  log('count', '⚠️  Count field not found — proceeding with whatever the default is.');
}

/** Helper: clear an input and type a value, dispatching React-compatible events. */
async function setInputValue(frame, el, value) {
  await el.click({ clickCount: 3 });
  await sleep(100);
  await el.press('Control+a');
  await el.fill(value);
  await el.evaluate((e, v) => {
    // Force React / Vue synthetic event handling
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) nativeInputValueSetter.call(e, v);
    e.dispatchEvent(new Event('input',  { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/**
 * STEP 3 — Click the "توليد الآن" generate button.
 */
async function stepClickGenerate(frame) {
  log('generate', `Clicking "${UI.generateButton}"…`);

  const selectors = [
    `button:has-text("${UI.generateButton}")`,
    `[role="button"]:has-text("${UI.generateButton}")`,
    // Fallback text matches
    'button:has-text("توليد")',
    '[role="button"]:has-text("توليد")',
    'button[type="submit"]',
  ];

  for (const sel of selectors) {
    const buttons = await frame.$$(sel);
    for (const btn of buttons) {
      try {
        const disabled = await btn.evaluate(e =>
          e.disabled || e.getAttribute('aria-disabled') === 'true'
        );
        if (disabled) continue;

        const text = await btn.evaluate(e => e.innerText?.trim() || '');
        await btn.click();
        log('generate', `✅ Clicked button: "${text}" (via "${sel}")`);
        return;
      } catch (_) {}
    }
  }

  throw new Error(`Could not find the "${UI.generateButton}" button.`);
}

/**
 * STEP 4 — Wait for the generation to complete.
 * Polls for thumbnail images to appear in the DOM.
 *
 * Completion signals we watch for:
 *   - One or more <img> elements appear that are NOT the placeholder/spinner
 *   - A thumbnail container with multiple children
 *   - The generate button becomes enabled again (processing finished)
 *   - An explicit "done" / "complete" indicator
 *
 * Returns the first generated thumbnail element.
 */
async function stepWaitForThumbnails(frame, timeoutMs) {
  log('wait', `Waiting up to ${timeoutMs / 1000}s for generated thumbnails…`);

  const startedAt = Date.now();
  const deadline  = startedAt + timeoutMs;

  // Capture initial image count so we can detect NEW images
  const initialImgCount = await frame.$$eval('img', imgs => imgs.length).catch(() => 0);
  log('wait', `Initial img count in frame: ${initialImgCount}`);

  while (Date.now() < deadline) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    // ── Check 1: new images appeared beyond the initial set ──────────────────
    const currentImgs = await frame.$$('img').catch(() => []);

    for (const img of currentImgs) {
      try {
        const info = await img.evaluate(el => ({
          src:     el.src || el.getAttribute('src') || '',
          visible: el.offsetParent !== null && el.getBoundingClientRect().width > 50,
          natural: el.naturalWidth > 50,
        }));

        // Accept images that are: visible, not a loading spinner, have real pixel content
        if (
          info.visible &&
          info.natural &&
          (info.src.startsWith('data:') ||
           info.src.startsWith('blob:') ||
           info.src.includes('generated') ||
           info.src.includes('output') ||
           info.src.includes('image'))
        ) {
          process.stdout.write('\n');
          log('wait', `✅ Thumbnail detected (${elapsed}s elapsed). src: ${info.src.slice(0, 80)}`);
          return img;
        }
      } catch (_) {}
    }

    // ── Check 2: grid / result container with children appeared ──────────────
    const gridSelectors = [
      '[class*="result" i] img',
      '[class*="output" i] img',
      '[class*="thumbnail" i]',
      '[class*="generated" i] img',
      '[class*="image-grid" i] img',
      '[class*="gallery" i] img',
      '.results img',
      '.output img',
    ];

    for (const sel of gridSelectors) {
      const els = await frame.$$(sel).catch(() => []);
      if (els.length > 0) {
        process.stdout.write('\n');
        log('wait', `✅ Result grid found via "${sel}" (${els.length} item(s), ${elapsed}s elapsed)`);
        return els[0];
      }
    }

    // ── Check 3: error state ──────────────────────────────────────────────────
    const errorEl = await frame.$('[class*="error" i], [role="alert"], [class*="alert" i]').catch(() => null);
    if (errorEl) {
      const errText = await errorEl.evaluate(e => e.innerText?.trim() || '').catch(() => '');
      if (errText) {
        process.stdout.write('\n');
        log('wait', `⚠️  UI error indicator: "${errText}"`);
      }
    }

    process.stdout.write(`\r[wait    ] ${elapsed}s — watching for thumbnails (${currentImgs.length} img elements in frame)…`);
    await sleep(2000);
  }

  process.stdout.write('\n');
  throw new Error(
    `Generation timed out after ${timeoutMs / 1000}s. ` +
    'The model may still be processing. Increase GENERATION_TIMEOUT and retry.'
  );
}

/**
 * STEP 5 — Click the first generated thumbnail to open the full-size view.
 */
async function stepOpenFirstThumbnail(frame, thumbnailEl) {
  log('open', 'Clicking the first generated thumbnail…');

  // Try clicking the thumbnail itself first
  try {
    await thumbnailEl.click();
    log('open', '✅ Clicked thumbnail directly.');
    await sleep(1500); // wait for the viewer/modal to open
    return;
  } catch (e) {
    log('open', `Direct click failed (${e.message}) — trying parent container…`);
  }

  // If the img is nested, click its clickable ancestor
  try {
    await thumbnailEl.evaluate(el => {
      // Walk up looking for a button, anchor, or div with a click handler
      let node = el;
      for (let i = 0; i < 5; i++) {
        node = node.parentElement;
        if (!node) break;
        const tag = node.tagName.toLowerCase();
        if (tag === 'button' || tag === 'a' || node.onclick || node.getAttribute('role') === 'button') {
          node.click();
          return;
        }
      }
      // Fallback: click the img itself
      el.click();
    });
    log('open', '✅ Clicked thumbnail via ancestor walk.');
    await sleep(1500);
  } catch (e) {
    log('open', `Ancestor click also failed: ${e.message} — will attempt download anyway.`);
  }
}

/**
 * STEP 6 — Click "تحميل" (Download) and save the image.
 *
 * After clicking a thumbnail, a full-size viewer / modal opens.
 * We locate the download button, extract the image URL, and save it.
 */
async function stepDownload(frame, page) {
  log('download', `Looking for "${UI.downloadButton}" button…`);

  const downloadSelectors = [
    `a:has-text("${UI.downloadButton}")`,
    `button:has-text("${UI.downloadButton}")`,
    `[role="button"]:has-text("${UI.downloadButton}")`,
    // Generic download anchors as fallback
    'a[download]',
    'a[href^="data:"]',
    'a[href^="blob:"]',
  ];

  // Wait up to 15s for the download button to appear after opening the viewer
  const btnDeadline = Date.now() + 15_000;
  let downloadEl    = null;

  while (Date.now() < btnDeadline) {
    for (const sel of downloadSelectors) {
      const elements = await frame.$$(sel).catch(() => []);
      for (const el of elements) {
        try {
          if (await el.isVisible()) {
            downloadEl = el;
            log('download', `✅ Download button found via "${sel}"`);
            break;
          }
        } catch (_) {}
      }
      if (downloadEl) break;
    }
    if (downloadEl) break;

    process.stdout.write(`\r[download] Waiting for "${UI.downloadButton}" button…`);
    await sleep(1000);
  }
  process.stdout.write('\n');

  if (!downloadEl) {
    throw new Error(`"${UI.downloadButton}" button did not appear within 15s.`);
  }

  // ── Strategy A: extract href and save directly (no browser dialog) ─────────
  const href = await downloadEl.evaluate(el => el.href || el.getAttribute('href') || '').catch(() => '');

  if (href.startsWith('data:') || href.startsWith('blob:')) {
    log('download', 'Extracting image from href attribute…');
    ensureDir(CFG.outputDir);
    const saved = await saveResult(frame, href, 0);
    return [saved];
  }

  // ── Strategy B: listen for download event, then click ─────────────────────
  log('download', 'No direct href — intercepting browser download event…');

  const [ download ] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
    downloadEl.click(),
  ]);

  if (download) {
    ensureDir(CFG.outputDir);
    const stamp    = new Date().toISOString().replace(/[:.]/g, '-');
    const suggested = download.suggestedFilename() || `generated_${stamp}.png`;
    const dest     = path.join(CFG.outputDir, suggested);
    await download.saveAs(dest);
    log('download', `✅ Saved via download event → ${dest}`);
    return [dest];
  }

  // ── Strategy C: capture the visible full-size image src after clicking ─────
  log('download', 'No download event — extracting displayed image src…');
  await sleep(800);

  const visibleImgs = await frame.$$('img');
  for (const img of visibleImgs) {
    const info = await img.evaluate(el => ({
      src:     el.src || '',
      natural: el.naturalWidth > 200,
      visible: el.getBoundingClientRect().width > 200,
    })).catch(() => ({ src: '', natural: false, visible: false }));

    if (info.visible && info.natural && (info.src.startsWith('data:') || info.src.startsWith('blob:'))) {
      ensureDir(CFG.outputDir);
      const saved = await saveResult(frame, info.src, 0);
      return [saved];
    }
  }

  throw new Error(
    'Could not capture the generated image. ' +
    'Try running with HEADLESS=false to inspect the UI manually.'
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Gemini Canvas – Text-to-Image Generation             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  URL      : ${CFG.targetUrl}`);
  console.log(`  Prompt   : ${CFG.prompt}`);
  console.log(`  Count    : ${CFG.imageCount}`);
  console.log(`  Output   : ${CFG.outputDir}`);
  console.log(`  Headless : ${CFG.headless}`);
  console.log('');

  ensureDir(CFG.outputDir);

  const cookies = loadCookies();

  // ── Launch Chromium ─────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless:       CFG.headless,
    executablePath: resolveChromium(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--no-zygote',
      '--disable-web-security',          // required to access sandboxed iframe DOM
      '--allow-running-insecure-content',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport:          { width: 1280, height: 900 },
    userAgent:         'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                     + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:            'ar-SA',
    timezoneId:        'Asia/Riyadh',
    bypassCSP:         true,
    ignoreHTTPSErrors: true,
    acceptDownloads:   true,
  });

  if (cookies.length > 0) {
    await context.addCookies(cookies);
    log('auth', `Injected ${cookies.length} cookies.`);
  }

  const page = await context.newPage();

  // Log browser errors for easier debugging
  page.on('pageerror', e => log('page-err', e.message));
  page.on('console',   m => {
    if (m.type() === 'error') log('console', m.text().slice(0, 200));
  });

  let savedFiles = [];

  try {
    // ── Navigate ──────────────────────────────────────────────────────────────
    log('nav', `Opening ${CFG.targetUrl}`);
    await page.goto(CFG.targetUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    log('nav', `Page title: "${await page.title()}"`);

    // ── CRITICAL WAIT: Canvas React app needs time to fully initialise ────────
    log('nav', `Waiting ${CFG.canvasLoadMs / 1000}s for Canvas JS to boot…`);
    await sleep(CFG.canvasLoadMs);

    // ── Locate the sandboxed Canvas iframe ────────────────────────────────────
    const { frame } = await findCanvasFrame(page);

    // Give the React app a moment to mount all components
    await sleep(1500);

    // ── Step 1: Enter prompt ──────────────────────────────────────────────────
    await stepEnterPrompt(frame, CFG.prompt);
    await sleep(500);

    // ── Step 2: Set image count ───────────────────────────────────────────────
    await stepSetImageCount(frame, CFG.imageCount);
    await sleep(500);

    // ── Step 3: Click generate ────────────────────────────────────────────────
    await stepClickGenerate(frame);

    // ── Step 4: Wait for thumbnails ───────────────────────────────────────────
    const firstThumbnail = await stepWaitForThumbnails(frame, CFG.generationTimeout);

    // Extra pause to ensure all thumbnails have rendered
    await sleep(1500);

    // ── Step 5: Click first thumbnail ────────────────────────────────────────
    await stepOpenFirstThumbnail(frame, firstThumbnail);

    // ── Step 6: Download ──────────────────────────────────────────────────────
    savedFiles = await stepDownload(frame, page);

  } finally {
    await browser.close();
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║  ✅  Done! ${savedFiles.length} file(s) saved.`
    .padEnd(61) + '║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  savedFiles.forEach(f => console.log(`   ${f}`));
  console.log('');
}

main().catch(err => {
  console.error('\n[FATAL]', err.message || err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
