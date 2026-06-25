# Implementation Plan — Local Password Filler (Chrome Extension, MV3)

## What it is
A Chrome extension that detects login forms, shows a click-to-fill icon, and fills
credentials matched by domain. Unlike Delinea (which fetches secrets from Secret
Server), the vault is **stored locally and encrypted with a master password** —
nothing leaves the machine.

## Decisions
- **Vault security:** master-password-encrypted (AES-GCM, key derived via PBKDF2).
- **Autofill mode:** click-to-fill icon injected into detected login fields.
- **Extra capability (v1):** password generator.

## Tech choices
- **Manifest V3** (service worker background, required for new Chrome extensions).
- **Vanilla JS + Web Crypto API** for crypto — no third-party crypto libs (smaller
  attack surface, no build step needed). Optional light bundler (esbuild) only if
  files get unwieldy.
- **`chrome.storage.local`** holds only the *encrypted* vault blob. The decrypted
  vault and derived key live **in service-worker memory only**, never persisted.

## Crypto design (the core of "store passwords in the extension")
- Master password → key via **PBKDF2-SHA256** (Web Crypto, high iteration count,
  random per-vault salt).
- Vault encrypted as a single JSON blob with **AES-GCM** (random IV per encryption).
- Stored at rest: `{ salt, iterations, iv, ciphertext, version }`. No plaintext, no
  master password, no key ever written to disk.
- **No recovery path** — forgetting the master password means the vault is
  unrecoverable. This will be stated explicitly in the UI.
- **Auto-lock**: configurable inactivity timer; locking wipes the key from memory.

---

## Components

```
manifest.json          # MV3 manifest, permissions, content-script + worker registration
background/
  worker.js            # in-memory vault state, lock/unlock, message router, auto-lock alarm
lib/
  crypto.js            # deriveKey, encryptVault, decryptVault (Web Crypto wrappers)
  vault.js             # CRUD over decrypted entries, domain matching, generator
  generator.js         # strong password generation
content/
  detect.js            # find login forms (password field + nearest username field)
  inject.js            # render fill icon, credential picker, fill fields + dispatch events
  content.css          # icon / dropdown styles (Shadow DOM to avoid page CSS clashes)
popup/
  popup.html/js/css    # unlock screen + per-site credential list, quick fill
options/
  options.html/js/css  # vault management (add/edit/delete), master-pw setup/change, settings
icons/                 # 16/32/48/128 px
```

## Data model
```js
// one decrypted vault entry
{ id, title, url, domain, username, password, notes, createdAt, updatedAt }
```
Matching is by **registrable domain** of the active tab vs. each entry's stored
domain (with optional subdomain handling).

---

## Build phases (each with a verify step)

**Phase 1 — Skeleton & load.**
Manifest + empty worker + placeholder popup. → *Verify:* loads unpacked in
`chrome://extensions` with no errors.

**Phase 2 — Crypto core.**
`crypto.js` (PBKDF2 + AES-GCM) and `vault.js`. → *Verify:* unit-style test page /
console round-trips encrypt→decrypt and rejects a wrong password.

**Phase 3 — Vault management UI (options page).**
Master-password setup, unlock, add/edit/delete entries, list view. → *Verify:*
create entries, lock, reload, unlock with correct/incorrect password.

**Phase 4 — Background state & messaging.**
Worker holds decrypted vault while unlocked; message API (`unlock`, `lock`,
`getMatches`, `getCredential`); auto-lock alarm. → *Verify:* popup reflects
locked/unlocked state; auto-lock fires.

**Phase 5 — Form detection + click-to-fill.**
Content script detects login forms, injects icon in Shadow DOM; clicking lists
domain matches; selecting fills username/password and dispatches `input`/`change`
events so frameworks (React etc.) register them. → *Verify:* on a real login page
the icon appears and fills correctly.

**Phase 6 — Popup quick-fill.**
Popup shows matches for the active tab; click fills the page. → *Verify:* fills
active tab from popup.

**Phase 7 — Password generator.**
Generator in add/edit forms (length + character-class options). → *Verify:*
generates and saves a strong password.

**Phase 8 — Polish & hardening.**
Auto-lock settings, content-script origin checks, README with security caveats,
store icons. → *Verify:* full manual end-to-end on 2–3 sites.

---

## Permissions (kept minimal)
`storage`, `activeTab`, `scripting`, `alarms` (auto-lock). Content script matches
`<all_urls>` but only acts on detected login forms. No `host_permissions` beyond
what fill requires.

## Security caveats (to document in the README)
- Local encrypted storage is **less hardened than a dedicated vault** (Delinea
  Secret Server); it's only as strong as the master password and the OS account.
- Click-to-fill (chosen) avoids auto-filling hidden/phishing forms.
- Strict domain matching to resist look-alike domains.
- No telemetry, no network calls.
