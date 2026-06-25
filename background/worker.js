// Service worker: holds decrypted vault in memory, routes messages, manages auto-lock.
import { encryptVault, decryptVault } from '../lib/crypto.js';

const LOCK_ALARM = 'autolock';
const DEFAULT_LOCK_MINUTES = 15;

let state = {
  locked: true,
  key: null,       // CryptoKey — never persisted
  vault: null,     // decrypted vault array
};

// ── public helpers ──────────────────────────────────────────────────────────

async function unlock(masterPassword) {
  const stored = await chrome.storage.local.get('vault');
  if (!stored.vault) {
    // First run — create empty vault
    const { ciphertext, key } = await encryptVault([], masterPassword);
    await chrome.storage.local.set({ vault: ciphertext });
    state = { locked: false, key, vault: [] };
    scheduleAutolock();
    return { ok: true, firstRun: true };
  }
  try {
    const { vault, key } = await decryptVault(stored.vault, masterPassword);
    state = { locked: false, key, vault };
    scheduleAutolock();
    return { ok: true, firstRun: false };
  } catch {
    return { ok: false, error: 'Wrong master password.' };
  }
}

function lock() {
  state = { locked: true, key: null, vault: null };
  chrome.alarms.clear(LOCK_ALARM);
}

async function saveVault() {
  if (state.locked) throw new Error('Vault is locked');
  const { ciphertext } = await encryptVault(state.vault, null, state.key);
  await chrome.storage.local.set({ vault: ciphertext });
}

function getMatches(domain) {
  if (state.locked) return [];
  return state.vault
    .filter(e => registrableDomain(e.domain) === registrableDomain(domain))
    .map(({ id, title, username, domain: d }) => ({ id, title, username, domain: d }));
}

function getCredential(id) {
  if (state.locked) return null;
  return state.vault.find(e => e.id === id) ?? null;
}

async function saveEntry(entry) {
  if (state.locked) throw new Error('Vault is locked');
  const idx = state.vault.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    state.vault[idx] = { ...entry, updatedAt: Date.now() };
  } else {
    state.vault.push({ ...entry, createdAt: Date.now(), updatedAt: Date.now() });
  }
  await saveVault();
}

async function deleteEntry(id) {
  if (state.locked) throw new Error('Vault is locked');
  state.vault = state.vault.filter(e => e.id !== id);
  await saveVault();
}

function getStatus() {
  return { locked: state.locked };
}

// ── auto-lock ────────────────────────────────────────────────────────────────

async function scheduleAutolock() {
  const { lockMinutes = DEFAULT_LOCK_MINUTES } = await chrome.storage.local.get('lockMinutes');
  chrome.alarms.create(LOCK_ALARM, { delayInMinutes: lockMinutes });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === LOCK_ALARM) lock();
});

// ── message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'unlock':      respond(await unlock(msg.masterPassword)); break;
        case 'lock':        lock(); respond({ ok: true }); break;
        case 'getStatus':   respond(getStatus()); break;
        case 'getMatches':  respond({ matches: getMatches(msg.domain) }); break;
        case 'getCredential': respond({ credential: getCredential(msg.id) }); break;
        case 'saveEntry':   await saveEntry(msg.entry); respond({ ok: true }); break;
        case 'deleteEntry': await deleteEntry(msg.id);  respond({ ok: true }); break;
        case 'getAll':      respond({ entries: state.locked ? null : state.vault.map(({ id, title, username, domain, url, notes }) => ({ id, title, username, domain, url, notes })) }); break;
        default:            respond({ error: 'Unknown message type' });
      }
    } catch (err) {
      respond({ error: err.message });
    }
  })();
  return true; // keep channel open for async respond
});

// ── helpers ──────────────────────────────────────────────────────────────────

function registrableDomain(hostname) {
  if (!hostname) return '';
  // Strip port and leading wildcard, return last two labels (covers most cases).
  const h = hostname.replace(/:\d+$/, '').replace(/^\*\./, '');
  const parts = h.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}
