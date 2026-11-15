// End-to-end test of numbers, Google Calendar connect, and Stripe self sign-up,
// against a local fake of the Retell, Stripe and Google APIs.
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "integ-"));
fs.cpSync(path.join(root, "tenants"), path.join(tmp, "tenants"), { recursive: true });

// ---------- fake external APIs ----------
const seen = { retell: [], stripe: [], google: [] };
const retellNumbers = new Set(["+442071110001"]);
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const fake = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  const u = new URL(req.url, "http://x");
  const json = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (u.pathname.startsWith("/retell/")) {
    const p = u.pathname.slice(7);
    const body = raw ? JSON.parse(raw) : {};
    seen.retell.push({ method: req.method, p, body });
    let m = p.match(/^\/update-phone-number\/(.+)$/);
    if (m) return retellNumbers.has(decodeURIComponent(m[1])) ? json(200, { phone_number: decodeURIComponent(m[1]), ...body }) : json(404, { error: "not found" });
    if (p === "/import-phone-number") { retellNumbers.add(body.phone_number); return json(201, body); }
  }
  if (u.pathname.startsWith("/stripe/v1/")) {
    const p = u.pathname.slice(10);
    const form = Object.fromEntries(new URLSearchParams(raw));
    seen.stripe.push({ p, form, idem: req.headers["idempotency-key"] });
    if (p === "/checkout/sessions") return json(200, { id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
    if (p === "/billing_portal/sessions") return json(200, { url: "https://billing.stripe.test/p_1" });
    if (p === "/billing/meter_events") return json(200, { object: "billing.meter_event" });
  }
  if (u.pathname === "/google/token") {
    const form = Object.fromEntries(new URLSearchParams(raw));
    seen.google.push({ p: "token", form });
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "owner@gmail.com" })).toString("base64url")}.y`;
    if (form.grant_type === "authorization_code" && form.code === "good-code") return json(200, { access_token: "at_1", refresh_token: "rt_secret_123", expires_in: 3600, id_token: idToken });
    if (form.grant_type === "refresh_token") return json(200, { access_token: "at_2", expires_in: 3600 });
    return json(400, { error: "invalid_grant" });
  }
  if (u.pathname === "/google/revoke") { seen.google.push({ p: "revoke", q: u.search }); return json(200, {}); }
  if (u.pathname.startsWith("/google/cal")) {
    const p = u.pathname.slice(11);
    seen.google.push({ p, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
    if (p === "/freeBusy") return json(200, { calendars: { primary: { busy: [] } } });
    if (p === "/calendars/primary/events") return json(200, { id: "ev_1", htmlLink: "https://calendar.google.com/ev_1" });
  }
  json(404, { error: `fake: no route ${u.pathname}` });
});
await new Promise((r) => fake.listen(0, r));
const F = `http://localhost:${fake.address().port}`;

Object.assign(process.env, {
  TENANTS_DIR: path.join(tmp, "tenants"), DATA_DIR: path.join(tmp, "data"),
  VOICE_PROVIDER: "retell", RETELL_API_KEY: "test_key", RETELL_AGENT_ID: "agent_main", PUBLIC_BASE_URL: "https://voice.dbsgroup.io",
  RETELL_API_BASE: `${F}/retell`, RETELL_SIP_TERMINATION_URI: "sip.dbsgroup.io",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_API_BASE: `${F}/stripe`,
  GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret", GOOGLE_AUTH_URL: `${F}/google/auth`,
  GOOGLE_TOKEN_URL: `${F}/google/token`, GOOGLE_REVOKE_URL: `${F}/google/revoke`, GOOGLE_CAL_BASE: `${F}/google/cal`,
  SESSION_SECRET: "test-session-secret-0123456789abcdef0123",
});

const { createServer } = await import("../src/server.js");
const { createUser } = await import("../src/auth.js");
const { signForTest } = await import("../src/retell.js");
const { signStripeForTest } = await import("../src/stripe.js");
const { readRecords } = await import("../src/store.js");

