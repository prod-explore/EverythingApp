let TOKEN = localStorage.getItem('everythingapp_token') || '';
let lastSeenTurnId = 0;
let renderedHistoryLength = 0;
let busy = false;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    localStorage.removeItem('everythingapp_token');
    location.reload();
    throw new Error('unauthorized');
  }
  return res.json();
}

function setBusy(v) {
  busy = v;
  document.getElementById('sendBtn').disabled = v;
  document.getElementById('thinking').style.display = v ? 'block' : 'none';
}

function renderHistory(history) {
  const log = document.getElementById('log');
  log.innerHTML = '';
  for (const msg of history) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      appendMsg('user', msg.content);
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) appendMsg('assistant', block.text);
        if (block.type === 'tool_use') appendMsg('tool', `[narzędzie] ${block.name}`);
      }
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') appendMsg('tool', block.is_error ? '[błąd narzędzia]' : '[wynik narzędzia]');
      }
    }
  }
  log.scrollTop = log.scrollHeight;
  renderedHistoryLength = history.length;
}

function appendMsg(cls, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  document.getElementById('log').appendChild(div);
  document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;
}

function renderUsage(summary) {
  document.getElementById('usage').textContent = summary;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function pollApprovals() {
  try {
    const { pending } = await api('/pending-approvals');
    const box = document.getElementById('approvals');
    box.innerHTML = '';
    for (const p of pending) {
      const card = document.createElement('div');
      card.className = 'approval-card' + (p.dangerous ? ' dangerous' : '');
      card.innerHTML = `
        ${p.dangerous ? '<div class="warn">⚠️ WYGLĄDA NA RYZYKOWNE / NIEODWRACALNE</div>' : ''}
        <div class="label">${escapeHtml(p.toolLabel)}</div>
        <pre>${escapeHtml(JSON.stringify(p.args, null, 2))}</pre>
        <div class="buttons">
          <button class="btn-deny" data-action="deny" data-id="${p.id}">Odrzuć</button>
          <button class="btn-approve" data-action="approve" data-id="${p.id}">Zatwierdź</button>
          ${p.dangerous ? '' : `<button class="btn-always" data-action="always" data-id="${p.id}">Zawsze</button>`}
        </div>`;
      box.appendChild(card);
    }
  } catch (e) { /* ignore transient polling errors */ }
}

// Event delegation on the container instead of a per-button inline handler —
// works under a strict script-src CSP (no 'unsafe-inline') and means each
// approval card doesn't need its own listener wired up as it's created.
document.getElementById('approvals').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const approved = btn.dataset.action !== 'deny';
  const alwaysAllow = btn.dataset.action === 'always';
  await api('/approve', { method: 'POST', body: JSON.stringify({ id, approved, alwaysAllow }) });
  pollApprovals();
});

// Covers three cases with one loop: our own turn finishing, a batch
// resolving in the background (server checks it periodically — the reply
// just shows up in `history` with no turnId of its own), and reload-mid-turn
// (status.id already reflects whatever was in flight before the reload).
async function pollStatus() {
  try {
    const s = await api('/status');
    renderUsage(s.usage);

    if (s.status === 'running') {
      setBusy(true);
      return;
    }

    if (s.id !== lastSeenTurnId) {
      lastSeenTurnId = s.id;
      if (s.status === 'error') appendMsg('tool', '[błąd] ' + s.error);
      renderHistory(s.history); // covers 'done' and 'idle' (e.g. right after an error)
    } else if (s.history.length !== renderedHistoryLength) {
      // Our own turn isn't what changed (same id) — a batch resolved in the background.
      renderHistory(s.history);
    }

    setBusy(false);
  } catch (e) { /* transient — next poll will retry */ }
}

async function sendMessage(evt) {
  evt.preventDefault();
  if (busy) return;
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  if (text.startsWith('/schedule ')) {
    setBusy(true);
    appendMsg('user', text);
    try {
      const result = await api('/schedule', { method: 'POST', body: JSON.stringify({ text: text.slice('/schedule '.length) }) });
      if (result.error) throw new Error(result.error);
      appendMsg('tool', `[batch] zakolejkowano (id: ${result.entry.batchId})`);
    } catch (e) {
      appendMsg('tool', '[błąd] ' + e.message);
    } finally {
      setBusy(false);
    }
    return;
  }

  setBusy(true);
  appendMsg('user', text); // optimistic — pollStatus() reconciles once the turn resolves
  try {
    const result = await api('/message', { method: 'POST', body: JSON.stringify({ text }) });
    if (result.error) {
      appendMsg('tool', '[błąd] ' + result.error);
      setBusy(false);
    }
    // else: leave busy=true, pollStatus() picks up 'running' → 'done'/'error'
  } catch (e) {
    appendMsg('tool', '[błąd] ' + e.message);
    setBusy(false);
  }
}

async function boot() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const status = await api('/status');
  lastSeenTurnId = status.id;
  renderUsage(status.usage);
  if (status.status === 'running') {
    setBusy(true);
    renderHistory(status.history);
  } else {
    const { history } = await api('/history');
    renderHistory(history);
  }
  setInterval(pollStatus, 1500);
  setInterval(pollApprovals, 1500);
}

function saveToken() {
  const value = document.getElementById('tokenInput').value.trim();
  if (!value) return;
  TOKEN = value;
  localStorage.setItem('everythingapp_token', TOKEN);
  boot();
}

document.getElementById('loginBtn').addEventListener('click', saveToken);
document.getElementById('tokenInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveToken();
});
document.getElementById('form').addEventListener('submit', sendMessage);
document.getElementById('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('form').requestSubmit();
  }
});

if (TOKEN) boot();
