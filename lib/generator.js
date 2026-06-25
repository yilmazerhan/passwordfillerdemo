const LOWER  = 'abcdefghijklmnopqrstuvwxyz';
const UPPER  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMS   = '!@#$%^&*()-_=+[]{}|;:,.<>?';

export function generatePassword({ length = 20, upper = true, digits = true, symbols = true } = {}) {
  let pool = LOWER;
  const required = [LOWER[randInt(LOWER.length)]];

  if (upper)   { pool += UPPER;  required.push(UPPER[randInt(UPPER.length)]); }
  if (digits)  { pool += DIGITS; required.push(DIGITS[randInt(DIGITS.length)]); }
  if (symbols) { pool += SYMS;   required.push(SYMS[randInt(SYMS.length)]); }

  const rest = Array.from({ length: length - required.length }, () => pool[randInt(pool.length)]);
  return shuffle([...required, ...rest]).join('');
}

function randInt(max) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
