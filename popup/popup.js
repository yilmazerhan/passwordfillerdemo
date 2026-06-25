import { extractDomain } from '../lib/vault.js';

const app = document.getElementById('app');

let activeTab = null;
let activeDomain = '';

function msg(payload) {
  return new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeDomain = activeTab?.url ? extractDomain(activeTab.url) : '';

  // Opening the popup is an action gesture; flush any pending recording start.
  if (activeTab?.id != null) msg({ type: 'popupReady', tabId: activeTab.id });

  const { vault } = await chrome.storage.local.get('vault');
  const status    = await msg({ type: 'getStatus' });

  if (!vault)            renderNoVault();
  else if (status.locked) renderUnlock();
  else                    renderMatches();
}

// ── no vault yet ─────────────────────────────────────────────────────────────

function renderNoVault() {
  app.innerHTML = '';
  app.appendChild(header());
  app.appendChild(el('p', { className: 'empty' }, 'No vault yet. Create one to get started.'));
  app.appendChild(el('button', { className: 'btn-primary', onclick: openOptions }, 'Set up vault'));
}

// ── unlock ───────────────────────────────────────────────────────────────────

function renderUnlock() {
  app.innerHTML = '';
  app.appendChild(header());

  const errEl = el('p', { className: 'error hidden' });
  const pwEl  = el('input', { type: 'password', placeholder: 'Master password' });

  const form = el('form', {
    onsubmit: async e => {
      e.preventDefault();
      errEl.classList.add('hidden');
      const res = await msg({ type: 'unlock', masterPassword: pwEl.value });
      if (res.ok) renderMatches();
      else { errEl.textContent = res.error; errEl.classList.remove('hidden'); }
    }
  },
    pwEl,
    errEl,
    el('button', { type: 'submit', className: 'btn-primary' }, 'Unlock')
  );
  app.appendChild(form);
  pwEl.focus();
}

// ── matches for the active tab ───────────────────────────────────────────────

async function renderMatches() {
  app.innerHTML = '';
  app.appendChild(header());

  const { matches } = await msg({ type: 'getMatches', domain: activeDomain });

  const list = el('ul', { className: 'cred-list' });
  if (!matches || matches.length === 0) {
    list.appendChild(el('li', { className: 'empty' },
      activeDomain ? `No saved logins for ${activeDomain}.` : 'No matching logins for this page.'));
  } else {
    matches.forEach(m => list.appendChild(credItem(m)));
  }
  app.appendChild(list);

  app.appendChild(await recordingRow());
  app.appendChild(footer());
}

// Recording status + control for the active tab.
async function recordingRow() {
  const row = el('div', { className: 'rec-row' });
  if (activeTab?.id == null) return row;

  const status = await msg({ type: 'recordStatus', tabId: activeTab.id });

  if (status.state === 'recording-here') {
    row.appendChild(el('span', { className: 'rec-dot live' }));
    row.appendChild(el('span', { className: 'rec-label' }, 'Recording this tab'));
    row.appendChild(el('button', {
      className: 'btn-stop', onclick: () => stopRecording(),
    }, '■ Stop & save'));
  } else if (status.state === 'recording-other-tab') {
    row.appendChild(el('span', { className: 'rec-dot live' }));
    row.appendChild(el('span', { className: 'rec-label' }, 'Recording this site (another tab)'));
    row.appendChild(el('button', {
      className: 'btn-ghost', onclick: () => startRecording(),
    }, 'Record here'));
    row.appendChild(el('button', {
      className: 'btn-stop', onclick: () => stopRecording(),
    }, '■ Stop & save'));
  } else if (status.state === 'idle') {
    row.appendChild(el('span', { className: 'rec-dot' }));
    row.appendChild(el('span', { className: 'rec-label' }, 'Not recording'));
    row.appendChild(el('button', {
      className: 'btn-ghost', onclick: () => startRecording(),
    }, '● Record this tab'));
  } else {
    return el('div', { className: 'rec-row hidden' }); // unsupported page
  }
  return row;
}

