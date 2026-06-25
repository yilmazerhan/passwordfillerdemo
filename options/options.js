import { generatePassword } from '../lib/generator.js';
import { extractDomain }   from '../lib/vault.js';

const app = document.getElementById('app');

// ── messaging helpers ────────────────────────────────────────────────────────

function msg(payload) {
  return new Promise(resolve => chrome.runtime.sendMessage(payload, resolve));
}

// ── top-level state ──────────────────────────────────────────────────────────

let appState = 'loading'; // 'loading' | 'setup' | 'locked' | 'unlocked'

async function init() {
  const { vault } = await chrome.storage.local.get('vault');
  const status    = await msg({ type: 'getStatus' });

  if (!vault) {
    appState = 'setup';
  } else if (status.locked) {
    appState = 'locked';
  } else {
    appState = 'unlocked';
  }
  render();
}

function render() {
  app.innerHTML = '';
  const header = el('header', {},
    el('h1', {}, '🔑 Password Filler'),
    appState === 'unlocked'
      ? el('button', { className: 'btn-secondary', onclick: doLock }, 'Lock vault')
      : ''
  );
  app.appendChild(header);

  if (appState === 'loading') {
    app.appendChild(el('p', {}, 'Loading…'));
  } else if (appState === 'setup') {
    app.appendChild(renderSetup());
  } else if (appState === 'locked') {
    app.appendChild(renderUnlock());
  } else {
    app.appendChild(renderVault());
  }
}

// ── setup (first run) ────────────────────────────────────────────────────────

function renderSetup() {
  const errEl = el('p', { className: 'error hidden' });
  const pw1   = el('input', { type: 'password', placeholder: 'Enter master password', id: 'mp1' });
  const pw2   = el('input', { type: 'password', placeholder: 'Confirm master password', id: 'mp2' });

  const form = el('form', {
    onsubmit: async e => {
      e.preventDefault();
      errEl.classList.add('hidden');
      if (pw1.value.length < 8) { showErr(errEl, 'Password must be at least 8 characters.'); return; }
      if (pw1.value !== pw2.value) { showErr(errEl, 'Passwords do not match.'); return; }
      const res = await msg({ type: 'unlock', masterPassword: pw1.value });
      if (res.ok) { appState = 'unlocked'; render(); }
      else showErr(errEl, res.error);
    }
  },
    el('div', { className: 'field' }, el('label', {}, 'Master password'), pw1),
    el('div', { className: 'field' }, el('label', {}, 'Confirm master password'), pw2),
    el('p', { className: 'hint' }, '⚠ There is no recovery path. If you forget this password your vault cannot be recovered.'),
    errEl,
    el('div', { className: 'row-actions' }, el('button', { type: 'submit', className: 'btn-primary' }, 'Create vault'))
  );

  return el('div', { className: 'card' }, el('h2', {}, 'Create your vault'), form);
}

// ── unlock ───────────────────────────────────────────────────────────────────

function renderUnlock() {
  const errEl = el('p', { className: 'error hidden' });
  const pwEl  = el('input', { type: 'password', placeholder: 'Master password' });

  const form = el('form', {
    onsubmit: async e => {
      e.preventDefault();
      errEl.classList.add('hidden');
      const res = await msg({ type: 'unlock', masterPassword: pwEl.value });
      if (res.ok) { appState = 'unlocked'; render(); }
      else showErr(errEl, res.error);
    }
  },
    el('div', { className: 'field' }, el('label', {}, 'Master password'), pwEl),
    errEl,
    el('div', { className: 'row-actions' }, el('button', { type: 'submit', className: 'btn-primary' }, 'Unlock'))
  );

  return el('div', { className: 'card' }, el('h2', {}, 'Unlock vault'), form);
}

// ── vault view ───────────────────────────────────────────────────────────────

let editingId = null;  // null = add mode, string = edit mode

function renderVault() {
  const frag = document.createDocumentFragment();

  // lock status bar
  frag.appendChild(
    el('div', { className: 'lock-bar' },
      el('span', { className: 'status-dot' }),
      'Vault is unlocked'
    )
  );

  // entry list card
  frag.appendChild(renderEntryListCard());

  // add / edit form card
  frag.appendChild(renderEntryForm());

  // settings card
  frag.appendChild(renderSettingsCard());

  return frag;
}

// ── settings (auto-lock + change master password) ────────────────────────────

