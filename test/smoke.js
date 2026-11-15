// End-to-end smoke test with signed requests. No network needed.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.RETELL_API_KEY = "test_key";
process.env.RETELL_AGENT_ID = "agent_test";
process.env.SKIP_SIGNATURE_CHECK = "false";
process.env.RESEND_API_KEY = "";
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "voice-"));

const { createServer } = await import("../src/server.js");
const { signForTest, verifyRetellSignature } = await import("../src/retell.js");
const { computeSlots, zonedToUtc } = await import("../src/calendar.js");
const { readRecords, } = await import("../src/store.js");
const { toolDefinitions } = await import("../src/tools.js");
const { GENERAL_PROMPT, DEFAULT_DYNAMIC_VARIABLES } = await import("../src/prompt.js");
const { getTenants, dynamicVariablesFor } = await import("../src/tenants.js");

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

// --- unit: signatures
const body = '{"a":1}';
assert.ok(verifyRetellSignature(body, signForTest(body, "k"), "k"));
assert.ok(!verifyRetellSignature(body, signForTest(body, "wrong"), "k"));
assert.ok(!verifyRetellSignature(body, signForTest(body, "k", Date.now() - 10 * 60_000), "k"));
ok("signature verify accepts valid, rejects wrong key and stale timestamp");

// --- unit: time zones (GMT in winter, BST in summer)
assert.equal(zonedToUtc("2026-12-01", "09:00", "Europe/London").toISOString(), "2026-12-01T09:00:00.000Z");
assert.equal(zonedToUtc("2026-07-01", "09:00", "Europe/London").toISOString(), "2026-07-01T08:00:00.000Z");
ok("UK time zone conversion handles GMT and BST");

// --- unit: slot finding skips busy blocks, buffer, closed days and notice period
const slots = computeSlots({
  startDate: "2026-11-16", days: 7, tz: "Europe/London", slotMinutes: 30, bufferMinutes: 0,
  hours: { mon: ["10:00", "12:00"], tue: ["10:00", "11:00"] },
  busy: [[new Date("2026-11-16T10:30:00Z"), new Date("2026-11-16T11:30:00Z")]],
  now: new Date("2026-11-15T12:00:00Z"), minNoticeMinutes: 60, limit: 10,
});
assert.deepEqual(slots.map((d) => d.toISOString()), [
  "2026-11-16T10:00:00.000Z", "2026-11-16T11:30:00.000Z", "2026-11-17T10:00:00.000Z", "2026-11-17T10:30:00.000Z",
]);
ok("free slots respect busy times and opening hours");

// --- unit: every {{variable}} in the prompt is supplied
const vars = [...GENERAL_PROMPT.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
const supplied = dynamicVariablesFor(getTenants()["dbs-group"], { fromNumber: "+447700900000" });
for (const v of vars) {
  assert.ok(v in supplied, `missing dynamic variable ${v}`);
  assert.ok(v in DEFAULT_DYNAMIC_VARIABLES, `missing default for ${v}`);
}
assert.ok(Object.values(supplied).every((v) => typeof v === "string"), "dynamic variables must be strings");
ok("prompt variables all supplied as strings, with defaults");

const defs = toolDefinitions("https://example.com");
assert.deepEqual(defs.map((d) => d.name), ["end_call", "transfer_to_team", "take_message", "qualify_lead", "check_availability", "book_appointment"]);
ok("tool definitions built");

// --- integration: HTTP server
const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const post = async (p, obj, { sign = true } = {}) => {
  const raw = JSON.stringify(obj);
  const r = await fetch(base + p, { method: "POST", body: raw, headers: { "Content-Type": "application/json", ...(sign ? { "x-retell-signature": signForTest(raw, "test_key") } : {}) } });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};

const DBS = getTenants()["dbs-group"].phone_numbers[0];
const call = { call_id: "call_1", from_number: "+447700900123", to_number: DBS, retell_llm_dynamic_variables: { tenant_id: "dbs-group" } };

let r = await post("/retell/inbound", { event: "call_inbound", call_inbound: { from_number: call.from_number, to_number: DBS } }, { sign: false });
assert.equal(r.status, 401);
ok("unsigned request rejected");

r = await post("/retell/inbound", { event: "call_inbound", call_inbound: { from_number: call.from_number, to_number: DBS } });
assert.equal(r.status, 200);
assert.equal(r.json.call_inbound.override_agent_id, "agent_test");
assert.equal(r.json.call_inbound.dynamic_variables.business_name, "DBS Group");
assert.equal(r.json.call_inbound.dynamic_variables.caller_number, "+447700900123");
ok("inbound call routed to DBS Group with its details");

r = await post("/retell/inbound", { event: "call_inbound", call_inbound: { from_number: "+1", to_number: "+440000000000" } });
assert.deepEqual(r.json, { call_inbound: {} });
ok("unknown number falls back to agent defaults");

r = await post("/tools/take_message", { name: "take_message", call, args: { caller_name: "Jane Smith", message: "Call me about card payments", urgency: "urgent" } });
assert.equal(r.json.saved, true);
assert.equal(readRecords("dbs-group", "messages")[0].callback_number, "+447700900123");
ok("message saved, caller number used as callback");

r = await post("/tools/qualify_lead", { name: "qualify_lead", call, args: { caller_name: "Raj", company: "Acme Ltd", need: "New app", score: "hot" } });
assert.equal(r.json.score, "hot");
assert.match(r.json.instruction, /transfer_to_team/);
ok("hot lead saved and transfer offered");

r = await post("/tools/check_availability", { name: "check_availability", call, args: {} });
assert.equal(r.json.error, true);
assert.match(r.json.instruction, /take_message/);
ok("calendar not configured -> graceful fallback to message");

r = await post("/retell/webhook", { event: "call_analyzed", call: { ...call, start_timestamp: 0, end_timestamp: 95000, call_analysis: { call_summary: "Asked about payments" } } });
assert.equal(r.status, 204);
await new Promise((res) => setTimeout(res, 50));
assert.equal(readRecords("dbs-group", "calls")[0].duration_sec, 95);
ok("call summary recorded after call_analyzed");

server.close();
console.log(`\nAll ${passed} checks passed.`);
