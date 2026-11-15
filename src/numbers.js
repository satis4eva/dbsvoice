// Phone numbers: a pool of DBS numbers, plus automatic binding in Retell.
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

const poolFile = () => path.join(path.resolve(process.env.DATA_DIR || "data"), "number-pool.json");
export const PHONE_RE = /^\+[1-9]\d{6,14}$/;

// ---------- Retell API ----------

async function retell(method, p, body) {
  if (!env.retellApiKey) throw new Error("RETELL_API_KEY is not set");
  const r = await fetch(`${env.retellApiBase}${p}`, {
    method,
    headers: { Authorization: `Bearer ${env.retellApiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`Retell ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : {};
}

function routing(tenant) {
  if (!env.agentId) throw new Error("RETELL_AGENT_ID is not set. Run npm run setup-agent first.");
  if (!env.publicBaseUrl) throw new Error("PUBLIC_BASE_URL is not set");
  return {
    inbound_agents: [{ agent_id: env.agentId, weight: 1 }],
    inbound_webhook_url: `${env.publicBaseUrl}/retell/inbound`,
    nickname: tenant ? `DBS Voice: ${tenant.name}`.slice(0, 60) : "DBS Voice (unassigned)",
  };
}

/** Point a number that already exists in Retell at our agent + inbound webhook. */
export async function bindNumber(number, tenant) {
  try {
    return await retell("PATCH", `/update-phone-number/${encodeURIComponent(number)}`, routing(tenant));
  } catch (e) {
    if (e.status === 404) throw new Error(`${number} isn't in your Retell account yet. Import it first (Numbers page).`);
    throw e;
  }
}

/** Import a number from DBS's SIP trunk into Retell and bind it. */
export async function importNumber(number, tenant) {
  if (!env.sipTerminationUri) throw new Error("RETELL_SIP_TERMINATION_URI is not set, so numbers can't be imported automatically.");
  return retell("POST", "/import-phone-number", {
    phone_number: number,
    termination_uri: env.sipTerminationUri,
    ...(env.sipUsername ? { sip_trunk_auth_username: env.sipUsername, sip_trunk_auth_password: env.sipPassword } : {}),
    ...routing(tenant),
  });
}

/** Bind several numbers; never throws. Returns one result per number. */
export async function syncNumbers(numbers, tenant) {
  const out = [];
  for (const n of numbers) {
    try { await bindNumber(n, tenant); out.push({ number: n, ok: true }); }
    catch (e) { out.push({ number: n, ok: false, error: e.message }); }
  }
  return out;
}

// ---------- Pool ----------
// [{ number, tenant_id: string|null, added_at, imported: bool }]

export function loadPool() {
  try { return JSON.parse(fs.readFileSync(poolFile(), "utf8")); } catch { return []; }
}

function savePool(pool) {
  fs.mkdirSync(path.dirname(poolFile()), { recursive: true });
  fs.writeFileSync(`${poolFile()}.tmp`, JSON.stringify(pool, null, 2));
  fs.renameSync(`${poolFile()}.tmp`, poolFile());
}

export async function addToPool(number, { importViaSip = false } = {}) {
  number = String(number || "").replace(/[\s()-]/g, "");
  if (!PHONE_RE.test(number)) throw new Error("Number must be in international format, e.g. +442071234567");
  const pool = loadPool();
  if (pool.some((p) => p.number === number)) throw new Error("That number is already in the pool");
  if (importViaSip) await importNumber(number, null);
  else await bindNumber(number, null); // confirms it exists in Retell and routes to us
  pool.push({ number, tenant_id: null, added_at: new Date().toISOString(), imported: importViaSip });
  savePool(pool);
  return pool;
}

export function removeFromPool(number) {
  const pool = loadPool();
  const entry = pool.find((p) => p.number === number);
  if (!entry) throw new Error("Number not in pool");
  if (entry.tenant_id) throw new Error("Release the number from its client first");
  savePool(pool.filter((p) => p.number !== number));
}

/** Take a free number from the pool for a tenant and bind it in Retell. Returns the number, or null if none free. */
export async function assignFromPool(tenant) {
  const pool = loadPool();
  const free = pool.find((p) => !p.tenant_id);
  if (!free) return null;
  await bindNumber(free.number, tenant);
  free.tenant_id = tenant.id;
  free.assigned_at = new Date().toISOString();
  savePool(pool);
  return free.number;
}

export function releaseFromPool(number) {
  const pool = loadPool();
  const entry = pool.find((p) => p.number === number);
  if (entry) { entry.tenant_id = null; delete entry.assigned_at; savePool(pool); }
}

export function markAssigned(number, tenantId) {
  const pool = loadPool();
  const entry = pool.find((p) => p.number === number);
  if (entry) { entry.tenant_id = tenantId; savePool(pool); }
}
