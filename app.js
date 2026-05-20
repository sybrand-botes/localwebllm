// ── Marked (loaded via <script> tag in index.html) ───────────────────────
function getMarked() {
  return window.marked;
}

// ── Constants ──────────────────────────────────────────────────────────────
// No system prompt — smaller models handle the chat template better without one
const SYSTEM_PROMPT = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const overlay       = document.getElementById('loading-overlay');
const progressBar   = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const loadingStatus = document.getElementById('loading-status');
const messagesEl    = document.getElementById('messages');
const welcomeEl     = document.getElementById('welcome');
const welcomeStatus = document.getElementById('welcome-status');
const userInput     = document.getElementById('user-input');
const sendBtn       = document.getElementById('send-btn');
const modelLabel    = document.getElementById('model-label');
const modelDot      = document.getElementById('model-dot');
const deviceBadge   = document.getElementById('device-badge');
const newChatBtn    = document.getElementById('new-chat-btn');
const sidebar       = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const topbar        = document.getElementById('topbar');
const topbarToggle  = document.getElementById('topbar-toggle');

// ── State ──────────────────────────────────────────────────────────────────
let isGenerating = false;
let messages = SYSTEM_PROMPT
  ? [{ role: 'system', content: SYSTEM_PROMPT }]
  : [];

// Active assistant bubble + raw token accumulator during streaming
let activeBubble   = null;
let activeCursor   = null;
let activeRaw      = '';
let renderPending  = false; // throttle: only one rAF queued at a time

// ── Device detection (async — probes requestAdapter to confirm GPU works) ──
async function detectDevice() {
  if (!navigator.gpu) {
    console.info('[SmolChat] navigator.gpu not present → WASM');
    return { device: 'wasm', dtype: 'q4' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.warn('[SmolChat] navigator.gpu.requestAdapter() returned null → WASM');
      return { device: 'wasm', dtype: 'q4' };
    }
    const info = adapter.info ?? {};
    console.info('[SmolChat] WebGPU adapter found:', info.vendor ?? 'unknown', info.architecture ?? '');
    return { device: 'webgpu', dtype: 'q4f16' };
  } catch (err) {
    console.warn('[SmolChat] WebGPU requestAdapter threw, falling back to WASM:', err);
    return { device: 'wasm', dtype: 'q4' };
  }
}

// Placeholders — set properly in boot() after async probe
let device = 'wasm';
let dtype  = 'q4';

// ── Worker ─────────────────────────────────────────────────────────────────
const worker = new Worker('./worker.js', { type: 'module' });

worker.addEventListener('message', ({ data }) => {
  const { type, payload } = data;

  if (type === 'progress') {
    const { status, file, progress } = payload;
    if (status === 'initiate') {
      loadingStatus.textContent = `Fetching ${file ?? 'model'}…`;
    }
    if (status === 'download' || status === 'progress') {
      const pct = Math.round(progress ?? 0);
      progressBar.style.width   = `${pct}%`;
      progressLabel.textContent = `${pct}%`;
      if (file) loadingStatus.textContent = `Downloading ${file}… ${pct}%`;
    }
    if (status === 'done') {
      loadingStatus.textContent = `Loaded ${file ?? 'file'}.`;
    }
    if (status === 'ready') {
      progressBar.style.width   = '100%';
      progressLabel.textContent = '100%';
      loadingStatus.textContent = 'Model ready!';
    }
    return;
  }

  if (type === 'ready') {
    overlay.classList.add('hidden');
    modelLabel.textContent    = 'SmolLM2 360M ready';
    modelDot.classList.add('ready');
    welcomeStatus.textContent = `Running on ${device.toUpperCase()} — type a message below.`;
    userInput.disabled = false;
    sendBtn.disabled   = false;
    userInput.focus();
    return;
  }

  if (type === 'token') {
    activeRaw += payload;
    // Throttle DOM updates: batch tokens into one render per animation frame
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        activeBubble.innerHTML = getMarked().parse(activeRaw);
        activeBubble.appendChild(activeCursor);
        scrollToBottom();
        renderPending = false;
      });
    }
    return;
  }

  if (type === 'done') {
    // Finalise bubble — do a final render regardless of pending rAF
    renderPending = false;
    activeCursor.remove();
    activeBubble.innerHTML = getMarked().parse(activeRaw);
    messages.push({ role: 'assistant', content: activeRaw });
    activeBubble  = null;
    activeCursor  = null;
    activeRaw     = '';
    isGenerating  = false;
    setInputEnabled(true);
    userInput.focus();
    scrollToBottom();
    return;
  }

  if (type === 'error') {
    overlay.classList.add('hidden');
    modelLabel.textContent = 'Error';
    modelDot.classList.add('error');
    if (activeCursor) activeCursor.remove();
    if (activeBubble && !activeRaw) {
      activeBubble.textContent = `Error: ${payload}`;
    }
    activeBubble  = null;
    activeCursor  = null;
    activeRaw     = '';
    renderPending = false;
    isGenerating  = false;
    setInputEnabled(true);
    appendError(payload);
  }
});

