// Plans, self sign-up, and what happens when Stripe tells us about payments.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { tenantById, saveTenant, getTenants } from "./tenants.js";
import { createUser, loadUsers } from "./auth.js";
import { assignFromPool, loadPool } from "./numbers.js";
import { notify } from "./notify.js";

const plansFile = path.resolve(process.env.PLANS_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "plans.json"));

export function loadPlans() {
  return JSON.parse(fs.readFileSync(plansFile, "utf8"));
}

export const publicPlans = () => loadPlans().map(({ stripe_price_base, stripe_price_minutes, ...p }) => p);
export const planById = (id) => loadPlans().find((p) => p.id === id) || null;

function slugify(name) {
  const base = String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "client";
  let id;
  do { id = `${base}-${crypto.randomBytes(2).toString("hex")}`; } while (tenantById(id));
  return id;
}

/** Create an inactive client + its owner login. Becomes active once paid (or when an admin activates it). */
export function signUp({ business_name, name, email, password, plan: planId }) {
  const plan = planById(planId);
  if (!plan) throw Object.assign(new Error("Choose a plan"), { status: 400 });
  const bizName = String(business_name || "").trim().slice(0, 100);
  if (bizName.length < 2) throw Object.assign(new Error("Enter your business name"), { status: 400 });
  if (loadUsers().some((u) => u.email === String(email || "").trim().toLowerCase())) {
    throw Object.assign(new Error("An account with that email already exists. Sign in instead."), { status: 409 });
  }
  const id = slugify(bizName);
  const tenant = {
    id, name: bizName, assistant_name: "Ava", phone_numbers: [], timezone: "Europe/London",
    greeting: `Hello, thanks for calling ${bizName}. I'm Ava, the virtual assistant. How can I help?`,
    business_info: "", services: [],
    hours: { mon: ["09:00", "17:30"], tue: ["09:00", "17:30"], wed: ["09:00", "17:30"], thu: ["09:00", "17:30"], fri: ["09:00", "17:30"] },
    faqs: [], qualification: { questions: ["What are you looking for?", "When would you like to start?"], hot_lead_criteria: "" },
    transfer_number: "", transfer_rules: "", calendar: { id: "", appointment_label: "appointment", slot_minutes: 30 },
    notify: { email: [String(email).trim().toLowerCase()], webhook: "", call_summaries: true }, blocked_numbers: [],
    billing: { plan: plan.id, monthly_fee: plan.monthly_fee, included_minutes: plan.included_minutes, overage_per_minute: plan.overage_per_minute, currency: plan.currency || "GBP", status: "pending_payment" },
    active: false, created_via: "signup", created_at: new Date().toISOString(),
  };
  // Create the user first: it validates email/password, so a bad form doesn't leave an orphan client
  const user = createUser({ email, password, name, role: "client", tenant_id: id });
  saveTenant(tenant);
  return { tenant, user };
}

export async function alertAdmin(title, fields) {
  if (!env.adminEmail) { console.log(`[admin] ${title}`, fields); return; }
  await notify({ id: "dbs-admin", name: "DBS Voice", notify: { email: [env.adminEmail] } }, title, fields);
}

/** Turn a client on: mark active and give them a phone number from the pool if they have none. */
export async function activateTenant(tenantId, billingPatch = {}) {
  const t = tenantById(tenantId);
  if (!t) throw new Error(`Unknown client ${tenantId}`);
  const next = structuredClone(t);
  next.active = true;
  next.billing = { ...(next.billing || {}), ...billingPatch, status: "active" };
  let numberNote = "";
  if (!next.phone_numbers?.length) {
    try {
      const n = await assignFromPool(next);
      if (n) { next.phone_numbers = [n]; numberNote = `Assigned ${n}`; }
      else numberNote = "No free numbers in the pool. Add one on the Numbers page and assign it.";
    } catch (e) { numberNote = `Number assignment failed: ${e.message}`; }
  }
  saveTenant(next);
  await alertAdmin(`New client live: ${next.name}`, { Client: next.name, Plan: next.billing.plan, Number: next.phone_numbers.join(", ") || "none", Note: numberNote });
  if (next.phone_numbers.length) {
    await notify(next, "Your AI receptionist is live", {
      "Your AI number": next.phone_numbers[0],
      "Next step": "Forward your business line to this number (or give it out directly). Then fill in your business details in the dashboard so the assistant can answer questions.",
      Dashboard: `${env.publicBaseUrl}/app`,
    });
  }
  return { tenant: next, numberNote };
}

