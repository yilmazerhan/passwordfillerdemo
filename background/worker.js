// Service worker: holds decrypted vault in memory, routes messages, manages auto-lock.
import { encryptVault, decryptVault } from '../lib/crypto.js';
import { initRecorder, onFill, onPopupReady, recordStatus, stopByTab } from './recorder.js';

initRecorder();

const LOCK_ALARM = 'autolock';
const DEFAULT_LOCK_MINUTES = 15;

let state = {
  locked: true,
  key: null,        // CryptoKey — never persisted
  vault: null,      // decrypted vault array
  salt: null,       // b64 salt of the stored blob (needed to re-store on save)
  iterations: null, // PBKDF2 iterations of the stored blob
};

// ── public helpers ──────────────────────────────────────────────────────────

async function unlock(masterPassword) {
  const stored = await chrome.storage.local.get('vault');
  if (!stored.vault) {
    // First run — create empty vault
    const { ciphertext, key } = await encryptVault([], masterPassword);
    await chrome.storage.local.set({ vault: ciphertext });
    state = { locked: false, key, vault: [], salt: ciphertext.salt, iterations: ciphertext.iterations };
    scheduleAutolock();
    return { ok: true, firstRun: true };
  }
  try {
    const { vault, key } = await decryptVault(stored.vault, masterPassword);
    state = {
      locked: false, key, vault,
      salt: stored.vault.salt,
      iterations: stored.vault.iterations,
    };
    scheduleAutolock();
    return { ok: true, firstRun: false };
  } catch {
    return { ok: false, error: 'Wrong master password.' };
  }
}

function lock() {
  state = { locked: true, key: null, vault: null, salt: null, iterations: null };
  chrome.alarms.clear(LOCK_ALARM);
}

async function saveVault() {
  if (state.locked) throw new Error('Vault is locked');
  const { ciphertext } = await encryptVault(state.vault, null, state.key);
  // encryptVault with an existing key produces no salt; restore the original
  // salt/iterations so the next unlock can re-derive the key.
  ciphertext.salt = state.salt;
  ciphertext.iterations = state.iterations;
  await chrome.storage.local.set({ vault: ciphertext });
}

async function changeMasterPassword(oldPassword, newPassword) {
  const stored = await chrome.storage.local.get('vault');
  if (!stored.vault) return { ok: false, error: 'No vault to change.' };
  // Verify the old password by decrypting.
  let vault;
  try {
    ({ vault } = await decryptVault(stored.vault, oldPassword));
  } catch {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  // Re-encrypt with a fresh key + salt derived from the new password.
  const { ciphertext, key } = await encryptVault(vault, newPassword);
  await chrome.storage.local.set({ vault: ciphertext });
  state = { locked: false, key, vault, salt: ciphertext.salt, iterations: ciphertext.iterations };
  scheduleAutolock();
  return { ok: true };
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
    state.vault[idx] = { ...state.vault[idx], ...entry, updatedAt: Date.now() };
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
  chrome.alarms.clear(LOCK_ALARM);
  if (lockMinutes > 0) chrome.alarms.create(LOCK_ALARM, { delayInMinutes: lockMinutes });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === LOCK_ALARM) lock();
});

// ── message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target === 'offscreen') return; // handled by the offscreen document
  (async () => {
    try {
      switch (msg.type) {
        case 'recordStart':  respond(await onFill(msg.tabId ?? sender.tab?.id)); break;
        case 'recordStop':   respond(await stopByTab(msg.tabId)); break;
        case 'popupReady':   respond(await onPopupReady(msg.tabId)); break;
        case 'recordStatus': respond(await recordStatus(msg.tabId)); break;
        case 'unlock':      respond(await unlock(msg.masterPassword)); break;
        case 'lock':        lock(); respond({ ok: true }); break;
        case 'getStatus':   respond(getStatus()); break;
        case 'getMatches':  respond({ matches: getMatches(msg.domain) }); break;
        case 'getCredential': respond({ credential: getCredential(msg.id) }); break;
        case 'saveEntry':   await saveEntry(msg.entry); respond({ ok: true }); break;
        case 'deleteEntry': await deleteEntry(msg.id);  respond({ ok: true }); break;
        case 'changeMasterPassword': respond(await changeMasterPassword(msg.oldPassword, msg.newPassword)); break;
        case 'setLockMinutes':
          await chrome.storage.local.set({ lockMinutes: msg.minutes });
          if (!state.locked) scheduleAutolock();
          respond({ ok: true });
          break;
        case 'getAll':
          respond({ entries: state.locked ? null : state.vault.map(
            ({ id, title, username, domain, url, notes }) => ({ id, title, username, domain, url, notes })) });
          break;
        default: respond({ error: 'Unknown message type' });
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