// ── Sidebar toggle ─────────────────────────────────────────────────────────
function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  topbar.classList.toggle('visible', collapsed);
}
sidebarToggle.addEventListener('click', () => setSidebarCollapsed(true));
topbarToggle.addEventListener('click',  () => setSidebarCollapsed(false));

// ── Chat helpers ───────────────────────────────────────────────────────────
function hideWelcome() {
  const el = document.getElementById('welcome');
  if (el) el.remove();
}

function appendUserMessage(text) {
  hideWelcome();
  const row = document.createElement('div');
  row.className = 'message-row user';
  row.innerHTML = `<div class="message-bubble">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(row);
  scrollToBottom();
}

function appendAssistantMessage() {
  hideWelcome();
  const row = document.createElement('div');
  row.className = 'message-row assistant';
  row.innerHTML = `<div class="role-label">SmolChat</div><div class="message-bubble" data-raw=""></div>`;
  messagesEl.appendChild(row);
  scrollToBottom();
  return row.querySelector('.message-bubble');
}

function appendError(msg) {
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.textContent = msg;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setInputEnabled(enabled) {
  userInput.disabled = !enabled;
  sendBtn.disabled   = !enabled;
}

// ── Auto-resize textarea ───────────────────────────────────────────────────
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = `${Math.min(userInput.scrollHeight, 200)}px`;
});

// ── Send on Enter (Shift+Enter = newline) ──────────────────────────────────
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});
sendBtn.addEventListener('click', sendMessage);

// ── Send message ───────────────────────────────────────────────────────────
function sendMessage() {
  if (isGenerating) return;

  const text = userInput.value.trim();
  if (!text) return;

  userInput.value = '';
  userInput.style.height = 'auto';
  setInputEnabled(false);

  messages.push({ role: 'user', content: text });
  appendUserMessage(text);

  activeBubble = appendAssistantMessage();
  activeCursor = document.createElement('span');
  activeCursor.className = 'cursor';
  activeBubble.appendChild(activeCursor);
  activeRaw = '';

  isGenerating = true;
  worker.postMessage({ type: 'generate', payload: { messages } });
}

// ── New Chat ───────────────────────────────────────────────────────────────
newChatBtn.addEventListener('click', () => {
  if (isGenerating) return;
  messages = SYSTEM_PROMPT
    ? [{ role: 'system', content: SYSTEM_PROMPT }]
    : [];
  messagesEl.innerHTML = '';

  const welcome = document.createElement('div');
  welcome.className = 'welcome';
  welcome.id = 'welcome';
  welcome.innerHTML = `
    <h1>SmolChat</h1>
    <p>Powered by <strong>SmolLM2&nbsp;135M</strong> running entirely in your browser.</p>
    <p class="welcome-sub">Running on ${device.toUpperCase()} — type a message below.</p>
  `;
  messagesEl.appendChild(welcome);
  userInput.focus();
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  ({ device, dtype } = await detectDevice());
  deviceBadge.textContent   = `${device.toUpperCase()} · ${dtype}`;
  welcomeStatus.textContent = `Downloading SmolLM2 360M (${device.toUpperCase()})…`;
  worker.postMessage({ type: 'load', payload: { device, dtype } });
}

boot();
