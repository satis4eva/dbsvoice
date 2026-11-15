// Dashboard API tests: logins, access control, settings validation, usage and billing.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
fs.cpSync(path.join(root, "tenants"), path.join(tmp, "tenants"), { recursive: true });
process.env.TENANTS_DIR = path.join(tmp, "tenants");
process.env.DATA_DIR = path.join(tmp, "data");
process.env.RETELL_API_KEY = "test_key";
process.env.PUBLIC_BASE_URL = "http://localhost";

const { createServer } = await import("../src/server.js");
const { createUser } = await import("../src/auth.js");
const { record } = await import("../src/store.js");

let passed = 0;
const ok = (n) => { passed++; console.log(`  ✓ ${n}`); };

createUser({ email: "admin@dbsgroup.io", password: "admin-password-123", role: "admin" });
createUser({ email: "owner@spice.co.uk", password: "client-password-123", role: "client", tenant_id: "example-restaurant" });

const month = new Date().toISOString().slice(0, 7);
record("dbs-group", "calls", { call_id: "c1", from: "+447700900001", duration_sec: 61, summary: "Payments enquiry" }); // 2 billed min
record("dbs-group", "calls", { call_id: "c2", from: "+447700900002", duration_sec: 30 }); // 1 billed min
record("dbs-group", "leads", { call_id: "c1", score: "hot", caller_name: "=HYPERLINK(\"x\")", need: "app" });

const server = createServer();
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

async function login(email, password) {
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
const call = async (cookie, p, { method = "GET", body } = {}) => {
  const r = await fetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text, type: r.headers.get("content-type") };
};

// static
let r = await fetch(`${base}/`);
assert.equal(r.status, 200);
assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
assert.equal((await fetch(`${base}/../package.json`)).status, 404);
ok("dashboard page served with security headers; no path traversal");

// login
assert.equal((await login("admin@dbsgroup.io", "wrong-password-xx")).status, 401);
assert.equal((await call("", "/api/me")).status, 401);
const admin = (await login("admin@dbsgroup.io", "admin-password-123")).cookie;
const client = (await login("owner@spice.co.uk", "client-password-123")).cookie;
assert.ok(admin.startsWith("sid=") && client.startsWith("sid="));
assert.equal((await call("sid=forged.abc", "/api/me")).status, 401);
ok("login works, wrong password and forged cookie rejected");

// access control
r = await call(client, "/api/me");
assert.deepEqual(r.json.tenants.map((t) => t.id), ["example-restaurant"]);
assert.equal((await call(client, "/api/tenants/dbs-group")).status, 404);
assert.equal((await call(client, "/api/tenants/dbs-group/calls")).status, 404);
assert.equal((await call(client, "/api/tenants")).status, 403);
assert.equal((await call(client, "/api/users")).status, 403);
assert.equal((await call(client, "/api/tenants/example-restaurant")).json.tenant.billing, undefined);
ok("clients only see their own business and can't reach admin pages");

// client can edit their info but not routing or billing
r = await call(client, "/api/tenants/example-restaurant", { method: "PUT", body: { greeting: "Hi from Spice!", phone_numbers: "+441111111111", billing: { monthly_fee: 0 } } });
assert.equal(r.status, 200);
assert.equal(r.json.tenant.greeting, "Hi from Spice!");
assert.deepEqual(r.json.tenant.phone_numbers, ["+447700900999"]);
ok("client edits greeting; phone numbers and billing stay locked");

// validation
r = await call(client, "/api/tenants/example-restaurant", { method: "PUT", body: { hours: { mon: ["18:00", "09:00"] } } });
assert.equal(r.status, 400);
r = await call(client, "/api/tenants/example-restaurant", { method: "PUT", body: { transfer_number: "07700 900123" } });
assert.match(r.json.error, /international format/);
r = await call(client, "/api/tenants/example-restaurant", { method: "PUT", body: { notify: { email: "not-an-email" } } });
assert.equal(r.status, 400);
const noJson = await fetch(`${base}/api/tenants/example-restaurant`, { method: "PUT", headers: { Cookie: client, "Content-Type": "text/plain" }, body: "{}" });
assert.equal(noJson.status, 415);
ok("bad hours, numbers, emails and non-JSON writes rejected");

