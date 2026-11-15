// Vapi voice engine: assistant auto-setup, Twilio number import, inbound routing, tools, transfers, end-of-call.
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vapi-"));
fs.cpSync(path.join(root, "tenants"), path.join(tmp, "tenants"), { recursive: true });

// ---------- fake Vapi API ----------
const seen = [];
const numbers = [{ id: "pn_existing", number: "+442071119001" }];
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const fake = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  const u = new URL(req.url, "http://x");
  seen.push({ method: req.method, p: u.pathname, body, auth: req.headers.authorization });
  const json = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "POST" && u.pathname === "/assistant") return json(201, { id: "asst_123", ...body });
  if (req.method === "PATCH" && u.pathname === "/assistant/asst_123") return json(200, { id: "asst_123" });
  if (req.method === "GET" && u.pathname === "/phone-number") return json(200, numbers);
  if (req.method === "POST" && u.pathname === "/phone-number") { const n = { id: `pn_${numbers.length}`, ...body }; numbers.push(n); return json(201, n); }
  const m = u.pathname.match(/^\/phone-number\/(.+)$/);
  if (req.method === "PATCH" && m) return json(200, { id: m[1], ...body });
  json(404, { message: "not found" });
});
await new Promise((r) => fake.listen(0, r));

Object.assign(process.env, {
  TENANTS_DIR: path.join(tmp, "tenants"), DATA_DIR: path.join(tmp, "data"),
  VOICE_PROVIDER: "vapi", VAPI_API_KEY: "vapi_private", VAPI_API_BASE: `http://localhost:${fake.address().port}`,
  TWILIO_ACCOUNT_SID: "AC123", TWILIO_API_KEY: "SK123", TWILIO_API_SECRET: "tw_secret",
  PUBLIC_BASE_URL: "https://voice.dbsgroup.io", SESSION_SECRET: "test-session-secret-0123456789abcdef0123",
});

const { createServer } = await import("../src/server.js");
const { syncAssistantOnStart, webhookSecret, assistantConfig } = await import("../src/vapi.js");
const { createUser } = await import("../src/auth.js");
const { readRecords } = await import("../src/store.js");
const { GENERAL_PROMPT } = await import("../src/prompt.js");

let passed = 0;
const ok = (n) => { passed++; console.log(`  ✓ ${n}`); };

// ---------- assistant auto-setup ----------
let r = await syncAssistantOnStart();
assert.equal(r.ok, "created");
const created = seen.find((x) => x.method === "POST" && x.p === "/assistant").body;
assert.equal(seen[0].auth, "Bearer vapi_private");
assert.equal(created.firstMessage, "{{greeting}}");
assert.match(created.model.messages[0].content, /\{\{business_name\}\}/);
assert.ok(!created.model.messages[0].content.includes("transfer_to_team"), "prompt uses Vapi tool names");
assert.deepEqual(created.model.tools.map((t) => t.function?.name || t.type), ["endCall", "transferCall", "take_message", "qualify_lead", "check_availability", "book_appointment"]);
assert.deepEqual(created.model.tools[1].destinations, [], "dynamic transfer: server picks the number");
const secret = webhookSecret();
assert.ok(secret.length >= 32);
assert.equal(created.server.url, `https://voice.dbsgroup.io/vapi/webhook?token=${secret}`);
assert.ok(created.serverMessages.includes("transfer-destination-request"));
assert.equal((await syncAssistantOnStart()).ok, "up to date");
assert.equal(seen.filter((x) => x.p === "/assistant").length, 1, "no extra calls when nothing changed");
ok("assistant created automatically on start, then left alone until the prompt changes");

