import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./api.js";
import { userFromRequest } from "./auth.js";
import { tenantById } from "./tenants.js";
import { oauthConfigured, makeState, readState, authUrl, exchangeCode } from "./google-oauth.js";
import { verifyStripeSignature, reportMinutes } from "./stripe.js";
import { handleStripeEvent } from "./billing.js";
import { vapiAuthorised, handleVapiMessage } from "./vapi.js";
import { billedMinutes } from "./usage.js";
import { env } from "./env.js";
import { verifyRetellSignature } from "./retell.js";
import { tenantByNumber, tenantForCall, dynamicVariablesFor, loadTenants } from "./tenants.js";
import { handlers } from "./tools.js";
import { notify } from "./notify.js";
import { record } from "./store.js";

const MAX_BODY = 1_000_000;

// ---- static dashboard files (fixed allowlist, no path traversal) ----
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC = {
  "/": ["landing.html", "text/html"], "/landing.css": ["landing.css", "text/css"], "/landing.js": ["landing.js", "text/javascript"],
  "/app": ["index.html", "text/html"], "/app/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"],
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; media-src https:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

function serveStatic(pathname, res) {
  if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return true; }
  const entry = STATIC[pathname];
  if (!entry) return false;
  const file = path.join(publicDir, entry[0]);
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { "Content-Type": `${entry[1]}; charset=utf-8`, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
  res.end(fs.readFileSync(file));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function send(res, status, body) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
}

function authorised(req, raw) {
  return env.skipSignature || verifyRetellSignature(raw, req.headers["x-retell-signature"], env.retellApiKey);
}

// ---- Inbound call: pick the client by the number that was dialled ----
function handleInbound(body) {
  const ev = body.call_inbound || body;
  const tenant = tenantByNumber(ev.to_number);
  if (!tenant || tenant.active === false) {
    console.warn(`[inbound] no active client for ${ev.to_number}, using agent defaults`);
    return { call_inbound: {} };
  }
  if (tenant.blocked_numbers?.includes(ev.from_number)) {
    return { call_inbound: { reject: true } };
  }
  return {
    call_inbound: {
      ...(env.agentId ? { override_agent_id: env.agentId } : {}),
      dynamic_variables: dynamicVariablesFor(tenant, { fromNumber: ev.from_number }),
      metadata: { tenant_id: tenant.id },
    },
  };
}

// ---- Call events: send a summary once Retell has analysed the call ----
/** Log a finished call, report minutes to Stripe, and email the summary. Same for every voice engine. */
async function recordFinishedCall(tenant, c) {
  const durationSec = c.duration_sec;
  record(tenant.id, "calls", {
    call_id: c.call_id, from: c.from_number, duration_sec: durationSec, summary: c.summary,
    sentiment: c.sentiment, successful: c.successful, recording_url: c.recording_url, disconnection: c.disconnection,
  });
  if (tenant.billing?.stripe_customer_id && durationSec > 0) {
    reportMinutes(tenant.billing.stripe_customer_id, billedMinutes(durationSec), c.call_id).catch((e) => console.error("[stripe meter]", e.message));
  }
  if (tenant.notify?.call_summaries === false) return;
  await notify(tenant, `Call summary: ${c.from_number || "unknown caller"}`, {
    From: c.from_number,
    Duration: durationSec !== undefined ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : undefined,
    Summary: c.summary,
    Sentiment: c.sentiment,
    Recording: c.recording_url,
    Transcript: c.transcript ? String(c.transcript).slice(0, 6000) : undefined,
  });
}

