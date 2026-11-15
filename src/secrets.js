// Per-client secrets (e.g. Google refresh tokens), encrypted at rest with AES-256-GCM.
// Kept outside tenants/*.json so they are never sent to the browser.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = () => path.join(path.resolve(process.env.DATA_DIR || "data"), "secrets");

function key() {
  const s = process.env.SESSION_SECRET || "dev-only-session-secret-change-me-please-0000";
  return crypto.createHash("sha256").update(`dbs-voice-secrets:${s}`).digest();
}

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(str) {
  const [iv, tag, data] = String(str).split(".").map((s) => Buffer.from(s, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
}

const file = (tenantId) => path.join(dir(), `${tenantId.replace(/[^a-z0-9-]/g, "")}.enc`);

export function getSecrets(tenantId) {
  try { return decrypt(fs.readFileSync(file(tenantId), "utf8")); } catch { return {}; }
}

export function setSecrets(tenantId, patch) {
  const next = { ...getSecrets(tenantId), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(tenantId), encrypt(next), { mode: 0o600 });
  return next;
}

export const hasGoogle = (tenantId) => Boolean(getSecrets(tenantId).google?.refresh_token);
