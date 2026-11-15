// Vapi voice engine: one shared assistant, per-client details injected on each inbound call.
//
// Flow per call:
//   assistant-request         -> we pick the client by the dialled number and return assistantId + variableValues
//   tool-calls                -> take_message / qualify_lead / check_availability / book_appointment
//   transfer-destination-request -> the client's transfer number
//   end-of-call-report        -> call log, summary email, Stripe minutes
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { tenantByNumber, tenantById, dynamicVariablesFor } from "./tenants.js";
import { handlers } from "./tools.js";
import { GENERAL_PROMPT, BEGIN_MESSAGE } from "./prompt.js";

const toolNames = new Set(Object.keys(handlers));

// ---------- saved state (assistant id, webhook secret) ----------
// Kept in DATA_DIR so hosts without a terminal still work: the server creates what it needs on start.
const stateFile = () => path.join(path.resolve(process.env.DATA_DIR || "data"), "vapi.json");
function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; } }
function writeState(patch) {
  const next = { ...readState(), ...patch };
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(`${stateFile()}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(`${stateFile()}.tmp`, stateFile());
  return next;
}
export const assistantId = () => env.vapiAssistantId || readState().assistant_id || "";
export function webhookSecret() {
  if (env.vapiWebhookSecret) return env.vapiWebhookSecret;
  const s = readState();
  return s.webhook_secret || writeState({ webhook_secret: crypto.randomBytes(24).toString("hex") }).webhook_secret;
}

// ---------- auth ----------
// The webhook URL carries a secret token (?token=...). We also accept it as a Bearer or X-Vapi-Secret header.
export function vapiAuthorised(req, url) {
  if (env.skipSignature) return true;
  const secret = webhookSecret();
  if (!secret) return false;
  const auth = String(req.headers.authorization || "");
  const candidates = [url.searchParams.get("token"), auth.startsWith("Bearer ") ? auth.slice(7) : "", req.headers["x-vapi-secret"]].filter(Boolean);
  const want = Buffer.from(secret);
  return candidates.some((c) => { const b = Buffer.from(String(c)); return b.length === want.length && crypto.timingSafeEqual(b, want); });
}

export const webhookUrl = () => `${env.publicBaseUrl}/vapi/webhook?token=${encodeURIComponent(webhookSecret())}`;

// ---------- which client is this call for? ----------
function dialledNumber(m) {
  return m.phoneNumber?.number || m.call?.phoneNumber?.number || m.call?.phoneNumberNumber || "";
}
function callerNumber(m) {
  return m.customer?.number || m.call?.customer?.number || "";
}
function tenantForMessage(m) {
  const vars = m.call?.assistantOverrides?.variableValues || m.assistant?.variableValues || m.call?.metadata || {};
  return (vars.tenant_id && tenantById(vars.tenant_id)) || tenantByNumber(dialledNumber(m)) || null;
}

/** Shape a Vapi message into the call object our existing tool handlers expect. */
function asCall(m, tenant) {
  return { call_id: m.call?.id, from_number: callerNumber(m), to_number: dialledNumber(m), retell_llm_dynamic_variables: { tenant_id: tenant?.id } };
}

function parseArgs(tc) {
  let a = tc.function?.arguments ?? tc.arguments ?? tc.parameters ?? {};
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
  return a || {};
}

// ---------- webhook ----------
export async function handleVapiMessage(body) {
  const m = body?.message || {};
  switch (m.type) {
    case "assistant-request": {
      const tenant = tenantByNumber(dialledNumber(m));
      if (!tenant || tenant.active === false || (tenant.blocked_numbers || []).includes(callerNumber(m))) {
        return { error: "This number is not in service." };
      }
      if (!assistantId()) return { error: "Assistant not set up yet." };
      return {
        assistantId: assistantId(),
        assistantOverrides: {
          variableValues: dynamicVariablesFor(tenant, { fromNumber: callerNumber(m) }),
        },
      };
    }

    case "tool-calls": {
      const tenant = tenantForMessage(m);
      const list = m.toolCallList || m.toolCalls || [];
      const results = [];
      for (const tc of list) {
        const name = tc.function?.name || tc.name;
        let out;
        if (!tenant) out = { error: true, instruction: "Apologise and take the caller's name, number and message; something went wrong on our side." };
        else if (!toolNames.has(name)) out = { error: true, instruction: "That action isn't available. Offer to take a message." };
        else {
          try { out = await handlers[name](tenant, parseArgs(tc), asCall(m, tenant)); }
          catch (e) { console.error(`[vapi tool ${name}]`, e.message); out = { error: true, instruction: "Apologise, there was a technical problem. Take a message instead." }; }
        }
        results.push({ toolCallId: tc.id, result: JSON.stringify(out) });
      }
      return { results };
    }

    case "transfer-destination-request": {
      const tenant = tenantForMessage(m);
      if (!tenant?.transfer_number) return { error: "Transfers are not available. Take a message instead." };
      return { destination: { type: "number", number: tenant.transfer_number, message: "Putting you through now, one moment." } };
    }

    case "end-of-call-report": {
      const tenant = tenantForMessage(m);
      if (!tenant) return { ok: true };
      const started = Date.parse(m.startedAt || m.call?.startedAt || "");
      const ended = Date.parse(m.endedAt || m.call?.endedAt || "");
      const durationSec = Number.isFinite(m.durationSeconds) ? Math.round(m.durationSeconds)
        : Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 1000) : undefined;
      const a = m.artifact || {};
      return {
        ok: true,
        callEvent: {
          tenant,
          call: {
            call_id: m.call?.id,
            from_number: callerNumber(m),
            to_number: dialledNumber(m),
            duration_sec: durationSec,
            summary: m.analysis?.summary || m.summary,
            successful: m.analysis?.successEvaluation,
            recording_url: a.recordingUrl || a.recording?.mono?.combinedUrl || m.recordingUrl,
            transcript: a.transcript || m.transcript,
            disconnection: m.endedReason,
          },
        },
      };
    }

    default:
      return { ok: true };
  }
}

// ---------- Vapi API ----------
async function vapi(method, p, body) {
  if (!env.vapiApiKey) throw new Error("VAPI_API_KEY is not set");
  const r = await fetch(`${env.vapiApiBase}${p}`, {
    method,
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`Vapi ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : {};
}

/** The shared assistant. Voice and model can be changed in the Vapi dashboard; we only set them when asked. */
export function assistantConfig({ includeVoice = true } = {}) {
  const fnTool = (name, description, properties, required, speak) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
    server: { url: webhookUrl(), timeoutSeconds: 15 },
    ...(speak ? { messages: [{ type: "request-start", content: speak }] } : {}),
  });
  const str = (description) => ({ type: "string", description });
  const prompt = GENERAL_PROMPT.replace(/transfer_to_team/g, "transferCall").replace(/\bend_call\b/g, "endCall");
  return {
    name: "DBS Voice Receptionist",
    firstMessage: BEGIN_MESSAGE,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: env.vapiModelProvider,
      model: env.vapiModel,
      temperature: 0.4,
      messages: [{ role: "system", content: prompt }],
      tools: [
        { type: "endCall" },
        {
          type: "transferCall",
          destinations: [],
          function: { name: "transferCall", description: "Put the caller through to a person on the team. Follow the transfer rules in the prompt.", parameters: { type: "object", properties: {} } },
        },
        fnTool("take_message", "Save a message for the team and notify them.", {
          caller_name: str("Caller's full name"),
          callback_number: str("Best number to call back"),
          message: str("The message, with key details"),
          urgency: { type: "string", enum: ["normal", "urgent"] },
        }, ["caller_name", "message"]),
        fnTool("qualify_lead", "Save a qualified sales lead after asking the qualification questions.", {
          caller_name: str("Caller's full name"), company: str("Company name, if any"), phone: str("Contact number"),
          email: str("Email address, spelled back to confirm"), need: str("What they are looking for"), budget: str("Budget, if given"),
          timeline: str("When they want to start"), answers: str("Summary of answers to the qualification questions"),
          score: { type: "string", enum: ["hot", "warm", "cold"] }, notes: str("Anything else useful"),
        }, ["caller_name", "need", "score"]),
        fnTool("check_availability", "Look up free appointment times. Only use when booking is enabled.", {
          date: str("Optional date as YYYY-MM-DD. Leave empty for the next available times."),
        }, [], "Let me just check the diary."),
        fnTool("book_appointment", "Book a time the caller chose from check_availability.", {
          start_iso: str("The start_iso of the chosen slot, exactly as returned"), caller_name: str("Caller's full name"),
          phone: str("Contact number"), email: str("Email address, if given"), reason: str("What the appointment is about"),
        }, ["start_iso", "caller_name"], "Booking that in for you now."),
      ],
    },
    ...(includeVoice ? { voice: { provider: env.vapiVoiceProvider, voiceId: env.vapiVoiceId } } : {}),
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    server: { url: webhookUrl(), timeoutSeconds: 20 },
    serverMessages: ["tool-calls", "transfer-destination-request", "end-of-call-report"],
    endCallMessage: "Thanks for calling. Goodbye.",
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 1200,
  };
}