function renderSettingsCard() {
  // auto-lock minutes
  const lockEl = el('input', { type: 'number', min: '0', max: '240', style: 'width:80px' });
  chrome.storage.local.get('lockMinutes').then(({ lockMinutes = 15 }) => { lockEl.value = lockMinutes; });
  const lockSaved = el('span', { className: 'hint hidden' }, 'Saved ✓');

  const lockRow = el('div', { className: 'field' },
    el('label', {}, 'Auto-lock after (minutes of inactivity — 0 disables)'),
    el('div', { style: 'display:flex;align-items:center;gap:10px' },
      lockEl,
      el('button', {
        type: 'button', className: 'btn-secondary',
        onclick: async () => {
          const minutes = Math.max(0, Math.min(240, parseInt(lockEl.value, 10) || 0));
          lockEl.value = minutes;
          await msg({ type: 'setLockMinutes', minutes });
          lockSaved.classList.remove('hidden');
          setTimeout(() => lockSaved.classList.add('hidden'), 1500);
        }
      }, 'Save'),
      lockSaved
    )
  );

  // change master password
  const oldEl  = el('input', { type: 'password', placeholder: 'Current password' });
  const new1El = el('input', { type: 'password', placeholder: 'New password' });
  const new2El = el('input', { type: 'password', placeholder: 'Confirm new password' });
  const cpErr  = el('p', { className: 'error hidden' });
  const cpOk   = el('p', { className: 'hint hidden' }, 'Master password changed ✓');

  const cpForm = el('form', {
    onsubmit: async e => {
      e.preventDefault();
      cpErr.classList.add('hidden'); cpOk.classList.add('hidden');
      if (new1El.value.length < 8)      { showErr(cpErr, 'New password must be at least 8 characters.'); return; }
      if (new1El.value !== new2El.value) { showErr(cpErr, 'New passwords do not match.'); return; }
      const res = await msg({ type: 'changeMasterPassword', oldPassword: oldEl.value, newPassword: new1El.value });
      if (!res.ok) { showErr(cpErr, res.error); return; }
      oldEl.value = new1El.value = new2El.value = '';
      cpOk.classList.remove('hidden');
    }
  },
    el('div', { className: 'field' }, el('label', {}, 'Current password'), oldEl),
    el('div', { className: 'field' }, el('label', {}, 'New password'), new1El),
    el('div', { className: 'field' }, el('label', {}, 'Confirm new password'), new2El),
    cpErr, cpOk,
    el('div', { className: 'row-actions' }, el('button', { type: 'submit', className: 'btn-secondary' }, 'Change password'))
  );

  return el('div', { className: 'card' },
    el('h2', {}, 'Settings'),
    lockRow,
    el('h2', { style: 'margin-top:24px' }, 'Change master password'),
    cpForm
  );
}

function renderEntryListCard() {
  const listEl = el('ul', { className: 'entry-list', id: 'entry-list' });
  loadEntryList(listEl);

  return el('div', { className: 'card' },
    el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px' },
      el('h2', { style: 'margin:0' }, 'Saved credentials'),
      el('button', {
        className: 'btn-primary',
        onclick: () => { editingId = null; renderEntryFormInPlace(); }
      }, '+ Add')
    ),
    listEl
  );
}

async function loadEntryList(listEl) {
  const { entries } = await msg({ type: 'getAll' });
  listEl.innerHTML = '';
  if (!entries || entries.length === 0) {
    listEl.appendChild(el('li', { className: 'empty-state' }, 'No credentials saved yet.'));
    return;
  }
  entries.forEach(e => listEl.appendChild(renderEntryItem(e)));
}

function renderEntryItem(e) {
  return el('li', { className: 'entry-item' },
    el('div', { className: 'entry-favicon' }, faviconChar(e.domain || e.url)),
    el('div', { className: 'entry-info' },
      el('div', { className: 'entry-title' }, e.title || e.domain || 'Untitled'),
      el('div', { className: 'entry-meta' }, e.username + (e.domain ? '  ·  ' + e.domain : ''))
    ),
    el('div', { className: 'entry-actions' },
      el('button', {
        className: 'btn-icon', title: 'Edit',
        onclick: () => startEdit(e.id)
      }, '✏️'),
      el('button', {
        className: 'btn-icon', title: 'Delete',
        onclick: () => confirmDelete(e.id, e.title || e.domain)
      }, '🗑️')
    )
  );
}

async function confirmDelete(id, label) {
  if (!confirm(`Delete "${label}"?`)) return;
  await msg({ type: 'deleteEntry', id });
  refreshList();
}

async function startEdit(id) {
  const res = await msg({ type: 'getCredential', id });
  if (!res.credential) return;
  editingId = id;
  renderEntryFormInPlace(res.credential);
}

function refreshList() {
  const listEl = document.getElementById('entry-list');
  if (listEl) loadEntryList(listEl);
}

// ── add / edit form ──────────────────────────────────────────────────────────

function renderEntryForm(prefill = {}) {
  return buildEntryFormCard(prefill);
}

