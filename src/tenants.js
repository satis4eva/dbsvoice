import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasGoogle } from "./secrets.js";

const dir = path.resolve(process.env.TENANTS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tenants"));

const normalise = (n) => String(n || "").replace(/[^\d+]/g, "");

let cache = null;

export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Write a tenant file atomically and refresh the cache. */
export function saveTenant(tenant) {
  if (!TENANT_ID_RE.test(tenant.id || "")) throw new Error("Invalid client id");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tenant.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tenant, null, 2) + "\n");
  fs.renameSync(tmp, file);
  loadTenants();
  return tenant;
}

export function loadTenants() {
  const tenants = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!t.id) throw new Error(`Tenant file ${f} is missing "id"`);
    tenants[t.id] = t;
  }
  cache = tenants;
  return tenants;
}

export function getTenants() {
  return cache || loadTenants();
}

export function tenantById(id) {
  return getTenants()[id] || null;
}

export function tenantByNumber(number) {
  const n = normalise(number);
  return Object.values(getTenants()).find((t) => (t.phone_numbers || []).map(normalise).includes(n)) || null;
}

/** Work out which client a Retell call belongs to. */
export function tenantForCall(call = {}) {
  const id = call.retell_llm_dynamic_variables?.tenant_id || call.metadata?.tenant_id;
  return (id && tenantById(id)) || tenantByNumber(call.to_number) || null;
}

const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export function describeHours(hours = {}) {
  return Object.entries(DAY_NAMES)
    .map(([k, name]) => (hours[k] ? `${name}: ${hours[k][0]}–${hours[k][1]}` : `${name}: closed`))
    .join("\n");
}

/** Dynamic variables injected into the shared prompt. Retell requires string values. */
export function dynamicVariablesFor(tenant, { fromNumber, now = new Date() } = {}) {
  const tz = tenant.timezone || "Europe/London";
  const nowLocal = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(now);
  const canBook = Boolean(tenant.calendar?.id || hasGoogle(tenant.id));
  const canTransfer = Boolean(tenant.transfer_number);
  return {
    tenant_id: tenant.id,
    business_name: tenant.name,
    assistant_name: tenant.assistant_name || "Ava",
    greeting: tenant.greeting || `Hello, thanks for calling ${tenant.name}. How can I help?`,
    business_info: tenant.business_info || "",
    services: (tenant.services || []).map((s) => `- ${s}`).join("\n"),
    opening_hours: describeHours(tenant.hours),
    faqs: (tenant.faqs || []).map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n"),
    qualification_questions: (tenant.qualification?.questions || []).map((q, i) => `${i + 1}. ${q}`).join("\n"),
    hot_lead_criteria: tenant.qualification?.hot_lead_criteria || "Clear need, budget and a timeline within 3 months.",
    transfer_number: tenant.transfer_number || "",
    transfer_rules: canTransfer ? tenant.transfer_rules || "Transfer hot leads and urgent issues during opening hours." : "Transfers are not available. Take a message instead.",
    booking_enabled: canBook ? "yes" : "no",
    appointment_label: tenant.calendar?.appointment_label || "appointment",
    now_local: nowLocal,
    timezone: tz,
    caller_number: fromNumber || "unknown",
  };
}
