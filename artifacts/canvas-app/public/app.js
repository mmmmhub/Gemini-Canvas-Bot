'use strict';

const BASE     = window.APP_BASE || '/canvas-app';
const POLL_MS  = 3000;
const MAX_PROG = 88; // cap while still processing

// ── DOM refs ────────────────────────────────────────────────────
const promptInput = document.getElementById('promptInput');
const countInput  = document.getElementById('countInput');
const generateBtn = document.getElementById('generateBtn');
const btnText     = document.getElementById('btnText');

const statusCard  = document.getElementById('statusCard');
const jobIcon     = document.getElementById('jobIcon');
const jobTitle    = document.getElementById('jobTitle');
const jobDesc     = document.getElementById('jobDesc');
const progressFill= document.getElementById('progressFill');
const jobMeta     = document.getElementById('jobMeta');

const resultCard  = document.getElementById('resultCard');
const resultImg   = document.getElementById('resultImg');
const downloadBtn = document.getElementById('downloadBtn');

const serverDot   = document.getElementById('serverDot');
const serverText  = document.getElementById('serverText');

// ── State ────────────────────────────────────────────────────────
let pollTimer   = null;
let progTimer   = null;
let currentPct  = 0;

// ── Server health ping ───────────────────────────────────────────
async function ping() {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      serverDot.className  = 'status-dot ready';
      serverText.textContent = 'Ready';
    } else throw 0;
  } catch {
    serverDot.className  = 'status-dot offline';
    serverText.textContent = 'Offline';
  }
}
ping();
setInterval(ping, 30_000);

// ── Progress helpers ─────────────────────────────────────────────
function setProgress(pct) {
  currentPct = Math.min(100, Math.max(0, pct));
  progressFill.style.width = currentPct + '%';
}

function animateTo(target, ms) {
  clearInterval(progTimer);
  const start = currentPct;
  const steps = 40;
  let i = 0;
  progTimer = setInterval(() => {
    i++;
    setProgress(start + (target - start) * (i / steps));
    if (i >= steps) clearInterval(progTimer);
  }, ms / steps);
}

function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(progTimer);
}

// ── Icon markup ──────────────────────────────────────────────────
const ICON = {
  queued:
    `<svg width="17" height="17" viewBox="0 0 17 17" fill="none">
       <circle cx="8.5" cy="8.5" r="6.5" stroke="currentColor" stroke-width="1.5"/>
       <path d="M8.5 5V8.5L11 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
     </svg>`,
  processing: `<div class="spinner"></div>`,
  completed:
    `<svg width="17" height="17" viewBox="0 0 17 17" fill="none">
       <circle cx="8.5" cy="8.5" r="6.5" stroke="currentColor" stroke-width="1.5"/>
       <path d="M5.5 8.5L7.5 10.5L11.5 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
     </svg>`,
  failed:
    `<svg width="17" height="17" viewBox="0 0 17 17" fill="none">
       <circle cx="8.5" cy="8.5" r="6.5" stroke="currentColor" stroke-width="1.5"/>
       <path d="M6 11L11 6M11 11L6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
     </svg>`,
};

function setVariant(v) {
  statusCard.className = `card card-status state-${v}`;
}

// ── Meta chips ───────────────────────────────────────────────────
function renderMeta(ticket) {
  const chips = [`#${ticket.ticketId.slice(0, 8)}`];
  if (ticket.imageCount) chips.push(`${ticket.imageCount} image${ticket.imageCount > 1 ? 's' : ''}`);
  if (ticket.status === 'queued' && ticket.position)
    chips.push(`queue pos ${ticket.position}`);
  if (ticket.startedAt)
    chips.push(`${Math.round((Date.now() - ticket.startedAt) / 1000)}s elapsed`);
  jobMeta.innerHTML = chips.map(c => `<span class="meta-chip">${c}</span>`).join('');
}

// ── Polling ──────────────────────────────────────────────────────
async function poll(ticketId) {
  let data;
  try {
    const r = await fetch(`${BASE}/api/status/${ticketId}`);
    data = await r.json();
  } catch {
    pollTimer = setTimeout(() => poll(ticketId), POLL_MS * 2);
    return;
  }

  renderMeta(data);

  if (data.status === 'queued') {
    setVariant('queued');
    jobIcon.innerHTML  = ICON.queued;
    const pos = data.position || 1;
    jobTitle.textContent = pos === 1 ? 'Next in queue' : `Queue position ${pos}`;
    jobDesc.textContent  = 'Waiting for an available worker (max 3 run simultaneously).';
    animateTo(10, 600);
    pollTimer = setTimeout(() => poll(ticketId), POLL_MS);
    return;
  }

  if (data.status === 'processing') {
    setVariant('processing');
    jobIcon.innerHTML  = ICON.processing;
    jobTitle.textContent = 'Generating…';
    jobDesc.textContent  = 'Gemini Canvas is working on your image. This usually takes 30–120 seconds.';
    animateTo(MAX_PROG, 100_000);
    pollTimer = setTimeout(() => poll(ticketId), POLL_MS);
    return;
  }

  if (data.status === 'completed') {
    stopTimers();
    setProgress(100);
    setVariant('completed');
    jobIcon.innerHTML  = ICON.completed;
    const secs = data.completedAt && data.startedAt
      ? Math.round((data.completedAt - data.startedAt) / 1000) : null;
    jobTitle.textContent = 'Image ready!';
    jobDesc.textContent  = secs ? `Completed in ${secs}s.` : 'Your image has been generated.';

    // Show result card
    resultImg.src        = data.imageUrl;
    downloadBtn.href     = data.imageUrl;
    resultCard.hidden    = false;

    generateBtn.disabled = false;
    btnText.textContent  = 'Generate Another';
    return;
  }

  if (data.status === 'failed') {
    stopTimers();
    setProgress(0);
    setVariant('failed');
    jobIcon.innerHTML    = ICON.failed;
    jobTitle.textContent = 'Generation failed';
    jobDesc.textContent  = data.error || 'An unexpected error occurred. Please try again.';
    generateBtn.disabled = false;
    btnText.textContent  = 'Try Again';
    return;
  }

  pollTimer = setTimeout(() => poll(ticketId), POLL_MS);
}

// ── Generate ─────────────────────────────────────────────────────
generateBtn.addEventListener('click', async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    promptInput.focus();
    promptInput.style.borderColor = 'var(--red)';
    setTimeout(() => (promptInput.style.borderColor = ''), 1800);
    return;
  }

  const count = Math.max(1, parseInt(countInput.value, 10) || 1);

  stopTimers();
  generateBtn.disabled  = true;
  btnText.textContent   = 'Submitting…';

  // Reset UI
  resultCard.hidden     = true;
  resultImg.src         = '';
  jobMeta.innerHTML     = '';
  setProgress(0);

  // Show status card immediately
  statusCard.hidden     = false;
  setVariant('queued');
  jobIcon.innerHTML     = ICON.queued;
  jobTitle.textContent  = 'Submitting request…';
  jobDesc.textContent   = 'Connecting to server…';

  let data;
  try {
    const res = await fetch(`${BASE}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt, image_count: count }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    stopTimers();
    setVariant('failed');
    jobIcon.innerHTML    = ICON.failed;
    jobTitle.textContent = 'Could not submit request';
    jobDesc.textContent  = err.message;
    generateBtn.disabled = false;
    btnText.textContent  = 'Try Again';
    return;
  }

  btnText.textContent = 'Generating…';
  animateTo(8, 400);
  poll(data.ticketId);
});

promptInput.addEventListener('input', () => (promptInput.style.borderColor = ''));
