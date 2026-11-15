import { env } from "./env.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function toHtml(title, fields) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top"><b>${esc(k)}</b></td><td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td></tr>`)
    .join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px"><h2 style="margin:0 0 12px">${esc(title)}</h2><table>${rows}</table></div>`;
}

function toText(title, fields) {
  return [title, ...Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)].join("\n");
}

/**
 * Send a notification for a tenant by email (Resend) and/or webhook (Slack, Make, Zapier, n8n...).
 * Never throws: a failed notification must not break a live call.
 */
export async function notify(tenant, title, fields) {
  const n = tenant.notify || {};
  const jobs = [];

  if (n.email && env.resendKey) {
    jobs.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.notifyFrom,
          to: Array.isArray(n.email) ? n.email : [n.email],
          subject: `[${tenant.name}] ${title}`,
          html: toHtml(title, fields),
          text: toText(title, fields),
        }),
      }).then(async (r) => { if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`); })
    );
  }

  if (n.webhook) {
    jobs.push(
      fetch(n.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "text" makes it work directly with Slack incoming webhooks
        body: JSON.stringify({ text: `*[${tenant.name}] ${title}*\n${toText("", fields).trim()}`, tenant: tenant.id, title, ...fields }),
      }).then(async (r) => { if (!r.ok) throw new Error(`Webhook ${r.status}`); })
    );
  }

  if (jobs.length === 0) {
    console.log(`[notify:${tenant.id}] ${toText(title, fields)}`);
    return { sent: false };
  }

  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error(`[notify:${tenant.id}]`, r.reason?.message);
  return { sent: results.some((r) => r.status === "fulfilled") };
}
