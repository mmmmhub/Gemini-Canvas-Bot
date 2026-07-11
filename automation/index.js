/**
 * Gemini Canvas – Text-to-Image Automation
 * Reads cookies from /root cookies.json, navigates the Canvas iframe,
 * types the prompt, sets count, generates, downloads the result, screenshots.
 */
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const COOKIES_PATH  = path.join(__dirname, '..', 'cookies.json');   // root cookies.json
const OUTPUT_DIR    = path.join(__dirname, 'output');
const TARGET_URL    = 'https://share.gemini.google/EIt5nvt7wCXV';
const PROMPT        = 'مدينة مستقبلية في الفضاء الخارجي';
const IMAGE_COUNT   = 1;
const CANVAS_WAIT   = 9000;   // ms to wait for Canvas React app to fully boot
const GEN_TIMEOUT   = 180000; // ms to wait for generation to finish
// Nix-store Chromium (fully self-contained wrapper with correct library paths)
const CHROMIUM_PATH = '/nix/store/gasnw5878924jbw6bql257ll29hkm4fd-chromium-123.0.6312.105/bin/chromium';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(tag, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] [${String(tag).padEnd(9)}] ${msg}`);
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

/** Playwright only accepts 'Strict' | 'Lax' | 'None' for sameSite. */
function normaliseSameSite(raw) {
  if (!raw) return 'Lax';
  const v = String(raw).toLowerCase();
  if (v === 'strict')                       return 'Strict';
  if (v === 'lax')                          return 'Lax';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return 'Lax';   // 'unspecified' and anything else
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) throw new Error(`cookies.json not found at ${COOKIES_PATH}`);
  const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  const cooked = raw.map(c => {
    const out = {
      name:     c.name,
      value:    c.value,
      domain:   c.domain   || '.google.com',
      path:     c.path     || '/',
      httpOnly: c.httpOnly ?? false,
      secure:   c.secure   ?? true,
      sameSite: normaliseSameSite(c.sameSite),
    };
    if (typeof c.expirationDate === 'number') out.expires = c.expirationDate;
    else if (typeof c.expires === 'number')   out.expires = c.expires;
    return out;
  });
  log('auth', `Loaded ${cooked.length} cookies from ${COOKIES_PATH}`);
  return cooked;
}

async function saveDataUrl(dataUrl, label) {
  const [header, b64] = dataUrl.split(',');
  if (!b64) throw new Error('No base64 payload in data URL');
  const mime = (header.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const ext  = mime.split('/')[1]?.replace(/\+.*$/, '') || 'png';
  const file = path.join(OUTPUT_DIR, `${label}.${ext}`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  log('save', `Wrote ${Math.round(b64.length * 0.75 / 1024)} KB → ${file}`);
  return file;
}

// ─── Canvas iframe discovery ──────────────────────────────────────────────────
async function findCanvasFrame(page) {
  log('iframe', 'Locating canvas iframe…');

  for (let attempt = 1; attempt <= 4; attempt++) {
    const iframes = await page.$$('iframe');
    log('iframe', `Attempt ${attempt}: ${iframes.length} iframe(s) on page`);

    let best = null, bestArea = 0;
    for (const h of iframes) {
      const frame = await h.contentFrame().catch(() => null);
      if (!frame) continue;
      await frame.waitForLoadState('domcontentloaded').catch(() => {});

      // Structural probe: canvas app has a textarea + a button
      const hasInput  = await frame.$('textarea, input[type="text"], input[type="number"]').catch(() => null);
      const hasButton = await frame.$('button').catch(() => null);
      if (hasInput && hasButton) {
        const box  = await h.boundingBox().catch(() => null);
        const area = box ? box.width * box.height : 0;
        if (area > bestArea) { bestArea = area; best = { handle: h, frame }; }
      }
    }

    if (best) {
      log('iframe', `✅ Canvas frame validated (area ${Math.round(bestArea)}px²)`);
      return best.frame;
    }

    log('iframe', `No validated frame yet — waiting 3s…`);
    await sleep(3000);
  }

  // Last-resort: largest iframe by area
  log('iframe', '⚠️  Validation failed — using largest iframe as fallback');
  const all = await page.$$('iframe');
  let fb = null, fbArea = 0;
  for (const h of all) {
    const b = await h.boundingBox().catch(() => null);
    if (!b) continue;
    const a = b.width * b.height;
    if (a > fbArea) { fbArea = a; fb = h; }
  }
  if (!fb) throw new Error('No iframes found on page at all.');
  return fb.contentFrame();
}

// ─── Step: enter prompt ───────────────────────────────────────────────────────
async function enterPrompt(frame, text) {
  log('prompt', `Typing: "${text}"`);
  const PLACEHOLDER = 'ما الذي تود رسمه؟';

  const selectors = [
    `textarea[placeholder*="${PLACEHOLDER}"]`,
    `input[placeholder*="${PLACEHOLDER}"]`,
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
  ];

  for (const sel of selectors) {
    const el = await frame.$(sel).catch(() => null);
    if (!el) continue;
    await el.click({ clickCount: 3 });
    await sleep(150);
    await el.fill('');
    await sleep(100);
    const isEditable = await el.evaluate(e => e.isContentEditable);
    if (isEditable) {
      await el.evaluate((e, t) => {
        e.textContent = t;
        e.dispatchEvent(new Event('input',  { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }, text);
    } else {
      await el.fill(text);
    }
    const got = await el.evaluate(e => e.value || e.textContent || '');
    if (got.trim().length > 0) {
      log('prompt', `✅ Entered via "${sel}"`);
      return;
    }
  }
  throw new Error('Could not locate the prompt textarea.');
}

// ─── Step: set image count ────────────────────────────────────────────────────
async function setCount(frame, count) {
  log('count', `Setting image count = ${count}`);

  // Strategy 1: find label containing "العدد:" then locate nearby input
  const found = await frame.evaluate((lbl) => {
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      if (el.children.length === 0 && el.textContent.includes(lbl)) {
        const container = el.closest('div, section, form, label') || el.parentElement;
        if (!container) continue;
        const inp = container.querySelector('input[type="number"], input[type="text"], input');
        if (inp) { inp.focus(); inp.select(); return true; }
      }
    }
    return false;
  }, 'العدد:');

  if (found) {
    const focused = await frame.$(':focus');
    if (focused) {
      await focused.fill(String(count));
      await focused.evaluate((e, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(e, v);
        e.dispatchEvent(new Event('input',  { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }, String(count));
      log('count', '✅ Count set via label proximity');
      return;
    }
  }

  // Strategy 2: numeric input selectors
  for (const sel of ['input[type="number"]', 'input[inputmode="numeric"]']) {
    const el = await frame.$(sel).catch(() => null);
    if (!el) continue;
    await el.click({ clickCount: 3 });
    await el.fill(String(count));
    await el.evaluate((e, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(e, v);
      e.dispatchEvent(new Event('input',  { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(count));
    log('count', `✅ Count set via "${sel}"`);
    return;
  }

  log('count', '⚠️  Count field not found — using app default');
}

// ─── Step: click generate ─────────────────────────────────────────────────────
async function clickGenerate(frame) {
  log('generate', 'Clicking "توليد الآن"…');

  const selectors = [
    'button:has-text("توليد الآن")',
    '[role="button"]:has-text("توليد الآن")',
    'button:has-text("توليد")',
  ];

  for (const sel of selectors) {
    const btns = await frame.$$(sel);
    for (const btn of btns) {
      const disabled = await btn.evaluate(e => e.disabled || e.getAttribute('aria-disabled') === 'true').catch(() => false);
      if (disabled) continue;
      const txt = await btn.evaluate(e => e.innerText?.trim()).catch(() => '');
      await btn.click();
      log('generate', `✅ Clicked: "${txt}"`);
      return;
    }
  }
  throw new Error('Could not find "توليد الآن" button.');
}

// ─── Step: wait for thumbnails ────────────────────────────────────────────────
async function waitForThumbnails(frame, timeoutMs) {
  log('wait', `Waiting up to ${timeoutMs / 1000}s for generated thumbnails…`);
  const startedAt = Date.now();
  const deadline  = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    // Look for any img with real pixel content (naturalWidth > 50) that is visible
    const imgs = await frame.$$('img');
    for (const img of imgs) {
      try {
        const info = await img.evaluate(el => ({
          src:      el.src || '',
          natural:  el.naturalWidth,
          w:        el.getBoundingClientRect().width,
          visible:  el.offsetParent !== null,
        }));
        if (info.visible && info.natural > 50 && info.w > 50 &&
            (info.src.startsWith('data:') || info.src.startsWith('blob:') ||
             /\.(jpg|jpeg|png|webp)/i.test(info.src))) {
          process.stdout.write('\n');
          log('wait', `✅ Thumbnail found after ${elapsed}s (src: ${info.src.slice(0,80)})`);
          return img;
        }
      } catch (_) {}
    }

    // Result container patterns
    for (const sel of [
      '[class*="result" i] img', '[class*="output" i] img',
      '[class*="generated" i] img', '[class*="gallery" i] img',
      '[class*="thumbnail" i]', '[class*="image-card" i] img',
    ]) {
      const els = await frame.$$(sel).catch(() => []);
      if (els.length > 0) {
        process.stdout.write('\n');
        log('wait', `✅ Result grid via "${sel}" (${els.length} items, ${elapsed}s)`);
        return els[0];
      }
    }

    process.stdout.write(`\r[wait     ] ${elapsed}s elapsed — waiting for thumbnails…`);
    await sleep(2000);
  }

  process.stdout.write('\n');
  throw new Error(`Generation timed out after ${timeoutMs / 1000}s.`);
}

// ─── Step: open thumbnail then download ──────────────────────────────────────
async function downloadResult(frame, page, thumbnail) {
  // Click the thumbnail to open full-size viewer
  log('download', 'Clicking first thumbnail to open viewer…');
  try {
    await thumbnail.click();
  } catch (_) {
    await thumbnail.evaluate(el => {
      let n = el;
      for (let i = 0; i < 5; i++) {
        n = n.parentElement;
        if (!n) break;
        const tag = n.tagName?.toLowerCase();
        if (tag === 'button' || tag === 'a' || n.getAttribute('role') === 'button') {
          return n.click();
        }
      }
      el.click();
    });
  }
  await sleep(2000);

  // Wait for "تحميل" button
  log('download', 'Waiting for "تحميل" button…');
  const dlDeadline = Date.now() + 20_000;
  let dlBtn = null;

  while (Date.now() < dlDeadline) {
    const selectors = [
      'a:has-text("تحميل")', 'button:has-text("تحميل")',
      '[role="button"]:has-text("تحميل")',
      'a[download]', 'a[href^="data:"]', 'a[href^="blob:"]',
    ];
    for (const sel of selectors) {
      const els = await frame.$$(sel).catch(() => []);
      for (const el of els) {
        if (await el.isVisible().catch(() => false)) {
          dlBtn = el; break;
        }
      }
      if (dlBtn) break;
    }
    if (dlBtn) break;
    process.stdout.write(`\r[download ] waiting for تحميل button…`);
    await sleep(1000);
  }
  process.stdout.write('\n');

  if (!dlBtn) throw new Error('"تحميل" button did not appear within 20s.');
  log('download', '✅ "تحميل" button found');

  // Extract href if it's a data: or blob: URL (avoid browser dialog)
  const href = await dlBtn.evaluate(el => el.href || el.getAttribute('href') || '').catch(() => '');

  if (href.startsWith('data:')) {
    ensureDir(OUTPUT_DIR);
    return saveDataUrl(href, 'generated_image');
  }

  if (href.startsWith('blob:')) {
    const dataUrl = await frame.evaluate(async (url) => {
      const res  = await fetch(url);
      const blob = await res.blob();
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.onerror   = rej;
        r.readAsDataURL(blob);
      });
    }, href);
    ensureDir(OUTPUT_DIR);
    return saveDataUrl(dataUrl, 'generated_image');
  }

  // Intercept browser download event
  log('download', 'No direct href — intercepting download event…');
  ensureDir(OUTPUT_DIR);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
    dlBtn.click(),
  ]);

  if (dl) {
    const name = dl.suggestedFilename() || 'generated_image.png';
    const dest = path.join(OUTPUT_DIR, name);
    await dl.saveAs(dest);
    log('download', `✅ Saved via download event → ${dest}`);
    return dest;
  }

  // Last resort: grab the largest visible img src after clicking
  log('download', 'No download event — capturing visible full-size image…');
  await sleep(1000);
  for (const img of await frame.$$('img')) {
    const info = await img.evaluate(e => ({
      src: e.src || '', w: e.getBoundingClientRect().width, nat: e.naturalWidth,
    })).catch(() => ({ src: '', w: 0, nat: 0 }));
    if (info.w > 200 && info.nat > 200 && (info.src.startsWith('data:') || info.src.startsWith('blob:'))) {
      let dataUrl = info.src;
      if (dataUrl.startsWith('blob:')) {
        dataUrl = await frame.evaluate(async (u) => {
          const r = await fetch(u); const b = await r.blob();
          return new Promise((res, rej) => { const fr = new FileReader(); fr.onloadend=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(b); });
        }, dataUrl);
      }
      return saveDataUrl(dataUrl, 'generated_image');
    }
  }

  throw new Error('Could not capture the generated image.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   Gemini Canvas — Text-to-Image Automation           ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  ensureDir(OUTPUT_DIR);
  const cookies = loadCookies();

  const browser = await chromium.launch({
    headless:       true,
    executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-software-rasterizer', '--no-first-run',
      '--no-zygote', '--disable-web-security',
      '--allow-running-insecure-content',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport:          { width: 1400, height: 900 },
    userAgent:         'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:            'ar-SA',
    timezoneId:        'Asia/Riyadh',
    bypassCSP:         true,
    ignoreHTTPSErrors: true,
    acceptDownloads:   true,
  });

  await context.addCookies(cookies);
  log('auth', `Injected ${cookies.length} cookies into browser context`);

  const page = await context.newPage();
  page.on('pageerror', e => log('page-err', e.message.slice(0, 120)));

  let savedImage  = null;
  let screenshotPath = null;

  try {
    // ── Navigate ────────────────────────────────────────────────────────────
    log('nav', `Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    log('nav', `Title: "${await page.title()}"`);

    // ── WAIT: Canvas React app needs time to fully boot ─────────────────────
    log('nav', `Waiting ${CANVAS_WAIT / 1000}s for Canvas to fully render…`);
    await sleep(CANVAS_WAIT);

    // ── Find iframe ──────────────────────────────────────────────────────────
    const frame = await findCanvasFrame(page);

    // Extra moment for React components to mount
    await sleep(1500);

    // ── Step 1: Enter prompt ─────────────────────────────────────────────────
    await enterPrompt(frame, PROMPT);
    await sleep(600);

    // ── Step 2: Set image count ───────────────────────────────────────────────
    await setCount(frame, IMAGE_COUNT);
    await sleep(600);

    // ── Step 3: Click generate ────────────────────────────────────────────────
    await clickGenerate(frame);
    log('generate', 'Generation started — waiting for results…');

    // ── Step 4: Wait for thumbnails ───────────────────────────────────────────
    const thumbnail = await waitForThumbnails(frame, GEN_TIMEOUT);
    await sleep(1500);

    // ── Step 5: Download ──────────────────────────────────────────────────────
    savedImage = await downloadResult(frame, page, thumbnail);

    // ── Step 6: Full-page screenshot before closing ────────────────────────────
    screenshotPath = path.join(OUTPUT_DIR, 'execution_screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log('screenshot', `Saved → ${screenshotPath}`);

  } finally {
    await browser.close();
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ✅  Automation complete!                             ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  if (savedImage)     console.log(`  Generated image : ${savedImage}`);
  if (screenshotPath) console.log(`  Screenshot      : ${screenshotPath}`);
  console.log('');

  // Write a simple manifest so the caller knows exactly what was saved
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedImage: savedImage, screenshot: screenshotPath }, null, 2)
  );
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
