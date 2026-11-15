import crypto from "node:crypto";

const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Verify the X-Retell-Signature header.
 * Format: "v=<unix_ms>,d=<hex>", where d = HMAC-SHA256(apiKey, rawBody + timestamp).
 */
export function verifyRetellSignature(rawBody, signature, apiKey, now = Date.now()) {
  if (!signature || !apiKey) return false;
  const m = String(signature).match(/v=(\d+),d=([a-f0-9]+)/i);
  if (!m) return false;
  const [, ts, digest] = m;
  if (Math.abs(now - Number(ts)) > MAX_AGE_MS) return false;
  const expected = crypto.createHmac("sha256", apiKey).update(rawBody + ts).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(digest, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Produce a signature the same way Retell does (used by tests). */
export function signForTest(rawBody, apiKey, ts = Date.now()) {
  const d = crypto.createHmac("sha256", apiKey).update(rawBody + ts).digest("hex");
  return `v=${ts},d=${d}`;
}
