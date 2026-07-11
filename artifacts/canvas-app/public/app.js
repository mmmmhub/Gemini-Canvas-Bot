'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE          = window.APP_BASE || '/canvas-app';
const POLL_MS       = 3000;   // polling interval
const PROGRESS_MAX  = 90;     // max % while still processing

// ─── DOM ──────────────────────────────────────────────────────────────────────
const promptInput = document.getElementById('promptInput');
const countInput  = document.getElementById('countInput');
const generateBtn = document.getElementById('generateBtn');
const btnLabel    = document.getElementById('btnLabel');
const statusCard  = document.getElementById('statusCard');
const statusRow   = document.getElementById('statusRow');
const statusIcon  = document.getElementById('statusIcon');
const statusLabel = document.getElementById('statusLabel');
const statusDesc  = document.getElementById('statusDesc');
const progressFill= document.getElementById('progressFill');
const metaRow     = document.getElementById('metaRow');
const result      = document.getElementById('result');
const resultImg   = document.getElementById('resultImg');
const downloadBtn = document.getElementById('downloadBtn');
const queueHint   = document.getElementById('queueHint');
const serverDot   = document.getElementById('serverDot');
const serverLabel = document.getElementById('serverLabel');

// ─── State ────────────────────────────────────────────────────────────────────
let pollTimer    = null;
let progTimer    = null;
let progressPct  = 0;

// ─── Server Status Ping ───────────────────────────────────────────────────────
async function pingServer() {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      serverDot.className   = 'badge-dot online';
      serverLabel.textContent = 'Ready';
    } else throw new Error();
  } catch {
    serverDot.className     = 'badge-dot offline';
    serverLabel.textContent = 'Offline';
  }
}
pingServer();
setInterval(pingServer, 30_000);

// ─── Progress Helpers ─────────────────────────────────────────────────────────
function setProgress(pct) {
  progressPct = Math.min(100, Math.max(0, pct));
  progressFill.style.width = progressPct + '%';
}

function animateProgressTo(target, durationMs) {
  clearInterval(progTimer);
  const start = progressPct;
  const delta = target - start;
  const steps = 40;
  const msPerStep = durationMs / steps;
  let i = 0;
  progTimer = setInterval(() => {
    i++;
    setProgress(start + delta * (i / steps));
    if (i >= steps) clearInterval(progTimer);
  }, msPerStep);
}