async function startRecording() {
  await msg({ type: 'recordStart', tabId: activeTab.id });
  renderMatches(); // refresh status row
}

async function stopRecording() {
  await msg({ type: 'recordStop', tabId: activeTab.id });
  showToast('Recording saved — open Manage vault → Recordings');
  renderMatches(); // refresh status row
}

function credItem(m) {
  const fillAndClose = async () => {
    const ok = await fillActiveTab(m.id);
    if (ok) {
      // Popup fill carries an action gesture, so recording can start immediately.
      if (activeTab?.id != null) msg({ type: 'recordStart', tabId: activeTab.id });
      showToast('Filled ✓'); setTimeout(() => window.close(), 600);
    } else showToast('No login fields found on this page.');
  };

  return el('li', { className: 'cred-item', onclick: fillAndClose },
    el('div', { className: 'cred-favicon' }, (m.title || m.domain || '?')[0].toUpperCase()),
    el('div', { className: 'cred-info' },
      el('div', { className: 'cred-title' }, m.title || m.domain || 'Untitled'),
      el('div', { className: 'cred-user' }, m.username)
    ),
    el('div', { className: 'cred-actions' },
      el('button', {
        className: 'btn-icon', title: 'Copy username',
        onclick: e => { e.stopPropagation(); copyField(m.id, 'username'); }
      }, '👤'),
      el('button', {
        className: 'btn-icon', title: 'Copy password',
        onclick: e => { e.stopPropagation(); copyField(m.id, 'password'); }
      }, '🔑')
    )
  );
}

// ── fill / copy actions ──────────────────────────────────────────────────────

async function fillActiveTab(id) {
  const { credential } = await msg({ type: 'getCredential', id });
  if (!credential || !activeTab) return false;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: fillForm,
    args: [credential.username, credential.password],
  });
  return result?.result === true;
}

async function copyField(id, field) {
  const { credential } = await msg({ type: 'getCredential', id });
  if (!credential) return;
  await navigator.clipboard.writeText(credential[field]);
  showToast(field === 'username' ? 'Username copied' : 'Password copied');
}

// Injected into the page. Must be self-contained (no closure over popup scope).
function fillForm(username, password) {
  const isVisible = el => el.offsetParent !== null && !el.disabled && !el.readOnly;

  const pwFields = [...document.querySelectorAll('input[type="password"]')].filter(isVisible);
  if (pwFields.length === 0) return false;
  const pw = pwFields[0];

  // Find the username field: nearest preceding text/email/tel input in the same form.
  const form = pw.form || document;
  const candidates = [...form.querySelectorAll('input')].filter(i =>
    isVisible(i) && ['text', 'email', 'tel', ''].includes(i.type) && i !== pw);
  const userField = candidates.reverse().find(i =>
    i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) || candidates[0];

  const setValue = (input, value) => {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (userField) setValue(userField, username);
  setValue(pw, password);
  return true;
}

// ── shared chrome / UI helpers ───────────────────────────────────────────────

function header() {
  return el('div', { className: 'head' },
    el('div', { className: 'title' }, '🔑 Password Filler'),
    activeDomain ? el('div', { className: 'domain' }, activeDomain) : ''
  );
}

function footer() {
  return el('div', { className: 'foot' },
    el('button', { className: 'btn-ghost', onclick: openOptions }, 'Manage vault'),
    el('button', {
      className: 'btn-ghost',
      onclick: async () => { await msg({ type: 'lock' }); renderUnlock(); }
    }, 'Lock')
  );
}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}

function showToast(text) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', { className: 'toast' }); app.appendChild(t); }
  t.textContent = text;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node[k] = v;
    else node[k] = v;
  }
  for (const c of children.flat()) {
    if (c == null || c === '') continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

init();
