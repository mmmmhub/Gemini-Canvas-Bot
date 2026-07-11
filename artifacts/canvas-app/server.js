'use strict';

/**
 * Gemini Canvas — Full-Stack Web Application
 *
 * Express server with a concurrent Playwright queue (max 3 simultaneous jobs).
 * ONE shared browser is launched at startup; each queued job opens its own
 * isolated BrowserContext and closes it when done to prevent memory leaks.
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || '18724', 10);
// BASE_PATH is injected by the artifact workflow (e.g. "/canvas-app/")
const BASE         = (process.env.BASE_PATH || '/canvas-app/').replace(/\/$/, '');
const COOKIES_PATH = path.join(__dirname, '..', '..', 'cookies.json');
const PUBLIC_DIR   = path.join(__dirname, 'public');
const GEN_DIR      = path.join(PUBLIC_DIR, 'generated');
const TARGET_URL   = 'https://gemini.google.com/share/208acf6ff84b?skid=37f8c433-6d51-4e61-bf86-1505680055e2';
const CANVAS_WAIT  = 2000;   // brief settle after iframe appears
const GEN_TIMEOUT  = 180000; // ms for generation
const CONCURRENCY  = 3;
const TICKET_TTL   = 2 * 60 * 60 * 1000; // 2 hours

const CHROMIUM_PATH =
  '/nix/store/gasnw5878924jbw6bql257ll29hkm4fd-chromium-123.0.6312.105/bin/chromium';

const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', '--disable-gpu',
  '--disable-software-rasterizer', '--no-first-run',
  '--no-zygote', '--disable-web-security',
  '--allow-running-insecure-content',
  '--disable-blink-features=AutomationControlled',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(tag, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] [${String(tag).padEnd(10)}] ${msg}`);
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function normaliseSameSite(raw) {
  if (!raw) return 'Lax';
  const v = String(raw).toLowerCase();
  if (v === 'strict')                         return 'Strict';
  if (v === 'lax')                            return 'Lax';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return 'Lax';
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH))
    throw new Error(`cookies.json not found at ${COOKIES_PATH}`);
  const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  return raw.map(c => {
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
}

// ─── Ticket Store ─────────────────────────────────────────────────────────────
const tickets    = new Map();   // ticketId → ticket object
const queueOrder = [];          // ordered queue of pending ticketIds

function createTicket(prompt, imageCount) {
  const id = uuidv4();
  const ticket = {
    id,
    status:      'queued',
    prompt,
    imageCount,
    imageUrl:    null,
    error:       null,
    createdAt:   Date.now(),
    startedAt:   null,
    completedAt: null,
  };
  tickets.set(id, ticket);
  queueOrder.push(id);
  return ticket;
}

function getQueuePosition(ticketId) {
  const idx = queueOrder.indexOf(ticketId);
  return idx === -1 ? 0 : idx + 1;
}

setInterval(() => {
  const cutoff = Date.now() - TICKET_TTL;
  for (const [id, t] of tickets) {
    if (t.createdAt < cutoff) {
      tickets.delete(id);
      const i = queueOrder.indexOf(id);
      if (i !== -1) queueOrder.splice(i, 1);
    }
  }
}, 15 * 60 * 1000);

// ─── Concurrent Queue ──────────────────────────────────────────────────────────
class ConcurrentQueue {
  constructor(concurrency, worker) {
    this.concurrency = concurrency;
    this.worker      = worker;
    this.running     = 0;
    this.pending     = [];
  }
  push(task) { this.pending.push(task); this._tick(); }
  _tick() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      this.running++;
      Promise.resolve(this.worker(task))
        .catch(err => log('queue', `Worker error: ${err.message}`))
        .finally(() => { this.running--; this._tick(); });
    }
  }
  get size() { return this.pending.length + this.running; }
}

// ─── Shared Browser ────────────────────────────────────────────────────────────
let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  log('browser', 'Launching shared Chromium browser…');
  sharedBrowser = await chromium.launch({
    headless:       true,
    executablePath: fs.existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined,
    args:           BROWSER_ARGS,
  });
  sharedBrowser.on('disconnected', () => {
    log('browser', '⚠️  Browser disconnected — will re-launch on next request');
    sharedBrowser = null;
  });
  log('browser', '✅ Shared browser ready');
  return sharedBrowser;
}

// ─── Automation Steps ─────────────────────────────────────────────────────────
async function findCanvasFrame(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const iframes = await page.$$('iframe');
    let best = null, bestArea = 0;
    for (const h of iframes) {
      const frame = await h.contentFrame().catch(() => null);
      if (!frame) continue;
      await frame.waitForLoadState('domcontentloaded').catch(() => {});
      const hasInput  = await frame.$('textarea, input[type="text"], input[type="number"]').catch(() => null);
      const hasButton = await frame.$('button').catch(() => null);
      if (hasInput && hasButton) {
        const box  = await h.boundingBox().catch(() => null);
        const area = box ? box.width * box.height : 0;
        if (area > bestArea) { bestArea = area; best = { handle: h, frame }; }
      }
    }
    if (best) {
      log('iframe', `✅ Canvas frame validated (${Math.round(bestArea)}px²)`);
      return best.frame;
    }
    if (attempt < 4) { log('iframe', `Attempt ${attempt} — waiting 3s…`); await sleep(3000); }
  }
  // Fallback: largest iframe
  const all = await page.$$('iframe');
  let fb = null, fbArea = 0;
  for (const h of all) {
    const b = await h.boundingBox().catch(() => null);
    if (!b) continue;
    if (b.width * b.height > fbArea) { fbArea = b.width * b.height; fb = h; }
  }
  if (!fb) throw new Error('No iframes found on page.');
  return fb.contentFrame();
}

async function enterPrompt(frame, text) {
  const PLACEHOLDER = 'ما الذي تود رسمه؟';
  const selectors = [
    `textarea[placeholder*="${PLACEHOLDER}"]`,
    `input[placeholder*="${PLACEHOLDER}"]`,
    'textarea', '[contenteditable="true"]', '[role="textbox"]',
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
    if (got.trim().length > 0) { log('prompt', `✅ Entered via "${sel}"`); return; }
  }
  throw new Error('Could not locate the prompt textarea.');
}

async function setCount(frame, count) {
  const found = await frame.evaluate((lbl) => {
    for (const el of Array.from(document.querySelectorAll('*'))) {
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

async function clickGenerate(frame) {
  const selectors = [
    'button:has-text("توليد الآن")',
    '[role="button"]:has-text("توليد الآن")',
    'button:has-text("توليد")',
  ];
  for (const sel of selectors) {
    for (const btn of await frame.$$(sel)) {
      const disabled = await btn.evaluate(e =>
        e.disabled || e.getAttribute('aria-disabled') === 'true'
      ).catch(() => false);
      if (disabled) continue;
      await btn.click();
      log('generate', '✅ Clicked generate button');
      return;
    }
  }
  throw new Error('Could not find "توليد الآن" button.');
}

async function waitForThumbnails(frame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const img of await frame.$$('img')) {
      try {
        const info = await img.evaluate(el => ({
          src:     el.src || '',
          natural: el.naturalWidth,
          w:       el.getBoundingClientRect().width,
          visible: el.offsetParent !== null,
        }));
        if (info.visible && info.natural > 50 && info.w > 50 &&
            (info.src.startsWith('data:') || info.src.startsWith('blob:') ||
             /\.(jpg|jpeg|png|webp)/i.test(info.src))) {
          log('wait', '✅ Thumbnail found');
          return img;
        }
      } catch (_) {}
    }
    for (const sel of [
      '[class*="result" i] img', '[class*="output" i] img',
      '[class*="generated" i] img', '[class*="gallery" i] img',
      '[class*="thumbnail" i]', '[class*="image-card" i] img',
    ]) {
      const els = await frame.$$(sel).catch(() => []);
      if (els.length > 0) { log('wait', `✅ Result via "${sel}"`); return els[0]; }
    }
    await sleep(2000);
  }
  throw new Error(`Generation timed out after ${timeoutMs / 1000}s.`);
}

async function downloadResult(frame, page, thumbnail, ticketId) {
  // Click thumbnail to open full-size viewer
  try { await thumbnail.click(); } catch (_) {
    await thumbnail.evaluate(el => {
      let n = el;
      for (let i = 0; i < 5; i++) {
        n = n.parentElement; if (!n) break;
        const tag = n.tagName?.toLowerCase();
        if (tag === 'button' || tag === 'a' || n.getAttribute('role') === 'button')
          return n.click();
      }
      el.click();
    });
  }
  await sleep(2000);

  // Wait for the download button
  const dlDeadline = Date.now() + 20_000;
  let dlBtn = null;
  while (Date.now() < dlDeadline && !dlBtn) {
    for (const sel of [
      'a:has-text("تحميل")', 'button:has-text("تحميل")',
      '[role="button"]:has-text("تحميل")',
      'a[download]', 'a[href^="data:"]', 'a[href^="blob:"]',
    ]) {
      for (const el of await frame.$$(sel).catch(() => [])) {
        if (await el.isVisible().catch(() => false)) { dlBtn = el; break; }
      }
      if (dlBtn) break;
    }
    if (!dlBtn) await sleep(1000);
  }
  if (!dlBtn) throw new Error('"تحميل" button did not appear within 20s.');
  log('download', '✅ "تحميل" button found');

  const outPath = path.join(GEN_DIR, `${ticketId}.png`);

  const href = await dlBtn.evaluate(el =>
    el.href || el.getAttribute('href') || ''
  ).catch(() => '');

  async function saveDataUrl(dataUrl) {
    const [, b64] = dataUrl.split(',');
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    return outPath;
  }

  if (href.startsWith('data:')) return saveDataUrl(href);

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
    return saveDataUrl(dataUrl);
  }

  // Intercept download event
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
    dlBtn.click(),
  ]);
  if (dl) { await dl.saveAs(outPath); log('download', `✅ Saved → ${outPath}`); return outPath; }

  // Last resort: grab largest visible img
  await sleep(1000);
  for (const img of await frame.$$('img')) {
    const info = await img.evaluate(e => ({
      src: e.src || '', w: e.getBoundingClientRect().width, nat: e.naturalWidth,
    })).catch(() => ({ src: '', w: 0, nat: 0 }));
    if (info.w > 200 && info.nat > 200 &&
        (info.src.startsWith('data:') || info.src.startsWith('blob:'))) {
      let dataUrl = info.src;
      if (dataUrl.startsWith('blob:')) {
        dataUrl = await frame.evaluate(async u => {
          const r = await fetch(u); const b = await r.blob();
          return new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onloadend = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(b);
          });
        }, dataUrl);
      }
      const [, b64] = dataUrl.split(',');
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
      return outPath;
    }
  }
  throw new Error('Could not capture the generated image.');
}

// ─── Job Worker ────────────────────────────────────────────────────────────────
async function processJob(ticket) {
  const { id, prompt, imageCount } = ticket;
  log('job', `[${id.slice(0, 8)}] Starting — "${prompt}" ×${imageCount}`);

  ticket.status    = 'processing';
  ticket.startedAt = Date.now();
  const qi = queueOrder.indexOf(id);
  if (qi !== -1) queueOrder.splice(qi, 1);

  let context = null;
  try {
    const browser = await getBrowser();
    const cookies  = loadCookies();

    context = await browser.newContext({
      viewport:          { width: 1400, height: 900 },
      userAgent:         'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale:            'ar-SA',
      timezoneId:        'Asia/Riyadh',
      bypassCSP:         true,
      ignoreHTTPSErrors: true,
      acceptDownloads:   true,
    });
    await context.addCookies(cookies);

    const page = await context.newPage();
    page.on('pageerror', e => log('page-err', e.message.slice(0, 80)));

    log('job', `[${id.slice(0, 8)}] Navigating…`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    log('job', `[${id.slice(0, 8)}] Title: "${await page.title()}"`);

    log('job', `[${id.slice(0, 8)}] Waiting for Canvas iframe to appear…`);
    await page.waitForSelector('iframe', { timeout: 30_000 });
    log('job', `[${id.slice(0, 8)}] Iframe detected — settling ${CANVAS_WAIT / 1000}s…`);
    await sleep(CANVAS_WAIT);

    const frame = await findCanvasFrame(page);
    await sleep(1500);

    await enterPrompt(frame, prompt);
    await sleep(600);
    await setCount(frame, imageCount);
    await sleep(600);
    await clickGenerate(frame);

    log('job', `[${id.slice(0, 8)}] Waiting for thumbnails…`);
    const thumbnail = await waitForThumbnails(frame, GEN_TIMEOUT);
    await sleep(1500);

    await downloadResult(frame, page, thumbnail, id);

    ticket.status      = 'completed';
    ticket.imageUrl    = `${BASE}/generated/${id}.png`;
    ticket.completedAt = Date.now();
    log('job', `[${id.slice(0, 8)}] ✅ Completed → ${ticket.imageUrl}`);

  } catch (err) {
    ticket.status      = 'failed';
    ticket.error       = err.message;
    ticket.completedAt = Date.now();
    log('job', `[${id.slice(0, 8)}] ❌ Failed: ${err.message}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

const jobQueue = new ConcurrentQueue(CONCURRENCY, processJob);

// ─── Express App ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Serve public/ as static files under BASE prefix
app.use(BASE, express.static(PUBLIC_DIR));

// Redirect bare /canvas-app → /canvas-app/
app.get(BASE, (req, res) => res.redirect(BASE + '/'));

// Health check
app.get(`${BASE}/api/health`, (_req, res) => {
  res.json({
    ok:      true,
    browser: sharedBrowser ? sharedBrowser.isConnected() : false,
    queue:   { concurrency: CONCURRENCY, running: jobQueue.running, pending: jobQueue.pending.length },
  });
});

// POST /api/generate — submit a new job
app.post(`${BASE}/api/generate`, (req, res) => {
  const { prompt, image_count } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const count  = Math.max(1, Math.min(10, parseInt(image_count, 10) || 1));
  const ticket = createTicket(prompt.trim(), count);
  log('api', `New job ${ticket.id.slice(0, 8)} — "${ticket.prompt}" ×${count} | queue size: ${jobQueue.size + 1}`);
  jobQueue.push(ticket);
  res.status(202).json({ ticketId: ticket.id, status: ticket.status, position: getQueuePosition(ticket.id) });
});

// GET /api/status/:ticketId — poll job status
app.get(`${BASE}/api/status/:ticketId`, (req, res) => {
  const ticket = tickets.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const response = {
    ticketId:    ticket.id,
    status:      ticket.status,
    prompt:      ticket.prompt,
    imageCount:  ticket.imageCount,
    createdAt:   ticket.createdAt,
    startedAt:   ticket.startedAt,
    completedAt: ticket.completedAt,
  };
  if (ticket.status === 'queued')     response.position = getQueuePosition(ticket.id);
  if (ticket.status === 'completed')  response.imageUrl  = ticket.imageUrl;
  if (ticket.status === 'failed')     response.error     = ticket.error;
  res.json(response);
});

// ─── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  ensureDir(GEN_DIR);

  if (!fs.existsSync(COOKIES_PATH)) {
    log('start', `⚠️  cookies.json not found at ${COOKIES_PATH}`);
    log('start', '    Generation will fail — add cookies.json to the workspace root');
  } else {
    try {
      const cookies = loadCookies();
      log('start', `✅ Loaded ${cookies.length} cookies from cookies.json`);
    } catch (e) {
      log('start', `⚠️  cookies.json parse error: ${e.message}`);
    }
  }

  try {
    await getBrowser();
  } catch (err) {
    log('start', `⚠️  Browser pre-launch failed: ${err.message}`);
    log('start', '    Will retry on first generation request');
  }

  app.listen(PORT, '0.0.0.0', () => {
    log('start', `✅ Server listening on port ${PORT}`);
    log('start', `   UI      → http://localhost:${PORT}${BASE}/`);
    log('start', `   Health  → http://localhost:${PORT}${BASE}/api/health`);
    log('start', `   Generate→ POST http://localhost:${PORT}${BASE}/api/generate`);
    log('start', `   Status  → GET  http://localhost:${PORT}${BASE}/api/status/:ticketId`);
    log('start', `   Concurrency: ${CONCURRENCY} parallel jobs`);
  });
}

start().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
