# Password Filler

A Chrome extension (Manifest V3) that detects login forms and fills credentials
with a click. Unlike Delinea Web Password Filler — which fetches secrets from a
Secret Server — this stores credentials **locally**, encrypted with a master
password. Nothing leaves your machine; there are no network calls and no
telemetry.

## Features

- **Encrypted local vault** — AES-GCM, key derived from your master password via
  PBKDF2-SHA256 (310,000 iterations). Only the encrypted blob is written to disk.
- **Click-to-fill** — a small key icon appears inside detected password fields;
  click it to pick a credential matching the current site.
- **Popup quick-fill** — open the toolbar icon to fill or copy credentials for the
  active tab.
- **Password generator** — built into the add/edit form (length + character-class
  options), backed by `crypto.getRandomValues`.
- **Auto-lock** — the vault locks after a configurable period of inactivity.
- **Change master password** — re-encrypts the vault with a fresh key.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension icon, or open its **options** page, to create your vault.

## Usage

1. **Create a vault** — set a master password (8+ characters) on first run.
2. **Add credentials** — open the options page → *Add* → fill in site, username,
   and password (or generate one).
3. **Fill a login** — on a login page, click the key icon in the password field
   (or open the popup) and select a credential.

## Architecture

```
manifest.json          MV3 manifest (module service worker + module content script)
background/worker.js    in-memory vault state, lock/unlock, message router, auto-lock alarm
lib/crypto.js           PBKDF2 key derivation + AES-GCM encrypt/decrypt
lib/vault.js            domain extraction + registrable-domain matching
lib/generator.js        secure password generation
content/detect.js       login-form detection (+ MutationObserver for SPAs)
content/inject.js       Shadow-DOM fill icon + credential dropdown
popup/                  unlock + per-site matches + click-to-fill / copy
options/                vault management, generator, settings
```

The decrypted vault and derived key live **only in the service worker's memory**
while unlocked. They are never persisted. When the worker is evicted by the
browser (or auto-lock fires), the vault locks and the master password is required
again.

## Security notes & caveats

- **This is less hardened than a dedicated secrets manager.** Your vault is only
  as strong as your master password and your OS account. Anyone who can run code
  as your user while the vault is unlocked could read decrypted data from memory.
- **There is no recovery path.** Forgetting the master password means the vault is
  permanently unrecoverable — by design (the key is derived from it).
- **Click-to-fill, not auto-fill.** Credentials are only filled when you
  explicitly choose them, which avoids silently filling hidden or look-alike
  forms.
- **Strict domain matching.** Credentials are matched by registrable domain to
  resist look-alike phishing domains.
- **No sync, no network.** The vault never leaves the machine.

## Testing

- `test-crypto.html` — open via a local static server to verify the
  encrypt→decrypt round-trip and wrong-password rejection.
- `tests/` — Node unit tests for crypto/generator/vault and a Playwright
  end-to-end test that drives the extension in Chromium. See `tests/README.md`.
