import { env } from "./env.js";
import { getTenants, tenantById, saveTenant, TENANT_ID_RE } from "./tenants.js";
import * as auth from "./auth.js";
import { monthStats, recordsFor, toCsv, currentMonth, billedMinutes } from "./usage.js";
import * as numbers from "./numbers.js";
import { googleStatus, disconnect as disconnectGoogle, oauthConfigured } from "./google-oauth.js";
import { stripeConfigured, createCheckout, portalUrl } from "./stripe.js";
import { publicPlans, planById, signUp, activateTenant, onboarding, freePoolCount } from "./billing.js";

const secure = () => env.publicBaseUrl.startsWith("https://");
const MONTH_RE = /^\d{4}-\d{2}$/;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- settings validation ----------

const str = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
const lines = (v, maxItems = 30, max = 300) => (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((s) => str(s, max)).filter(Boolean).slice(0, maxItems);

function cleanHours(h) {
  const out = {};
  for (const d of DAYS) {
    const v = h?.[d];
    if (!v) continue;
    if (!Array.isArray(v) || !TIME_RE.test(v[0]) || !TIME_RE.test(v[1]) || v[0] >= v[1]) throw new HttpError(400, `Opening hours for ${d} must be two times like 09:00 and 17:30`);
    out[d] = [v[0], v[1]];
  }
  return out;
}

function cleanPhone(v, label) {
  const p = str(v, 20).replace(/[\s()-]/g, "");
  if (p && !PHONE_RE.test(p)) throw new HttpError(400, `${label} must be in international format, e.g. +447700900123`);
  return p;
}

/** Fields a client may edit for their own business. */
function applyClientFields(t, b) {
  if ("name" in b) { t.name = str(b.name, 100); if (!t.name) throw new HttpError(400, "Business name is required"); }
  if ("assistant_name" in b) t.assistant_name = str(b.assistant_name, 40) || "Ava";
  if ("greeting" in b) t.greeting = str(b.greeting, 400);
  if ("business_info" in b) t.business_info = str(b.business_info, 4000);
  if ("services" in b) t.services = lines(b.services);
  if ("hours" in b) t.hours = cleanHours(b.hours);
  if ("faqs" in b) {
    if (!Array.isArray(b.faqs)) throw new HttpError(400, "FAQs must be a list");
    t.faqs = b.faqs.map((f) => ({ q: str(f?.q, 300), a: str(f?.a, 1000) })).filter((f) => f.q && f.a).slice(0, 40);
  }
  if ("qualification" in b) t.qualification = { questions: lines(b.qualification?.questions, 12), hot_lead_criteria: str(b.qualification?.hot_lead_criteria, 500) };
  if ("transfer_number" in b) t.transfer_number = cleanPhone(b.transfer_number, "Transfer number");
  if ("transfer_rules" in b) t.transfer_rules = str(b.transfer_rules, 600);
  if ("notify" in b) {
    const emails = lines(Array.isArray(b.notify?.email) ? b.notify.email : String(b.notify?.email ?? "").split(/[,\n]/), 10, 200);
    for (const e of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, `"${e}" is not a valid email`);
    const webhook = str(b.notify?.webhook, 500);
    if (webhook && !/^https:\/\//.test(webhook)) throw new HttpError(400, "Webhook must start with https://");
    t.notify = { email: emails, webhook, call_summaries: b.notify?.call_summaries !== false };
  }
  if ("blocked_numbers" in b) t.blocked_numbers = lines(b.blocked_numbers, 200, 20).map((n) => cleanPhone(n, "Blocked number")).filter(Boolean);
}

/** Extra fields only DBS admins may change: routing, calendar, billing. */
function applyAdminFields(t, b) {
  if ("phone_numbers" in b) t.phone_numbers = lines(b.phone_numbers, 20, 20).map((n) => cleanPhone(n, "Phone number")).filter(Boolean);
  if ("timezone" in b) {
    const tz = str(b.timezone, 60) || "Europe/London";
    try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); } catch { throw new HttpError(400, "Unknown time zone"); }
    t.timezone = tz;
  }
  if ("calendar" in b) {
    const c = b.calendar || {};
    t.calendar = {
      id: str(c.id, 200),
      appointment_label: str(c.appointment_label, 40) || "appointment",
      slot_minutes: Math.min(240, Math.max(10, Number(c.slot_minutes) || 30)),
      buffer_minutes: Math.min(120, Math.max(0, Number(c.buffer_minutes) || 0)),
      min_notice_minutes: Math.min(10080, Math.max(0, Number(c.min_notice_minutes ?? 120))),
      ...(c.booking_hours && Object.keys(c.booking_hours).length ? { booking_hours: cleanHours(c.booking_hours) } : {}),
    };
  }
  if ("billing" in b) {
    const num = (v) => Math.max(0, Math.round(Number(v || 0) * 100) / 100);
    t.billing = { ...(t.billing || {}), monthly_fee: num(b.billing?.monthly_fee), included_minutes: Math.floor(num(b.billing?.included_minutes)), overage_per_minute: num(b.billing?.overage_per_minute), currency: str(b.billing?.currency, 3).toUpperCase() || "GBP" };
  }
  if ("active" in b) t.active = b.active !== false;
}

