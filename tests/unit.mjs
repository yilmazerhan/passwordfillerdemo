// Node unit tests for the pure library modules (no Chrome APIs needed).
// Run: node tests/unit.mjs
import { encryptVault, decryptVault } from '../lib/crypto.js';
import { generatePassword } from '../lib/generator.js';
import { extractDomain, registrableDomain, matchesForDomain } from '../lib/vault.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else      { fail++; console.error(`FAIL  ${name}`); }
}

// ── crypto ──────────────────────────────────────────────────────────────────
{
  const vault = [{ id: '1', title: 'GitHub', username: 'alice', password: 's3cr3t!' }];

  const { ciphertext, key } = await encryptVault(vault, 'master-password');
  check('blob has salt/iv/ciphertext', ciphertext.salt && ciphertext.iv && ciphertext.ciphertext);
  check('blob has no plaintext', !JSON.stringify(ciphertext).includes('s3cr3t'));

  const { vault: dec } = await decryptVault(ciphertext, 'master-password');
  check('round-trips correctly', JSON.stringify(dec) === JSON.stringify(vault));

  // Re-encrypt with existing key, then restore salt (mirrors worker.saveVault).
  const v2 = [...vault, { id: '2', username: 'bob', password: 'pw2' }];
  const { ciphertext: ct2 } = await encryptVault(v2, null, key);
  ct2.salt = ciphertext.salt;
  ct2.iterations = ciphertext.iterations;
  const { vault: dec2 } = await decryptVault(ct2, 'master-password');
  check('saveVault salt-restore round-trips', JSON.stringify(dec2) === JSON.stringify(v2));

  let threw = false;
  try { await decryptVault(ciphertext, 'wrong-password'); } catch { threw = true; }
  check('wrong password is rejected', threw);
}

// ── generator ─────────────────────────────────────────────────────────────────
{
  const pw = generatePassword({ length: 24, upper: true, digits: true, symbols: true });
  check('generator honors length', pw.length === 24);
  check('generator has lowercase', /[a-z]/.test(pw));
  check('generator has uppercase', /[A-Z]/.test(pw));
  check('generator has digit',     /[0-9]/.test(pw));
  check('generator has symbol',    /[^A-Za-z0-9]/.test(pw));

  const simple = generatePassword({ length: 16, upper: false, digits: false, symbols: false });
  check('generator lowercase-only respects toggles', /^[a-z]{16}$/.test(simple));

  const a = generatePassword({ length: 20 });
  const b = generatePassword({ length: 20 });
  check('generator is non-deterministic', a !== b);
}

// ── vault domain helpers ───────────────────────────────────────────────────────
{
  check('extractDomain from full url',  extractDomain('https://github.com/login') === 'github.com');
  check('extractDomain from bare host', extractDomain('mail.google.com') === 'mail.google.com');
  check('registrableDomain strips sub', registrableDomain('mail.google.com') === 'google.com');
  check('registrableDomain strips port', registrableDomain('localhost:3000') === 'localhost');

  const entries = [
    { id: '1', domain: 'github.com' },
    { id: '2', domain: 'login.github.com' },
    { id: '3', domain: 'example.com' },
  ];
  const m = matchesForDomain(entries, 'github.com');
  check('matchesForDomain matches subdomains', m.length === 2 && m.every(e => e.id !== '3'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