let passed = 0;
const ok = (n) => { passed++; console.log(`  ✓ ${n}`); };

createUser({ email: "admin@dbsgroup.io", password: "admin-password-123", role: "admin" });
const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const req = async (p, { method = "GET", body, cookie = "", headers = {}, raw } = {}) => {
  const r = await fetch(base + p, { method, redirect: "manual", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, location: r.headers.get("location"), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
};
const retellPost = (p, obj) => { const raw = JSON.stringify(obj); return req(p, { method: "POST", raw, headers: { "Content-Type": "application/json", "x-retell-signature": signForTest(raw, "test_key") } }); };
const stripePost = (event, secret = "whsec_test") => { const raw = JSON.stringify(event); return req("/stripe/webhook", { method: "POST", raw, headers: { "Content-Type": "application/json", "stripe-signature": signStripeForTest(raw, secret) } }); };

const admin = (await req("/api/login", { method: "POST", body: { email: "admin@dbsgroup.io", password: "admin-password-123" } })).cookie;

// ---------- 1. number pool ----------
let r = await req("/api/numbers", { method: "POST", cookie: admin, body: { number: "+44 20 7111 0001", import: false } });
assert.equal(r.status, 201, JSON.stringify(r.json));
const bind = seen.retell.find((x) => x.p === "/update-phone-number/%2B442071110001");
assert.deepEqual(bind.body.inbound_agents, [{ agent_id: "agent_main", weight: 1 }]);
assert.equal(bind.body.inbound_webhook_url, "https://voice.dbsgroup.io/retell/inbound");
r = await req("/api/numbers", { method: "POST", cookie: admin, body: { number: "+442071110099", import: false } });
assert.match(r.json.error, /isn't in your Retell account/);
r = await req("/api/numbers", { method: "POST", cookie: admin, body: { number: "+442071110002", import: true } });
assert.equal(r.status, 201);
const imp = seen.retell.find((x) => x.p === "/import-phone-number");
assert.equal(imp.body.termination_uri, "sip.dbsgroup.io");
assert.equal(imp.body.phone_number, "+442071110002");
r = await req("/api/numbers", { cookie: admin });
assert.equal(r.json.free, 2);
ok("numbers added to pool: existing ones bound to agent + webhook, new ones imported via SIP");

// ---------- 2. self sign-up ----------
r = await req("/api/plans");
assert.ok(r.json.plans.length >= 1 && r.json.payments === true);
assert.ok(!JSON.stringify(r.json).includes("price_"), "Stripe price ids must not be public");
r = await req("/api/signup", { method: "POST", body: { business_name: "Bright Smile Dental", name: "Dr Lee", email: "lee@brightsmile.co.uk", password: "short", plan: "pro" } });
assert.equal(r.status, 400);
assert.equal(fs.readdirSync(path.join(tmp, "tenants")).filter((f) => f.startsWith("bright")).length, 0, "no orphan client on failed sign-up");
r = await req("/api/signup", { method: "POST", body: { business_name: "Bright Smile Dental", name: "Dr Lee", email: "lee@brightsmile.co.uk", password: "a-good-password", plan: "pro" } });
assert.equal(r.status, 201, JSON.stringify(r.json));
assert.equal(r.json.checkout_url, "https://checkout.stripe.test/cs_1");
const client = r.cookie;
const tid = r.json.tenant_id;
assert.match(tid, /^bright-smile-dental-[0-9a-f]{4}$/);
const co = seen.stripe.find((x) => x.p === "/checkout/sessions").form;
assert.equal(co.mode, "subscription");
assert.equal(co.client_reference_id, tid);
assert.equal(co["line_items[0][price]"], "price_REPLACE_PRO_MONTHLY");
assert.equal(co["line_items[1][price]"], "price_REPLACE_PRO_MINUTES");
assert.equal(co["line_items[1][quantity]"], undefined, "metered price has no quantity");
r = await req(`/api/tenants/${tid}`, { cookie: client });
assert.equal(r.json.tenant.active, false);
assert.equal(r.json.plan.can_pay, true);
assert.equal(r.json.onboarding.steps.find((s) => s.id === "payment").done, false);
assert.equal((await req("/api/signup", { method: "POST", body: { business_name: "Dup", email: "lee@brightsmile.co.uk", password: "a-good-password", plan: "pro" } })).status, 409);
ok("sign-up creates an inactive client + login and sends them to Stripe Checkout");

// clients can't touch admin features
assert.equal((await req("/api/numbers", { cookie: client })).status, 403);
assert.equal((await req(`/api/tenants/${tid}/activate`, { method: "POST", cookie: client, body: {} })).status, 403);
assert.equal((await req(`/api/tenants/${tid}/assign-number`, { method: "POST", cookie: client, body: {} })).status, 403);
ok("clients can't activate themselves or take numbers");

// ---------- 3. Stripe webhook activates + assigns number ----------
const completed = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", client_reference_id: tid, customer: "cus_123", subscription: "sub_123", metadata: { tenant_id: tid } } } };
assert.equal((await stripePost(completed, "whsec_wrong")).status, 400);
r = await stripePost(completed);
assert.equal(r.json.ok, "activated");
r = await req(`/api/tenants/${tid}`, { cookie: client });
assert.equal(r.json.tenant.active, true);
assert.deepEqual(r.json.tenant.phone_numbers, ["+442071110001"]);
assert.equal(r.json.plan.has_portal, true);
assert.match(seen.retell.filter((x) => x.p === "/update-phone-number/%2B442071110001").at(-1).body.nickname, /Bright Smile Dental/);
assert.equal((await stripePost(completed)).json.ok, "already active");
ok("paid sign-up goes live automatically with a number from the pool (and replays are harmless)");

r = await retellPost("/retell/inbound", { call_inbound: { to_number: "+442071110001", from_number: "+447700900777" } });
assert.equal(r.json.call_inbound.dynamic_variables.business_name, "Bright Smile Dental");
assert.equal(r.json.call_inbound.dynamic_variables.booking_enabled, "no");
ok("calls to the new number are answered as the new client");

// ---------- 4. per-minute billing ----------
await retellPost("/retell/webhook", { event: "call_analyzed", call: { call_id: "call_77", to_number: "+442071110001", from_number: "+447700900777", start_timestamp: 1000, end_timestamp: 1000 + 125_000, call_analysis: { call_summary: "Booked a check-up" } } });
await new Promise((res) => setTimeout(res, 100));
const meter = seen.stripe.find((x) => x.p === "/billing/meter_events").form;
assert.equal(meter.event_name, "voice_minutes");
assert.equal(meter["payload[stripe_customer_id]"], "cus_123");
assert.equal(meter["payload[value]"], "3");
assert.equal(meter.identifier, "call_call_77");
assert.equal(readRecords(tid, "calls").length, 1);
ok("each call reports billed minutes to Stripe (125s → 3 min), once per call");

r = await req(`/api/tenants/${tid}/portal`, { method: "POST", cookie: client, body: {} });
assert.equal(r.json.url, "https://billing.stripe.test/p_1");
ok("client can open Stripe billing portal to update card or cancel");

// ---------- 5. Google Calendar connect ----------
r = await req(`/oauth/google/start?tenant=${tid}`, { cookie: client });
assert.equal(r.status, 302);
const auth = new URL(r.location);
assert.equal(auth.origin + auth.pathname, `${F}/google/auth`);
assert.equal(auth.searchParams.get("access_type"), "offline");
assert.equal(auth.searchParams.get("redirect_uri"), "https://voice.dbsgroup.io/oauth/google/callback");
const state = auth.searchParams.get("state");
assert.equal((await req(`/oauth/google/start?tenant=dbs-group`, { cookie: client })).location, "/app#/settings?calendar=denied");
assert.equal((await req(`/oauth/google/callback?code=good-code&state=tampered.${state.split(".")[1]}`)).location, "/app#/settings?calendar=expired");
r = await req(`/oauth/google/callback?code=good-code&state=${encodeURIComponent(state)}`);
assert.equal(r.location, "/app#/settings?calendar=connected");
const secretFile = fs.readFileSync(path.join(tmp, "data", "secrets", `${tid}.enc`), "utf8");
assert.ok(!secretFile.includes("rt_secret_123"), "refresh token must be encrypted at rest");
r = await req(`/api/tenants/${tid}`, { cookie: client });
assert.deepEqual([r.json.google.connected, r.json.google.email], [true, "owner@gmail.com"]);
assert.ok(!JSON.stringify(r.json).includes("rt_secret"), "token never sent to browser");
ok("client connects Google Calendar; token stored encrypted and never shown");

r = await retellPost("/retell/inbound", { call_inbound: { to_number: "+442071110001", from_number: "+447700900777" } });
assert.equal(r.json.call_inbound.dynamic_variables.booking_enabled, "yes");
const call = { call_id: "call_78", to_number: "+442071110001", from_number: "+447700900777", retell_llm_dynamic_variables: { tenant_id: tid } };
r = await retellPost("/tools/check_availability", { name: "check_availability", call, args: {} });
assert.ok(r.json.slots?.length > 0, JSON.stringify(r.json));
r = await retellPost("/tools/book_appointment", { name: "book_appointment", call, args: { start_iso: r.json.slots[0].start_iso, caller_name: "Sam Patel", reason: "Check-up" } });
assert.equal(r.json.booked, true, JSON.stringify(r.json));
const ev = seen.google.find((x) => x.p === "/calendars/primary/events");
assert.equal(ev.auth, "Bearer at_1");
assert.match(ev.body.summary, /Sam Patel/);
ok("assistant books into the client's own Google Calendar");

r = await req(`/api/tenants/${tid}/calendar-disconnect`, { method: "POST", cookie: client, body: {} });
assert.ok(seen.google.some((x) => x.p === "revoke" && x.q.includes("rt_secret_123")));
assert.equal((await req(`/api/tenants/${tid}`, { cookie: client })).json.google.connected, false);
ok("disconnect revokes Google access");

// ---------- 6. admin manual flows ----------
r = await req("/api/tenants", { method: "POST", cookie: admin, body: { id: "walk-in-cafe", name: "Walk-in Cafe" } });
assert.equal(r.status, 201);
r = await req("/api/tenants/walk-in-cafe/activate", { method: "POST", cookie: admin, body: {} });
assert.deepEqual(r.json.tenant.phone_numbers, ["+442071110002"]);
r = await req("/api/tenants/walk-in-cafe/assign-number", { method: "POST", cookie: admin, body: {} });
assert.equal(r.status, 409);
r = await req("/api/tenants/walk-in-cafe/release-number", { method: "POST", cookie: admin, body: { number: "+442071110002" } });
assert.deepEqual(r.json.tenant.phone_numbers, []);
assert.equal((await req("/api/numbers", { cookie: admin })).json.free, 1);
r = await req("/api/tenants/walk-in-cafe", { method: "PUT", cookie: admin, body: { phone_numbers: "+442071110099" } });
assert.equal(r.json.numbers_sync[0].ok, false);
ok("admin can activate without Stripe, assign and release numbers; bad numbers reported on save");

// ---------- 7. cancellation ----------
r = await stripePost({ id: "evt_2", type: "customer.subscription.deleted", data: { object: { id: "sub_123", customer: "cus_123", status: "canceled", metadata: { tenant_id: tid } } } });
assert.equal(r.json.ok, "paused");
r = await retellPost("/retell/inbound", { call_inbound: { to_number: "+442071110001", from_number: "+447700900777" } });
assert.deepEqual(r.json, { call_inbound: {} });
ok("cancelled subscription pauses the client");

server.close(); fake.close();
console.log(`\nAll ${passed} integration checks passed.`);
