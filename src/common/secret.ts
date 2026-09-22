import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const key = (hex: string) => (hex ? Buffer.from(hex, "hex") : createHash("sha256").update("gestao-dev-secrets").digest());

export function encryptSecret(plain: string, hex: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(hex), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(blob: string, hex: string): string {
  if (!blob) return "";
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(hex), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
