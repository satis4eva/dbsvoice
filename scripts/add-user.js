// Create a dashboard login.
//   npm run add-user -- --email you@dbsgroup.io --password "long-password" --role admin
//   npm run add-user -- --email owner@client.co.uk --password "..." --role client --tenant smith-dental
import "../src/env.js";
import { createUser } from "../src/auth.js";
import { tenantById } from "../src/tenants.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);

try {
  if (args.role === "client" && !tenantById(args.tenant)) throw new Error(`No client with id "${args.tenant}" in tenants/`);
  const u = createUser({ email: args.email, password: args.password, name: args.name, role: args.role || "admin", tenant_id: args.tenant });
  console.log(`Created ${u.role} user ${u.email}${u.tenant_id ? ` for ${u.tenant_id}` : ""}.`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
