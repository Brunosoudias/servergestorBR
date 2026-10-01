import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Segredo TOTP inválido.");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = () => base32Encode(randomBytes(20));
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Devolve o passo de tempo aceito (tolerância de ±1 passo) ou null. Passos já usados (<= lastStep) são recusados contra replay. */
export function verifyTotp(secret: string, code: string, lastStep = 0, now = Date.now()): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_RE = /^[a-z2-7]{5}-[a-z2-7]{5}$/;

export function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const s = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/\s+/g, "");

export const otpauthUrl = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