function renderEntryFormInPlace(prefill = {}) {
  const existing = document.getElementById('entry-form-card');
  const card = buildEntryFormCard(prefill);
  if (existing) existing.replaceWith(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildEntryFormCard(prefill = {}) {
  const isEdit = Boolean(prefill.id);
  const errEl  = el('p', { className: 'error hidden' });

  const titleEl    = el('input', { type: 'text',     value: prefill.title    ?? '', placeholder: 'e.g. GitHub' });
  const urlEl      = el('input', { type: 'url',      value: prefill.url      ?? '', placeholder: 'https://example.com/login' });
  const usernameEl = el('input', { type: 'text',     value: prefill.username ?? '', placeholder: 'user@example.com', autocomplete: 'off' });
  const passwordEl = el('input', { type: 'password', value: prefill.password ?? '', autocomplete: 'new-password', style: 'font-family:monospace' });
  const notesEl    = el('textarea', { placeholder: 'Optional notes' }, prefill.notes ?? '');

  // toggle password visibility
  const eyeBtn = el('button', {
    type: 'button', className: 'btn-secondary',
    onclick: () => { passwordEl.type = passwordEl.type === 'password' ? 'text' : 'password'; }
  }, '👁');

  // generator controls
  const lenEl  = el('input', { type: 'number', value: '20', min: '8', max: '64', style: 'width:60px' });
  const upperEl = el('input', { type: 'checkbox', checked: true });
  const digEl   = el('input', { type: 'checkbox', checked: true });
  const symEl   = el('input', { type: 'checkbox', checked: true });

  const genBtn = el('button', {
    type: 'button', className: 'btn-secondary',
    onclick: () => {
      passwordEl.value = generatePassword({
        length:  parseInt(lenEl.value, 10) || 20,
        upper:   upperEl.checked,
        digits:  digEl.checked,
        symbols: symEl.checked,
      });
      passwordEl.type = 'text';
    }
  }, 'Generate');

  const form = el('form', {
    onsubmit: async e => {
      e.preventDefault();
      errEl.classList.add('hidden');
      if (!usernameEl.value.trim()) { showErr(errEl, 'Username is required.'); return; }
      if (!passwordEl.value)        { showErr(errEl, 'Password is required.');  return; }

      const entry = {
        id:       prefill.id ?? crypto.randomUUID(),
        title:    titleEl.value.trim(),
        url:      urlEl.value.trim(),
        domain:   extractDomain(urlEl.value.trim() || usernameEl.value),
        username: usernameEl.value.trim(),
        password: passwordEl.value,
        notes:    notesEl.value.trim(),
      };

      const res = await msg({ type: 'saveEntry', entry });
      if (!res.ok) { showErr(errEl, res.error); return; }

      editingId = null;
      resetFormCard();
      refreshList();
    }
  },
    el('div', { className: 'field' }, el('label', {}, 'Title'), titleEl),
    el('div', { className: 'field' }, el('label', {}, 'Login URL'), urlEl),
    el('div', { className: 'field' }, el('label', {}, 'Username / Email'), usernameEl),
    el('div', { className: 'field' },
      el('label', {}, 'Password'),
      el('div', { className: 'pw-row' }, passwordEl, eyeBtn)
    ),
    el('div', { className: 'gen-options' },
      genBtn,
      el('label', {}, lenEl, ' chars'),
      el('label', {}, upperEl, ' A–Z'),
      el('label', {}, digEl,   ' 0–9'),
      el('label', {}, symEl,   ' !@#…')
    ),
    el('div', { className: 'field' }, el('label', {}, 'Notes (optional)'), notesEl),
    errEl,
    el('div', { className: 'row-actions' },
      el('button', {
        type: 'button', className: 'btn-secondary',
        onclick: () => { editingId = null; resetFormCard(); }
      }, 'Cancel'),
      el('button', { type: 'submit', className: 'btn-primary' }, isEdit ? 'Save changes' : 'Save')
    )
  );

  const card = el('div', { className: 'card', id: 'entry-form-card' },
    el('h2', {}, isEdit ? 'Edit credential' : 'Add credential'),
    form
  );
  return card;
}

function resetFormCard() {
  const card = document.getElementById('entry-form-card');
  if (card) card.replaceWith(buildEntryFormCard());
}

// ── lock ─────────────────────────────────────────────────────────────────────

async function doLock() {
  await msg({ type: 'lock' });
  appState = 'locked';
  render();
}

// ── utils ─────────────────────────────────────────────────────────────────────

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') node.style.cssText = v;
    else if (k.startsWith('on')) node[k] = v;
    else if (k === 'checked') node.checked = v;
    else node[k] = v;
  }
  for (const c of children.flat()) {
    if (c == null || c === '') continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function faviconChar(domain) {
  return domain ? domain[0].toUpperCase() : '?';
}

// ── boot ──────────────────────────────────────────────────────────────────────

init();
