import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.DATA_DIR || "data");

/** Append one record to data/<tenant>/<kind>.jsonl. Notifications are the main record; this is a backup log. */
export function record(tenantId, kind, data) {
  const dir = path.join(root, tenantId || "unknown");
  fs.mkdirSync(dir, { recursive: true });
  const row = { at: new Date().toISOString(), ...data };
  fs.appendFileSync(path.join(dir, `${kind}.jsonl`), JSON.stringify(row) + "\n");
  return row;
}

export function readRecords(tenantId, kind) {
  const file = path.join(root, tenantId, `${kind}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