// admin: billing + usage
r = await call(admin, "/api/tenants/dbs-group", { method: "PUT", body: { billing: { monthly_fee: 49, included_minutes: 2, overage_per_minute: 0.25, currency: "gbp" } } });
assert.equal(r.json.tenant.billing.currency, "GBP");
r = await call(admin, `/api/tenants/dbs-group/stats?month=${month}`);
assert.equal(r.json.stats.billed_minutes, 3);
assert.equal(r.json.stats.invoice.overage_minutes, 1);
assert.equal(r.json.stats.invoice.total, 49.25);
assert.equal(r.json.stats.hot_leads, 1);
ok("minutes rounded up per call; invoice = fee + extra minutes");

r = await call(admin, `/api/tenants?month=${month}&format=csv`);
assert.match(r.type, /text\/csv/);
assert.match(r.text, /DBS Group,dbs-group,.*,49.25,GBP/);
r = await call(admin, `/api/tenants/dbs-group/leads.csv?month=${month}`);
assert.match(r.text, /'=HYPERLINK/);
ok("usage CSV exports; formula injection neutralised");

// admin: create client + number clash
r = await call(admin, "/api/tenants", { method: "POST", body: { id: "smith-dental", name: "Smith Dental", phone_numbers: "+44 20 7946 0000" } });
assert.equal(r.status, 201);
assert.deepEqual(r.json.tenant.phone_numbers, ["+442079460000"]);
assert.ok(fs.existsSync(path.join(tmp, "tenants", "smith-dental.json")));
r = await call(admin, "/api/tenants", { method: "POST", body: { id: "other", name: "Other", phone_numbers: "+442079460000" } });
assert.equal(r.status, 409);
r = await call(admin, "/api/tenants", { method: "POST", body: { id: "../evil", name: "x" } });
assert.equal(r.status, 400);
ok("admin creates a client; duplicate numbers and bad ids rejected");

// new client answers calls straight away
r = await fetch(`${base}/retell/inbound`, { method: "POST", headers: { "Content-Type": "application/json", "x-retell-signature": (await import("../src/retell.js")).signForTest(JSON.stringify({ call_inbound: { to_number: "+442079460000", from_number: "+447700900009" } }), "test_key") }, body: JSON.stringify({ call_inbound: { to_number: "+442079460000", from_number: "+447700900009" } }) });
assert.equal((await r.json()).call_inbound.dynamic_variables.business_name, "Smith Dental");
ok("new client's number routes to it without a restart");

// pausing a client stops it answering as that business
await call(admin, "/api/tenants/smith-dental", { method: "PUT", body: { active: false } });
const body2 = JSON.stringify({ call_inbound: { to_number: "+442079460000", from_number: "+447700900009" } });
r = await fetch(`${base}/retell/inbound`, { method: "POST", headers: { "Content-Type": "application/json", "x-retell-signature": (await import("../src/retell.js")).signForTest(body2, "test_key") }, body: body2 });
assert.deepEqual(await r.json(), { call_inbound: {} });
ok("paused client no longer answered as that business");

// users
r = await call(admin, "/api/users", { method: "POST", body: { email: "a@b.co", password: "short", role: "client", tenant_id: "smith-dental" } });
assert.equal(r.status, 400);
r = await call(admin, "/api/users", { method: "POST", body: { email: "dr@smith.co.uk", password: "long-enough-pass", role: "client", tenant_id: "smith-dental" } });
assert.equal(r.status, 201);
assert.equal(r.json.user.password, undefined);
r = await call(client, "/api/me/password", { method: "POST", body: { current: "client-password-123", password: "new-client-password" } });
assert.equal(r.status, 200);
assert.equal((await login("owner@spice.co.uk", "new-client-password")).status, 200);
ok("users created without exposing hashes; password change works");

server.close();
console.log(`\nAll ${passed} dashboard checks passed.`);