function numberInUse(t) {
  for (const other of Object.values(getTenants())) {
    if (other.id === t.id) continue;
    const clash = (t.phone_numbers || []).find((n) => (other.phone_numbers || []).includes(n));
    if (clash) throw new HttpError(409, `${clash} is already used by ${other.name}`);
  }
}

// ---------- helpers ----------

function canSee(user, tenantId) {
  return user.role === "admin" || user.tenant_id === tenantId;
}

function tenantOr404(user, id) {
  const t = tenantById(id);
  if (!t || !canSee(user, id)) throw new HttpError(404, "Client not found");
  return t;
}

const COLUMNS = {
  calls: ["at", "call_id", "from", "duration_sec", "summary", "sentiment", "successful", "disconnection", "recording_url"],
  leads: ["at", "score", "caller_name", "company", "phone", "email", "need", "budget", "timeline", "answers", "notes", "call_id"],
  messages: ["at", "urgency", "caller_name", "callback_number", "message", "call_id"],
  bookings: ["at", "start_iso", "caller_name", "phone", "email", "reason", "event_id", "call_id"],
};

// ---------- router ----------

/**
 * Handle /api/* requests. `body` is parsed JSON (or {}).
 * Returns { status, json } or { status, csv, filename } or { status, json, headers }.
 */
export async function handleApi(req, url, body) {
  try {
    return await route(req, url, body);
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
    if (/^(Enter|Password|Role|Client users|A user)/.test(e.message)) return { status: 400, json: { error: e.message } };
    console.error("[api]", e);
    return { status: 500, json: { error: "Something went wrong" } };
  }
}

