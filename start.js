// Production entry point (used by Hostinger and `npm start`). Always starts listening.
// No top-level await: Hostinger's LiteSpeed runner loads this file with require().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./src/env.js";
import { createServer } from "./src/server.js";
import { loadTenants } from "./src/tenants.js";
import { bootstrapAdmin } from "./src/auth.js";
import { syncAssistantOnStart } from "./src/vapi.js";

const here = path.dirname(fileURLToPath(import.meta.url));

if (process.env.NODE_ENV === "production" && (process.env.SESSION_SECRET || "").length < 32) {
  console.error("SESSION_SECRET must be set to 32+ random characters in production.");
  process.exit(1);
}

// Seed the client-settings folder on first run (it lives outside the app folder so redeploys keep it).
const tenantsDir = path.resolve(process.env.TENANTS_DIR || path.join(here, "tenants"));
if (!fs.existsSync(tenantsDir) || !fs.readdirSync(tenantsDir).some((f) => f.endsWith(".json"))) {
  fs.mkdirSync(tenantsDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(here, "tenants")).filter((f) => f.endsWith(".json"))) {
    fs.copyFileSync(path.join(here, "tenants", f), path.join(tenantsDir, f));
  }
  console.log(`Seeded client settings into ${tenantsDir}`);
}

const created = bootstrapAdmin();
if (created) console.log(`Created first admin login ${created}`);

const tenants = loadTenants();
createServer().listen(env.port, () => {
  console.log(`DBS Voice listening on :${env.port} with ${Object.keys(tenants).length} client(s)`);
  if (env.voiceProvider === "vapi") {
    if (!env.vapiApiKey) console.warn("VAPI_API_KEY is not set yet: dashboard works, calls won't.");
    syncAssistantOnStart()
      .then((r) => console.log(`Vapi assistant: ${r.ok || r.skipped}${r.id ? ` (${r.id})` : ""}`))
      .catch((e) => console.error(`Vapi assistant sync failed: ${e.message}`));
  } else if (!env.retellApiKey) console.warn("RETELL_API_KEY is not set yet: dashboard works, calls won't.");
});