function stopAll() {
  clearTimeout(pollTimer);
  clearInterval(progTimer);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function elapsed(fromMs) {
  const s = Math.round((Date.now() - fromMs) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function showStatusCard() {
  statusCard.hidden = false;
  queueHint.hidden  = false;
}

function applyVariant(variant) {
  statusCard.className = `card card-status state-${variant}`;
}

function renderMeta(ticket) {
  const chips = [
    `#${ticket.ticketId.slice(0, 8)}`,
    `${ticket.imageCount || 1} image${(ticket.imageCount || 1) > 1 ? 's' : ''}`,
  ];
  if (ticket.startedAt) chips.push(`running ${elapsed(ticket.startedAt)}`);
  metaRow.innerHTML = chips.map(c => `<span class="meta-chip">${c}</span>`).join('');
}

// Icon SVG templates
const ICONS = {
  queued:
    `<svg width="19" height="19" viewBox="0 0 19 19" fill="none"><circle cx="9.5" cy="9.5" r="7.5" stroke="currentColor" stroke-width="1.55"/><path d="M9.5 5.5V9.5L12 12" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/></svg>`,
  processing:
    `<div class="spinner"></div>`,
  completed:
    `<svg width="19" height="19" viewBox="0 0 19 19" fill="none"><circle cx="9.5" cy="9.5" r="7.5" stroke="currentColor" stroke-width="1.55"/><path d="M6 9.5L8.5 12L13 7" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  failed:
    `<svg width="19" height="19" viewBox="0 0 19 19" fill="none"><circle cx="9.5" cy="9.5" r="7.5" stroke="currentColor" stroke-width="1.55"/><path d="M7 12L12 7M12 12L7 7" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/></svg>`,
};

// ─── Poll ─────────────────────────────────────────────────────────────────────
async function poll(ticketId) {
  let data;
  try {
    const r = await fetch(`${BASE}/api/status/${ticketId}`);
    data = await r.json();
  } catch {
    // Network hiccup — retry soon
    pollTimer = setTimeout(() => poll(ticketId), POLL_MS * 2);
    return;
  }

  renderMeta(data);

  switch (data.status) {
    case 'queued': {
      const pos = data.position || 1;
      applyVariant('queued');
      statusIcon.innerHTML  = ICONS.queued;
      statusLabel.textContent = pos === 1 ? 'Next in queue' : `Position ${pos} in queue`;
      statusDesc.textContent  = `Waiting for a worker slot. Up to ${CONCURRENCY} jobs run simultaneously.`;
      queueHint.hidden = false;
      animateProgressTo(12, 800);
      pollTimer = setTimeout(() => poll(ticketId), POLL_MS);
      break;
    }

    case 'processing': {
      applyVariant('processing');
      statusIcon.innerHTML  = ICONS.processing;
      statusLabel.textContent = 'Generating your image…';
      statusDesc.textContent  = 'Gemini Canvas is working on it. This usually takes 30–120 seconds.';
      animateProgressTo(PROGRESS_MAX, 100_000);
      pollTimer = setTimeout(() => poll(ticketId), POLL_MS);
      break;
    }

    case 'completed': {
      stopAll();
      setProgress(100);
      applyVariant('completed');
      statusIcon.innerHTML  = ICONS.completed;
      statusLabel.textContent = '✨ Image generated!';
      const dur = data.completedAt && data.startedAt
        ? `Completed in ${Math.round((data.completedAt - data.startedAt) / 1000)}s.`
        : 'Your image is ready.';
      statusDesc.textContent = dur;
      queueHint.hidden = true;

      result.hidden     = false;
      resultImg.src     = data.imageUrl;
      downloadBtn.href  = data.imageUrl;

      generateBtn.disabled = false;
      btnLabel.textContent = 'Generate Another';
      break;
    }

    case 'failed': {
      stopAll();
      setProgress(0);
      applyVariant('failed');
      statusIcon.innerHTML  = ICONS.failed;
      statusLabel.textContent = 'Generation failed';
      statusDesc.textContent  = data.error || 'An unexpected error occurred. Please try again.';
      queueHint.hidden = true;
      generateBtn.disabled = false;
      btnLabel.textContent = 'Try Again';
      break;
    }

    default:
      pollTimer = setTimeout(() => poll(ticketId), POLL_MS);
  }
}

const CONCURRENCY = 3;

// ─── Generate ─────────────────────────────────────────────────────────────────
generateBtn.addEventListener('click', async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    promptInput.focus();
    promptInput.style.outline = '2px solid var(--red)';
    setTimeout(() => (promptInput.style.outline = ''), 1800);
    return;
  }

  const count = Math.max(1, parseInt(countInput.value, 10) || 1);

  // Reset state
  stopAll();
  generateBtn.disabled = true;
  btnLabel.textContent = 'Submitting…';
  result.hidden        = true;
  resultImg.src        = '';
  metaRow.innerHTML    = '';
  setProgress(0);

  showStatusCard();
  applyVariant('queued');
  statusIcon.innerHTML    = ICONS.queued;
  statusLabel.textContent = 'Submitting request…';
  statusDesc.textContent  = 'Connecting to server…';

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
    stopAll();
    applyVariant('failed');
    statusIcon.innerHTML    = ICONS.failed;
    statusLabel.textContent = 'Could not submit request';
    statusDesc.textContent  = err.message;
    generateBtn.disabled = false;
    btnLabel.textContent = 'Try Again';
    return;
  }

  btnLabel.textContent = 'Generating…';
  animateProgressTo(8, 500);
  poll(data.ticketId);
});

// Clear red outline when user types
promptInput.addEventListener('input', () => { promptInput.style.outline = ''; });
