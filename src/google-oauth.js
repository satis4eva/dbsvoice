// "Connect Google Calendar" for each client, using Google OAuth (offline access).
import crypto from "node:crypto";
import { env } from "./env.js";
import { getSecrets, setSecrets } from "./secrets.js";

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];
const redirectUri = () => `${env.publicBaseUrl}/oauth/google/callback`;
export const oauthConfigured = () => Boolean(env.googleClientId && env.googleClientSecret && env.publicBaseUrl);

function secret() { return process.env.SESSION_SECRET || "dev-only-session-secret-change-me-please-0000"; }
const sign = (s) => crypto.createHmac("sha256", secret()).update(`oauth:${s}`).digest("base64url");

/** Signed state carries who started the flow, since the callback arrives without our cookie. */
export function makeState(tenantId, userId) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, u: userId, exp: Date.now() + 10 * 60_000, n: crypto.randomBytes(8).toString("hex") })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readState(state) {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) return null;
  const a = Buffer.from(sign(payload)), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

export function authUrl(state, loginHint) {
  const q = new URLSearchParams({
    client_id: env.googleClientId, redirect_uri: redirectUri(), response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${env.googleAuthUrl}?${q}`;
}

async function tokenRequest(params) {
  const r = await fetch(env.googleTokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google: ${j.error_description || j.error || r.status}`);
  return j;
}

export async function exchangeCode(tenantId, code) {
  const j = await tokenRequest({ code, client_id: env.googleClientId, client_secret: env.googleClientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" });
  if (!j.refresh_token) throw new Error("Google didn't return offline access. Remove DBS Voice from your Google account permissions and try again.");
  let email = "";
  try { email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString()).email || ""; } catch { /* optional */ }
  setSecrets(tenantId, { google: { refresh_token: j.refresh_token, email, connected_at: new Date().toISOString() } });
  cache.set(tenantId, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return { email };
}

const cache = new Map();

/** Access token for a connected tenant, refreshing when needed. */
export async function accessTokenFor(tenantId) {
  const c = cache.get(tenantId);
  if (c && Date.now() < c.exp - 60_000) return c.token;
  const g = getSecrets(tenantId).google;
  if (!g?.refresh_token) throw new Error("Google Calendar is not connected");
  try {
    const j = await tokenRequest({ refresh_token: g.refresh_token, client_id: env.googleClientId, client_secret: env.googleClientSecret, grant_type: "refresh_token" });
    cache.set(tenantId, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    return j.access_token;
  } catch (e) {
    if (/invalid_grant|revoked|expired/i.test(e.message)) {
      setSecrets(tenantId, { google: { ...g, broken: true } });
    }
    throw e;
  }
}

export async function disconnect(tenantId) {
  const g = getSecrets(tenantId).google;
  cache.delete(tenantId);
  setSecrets(tenantId, { google: null });
  if (g?.refresh_token) {
    await fetch(`${env.googleRevokeUrl}?token=${encodeURIComponent(g.refresh_token)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }).catch(() => {});
  }
}

export function googleStatus(tenantId) {
  const g = getSecrets(tenantId).google;
  return g ? { connected: !g.broken, email: g.email || "", needs_reconnect: Boolean(g.broken), connected_at: g.connected_at } : { connected: false };
}