export async function upsertAssistant() {
  const id = assistantId();
  if (id) {
    // Keep whatever voice was picked in the dashboard unless VAPI_VOICE_ID is set explicitly.
    await vapi("PATCH", `/assistant/${id}`, assistantConfig({ includeVoice: Boolean(process.env.VAPI_VOICE_ID) }));
    return { id, created: false };
  }
  const a = await vapi("POST", "/assistant", assistantConfig());
  writeState({ assistant_id: a.id });
  return { id: a.id, created: true };
}

/**
 * Called on server start: create the assistant if there isn't one, or update it when the prompt/tools changed.
 * Hosts may start several processes at once, so a short lock stops two assistants being created.
 */
export async function syncAssistantOnStart() {
  if (!env.vapiApiKey || !env.publicBaseUrl) return { skipped: "VAPI_API_KEY or PUBLIC_BASE_URL not set" };
  const hash = crypto.createHash("sha256").update(JSON.stringify(assistantConfig({ includeVoice: false }))).digest("hex").slice(0, 16);
  if (assistantId() && readState().config_hash === hash) return { ok: "up to date", id: assistantId() };
  const lock = `${stateFile()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 60_000) return { skipped: "another process is syncing" };
    fs.unlinkSync(lock);
  } catch { /* no lock */ }
  let fd;
  try { fd = fs.openSync(lock, "wx"); } catch { return { skipped: "another process is syncing" }; }
  try {
    const res = await upsertAssistant();
    writeState({ config_hash: hash });
    return { ok: res.created ? "created" : "updated", id: res.id };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

// ---------- phone numbers ----------
// Numbers have no assistant attached; instead they point at our webhook, so every call triggers assistant-request.

const phoneRouting = (tenant, { patch = false } = {}) => ({
  name: (tenant ? `DBS Voice: ${tenant.name}` : "DBS Voice (unassigned)").slice(0, 40),
  ...(patch ? { assistantId: null } : {}),
  server: { url: webhookUrl(), timeoutSeconds: 20 },
});

async function findVapiNumber(number) {
  const list = await vapi("GET", "/phone-number?limit=1000");
  return (Array.isArray(list) ? list : list.results || []).find((p) => p.number === number) || null;
}

/** Point a number already in Vapi at our webhook. */
export async function bindVapiNumber(number, tenant) {
  const found = await findVapiNumber(number);
  if (!found) throw new Error(`${number} isn't in your Vapi account yet. Tick "Import from Twilio" to add it.`);
  return vapi("PATCH", `/phone-number/${found.id}`, phoneRouting(tenant, { patch: true }));
}

/** Import a Twilio number into Vapi and point it at our webhook. */
export async function importVapiNumber(number, tenant) {
  if (!env.twilioAccountSid || !(env.twilioApiKey && env.twilioApiSecret) && !env.twilioAuthToken) {
    throw new Error("Twilio details aren't set on the server (TWILIO_ACCOUNT_SID plus an API key and secret).");
  }
  const existing = await findVapiNumber(number).catch(() => null);
  if (existing) return vapi("PATCH", `/phone-number/${existing.id}`, phoneRouting(tenant, { patch: true }));
  return vapi("POST", "/phone-number", {
    provider: "twilio",
    number,
    twilioAccountSid: env.twilioAccountSid,
    ...(env.twilioApiKey ? { twilioApiKey: env.twilioApiKey, twilioApiSecret: env.twilioApiSecret } : { twilioAuthToken: env.twilioAuthToken }),
    smsEnabled: false,
    ...phoneRouting(tenant),
  });
}
