import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no dependencies). Real environment variables win.
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

export const env = {
  retellApiKey: process.env.RETELL_API_KEY || "",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  agentId: process.env.RETELL_AGENT_ID || "",
  voiceId: process.env.RETELL_VOICE_ID || "11labs-Adrian",
  model: process.env.RETELL_MODEL || "",
  port: Number(process.env.PORT || 8080),
  skipSignature: process.env.SKIP_SIGNATURE_CHECK === "true",
  resendKey: process.env.RESEND_API_KEY || "",
  notifyFrom: process.env.NOTIFY_FROM || "DBS Voice Assistant <assistant@dbsgroup.io>",
  googleEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  googleKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),

  // Phone numbers: SIP trunk used when importing UK numbers into Retell
  sipTerminationUri: process.env.RETELL_SIP_TERMINATION_URI || "",
  sipUsername: process.env.RETELL_SIP_USERNAME || "",
  sipPassword: process.env.RETELL_SIP_PASSWORD || "",

  // Google Calendar "Connect" button (OAuth client, type "Web application")
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",

  // Stripe self sign-up
  stripeKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripeMeterEvent: process.env.STRIPE_METER_EVENT || "voice_minutes",

  // Where DBS gets alerts about new sign-ups and failed payments
  adminEmail: process.env.ADMIN_EMAIL || "",
  demoNumber: process.env.DEMO_PHONE_NUMBER || "",

  // API base URLs (overridable for tests)
  retellApiBase: process.env.RETELL_API_BASE || "https://api.retellai.com",
  stripeApiBase: process.env.STRIPE_API_BASE || "https://api.stripe.com",
  googleAuthUrl: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  googleTokenUrl: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  googleRevokeUrl: process.env.GOOGLE_REVOKE_URL || "https://oauth2.googleapis.com/revoke",
  googleCalBase: process.env.GOOGLE_CAL_BASE || "https://www.googleapis.com/calendar/v3",
};
