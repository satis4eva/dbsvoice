import crypto from "node:crypto";
import { env } from "./env.js";
import { hasGoogle } from "./secrets.js";
import { accessTokenFor } from "./google-oauth.js";

// ---------- Time zone helpers (no dependencies) ----------

function tzOffsetMs(tz, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second) - date.getTime();
}

/** Convert a wall-clock time in `tz` to a UTC Date. */
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMs(tz, new Date(guess));
  let t = guess - off;
  const off2 = tzOffsetMs(tz, new Date(t));
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

/** Local YYYY-MM-DD for a Date in `tz`. */
export function localDate(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dayKey = (dateStr) => DAY_KEYS[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];

export function speakSlot(date, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

// ---------- Google auth (service account JWT) ----------

let tokenCache = { token: null, exp: 0 };

async function googleToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  if (!env.googleEmail || !env.googleKey) throw new Error("Google Calendar is not configured");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: env.googleEmail, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(env.googleKey).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!r.ok) throw new Error(`Google token error ${r.status}: ${await r.text()}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

/** Use the client's own connected Google account if they have one, otherwise the DBS service account. */
async function tokenFor(tenant) {
  return tenant && hasGoogle(tenant.id) ? accessTokenFor(tenant.id) : googleToken();
}

async function gcal(tenant, pathname, body) {
  const r = await fetch(`${env.googleCalBase}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenFor(tenant)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Google Calendar ${r.status}: ${await r.text()}`);
  return r.json();
}

async function busyBlocks(tenant, calendarId, from, to, tz) {
  const j = await gcal(tenant, "/freeBusy", { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: tz, items: [{ id: calendarId }] });
  const cal = j.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error(`Calendar not accessible: ${cal.errors[0].reason}`);
  return (cal?.busy || []).map((b) => [new Date(b.start), new Date(b.end)]);
}

// ---------- Slot logic ----------

/** Pure function: list free slots given working hours and busy blocks. Exported for tests. */
export function computeSlots({ startDate, days, hours, slotMinutes, bufferMinutes = 0, tz, busy, now = new Date(), minNoticeMinutes = 60, limit = 6 }) {
  const slots = [];
  const earliest = new Date(now.getTime() + minNoticeMinutes * 60_000);
  for (let i = 0; i < days && slots.length < limit; i++) {
    const date = addDays(startDate, i);
    const wh = hours[dayKey(date)];
    if (!wh) continue;
    let t = zonedToUtc(date, wh[0], tz);
    const close = zonedToUtc(date, wh[1], tz);
    while (t.getTime() + slotMinutes * 60_000 <= close.getTime() && slots.length < limit) {
      const end = new Date(t.getTime() + slotMinutes * 60_000);
      const clash = busy.some(([bs, be]) => t < new Date(be.getTime() + bufferMinutes * 60_000) && end > new Date(bs.getTime() - bufferMinutes * 60_000));
      if (t >= earliest && !clash) slots.push(new Date(t));
      t = new Date(t.getTime() + slotMinutes * 60_000);
    }
  }
  return slots;
}

function calSettings(tenant) {
  const c = tenant.calendar || {};
  return {
    id: c.id || (hasGoogle(tenant.id) ? "primary" : ""),
    tz: tenant.timezone || "Europe/London",
    hours: c.booking_hours || tenant.hours || {},
    slotMinutes: c.slot_minutes || 30,
    bufferMinutes: c.buffer_minutes || 0,
    minNotice: c.min_notice_minutes ?? 120,
    label: c.appointment_label || "Appointment",
  };
}

export async function findSlots(tenant, { date, days = 5 } = {}) {
  const s = calSettings(tenant);
  if (!s.id) throw new Error("Booking is not enabled for this business");
  const startDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate(new Date(), s.tz);
  const span = date ? 1 : days;
  const from = zonedToUtc(startDate, "00:00", s.tz);
  const to = zonedToUtc(addDays(startDate, span), "00:00", s.tz);
  const busy = await busyBlocks(tenant, s.id, from, to, s.tz);
  const slots = computeSlots({ startDate, days: span, hours: s.hours, slotMinutes: s.slotMinutes, bufferMinutes: s.bufferMinutes, tz: s.tz, busy, minNoticeMinutes: s.minNotice });
  return slots.map((d) => ({ start_iso: d.toISOString(), spoken: speakSlot(d, s.tz) }));
}

export async function bookSlot(tenant, { startIso, callerName, callerPhone, callerEmail, reason }) {
  const s = calSettings(tenant);
  if (!s.id) throw new Error("Booking is not enabled for this business");
  const start = new Date(startIso);
  if (isNaN(start)) throw new Error("Invalid start time");
  const end = new Date(start.getTime() + s.slotMinutes * 60_000);

  // Re-check right before booking so two callers can't take the same slot.
  const busy = await busyBlocks(tenant, s.id, start, end, s.tz);
  if (busy.some(([bs, be]) => start < be && end > bs)) return { booked: false, reason: "slot_taken" };

  const ev = await gcal(tenant, `/calendars/${encodeURIComponent(s.id)}/events`, {
    summary: `${s.label}: ${callerName || "Caller"}`,
    description: [`Booked by AI phone assistant`, `Name: ${callerName || "-"}`, `Phone: ${callerPhone || "-"}`, `Email: ${callerEmail || "-"}`, `Reason: ${reason || "-"}`].join("\n"),
    start: { dateTime: start.toISOString(), timeZone: s.tz },
    end: { dateTime: end.toISOString(), timeZone: s.tz },
  });
  return { booked: true, event_id: ev.id, link: ev.htmlLink, spoken: speakSlot(start, s.tz) };
}

/** Booking is on when the client has a calendar ID or a connected Google account. */
export const bookingEnabled = (tenant) => Boolean(tenant?.calendar?.id || (tenant && hasGoogle(tenant.id)));
