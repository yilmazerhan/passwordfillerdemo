// Click-to-fill icon + credential dropdown. Classic content script; reads
// detection helpers from the shared namespace set up by detect.js.
(() => {
const { findLoginPairs, watchForForms } = self.__pwFiller;

// ── SVG key icon ─────────────────────────────────────────────────────────────

const KEY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
  viewBox="0 0 24 24" fill="none" stroke="#4f46e5"
  stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="7.5" cy="15.5" r="5.5"/>
  <path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>
</svg>`;

// ── Shadow DOM style strings ──────────────────────────────────────────────────

const ICON_CSS = `
:host { all: initial; display: block; }
button {
  all: unset; width: 100%; height: 100%; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  background: #fff; border: 1px solid #d1d5db; border-radius: 4px;
  cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.1);
  transition: border-color .12s, box-shadow .12s;
}
button:hover { border-color: #4f46e5; box-shadow: 0 1px 5px rgba(79,70,229,.3); }
`;

const DROPDOWN_CSS = `
:host { all: initial; display: block; }
.menu {
  background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.14); overflow: hidden;
  font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
  min-width: 230px; max-width: 310px; color: #111827;
}
.head {
  padding: 8px 13px; font-size: 11px; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase;
  color: #6b7280; border-bottom: 1px solid #f3f4f6;
}
.item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 13px; cursor: pointer; user-select: none;
}
.item:hover { background: #f9fafb; }
.avatar {
  width: 26px; height: 26px; background: #ede9fe; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #4f46e5; flex-shrink: 0;
}
.info { min-width: 0; }
.name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.user { font-size: 11px; color: #6b7280; margin-top: 1px; }
.msg { padding: 14px 13px; text-align: center; color: #9ca3af; }
.msg.warn { color: #f97316; }
`;

// ── State ─────────────────────────────────────────────────────────────────────

const processed = new WeakSet();
let openDropdown = null; // { host, pair } | null

// ── Boot ──────────────────────────────────────────────────────────────────────

findLoginPairs().forEach(injectIcon);
watchForForms(injectIcon);

// Close dropdown on outside click or Escape
document.addEventListener('click', () => closeDropdown());
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });

// ── Icon injection ────────────────────────────────────────────────────────────

function injectIcon(pair) {
  if (processed.has(pair.passwordField)) return;
  processed.add(pair.passwordField);

  const host = document.createElement('div');
  host.setAttribute('data-pf', '');
  host.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:all;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${ICON_CSS}</style><button aria-label="Fill password">${KEY_SVG}</button>`;
  const btn = shadow.querySelector('button');

  const place = () => {
    const r = pair.passwordField.getBoundingClientRect();
    if (!r.width || !r.height) { host.style.display = 'none'; return; }
    const sz = Math.max(16, Math.min(r.height - 6, 22));
    host.style.cssText = `
      position:fixed; z-index:2147483646; pointer-events:all;
      top:${r.top + (r.height - sz) / 2}px;
      left:${r.right - sz - 6}px;
      width:${sz}px; height:${sz}px;
    `;
  };

  place();
  window.addEventListener('scroll', place, { passive: true, capture: true });
  window.addEventListener('resize', place, { passive: true });

  // Clean up if the field leaves the DOM
  new MutationObserver(() => {
    if (!pair.passwordField.isConnected) { host.remove(); }
  }).observe(document.documentElement, { childList: true, subtree: true });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (openDropdown?.pair === pair) { closeDropdown(); return; }
    closeDropdown();
    showDropdown(pair);
  });
}

// ── Dropdown ──────────────────────────────────────────────────────────────────

function showDropdown(pair) {
  const host = document.createElement('div');
  host.setAttribute('data-pf-dd', '');
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${DROPDOWN_CSS}</style>
    <div class="menu">
      <div class="head">Password Filler</div>
      <div class="msg">Loading…</div>
    </div>`;

  // Position below the password field
  const r = pair.passwordField.getBoundingClientRect();
  host.style.cssText = `position:fixed;z-index:2147483647;top:${r.bottom + 4}px;left:${r.left}px;`;

  openDropdown = { host, pair };

  chrome.runtime.sendMessage({ type: 'getStatus' }, status => {
    if (chrome.runtime.lastError || !status) return;
    if (status.locked) {
      renderMsg(shadow, '🔒 Vault is locked — click the toolbar icon to unlock.', true);
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'getMatches', domain: window.location.hostname },
      ({ matches } = {}) => renderItems(shadow, matches ?? [], pair)
    );
  });
}

function renderMsg(shadow, text, warn = false) {
  const menu = shadow.querySelector('.menu');
  menu.querySelectorAll('.msg, .item').forEach(n => n.remove());
  const d = document.createElement('div');
  d.className = warn ? 'msg warn' : 'msg';
  d.textContent = text;
  menu.appendChild(d);
}

function renderItems(shadow, matches, pair) {
  if (matches.length === 0) { renderMsg(shadow, 'No saved logins for this site.'); return; }
  const menu = shadow.querySelector('.menu');
  menu.querySelectorAll('.msg, .item').forEach(n => n.remove());

  matches.forEach(m => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div class="avatar">${esc(m.title || m.domain || '?')[0].toUpperCase()}</div>
      <div class="info">
        <div class="name">${esc(m.title || m.domain || 'Untitled')}</div>
        <div class="user">${esc(m.username)}</div>
      </div>`;
    item.addEventListener('click', e => {
      e.stopPropagation();
      pickCredential(m.id, pair);
    });
    menu.appendChild(item);
  });
}

function pickCredential(id, pair) {
  closeDropdown();
  chrome.runtime.sendMessage({ type: 'getCredential', id }, ({ credential } = {}) => {
    if (!credential) return;
    if (pair.usernameField) setNativeValue(pair.usernameField, credential.username);
    setNativeValue(pair.passwordField, credential.password);
  });
}

function closeDropdown() {
  if (!openDropdown) return;
  openDropdown.host.remove();
  openDropdown = null;
}

// ── Fill helpers ──────────────────────────────────────────────────────────────

function setNativeValue(input, value) {
  // Use the native value setter so React/Vue/Angular register the change.
  const proto  = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value); else input.value = value;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
})();
