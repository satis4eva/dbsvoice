import { readRecords } from "./store.js";

export const monthOf = (iso) => String(iso || "").slice(0, 7);
export const currentMonth = () => new Date().toISOString().slice(0, 7);

/** Records of one kind for a tenant, optionally filtered to "YYYY-MM", newest first. */
export function recordsFor(tenantId, kind, month) {
  const rows = readRecords(tenantId, kind);
  return (month ? rows.filter((r) => monthOf(r.at) === month) : rows).reverse();
}

/** Each call is billed in whole minutes, rounded up. */
export const billedMinutes = (sec) => (sec > 0 ? Math.ceil(sec / 60) : 0);

export function monthStats(tenant, month = currentMonth()) {
  const calls = recordsFor(tenant.id, "calls", month);
  const seconds = calls.reduce((s, c) => s + (c.duration_sec || 0), 0);
  const minutes = calls.reduce((s, c) => s + billedMinutes(c.duration_sec || 0), 0);
  const leads = recordsFor(tenant.id, "leads", month);
  const b = tenant.billing || {};
  const fee = Number(b.monthly_fee || 0);
  const included = Number(b.included_minutes || 0);
  const rate = Number(b.overage_per_minute || 0);
  const overageMinutes = Math.max(0, minutes - included);
  const overage = Math.round(overageMinutes * rate * 100) / 100;
  return {
    month,
    calls: calls.length,
    talk_seconds: seconds,
    billed_minutes: minutes,
    avg_call_seconds: calls.length ? Math.round(seconds / calls.length) : 0,
    leads: leads.length,
    hot_leads: leads.filter((l) => l.score === "hot").length,
    messages: recordsFor(tenant.id, "messages", month).length,
    bookings: recordsFor(tenant.id, "bookings", month).length,
    invoice: {
      currency: b.currency || "GBP",
      monthly_fee: fee,
      included_minutes: included,
      overage_minutes: overageMinutes,
      overage_per_minute: rate,
      overage,
      total: Math.round((fee + overage) * 100) / 100,
    },
  };
}

export function toCsv(rows, columns) {
  const cell = (v) => {
    let s = v === undefined || v === null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection from caller-supplied text
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