// Retell: call_analyzed event
async function handleCallEvent(body) {
  const { event, call } = body;
  if (event !== "call_analyzed" || !call) return;
  const tenant = tenantForCall(call);
  if (!tenant) return;
  const a = call.call_analysis || {};
  await recordFinishedCall(tenant, {
    call_id: call.call_id, from_number: call.from_number,
    duration_sec: call.end_timestamp != null && call.start_timestamp != null ? Math.round((call.end_timestamp - call.start_timestamp) / 1000) : undefined,
    summary: a.call_summary, sentiment: a.user_sentiment, successful: a.call_successful,
    recording_url: call.recording_url, transcript: call.transcript, disconnection: call.disconnection_reason,
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

      // ---- Google Calendar connect ----
      if (req.method === "GET" && url.pathname === "/oauth/google/start") {
        const user = userFromRequest(req);
        const tid = url.searchParams.get("tenant") || "";
        if (!user || !tenantById(tid) || (user.role !== "admin" && user.tenant_id !== tid)) return redirect(res, "/app#/settings?calendar=denied");
        if (!oauthConfigured()) return redirect(res, "/app#/settings?calendar=unavailable");
        return redirect(res, authUrl(makeState(tid, user.id), user.email));
      }
      if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
        const st = readState(url.searchParams.get("state"));
        if (!st || !tenantById(st.t)) return redirect(res, "/app#/settings?calendar=expired");
        if (url.searchParams.get("error") || !url.searchParams.get("code")) return redirect(res, "/app#/settings?calendar=cancelled");
        try { await exchangeCode(st.t, url.searchParams.get("code")); return redirect(res, "/app#/settings?calendar=connected"); }
        catch (e) { console.error("[google oauth]", e.message); return redirect(res, "/app#/settings?calendar=error"); }
      }

      // ---- Vapi (voice engine) ----
      if (req.method === "POST" && url.pathname === "/vapi/webhook") {
        const raw = await readBody(req);
        if (!vapiAuthorised(req, url)) return send(res, 401, { error: "unauthorised" });
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "Invalid JSON" }); }
        const out = await handleVapiMessage(body);
        if (out.callEvent) {
          send(res, 200, { ok: true }); // acknowledge, then process
          recordFinishedCall(out.callEvent.tenant, out.callEvent.call).catch((e) => console.error("[vapi end-of-call]", e));
          return;
        }
        return send(res, 200, out);
      }

      // ---- Stripe webhook ----
      if (req.method === "POST" && url.pathname === "/stripe/webhook") {
        const raw = await readBody(req);
        if (!verifyStripeSignature(raw, req.headers["stripe-signature"], env.stripeWebhookSecret)) return send(res, 400, { error: "bad signature" });
        const result = await handleStripeEvent(JSON.parse(raw));
        return send(res, 200, { received: true, ...result });
      }

      // ---- dashboard ----
      if (url.pathname.startsWith("/api/")) {
        const raw = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: "Invalid JSON" }); }
        const out = await handleApi(req, url, body);
        const headers = { "Cache-Control": "no-store", ...(out.headers || {}) };
        if (out.csv !== undefined) {
          res.writeHead(out.status, { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${out.filename}"` });
          return res.end(out.csv);
        }
        res.writeHead(out.status, { ...headers, "Content-Type": "application/json" });
        return res.end(JSON.stringify(out.json));
      }
      if (req.method === "GET" && serveStatic(url.pathname, res)) return;

      if (req.method !== "POST") return send(res, 404, { error: "not found" });

      const raw = await readBody(req);
      if (!authorised(req, raw)) return send(res, 401, { error: "invalid signature" });
      const body = raw ? JSON.parse(raw) : {};

      if (url.pathname === "/retell/inbound") return send(res, 200, handleInbound(body));

      if (url.pathname === "/retell/webhook") {
        send(res, 204); // acknowledge fast, process after
        handleCallEvent(body).catch((e) => console.error("[webhook]", e));
        return;
      }

      const m = url.pathname.match(/^\/tools\/([a-z_]+)$/);
      if (m && handlers[m[1]]) {
        const tenant = tenantForCall(body.call);
        if (!tenant) return send(res, 200, { error: true, instruction: "Apologise and take the caller's name, number and message; something went wrong on our side." });
        const args = body.args || {};
        const result = await handlers[m[1]](tenant, args, body.call);
        return send(res, 200, result);
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      console.error(`[${url.pathname}]`, e);
      if (!res.headersSent) send(res, 500, { error: true, instruction: "Apologise, there was a technical problem. Take a message instead." });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.NODE_ENV === "production" && (process.env.SESSION_SECRET || "").length < 32) {
    console.error("SESSION_SECRET must be set to 32+ random characters in production (openssl rand -hex 32).");
    process.exit(1);
  }
  const tenants = loadTenants();
  createServer().listen(env.port, () => {
    console.log(`DBS voice agent listening on :${env.port} with ${Object.keys(tenants).length} client(s): ${Object.keys(tenants).join(", ")}`);
    if (env.skipSignature) console.warn("WARNING: signature checks are OFF");
    if (!env.retellApiKey) console.warn("WARNING: RETELL_API_KEY is not set");
  });
}
