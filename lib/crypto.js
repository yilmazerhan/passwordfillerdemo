// Crypto primitives: PBKDF2-SHA256 key derivation + AES-GCM vault encryption.

const PBKDF2_ITERATIONS = 310_000; // OWASP minimum for PBKDF2-HMAC-SHA256
const VERSION = 1;

// ── key derivation ───────────────────────────────────────────────────────────

async function deriveKey(masterPassword, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(masterPassword), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, hash: 'SHA-256', iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ── encrypt ──────────────────────────────────────────────────────────────────

/**
 * Encrypt a vault array.
 * Pass masterPassword to derive a new key (first save / password change).
 * Pass an existing CryptoKey via `existingKey` for subsequent saves.
 * Returns { ciphertext: object, key: CryptoKey }.
 */
export async function encryptVault(vaultArray, masterPassword, existingKey = null) {
  const salt = existingKey ? null : crypto.getRandomValues(new Uint8Array(32));
  const key  = existingKey ?? await deriveKey(masterPassword, salt);
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const enc  = new TextEncoder();

  const cipherbuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(vaultArray))
  );

  const ciphertext = {
    version: VERSION,
    iterations: PBKDF2_ITERATIONS,
    salt:       existingKey ? null : bufToB64(salt),
    iv:         bufToB64(iv),
    ciphertext: bufToB64(new Uint8Array(cipherbuf)),
  };

  return { ciphertext, key };
}

// ── decrypt ──────────────────────────────────────────────────────────────────

/**
 * Decrypt a vault blob.
 * Returns { vault: array, key: CryptoKey }.
 * Throws if masterPassword is wrong (AES-GCM tag mismatch).
 */
export async function decryptVault(blob, masterPassword) {
  const { salt, iv, ciphertext, iterations } = blob;
  const saltBuf = b64ToBuf(salt);
  const ivBuf   = b64ToBuf(iv);
  const cipher  = b64ToBuf(ciphertext);

  const enc  = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(masterPassword), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, hash: 'SHA-256', iterations: iterations ?? PBKDF2_ITERATIONS },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const plainbuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, cipher);
  const vault    = JSON.parse(new TextDecoder().decode(plainbuf));

  return { vault, key };
}

// ── utils ────────────────────────────────────────────────────────────────────

function bufToB64(buf) {
  return btoa(String.fromCharCode(...buf));
}

function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
