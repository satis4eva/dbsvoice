// Stripe: Checkout for sign-up, Billing Portal, webhook verification, and per-minute meter events.
import crypto from "node:crypto";
import { env } from "./env.js";

export const stripeConfigured = () => Boolean(env.stripeKey);

/** Encode nested objects the way Stripe expects (a[b][0][c]=...). */
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(method, p, params, { idempotencyKey } = {}) {
  if (!env.stripeKey) throw new Error("Stripe is not configured");
  const r = await fetch(`${env.stripeApiBase}/v1${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params ? form(params) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe: ${j.error?.message || r.status}`);
  return j;
}

export async function createCheckout({ tenant, plan, email }) {
  const base = env.publicBaseUrl;
  const lineItems = [{ price: plan.stripe_price_base, quantity: 1 }];
  if (plan.stripe_price_minutes) lineItems.push({ price: plan.stripe_price_minutes }); // metered: no quantity
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: lineItems,
    customer_email: email,
    client_reference_id: tenant.id,
    metadata: { tenant_id: tenant.id, plan: plan.id },
    subscription_data: { metadata: { tenant_id: tenant.id, plan: plan.id } },
    billing_address_collection: "required",
    tax_id_collection: { enabled: "true" },
    allow_promotion_codes: "true",
    success_url: `${base}/app#/overview?paid=1`,
    cancel_url: `${base}/app#/overview?paid=0`,
  });
  return session.url;
}

export async function portalUrl(customerId) {
  const s = await stripe("POST", "/billing_portal/sessions", { customer: customerId, return_url: `${env.publicBaseUrl}/app#/overview` });
  return s.url;
}

/** Report billed minutes for one call. Identifier makes retries safe. */
export async function reportMinutes(customerId, minutes, callId) {
  if (!env.stripeKey || !customerId || !(minutes > 0)) return;
  await stripe("POST", "/billing/meter_events", {
    event_name: env.stripeMeterEvent,
    identifier: `call_${callId}`,
    payload: { stripe_customer_id: customerId, value: minutes },
  });
}

/** Verify the Stripe-Signature header ("t=...,v1=..."). */
export function verifyStripeSignature(raw, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(",").map((kv) => kv.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header).split(",").filter((p) => p.trim().startsWith("v1=")).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex"));
  return sigs.some((s) => { const b = Buffer.from(s); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
}

export function signStripeForTest(raw, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
}
