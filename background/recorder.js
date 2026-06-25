// Session-recording orchestration (service-worker side). Owns session state,
// tab tracking, the offscreen document, and tabCapture stream acquisition.
//
// HARD CONSTRAINT: chrome.tabCapture only works on a tab the extension has been
// "invoked" on (activeTab) — a toolbar click, context-menu click, or keyboard
// command. An injected in-page icon click does NOT count. So:
//  - Recording reliably starts/switches from the POPUP (opening it is an
//    invocation that grants activeTab for the current tab).
//  - A fill from the in-page icon cannot capture, so we store a "pending" start
//    and notify the user to click the toolbar icon; opening the popup flushes it.
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
  // Already recording this site: switch capture to this tab (popup gave a gesture).
  if (store.hasDomain(domain)) {
    const session = store.get(domain);
    store.addTab(domain, tabId);
    markTab(tabId, true);
    await persist();
    if (session.currentTabId !== tabId) await switchTo(session, tabId);
    return { ok: true };
  }

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

  try {
    await ensureOffscreen();
    const id = `${domain}-${Date.now()}`;
    const filename = `session-${safe(domain)}-${stamp()}.webm`;
    const res = await toOffscreen({ cmd: 'start', sessionId: id, streamId, filename, domain });
    if (!res?.ok) throw new Error(res?.error || 'recorder did not start');

    store.create(domain, tabId, id, filename);
    for (const t of await chrome.tabs.query({})) {            // pull in open same-site tabs
      if (t.id != null && domainOf(t.url) === domain) store.addTab(domain, t.id);
    }
    delete pending[domain];
    await persist();
    markSessionTabs(store.get(domain), true);
    notify(`pf-start-${domain}`, '🔴 Recording started',
      `Recording ${domain}. The video saves automatically when you close the last tab of this site.`);
    return { ok: true };
  } catch (err) {
    notify(`pf-fail-${domain}`, 'Recording could not start', `${domain}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function switchTo(session, tabId) {
  try {
    const streamId = await getStreamId(tabId);
    await toOffscreen({ cmd: 'switch', sessionId: session.id, streamId });
    session.currentTabId = tabId;
    await persist();
  } catch {
    // Cannot capture this tab without a gesture; keep recording the previous tab.
    // (User can click the popup's "Record this tab" to switch capture here.)
  }
}

async function finalizeStop(session) {
  markSessionTabs(session, false);
  const res = await toOffscreen({ cmd: 'stop', sessionId: session.id });
  if (res?.saved) {
    notify(`pf-saved-${session.id}`, '✅ Recording saved',
      `Recording of ${session.domain} is saved in the extension. Open Password Filler options → Recordings to download it.`);
  }
}

// ── public entry points (called from the worker message router) ───────────────

export async function onFill(tabId) {
  await loadState();
  const tab = await safeGetTab(tabId);
  const domain = domainOf(tab?.url);
  if (!domain) return { ok: false, error: 'Unsupported page' };
  return beginSession(domain, tabId);
}

// Manual stop from the popup: stop the session for this tab's site and save it.
export async function stopByTab(tabId) {
  await loadState();
  const tab = await safeGetTab(tabId);
  const domain = domainOf(tab?.url);
  const session = domain && store.get(domain);
  if (!session) return { ok: false, error: 'not recording' };
  store.delete(domain);
  delete pending[domain];
  await persist();
  await finalizeStop(session);
  return { ok: true };
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

// Recording status for the current tab, used by the popup UI.
export async function recordStatus(tabId) {
  await loadState();
  const tab = await safeGetTab(tabId);
  const domain = domainOf(tab?.url);
  if (!domain) return { state: 'unsupported' };
  const session = store.get(domain);
  if (!session) return { state: 'idle', domain };
  return { state: session.currentTabId === tabId ? 'recording-here' : 'recording-other-tab', domain };
}

// ── tab listeners ──────────────────────────────────────────────────────────────

export function initRecorder() {
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

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
    if (owner && owner.domain !== newDomain) {          // navigated away from its session's site
      markTab(tabId, false);
      const ended = store.removeTab(tabId);
      await persist();
      if (ended) await finalizeStop(ended);
    }
    if (newDomain && store.hasDomain(newDomain) && !store.get(newDomain).tabIds.has(tabId)) {
      store.addTab(newDomain, tabId);                   // new same-site tab joins the session
      markTab(tabId, true);
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

// ── badge / notifications ─────────────────────────────────────────────────────

function markTab(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? '●' : '' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: on ? 'Recording this site — Password Filler' : 'Password Filler' }).catch(() => {});
}

function markSessionTabs(session, on) {
  if (session) for (const id of session.tabIds) markTab(id, on);
}

function promptForGesture(domain) {
  notify(`pf-rec-${domain}`, 'Password Filler — start recording',
    `Click the Password Filler toolbar icon on this ${domain} tab to record this session.`);
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function safeGetTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

function safe(s)  { return s.replace(/[^a-z0-9.-]/gi, '_'); }
function stamp()  {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
