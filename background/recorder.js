// Session-recording orchestration (service-worker side). Owns session state,
// tab tracking, the offscreen document, and tabCapture stream acquisition.
//
// tabCapture requires a user-gesture / activeTab grant for the target tab, so:
//  - A fill from the popup (the popup opens via an action click -> activeTab) can
//    start recording immediately.
//  - A fill from the in-page icon usually cannot, so we record a "pending" start
//    and prompt the user to click the toolbar icon once; opening the popup then
//    flushes the pending start.
import { domainOf, SessionStore } from '../lib/sessions.js';

const STORE_KEY = 'recSessions';
const PEND_KEY  = 'recPending';

let store = new SessionStore();
let pending = {};            // domain -> tabId awaiting a gesture
let offscreenCreating = null;

// ── persistence (survives service-worker restarts) ───────────────────────────

async function loadState() {
  const data = await chrome.storage.session.get([STORE_KEY, PEND_KEY]);
  store = SessionStore.fromJSON(data[STORE_KEY]);
  pending = data[PEND_KEY] ?? {};
}
async function persist() {
  await chrome.storage.session.set({ [STORE_KEY]: store.toJSON(), [PEND_KEY]: pending });
}

// ── offscreen document ────────────────────────────────────────────────────────

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Record the active tab as a session video.',
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

function toOffscreen(payload) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
}

// ── tabCapture stream id (callback form is always valid) ──────────────────────

function getStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, id => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message || 'Could not capture tab'));
      else resolve(id);
    });
  });
}

// ── start / switch / stop ──────────────────────────────────────────────────────

async function beginSession(domain, tabId) {
  if (store.hasDomain(domain)) { store.addTab(domain, tabId); await persist(); return { ok: true }; }

  let streamId;
  try {
    streamId = await getStreamId(tabId);
  } catch {
    // No capture permission for this tab yet — defer until a toolbar click.
    pending[domain] = tabId;
    await persist();
    promptForGesture(domain);
    return { ok: false, pending: true };
  }

  await ensureOffscreen();
  const id = `${domain}-${Date.now()}`;
  const filename = `PasswordFiller/session-${safe(domain)}-${stamp()}.webm`;
  const res = await toOffscreen({ cmd: 'start', sessionId: id, streamId, filename });
  if (!res?.ok) return { ok: false, error: res?.error };

  store.create(domain, tabId, id, filename);
  // Pull in any already-open tabs of the same site.
  for (const t of await chrome.tabs.query({})) {
    if (t.id != null && domainOf(t.url) === domain) store.addTab(domain, t.id);
  }
  delete pending[domain];
  await persist();
  setBadge(true);
  return { ok: true };
}

async function switchTo(session, tabId) {
  try {
    const streamId = await getStreamId(tabId);
    await toOffscreen({ cmd: 'switch', sessionId: session.id, streamId });
    session.currentTabId = tabId;
    await persist();
  } catch {
    // Cannot capture this tab without a gesture; keep recording the previous tab.
    promptForGesture(session.domain);
  }
}

async function finalizeStop(session) {
  await toOffscreen({ cmd: 'stop', sessionId: session.id });
  if (store.all().length === 0) setBadge(false);
}

// ── public entry points (called from the worker message router) ───────────────

export async function onFill(tabId) {
  await loadState();
  const tab = await safeGetTab(tabId);
  const domain = domainOf(tab?.url);
  if (!domain) return { ok: false, error: 'Unsupported page' };
  return beginSession(domain, tabId);
}

// Popup opened with an action gesture: flush any pending start for its domain.
export async function onPopupReady(tabId) {
  await loadState();
  const tab = await safeGetTab(tabId);
  const domain = domainOf(tab?.url);
  if (domain && pending[domain] != null && !store.hasDomain(domain)) {
    await beginSession(domain, tabId);
  }
}

// ── tab listeners ──────────────────────────────────────────────────────────────

export function initRecorder() {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    await loadState();
    const tab = await safeGetTab(tabId);
    const session = store.get(domainOf(tab?.url));
    if (session && session.currentTabId !== tabId) await switchTo(session, tabId);
  });

  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete') return;
    await loadState();
    const newDomain = domainOf(tab.url);
    const owner = store.all().find(s => s.tabIds.has(tabId));
    if (owner && owner.domain !== newDomain) {
      const ended = store.removeTab(tabId);
      await persist();
      if (ended) await finalizeStop(ended);
    }
    if (newDomain && store.hasDomain(newDomain) && !store.get(newDomain).tabIds.has(tabId)) {
      store.addTab(newDomain, tabId);
      await persist();
    }
  });

  chrome.tabs.onRemoved.addListener(async tabId => {
    await loadState();
    const ended = store.removeTab(tabId);
    await persist();
    if (ended) await finalizeStop(ended);
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function safeGetTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
}

function promptForGesture(domain) {
  chrome.notifications.create(`pf-rec-${domain}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Password Filler — start recording',
    message: `Click the Password Filler toolbar icon on this ${domain} tab to record this session.`,
  });
}

function safe(s)  { return s.replace(/[^a-z0-9.-]/gi, '_'); }
function stamp()  {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