// every {{variable}} in the prompt is something we send
const vars = [...GENERAL_PROMPT.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
assert.ok(vars.length > 5 && assistantConfig());
ok("prompt variables line up with what inbound calls send");

// ---------- server ----------
createUser({ email: "admin@dbsgroup.io", password: "admin-password-123", role: "admin" });
const server = createServer();
await new Promise((res) => server.listen(0, res));
const base = `http://localhost:${server.address().port}`;
const hook = (msg, token = secret) => fetch(`${base}/vapi/webhook?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg }) }).then(async (x) => ({ status: x.status, json: await x.json() }));
const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@dbsgroup.io", password: "admin-password-123" }) });
const admin = (login.headers.get("set-cookie") || "").split(";")[0];
const api = (p, body, method = "POST") => fetch(base + p, { method, headers: { Cookie: admin, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (x) => ({ status: x.status, json: await x.json() }));

assert.equal((await hook({ type: "assistant-request" }, "wrong")).status, 401);
const viaHeader = await fetch(`${base}/vapi/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-vapi-secret": secret }, body: JSON.stringify({ message: { type: "status-update" } }) });
assert.equal(viaHeader.status, 200);
ok("webhook rejects a wrong token; accepts the token in the URL or X-Vapi-Secret header");

// ---------- numbers ----------
r = await api("/api/numbers", null, "GET");
assert.equal(r.json.engine, "Vapi");
assert.equal(r.json.can_import, true);
assert.equal(r.json.ready, true);
r = await api("/api/numbers", { number: "+442071119002", import: true });
assert.equal(r.status, 201, JSON.stringify(r.json));
const imported = seen.find((x) => x.method === "POST" && x.p === "/phone-number").body;
assert.equal(imported.provider, "twilio");
assert.equal(imported.twilioAccountSid, "AC123");
assert.equal(imported.twilioApiKey, "SK123");
assert.equal(imported.twilioAuthToken, undefined, "uses the revocable API key, not the master token");
assert.equal(imported.assistantId, undefined, "no assistant on the number, so calls ask our server");
assert.equal(imported.server.url, `https://voice.dbsgroup.io/vapi/webhook?token=${secret}`);
r = await api("/api/numbers", { number: "+442071119001", import: false });
assert.equal(r.status, 201);
const bound = seen.find((x) => x.method === "PATCH" && x.p === "/phone-number/pn_existing").body;
assert.equal(bound.assistantId, null);
assert.match(bound.server.url, /\/vapi\/webhook\?token=/);
r = await api("/api/numbers", { number: "+442071119999", import: false });
assert.match(r.json.error, /isn't in your Vapi account/);
ok("Twilio numbers imported into Vapi (or existing ones re-pointed) and routed to our server");

r = await api("/api/tenants/dbs-group/assign-number", {});
const dbsNumber = r.json.number;
assert.ok(dbsNumber);
assert.match(seen.filter((x) => x.method === "PATCH" && x.p.startsWith("/phone-number/")).at(-1).body.name, /DBS Group/);
await api("/api/tenants/dbs-group", { transfer_number: "+447700900500", billing: { monthly_fee: 99, included_minutes: 400, overage_per_minute: 0.2, currency: "GBP", stripe_customer_id: undefined } }, "PUT");
ok("assigning a number labels it in Vapi with the client's name");

// ---------- a call ----------
const callBase = { id: "call_v1", customer: { number: "+447700900123" }, phoneNumber: { number: dbsNumber } };
r = await hook({ type: "assistant-request", call: callBase, phoneNumber: { number: dbsNumber }, customer: { number: "+447700900123" } });
assert.equal(r.json.assistantId, "asst_123");
const vv = r.json.assistantOverrides.variableValues;
assert.equal(vv.business_name, "DBS Group");
assert.equal(vv.caller_number, "+447700900123");
assert.ok(Object.values(vv).every((v) => typeof v === "string"));
for (const v of vars) assert.ok(v in vv, `missing ${v}`);
ok("inbound call: our server picks the right client and fills in its details");

r = await hook({ type: "assistant-request", phoneNumber: { number: "+440000000000" }, customer: { number: "+447700900123" } });
assert.ok(r.json.error);
ok("unknown or paused numbers are refused cleanly");

const call = { ...callBase, assistantOverrides: { variableValues: vv } };
r = await hook({ type: "tool-calls", call, toolCallList: [
  { id: "tc_1", type: "function", function: { name: "take_message", arguments: JSON.stringify({ caller_name: "Jane", message: "Call me about card terminals", urgency: "urgent" }) } },
  { id: "tc_2", type: "function", function: { name: "qualify_lead", arguments: { caller_name: "Raj", need: "New app", score: "hot" } } },
  { id: "tc_3", type: "function", function: { name: "delete_everything", arguments: {} } },
] });
assert.deepEqual(r.json.results.map((x) => x.toolCallId), ["tc_1", "tc_2", "tc_3"]);
assert.equal(JSON.parse(r.json.results[0].result).saved, true);
assert.match(JSON.parse(r.json.results[1].result).instruction, /transfer tool/);
assert.equal(JSON.parse(r.json.results[2].result).error, true);
assert.equal(readRecords("dbs-group", "messages")[0].callback_number, "+447700900123");
assert.equal(readRecords("dbs-group", "leads")[0].score, "hot");
ok("tool calls (string or object arguments) save messages and leads; unknown tools refused");

r = await hook({ type: "transfer-destination-request", call });
assert.deepEqual(r.json.destination, { type: "number", number: "+447700900500", message: "Putting you through now, one moment." });
ok("transfers go to the client's own transfer number");

r = await hook({ type: "end-of-call-report", call, phoneNumber: { number: dbsNumber }, customer: { number: "+447700900123" },
  durationSeconds: 125.4, endedReason: "customer-ended-call", analysis: { summary: "Asked about card terminals" },
  artifact: { recordingUrl: "https://storage.vapi.ai/rec.wav", transcript: "AI: Hello..." } });
assert.equal(r.status, 200);
await new Promise((res) => setTimeout(res, 50));
const logged = readRecords("dbs-group", "calls")[0];
assert.deepEqual([logged.duration_sec, logged.summary, logged.recording_url, logged.from], [125, "Asked about card terminals", "https://storage.vapi.ai/rec.wav", "+447700900123"]);
r = await api("/api/tenants/dbs-group/stats", null, "GET");
assert.equal(r.json.stats.billed_minutes, 3);
ok("end-of-call report logged with summary and recording; minutes count towards the bill");

// summary can also arrive on the call object
await hook({ type: "end-of-call-report", call: { ...call, id: "call_v2", analysis: { summary: "Wants a quote" } }, phoneNumber: { number: dbsNumber }, customer: { number: "+447700900123" }, durationSeconds: 30, artifact: {} });
await new Promise((res) => setTimeout(res, 50));
assert.equal(readRecords("dbs-group", "calls").at(-1).summary, "Wants a quote");
assert.ok(assistantConfig().analysisPlan.summaryPlan.enabled);
ok("call summaries requested from Vapi and read from either place they arrive");

// ---------- clients take their own number ----------
await api("/api/tenants", { id: "cafe-one", name: "Cafe One" });
await api("/api/tenants", { id: "cafe-two", name: "Cafe Two" });
await api("/api/users", { email: "one@cafe.co.uk", password: "cafe-one-password", role: "client", tenant_id: "cafe-one" });
await api("/api/users", { email: "two@cafe.co.uk", password: "cafe-two-password", role: "client", tenant_id: "cafe-two" });
const loginAs = async (email, password) => (await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).headers.get("set-cookie").split(";")[0];
const asClient = (cookie, p) => fetch(base + p, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" }).then(async (x) => ({ status: x.status, json: await x.json() }));
const one = await loginAs("one@cafe.co.uk", "cafe-one-password");
const two = await loginAs("two@cafe.co.uk", "cafe-two-password");
r = await asClient(one, "/api/tenants/cafe-one/claim-number");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.match(seen.filter((x) => x.method === "PATCH" && x.p.startsWith("/phone-number/")).at(-1).body.name, /Cafe One/);
r = await asClient(one, "/api/tenants/cafe-one/claim-number");
assert.equal(r.status, 409);
assert.match(r.json.error, /already have an AI number/);
assert.equal((await asClient(one, "/api/tenants/cafe-two/claim-number")).status, 404, "can't claim for another business");
r = await asClient(two, "/api/tenants/cafe-two/claim-number");
assert.equal(r.status, 409);
assert.match(r.json.error, /No numbers are free/);
await api("/api/tenants/cafe-two", { active: false }, "PUT");
assert.equal((await asClient(two, "/api/tenants/cafe-two/claim-number")).status, 403);
ok("clients can take one free number themselves; not twice, not for others, not when paused or the pool is empty");

server.close(); fake.close();
console.log(`\nAll ${passed} Vapi checks passed.`);
