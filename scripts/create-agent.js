// Creates (or updates) the shared Retell LLM + agent. Run once, then again after prompt/tool changes.
//   npm run setup-agent
import fs from "node:fs";
import { env } from "../src/env.js";
import { GENERAL_PROMPT, BEGIN_MESSAGE, DEFAULT_DYNAMIC_VARIABLES } from "../src/prompt.js";
import { toolDefinitions } from "../src/tools.js";
import { upsertAssistant, webhookUrl } from "../src/vapi.js";

if (env.voiceProvider === "vapi") {
  if (!env.vapiApiKey) throw new Error("Set VAPI_API_KEY in .env");
  if (!env.publicBaseUrl.startsWith("https://")) throw new Error("Set PUBLIC_BASE_URL in .env to your public https URL");
  const r = await upsertAssistant();
  console.log(`${r.created ? "Created" : "Updated"} Vapi assistant ${r.id}.`);
  console.log(`Phone numbers should have no assistant and this Server URL:\n  ${webhookUrl().replace(/token=[^&]+/, "token=…")}`);
  console.log("The Numbers page in the dashboard sets this up for you.");
  process.exit(0);
}

const API = "https://api.retellai.com";

async function retell(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.retellApiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

if (!env.retellApiKey) throw new Error("Set RETELL_API_KEY in .env");
if (!env.publicBaseUrl.startsWith("https://")) throw new Error("Set PUBLIC_BASE_URL in .env to your public https URL");

const llmConfig = {
  general_prompt: GENERAL_PROMPT,
  begin_message: BEGIN_MESSAGE,
  general_tools: toolDefinitions(env.publicBaseUrl),
  default_dynamic_variables: DEFAULT_DYNAMIC_VARIABLES,
  ...(env.model ? { model: env.model } : {}),
};

const agentConfig = {
  agent_name: "DBS Voice Receptionist",
  voice_id: env.voiceId,
  language: "en-GB",
  webhook_url: `${env.publicBaseUrl}/retell/webhook`,
  enable_backchannel: true,
  end_call_after_silence_ms: 30000,
  max_call_duration_ms: 20 * 60 * 1000,
};

let agentId = env.agentId;

if (agentId) {
  const agent = await retell("GET", `/get-agent/${agentId}`);
  const llmId = agent.response_engine?.llm_id;
  await retell("PATCH", `/update-retell-llm/${llmId}`, llmConfig);
  await retell("PATCH", `/update-agent/${agentId}`, agentConfig);
  console.log(`Updated agent ${agentId} (LLM ${llmId}).`);
} else {
  const llm = await retell("POST", "/create-retell-llm", llmConfig);
  const agent = await retell("POST", "/create-agent", { ...agentConfig, response_engine: { type: "retell-llm", llm_id: llm.llm_id } });
  agentId = agent.agent_id;
  console.log(`Created LLM ${llm.llm_id} and agent ${agentId}.`);
  if (fs.existsSync(".env")) {
    const cur = fs.readFileSync(".env", "utf8");
    fs.writeFileSync(".env", /^RETELL_AGENT_ID=.*$/m.test(cur) ? cur.replace(/^RETELL_AGENT_ID=.*$/m, `RETELL_AGENT_ID=${agentId}`) : `${cur}\nRETELL_AGENT_ID=${agentId}\n`);
    console.log("Saved RETELL_AGENT_ID to .env");
  }
}

console.log(`
Next, for each client phone number in the Retell dashboard (Phone Numbers):
  Inbound agent:        ${agentId}
  Inbound webhook URL:  ${env.publicBaseUrl}/retell/inbound
Then call the number to test. In the dashboard, check the agent's version is published if your account uses versioning.`);