async function route(req, url, body) {
  const p = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  if (method === "POST" && p === "/api/login") {
    const ip = req.socket.remoteAddress || "?";
    if (!auth.loginAllowed(ip)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
    const u = auth.authenticate(body.email, body.password);
    if (!u) { auth.noteFailedLogin(ip); throw new HttpError(401, "Wrong email or password"); }
    return { status: 200, json: { user: auth.publicUser(u) }, headers: { "Set-Cookie": auth.sessionCookie(u, secure()) } };
  }
  if (method === "GET" && p === "/api/plans") {
    return { status: 200, json: { plans: publicPlans(), payments: stripeConfigured(), demo_number: process.env.DEMO_PHONE_NUMBER || null } };
  }

  if (method === "POST" && p === "/api/signup") {
    const ip = req.socket.remoteAddress || "?";
    if (!auth.loginAllowed(`signup:${ip}`)) throw new HttpError(429, "Too many sign-ups from here. Try again later.");
    auth.noteFailedLogin(`signup:${ip}`); // counts every attempt
    let created;
    try { created = signUp(body); }
    catch (e) { throw new HttpError(e.status || 400, e.message); }
    const fullUser = auth.loadUsers().find((u) => u.id === created.user.id);
    let checkout_url = null;
    if (stripeConfigured()) {
      try { checkout_url = await createCheckout({ tenant: created.tenant, plan: planById(body.plan), email: created.user.email }); }
      catch (e) { console.error("[signup checkout]", e.message); }
    }
    return { status: 201, json: { user: created.user, tenant_id: created.tenant.id, checkout_url }, headers: { "Set-Cookie": auth.sessionCookie(fullUser, secure()) } };
  }

  if (method === "POST" && p === "/api/logout") {
    return { status: 200, json: { ok: true }, headers: { "Set-Cookie": auth.clearCookie(secure()) } };
  }

  const user = auth.userFromRequest(req);
  if (!user) throw new HttpError(401, "Please sign in");
  const admin = user.role === "admin";
  const requireAdmin = () => { if (!admin) throw new HttpError(403, "DBS admins only"); };

  // Require JSON for writes (with SameSite=Strict cookies this blocks cross-site form posts)
  if (method !== "GET" && !String(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "Send JSON");

  if (method === "GET" && p === "/api/me") {
    const tenants = Object.values(getTenants()).filter((t) => canSee(user, t.id)).map((t) => ({ id: t.id, name: t.name, active: t.active !== false }));
    return { status: 200, json: { user: auth.publicUser(user), tenants } };
  }

  if (method === "POST" && p === "/api/me/password") {
    if (!auth.verifyPassword(String(body.current || ""), user.password)) throw new HttpError(400, "Current password is wrong");
    auth.setPassword(user.id, body.password);
    return { status: 200, json: { ok: true } };
  }

  // ---- admin: clients & usage ----
  if (method === "GET" && p === "/api/tenants") {
    requireAdmin();
    const month = MONTH_RE.test(url.searchParams.get("month")) ? url.searchParams.get("month") : currentMonth();
    const rows = Object.values(getTenants()).map((t) => ({ id: t.id, name: t.name, active: t.active !== false, phone_numbers: t.phone_numbers || [], ...monthStats(t, month) }));
    if (url.searchParams.get("format") === "csv") {
      const flat = rows.map((r) => ({ client: r.name, id: r.id, month, calls: r.calls, billed_minutes: r.billed_minutes, included_minutes: r.invoice.included_minutes, overage_minutes: r.invoice.overage_minutes, monthly_fee: r.invoice.monthly_fee, overage: r.invoice.overage, total: r.invoice.total, currency: r.invoice.currency }));
      return { status: 200, csv: toCsv(flat, Object.keys(flat[0] || { client: 1 })), filename: `dbs-voice-usage-${month}.csv` };
    }
    return { status: 200, json: { month, tenants: rows } };
  }

  if (method === "POST" && p === "/api/tenants") {
    requireAdmin();
    const id = str(body.id, 41).toLowerCase();
    if (!TENANT_ID_RE.test(id)) throw new HttpError(400, "Client id must be lowercase letters, numbers and dashes, e.g. smith-dental");
    if (tenantById(id)) throw new HttpError(409, "That client id already exists");
    const t = {
      id, name: "", assistant_name: "Ava", phone_numbers: [], timezone: "Europe/London", greeting: "", business_info: "", services: [],
      hours: { mon: ["09:00", "17:30"], tue: ["09:00", "17:30"], wed: ["09:00", "17:30"], thu: ["09:00", "17:30"], fri: ["09:00", "17:30"] },
      faqs: [], qualification: { questions: ["What are you looking for?", "When would you like to start?"], hot_lead_criteria: "" },
      transfer_number: "", transfer_rules: "", calendar: { id: "", appointment_label: "appointment", slot_minutes: 30 },
      notify: { email: [], webhook: "", call_summaries: true }, blocked_numbers: [],
      billing: { monthly_fee: 0, included_minutes: 0, overage_per_minute: 0, currency: "GBP" }, active: true,
    };
    applyClientFields(t, { name: body.name });
    if (!t.greeting) t.greeting = `Hello, thanks for calling ${t.name}. How can I help?`;
    applyAdminFields(t, body);
    numberInUse(t);
    saveTenant(t);
    return { status: 201, json: { tenant: t } };
  }

  // ---- users ----
  if (p === "/api/users") {
    requireAdmin();
    if (method === "GET") return { status: 200, json: { users: auth.loadUsers().map(auth.publicUser) } };
    if (method === "POST") {
      if (body.role === "client" && !tenantById(body.tenant_id)) throw new HttpError(400, "Choose a valid client");
      return { status: 201, json: { user: auth.createUser(body) } };
    }
  }
  let m = p.match(/^\/api\/users\/([\w-]+)$/);
  if (m && method === "DELETE") {
    requireAdmin();
    if (m[1] === user.id) throw new HttpError(400, "You can't delete yourself");
    auth.deleteUser(m[1]);
    return { status: 200, json: { ok: true } };
  }

  // ---- one client ----
  m = p.match(/^\/api\/tenants\/([a-z0-9-]+)$/);
  if (m) {
    const t = tenantOr404(user, m[1]);
    if (method === "GET") {
      const view = structuredClone(t);
      const b = t.billing || {};
      if (!admin) delete view.billing;
      const google = googleStatus(t.id);
      return { status: 200, json: {
        tenant: view, admin_fields_locked: !admin, google,
        plan: { plan: b.plan || null, status: b.status || (t.active === false ? "paused" : "active"), has_portal: Boolean(b.stripe_customer_id && stripeConfigured()), can_pay: stripeConfigured() && Boolean(planById(b.plan)) && !b.stripe_subscription_id },
        features: { google_connect: oauthConfigured(), payments: stripeConfigured() },
        onboarding: onboarding(t, google.connected),
      } };
    }
    if (method === "PUT") {
      const next = structuredClone(t);
      applyClientFields(next, body);
      let numbers_sync;
      if (admin) {
        applyAdminFields(next, body);
        numberInUse(next);
        const before = new Set(t.phone_numbers || []);
        const after = new Set(next.phone_numbers || []);
        const added = [...after].filter((n) => !before.has(n));
        for (const n of [...before].filter((n) => !after.has(n))) numbers.releaseFromPool(n);
        if (added.length) {
          numbers_sync = await numbers.syncNumbers(added, next);
          for (const r of numbers_sync) if (r.ok) numbers.markAssigned(r.number, next.id);
        }
      }
      saveTenant(next);
      return { status: 200, json: { tenant: next, numbers_sync } };
    }
  }

  m = p.match(/^\/api\/tenants\/([a-z0-9-]+)\/(checkout|portal|calendar-disconnect|forwarding|assign-number|release-number|activate)$/);
  if (m && method === "POST") {
    const t = tenantOr404(user, m[1]);
    const action = m[2];
    if (action === "checkout") {
      const plan = planById(t.billing?.plan) || planById(body.plan);
      if (!stripeConfigured() || !plan) throw new HttpError(400, "Online payment isn't set up. Contact DBS Group to activate.");
      if (t.billing?.stripe_subscription_id) throw new HttpError(400, "This account already has a subscription. Use Manage billing.");
      return { status: 200, json: { url: await createCheckout({ tenant: t, plan, email: user.email }) } };
    }
    if (action === "portal") {
      if (!t.billing?.stripe_customer_id || !stripeConfigured()) throw new HttpError(400, "No billing account yet");
      return { status: 200, json: { url: await portalUrl(t.billing.stripe_customer_id) } };
    }
    if (action === "calendar-disconnect") {
      await disconnectGoogle(t.id);
      return { status: 200, json: { ok: true } };
    }
    if (action === "forwarding") {
      saveTenant({ ...t, forwarding_confirmed: body.confirmed !== false });
      return { status: 200, json: { ok: true } };
    }
    requireAdmin();
    if (action === "activate") {
      const res = await activateTenant(t.id, { status: "active", activated_by: user.email });
      return { status: 200, json: { tenant: res.tenant, note: res.numberNote } };
    }
    if (action === "assign-number") {
      let n;
      try { n = await numbers.assignFromPool(t); } catch (e) { throw new HttpError(502, e.message); }
      if (!n) throw new HttpError(409, "No free numbers in the pool. Add one on the Numbers page.");
      const next = { ...t, phone_numbers: [...(t.phone_numbers || []), n] };
      saveTenant(next);
      return { status: 200, json: { number: n, tenant: next } };
    }
    if (action === "release-number") {
      const n = String(body.number || "");
      if (!(t.phone_numbers || []).includes(n)) throw new HttpError(400, "That number isn't assigned to this client");
      numbers.releaseFromPool(n);
      const next = { ...t, phone_numbers: t.phone_numbers.filter((x) => x !== n) };
      saveTenant(next);
      return { status: 200, json: { tenant: next } };
    }
  }

  // ---- admin: number pool ----
  if (p === "/api/numbers") {
    requireAdmin();
    if (method === "GET") {
      const names = Object.fromEntries(Object.values(getTenants()).map((t) => [t.id, t.name]));
      return { status: 200, json: {
        numbers: numbers.loadPool().map((n) => ({ ...n, tenant_name: n.tenant_id ? names[n.tenant_id] || n.tenant_id : null })),
        free: freePoolCount(), ...numbers.engineStatus(),
      } };
    }
    if (method === "POST") {
      try { await numbers.addToPool(body.number, { importViaSip: body.import === true }); }
      catch (e) { throw new HttpError(400, e.message); }
      return { status: 201, json: { ok: true } };
    }
  }
  m = p.match(/^\/api\/numbers\/([^/]+)$/);
  if (m && method === "DELETE") {
    requireAdmin();
    try { numbers.removeFromPool(decodeURIComponent(m[1])); } catch (e) { throw new HttpError(400, e.message); }
    return { status: 200, json: { ok: true } };
  }

  m = p.match(/^\/api\/tenants\/([a-z0-9-]+)\/stats$/);
  if (m && method === "GET") {
    const t = tenantOr404(user, m[1]);
    const month = MONTH_RE.test(url.searchParams.get("month")) ? url.searchParams.get("month") : currentMonth();
    const stats = monthStats(t, month);
    if (!admin && !t.billing) delete stats.invoice;
    return { status: 200, json: { stats } };
  }

  m = p.match(/^\/api\/tenants\/([a-z0-9-]+)\/(calls|leads|messages|bookings)(\.csv)?$/);
  if (m && method === "GET") {
    const t = tenantOr404(user, m[1]);
    const kind = m[2];
    const month = MONTH_RE.test(url.searchParams.get("month")) ? url.searchParams.get("month") : null;
    let rows = recordsFor(t.id, kind, month);
    if (kind === "calls") rows = rows.map((r) => ({ ...r, billed_minutes: billedMinutes(r.duration_sec || 0) }));
    if (m[3]) return { status: 200, csv: toCsv(rows, COLUMNS[kind]), filename: `${t.id}-${kind}${month ? `-${month}` : ""}.csv` };
    return { status: 200, json: { rows: rows.slice(0, 500), total: rows.length } };
  }

  throw new HttpError(404, "Not found");
}