const tenantFromObject = (o) => o?.metadata?.tenant_id || o?.client_reference_id || null;
function tenantByCustomer(customerId) {
  return Object.values(getTenants()).find((t) => t.billing?.stripe_customer_id === customerId) || null;
}

/** Handle a verified Stripe event. Safe to receive the same event twice. */
export async function handleStripeEvent(event) {
  const o = event.data?.object || {};
  switch (event.type) {
    case "checkout.session.completed": {
      const id = tenantFromObject(o);
      if (!id || !tenantById(id)) return { ignored: "no tenant" };
      if (tenantById(id).active && tenantById(id).billing?.stripe_subscription_id === o.subscription) return { ok: "already active" };
      await activateTenant(id, { stripe_customer_id: o.customer, stripe_subscription_id: o.subscription });
      return { ok: "activated" };
    }
    case "customer.subscription.updated": {
      const t = tenantById(tenantFromObject(o)) || tenantByCustomer(o.customer);
      if (!t) return { ignored: "no tenant" };
      const next = structuredClone(t);
      next.billing = { ...(next.billing || {}), status: o.status };
      if (["past_due", "unpaid"].includes(o.status)) await alertAdmin(`Payment problem: ${t.name}`, { Client: t.name, Status: o.status });
      if (o.status === "active" && !t.active && t.billing?.stripe_customer_id) next.active = true;
      saveTenant(next);
      return { ok: o.status };
    }
    case "customer.subscription.deleted": {
      const t = tenantById(tenantFromObject(o)) || tenantByCustomer(o.customer);
      if (!t) return { ignored: "no tenant" };
      saveTenant({ ...t, active: false, billing: { ...(t.billing || {}), status: "cancelled" } });
      await alertAdmin(`Client cancelled: ${t.name}`, { Client: t.name, Numbers: (t.phone_numbers || []).join(", "), Note: "Paused. Release their number from the Numbers page if they don't come back." });
      return { ok: "paused" };
    }
    case "invoice.payment_failed": {
      const t = tenantByCustomer(o.customer);
      if (t) await alertAdmin(`Payment failed: ${t.name}`, { Client: t.name, Amount: o.amount_due ? `${(o.amount_due / 100).toFixed(2)} ${String(o.currency || "").toUpperCase()}` : "" });
      return { ok: "noted" };
    }
    default:
      return { ignored: event.type };
  }
}

/** Getting-started checklist shown to new clients. */
export function onboarding(t, googleConnected) {
  const steps = [
    { id: "payment", label: "Activate your plan", done: t.active !== false },
    { id: "number", label: "Get your AI phone number", done: (t.phone_numbers || []).length > 0 },
    { id: "info", label: "Describe your business", done: (t.business_info || "").length > 40 && (t.services || []).length > 0 },
    { id: "alerts", label: "Choose where alerts go", done: (t.notify?.email || []).length > 0 || Boolean(t.notify?.webhook) },
    { id: "calendar", label: "Connect Google Calendar (optional)", done: googleConnected || Boolean(t.calendar?.id) },
    { id: "forward", label: "Forward your calls to your AI number", done: Boolean(t.forwarding_confirmed) },
  ];
  return { steps, complete: steps.every((s) => s.done || s.id === "calendar") };
}

export const freePoolCount = () => loadPool().filter((p) => !p.tenant_id).length;
