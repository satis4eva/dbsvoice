// DBS Voice dashboard. Plain JS, no build step. All text goes in via textContent (safe for caller-supplied data).

const app = document.getElementById("app");
const state = { user: null, tenants: [], tenantId: null, month: new Date().toISOString().slice(0, 7) };

// ---------- tiny helpers ----------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") { state.user = null; render(); throw new Error("Please sign in"); }
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : "–");
const money = (n, cur = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency: cur || "GBP" }).format(n || 0);
const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const isAdmin = () => state.user?.role === "admin";
const tenantName = () => state.tenants.find((t) => t.id === state.tenantId)?.name || "";
const msg = (text, kind = "err") => h("div", { class: `msg ${kind}` }, text);

function route() { return (location.hash.replace(/^#\/?/, "") || "overview").split("?")[0]; }
function hashQuery() { return new URLSearchParams(location.hash.split("?")[1] || ""); }
async function goTo(apiPath, body = {}) { const { url } = await api(apiPath, { method: "POST", body }); location.href = url; }
function go(r) { location.hash = `#/${r}`; }

// ---------- boot ----------

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    state.tenants = me.tenants;
    const saved = localStorageGet("tenant");
    state.tenantId = state.tenants.find((t) => t.id === saved)?.id || me.user.tenant_id || state.tenants[0]?.id || null;
  } catch { state.user = null; }
  render();
}

function localStorageGet(k) { try { return localStorage.getItem(`dbsvoice.${k}`); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(`dbsvoice.${k}`, v); } catch { /* ignore */ } }

window.addEventListener("hashchange", () => render());

// ---------- login ----------

function loginView() {
  const err = h("div");
  const email = h("input", { type: "email", autocomplete: "username", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const btn = h("button", { type: "submit", class: "primary wide" }, "Sign in");
  return h("div", { class: "login" },
    h("form", { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.replaceChildren();
      try { await api("/api/login", { method: "POST", body: { email: email.value, password: pw.value } }); await boot(); }
      catch (ex) { err.replaceChildren(msg(ex.message)); btn.disabled = false; }
    } },
      h("div", { class: "logo" }, "DBS ", h("span", {}, "Voice")),
      h("p", { class: "muted small" }, "AI phone receptionist dashboard"),
      err,
      h("label", {}, "Email"), email,
      h("label", {}, "Password"), pw,
      btn,
      h("p", { class: "small muted center" }, "New to DBS Voice? ", h("a", { href: "#/signup" }, "Create an account"))));
}

// ---------- sign up ----------

async function signupView() {
  const { plans, payments } = await api("/api/plans");
  const wanted = hashQuery().get("plan");
  let chosen = (plans.find((p) => p.id === wanted) || plans.find((p) => p.popular) || plans[0])?.id;
  const err = h("div");
  const cards = h("div", { class: "plans" });
  const drawPlans = () => cards.replaceChildren(...plans.map((p) => h("button", { type: "button", class: `plan${p.id === chosen ? " on" : ""}`, onclick: () => { chosen = p.id; drawPlans(); } },
    p.popular ? h("span", { class: "badge" }, "Most popular") : null,
    h("div", { class: "plan-name" }, p.name),
    h("div", { class: "plan-price" }, money(p.monthly_fee, p.currency), h("span", { class: "muted small" }, " / month")),
    h("div", { class: "muted small" }, `then ${money(p.overage_per_minute, p.currency)} per extra minute`),
    h("ul", {}, p.features.map((f) => h("li", {}, f))))));
  drawPlans();
  const biz = h("input", { autocomplete: "organization", required: true });
  const name = h("input", { autocomplete: "name" });
  const email = h("input", { type: "email", autocomplete: "email", required: true });
  const pw = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 10 });
  const terms = h("input", { type: "checkbox", required: true });
  const btn = h("button", { type: "submit", class: "primary wide" }, payments ? "Continue to payment" : "Create account");
  return h("div", { class: "signup" },
    h("div", { class: "logo" }, "DBS ", h("span", {}, "Voice")),
    h("h1", { class: "mt" }, "An AI receptionist that answers every call"),
    h("p", { class: "muted" }, "Takes messages, qualifies leads and books appointments around the clock. Set up in minutes, cancel any time."),
    cards,
    h("form", { class: "panel", onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.replaceChildren();
      try {
        const res = await api("/api/signup", { method: "POST", body: { business_name: biz.value, name: name.value, email: email.value, password: pw.value, plan: chosen } });
        if (res.checkout_url) { location.href = res.checkout_url; return; }
        location.hash = "#/overview"; await boot();
      } catch (ex) { err.replaceChildren(msg(ex.message)); btn.disabled = false; }
    } },
      h("h2", {}, "Create your account"), err,
      h("div", { class: "row" }, h("div", {}, h("label", {}, "Business name"), biz), h("div", {}, h("label", {}, "Your name"), name)),
      h("div", { class: "row" }, h("div", {}, h("label", {}, "Email"), email), h("div", {}, h("label", {}, "Password ", h("span", { class: "hint" }, "at least 10 characters")), pw)),
      h("label", { class: "check mt" }, terms, "I agree to the DBS Group terms and that calls are recorded and handled by AI"),
      btn,
      h("p", { class: "small muted center" }, "Already have an account? ", h("a", { href: "#/" }, "Sign in"))));
}

// ---------- shell ----------

function shell(content) {
  const r = route();
  const link = (id, label) => h("a", { href: `#/${id}`, class: r === id ? "on" : "" }, label);
  const picker = state.tenants.length > 1
    ? h("select", { onchange: (e) => { state.tenantId = e.target.value; localStorageSet("tenant", state.tenantId); render(); } },
      state.tenants.map((t) => h("option", { value: t.id, selected: t.id === state.tenantId || undefined }, t.name + (t.active ? "" : " (paused)"))))
    : null;
  return h("div", { class: "shell" },
    h("aside", { class: "side" },
      h("div", { class: "logo" }, "DBS ", h("span", {}, "Voice")),
      picker,
      h("nav", {},
        link("overview", "Overview"), link("calls", "Calls"), link("leads", "Leads"), link("messages", "Messages"), link("bookings", "Bookings"), link("settings", "Settings"),
        isAdmin() ? [h("div", { class: "sep" }, "DBS admin"), link("clients", "Clients & billing"), link("numbers", "Numbers"), link("users", "Users")] : null,
        link("account", "Account")),
      h("div", { class: "who" }, state.user.email, h("br"), h("button", { onclick: logout }, "Sign out"))),
    h("main", {}, content));
}

async function logout() { await api("/api/logout", { method: "POST", body: {} }).catch(() => {}); state.user = null; render(); }

function monthPicker() {
  return h("input", { type: "month", value: state.month, class: "auto", onchange: (e) => { if (e.target.value) { state.month = e.target.value; render(); } } });
}

function top(title, ...actions) {
  return h("div", { class: "top" }, h("div", {}, h("h1", {}, title), state.tenantId && !["clients", "numbers", "users", "account"].includes(route()) ? h("div", { class: "muted small" }, tenantName()) : null), h("div", { class: "actions" }, actions));
}

// ---------- render ----------

const VIEWS = { overview: overviewView, calls: () => listView("calls"), leads: () => listView("leads"), messages: () => listView("messages"), bookings: () => listView("bookings"), settings: settingsView, clients: clientsView, numbers: numbersView, users: usersView, account: accountView };

async function render() {
  if (!state.user) {
    if (route() === "signup") {
      const box = h("p", { class: "loading" }, "Loading…");
      app.replaceChildren(box);
      try { box.replaceWith(await signupView()); } catch (e) { box.replaceWith(msg(e.message)); }
    } else app.replaceChildren(loginView());
    return;
  }
  const r = route();
  const view = VIEWS[r] || overviewView;
  if (!state.tenantId && !["clients", "numbers", "users", "account"].includes(r)) {
    app.replaceChildren(shell([top("Welcome"), h("div", { class: "panel" }, isAdmin() ? "No clients yet. Add one under Clients & billing." : "Your account isn't linked to a business yet. Contact DBS Group.")]));
    return;
  }
  const placeholder = h("p", { class: "loading" }, "Loading…");
  app.replaceChildren(shell(placeholder));
  try { placeholder.replaceWith(await view()); }
  catch (e) { placeholder.replaceWith(msg(e.message)); }
}

// ---------- overview ----------

async function overviewView() {
  const t = state.tenantId;
  const [{ stats: s }, leads, msgs, info] = await Promise.all([
    api(`/api/tenants/${t}/stats?month=${state.month}`),
    api(`/api/tenants/${t}/leads?month=${state.month}`),
    api(`/api/tenants/${t}/messages?month=${state.month}`),
    api(`/api/tenants/${t}`),
  ]);
  const stat = (k, v) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  const inv = s.invoice;
  return h("div", {},
    top("Overview", info.plan.has_portal ? h("button", { onclick: () => goTo(`/api/tenants/${t}/portal`).catch((e) => alert(e.message)) }, "Manage billing") : null, monthPicker()),
    paidNotice(),
    setupPanel(info),
    h("div", { class: "stats" },
      stat("Calls", s.calls), stat("Minutes", s.billed_minutes), stat("Avg call", fmtDur(s.avg_call_seconds)),
      stat("Leads", `${s.leads}${s.hot_leads ? ` · ${s.hot_leads} hot` : ""}`), stat("Messages", s.messages), stat("Bookings", s.bookings)),
    inv ? h("div", { class: "panel" }, h("h2", {}, `Plan usage, ${state.month}`),
      h("dl", { class: "kv" },
        h("dt", {}, "Monthly fee"), h("dd", {}, money(inv.monthly_fee, inv.currency)),
        h("dt", {}, "Minutes used"), h("dd", {}, `${s.billed_minutes} of ${inv.included_minutes} included`),
        h("dt", {}, "Extra minutes"), h("dd", {}, `${inv.overage_minutes} × ${money(inv.overage_per_minute, inv.currency)} = ${money(inv.overage, inv.currency)}`),
        h("dt", {}, "Estimated total"), h("dd", { class: "total" }, money(inv.total, inv.currency)))) : null,
    h("div", { class: "grid2" },
      h("div", { class: "panel" }, h("h2", {}, "Latest leads"), leads.rows.slice(0, 5).map(leadItem), leads.rows.length ? null : h("div", { class: "empty" }, "No leads this month."),
        leads.rows.length > 5 ? h("a", { href: "#/leads" }, "See all") : null),
      h("div", { class: "panel" }, h("h2", {}, "Latest messages"), msgs.rows.slice(0, 5).map(messageItem), msgs.rows.length ? null : h("div", { class: "empty" }, "No messages this month."),
        msgs.rows.length > 5 ? h("a", { href: "#/messages" }, "See all") : null)));
}

function paidNotice() {
  const paid = hashQuery().get("paid");
  if (paid === "1") return msg("Payment received, thank you. Your account switches on within a minute. Refresh if it still shows as not active.", "ok");
  if (paid === "0") return msg("Payment was cancelled. You can try again whenever you're ready.");
  return null;
}

function setupPanel(info) {
  const t = info.tenant;
  const ob = info.onboarding;
  if (ob.complete && t.active !== false) return null;
  const links = { info: "#/settings", alerts: "#/settings", calendar: "#/settings" };
  const number = (t.phone_numbers || [])[0];
  const actions = [];
  if (t.active === false) {
    if (info.plan.can_pay) actions.push(h("button", { class: "primary", onclick: () => goTo(`/api/tenants/${t.id}/checkout`).catch((e) => alert(e.message)) }, "Activate plan"));
    else if (isAdmin()) actions.push(h("button", { class: "primary", onclick: async () => { try { const r = await api(`/api/tenants/${t.id}/activate`, { method: "POST", body: {} }); alert(r.note || "Activated"); render(); } catch (e) { alert(e.message); } } }, "Activate now (admin)"));
    else actions.push(h("span", { class: "muted small" }, "DBS Group will activate your account shortly."));
  }
  return h("div", { class: "panel setup" },
    h("h2", {}, t.active === false ? "Finish setting up" : "Getting started"),
    number ? h("div", { class: "ainum" }, h("div", { class: "muted small" }, "Your AI phone number"), h("div", { class: "num" }, number),
      h("p", { class: "small" }, "Forward your business line to this number, or set it to forward when you're busy or don't answer. Your phone provider can do this, often by dialling a short code from your phone."),
      !t.forwarding_confirmed ? h("button", { onclick: async () => { await api(`/api/tenants/${t.id}/forwarding`, { method: "POST", body: { confirmed: true } }); render(); } }, "I've set up forwarding") : null) : null,
    !number && t.active !== false ? h("div", { class: "ainum" },
      h("p", { class: "small" }, "Get a UK phone number for your AI receptionist. You'll then forward your business line to it."),
      h("button", { class: "primary", onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await api(`/api/tenants/${t.id}/claim-number`, { method: "POST", body: {} }); alert(`Your AI number is ${r.number}`); render(); }
        catch (ex) { alert(ex.message); e.target.disabled = false; }
      } }, "Get my AI number")) : null,
    h("ol", { class: "steps" }, ob.steps.map((st) => h("li", { class: st.done ? "done" : "" }, h("span", { class: "tick" }, st.done ? "✓" : ""), links[st.id] && !st.done ? h("a", { href: links[st.id] }, st.label) : st.label))),
    actions.length ? h("div", { class: "mt" }, actions) : null);
}

// ---------- lists ----------

function callItem(c) {
  const rec = /^https:\/\//.test(c.recording_url || "") ? h("audio", { controls: true, preload: "none", src: c.recording_url }) : null;
  return h("div", { class: "item" },
    h("div", { class: "head" }, h("b", {}, c.from || "Unknown caller"), h("span", { class: "muted small" }, `${fmtDate(c.at)} · ${fmtDur(c.duration_sec)}`)),
    c.summary ? h("p", {}, c.summary) : null,
    c.sentiment ? h("div", { class: "muted small" }, `Sentiment: ${c.sentiment}`) : null,
    rec);
}

function leadItem(l) {
  return h("div", { class: "item" },
    h("div", { class: "head" }, h("span", {}, h("span", { class: `badge ${l.score}` }, l.score), " ", h("b", {}, l.caller_name || "Unknown"), l.company ? ` · ${l.company}` : ""), h("span", { class: "muted small" }, fmtDate(l.at))),
    h("div", { class: "small" }, [l.phone, l.email].filter(Boolean).join(" · ")),
    l.need ? h("p", {}, l.need) : null,
    (l.budget || l.timeline) ? h("div", { class: "muted small" }, [l.budget && `Budget: ${l.budget}`, l.timeline && `Timeline: ${l.timeline}`].filter(Boolean).join(" · ")) : null,
    l.answers ? h("p", { class: "muted small" }, l.answers) : null);
}

function messageItem(m) {
  return h("div", { class: "item" },
    h("div", { class: "head" }, h("span", {}, m.urgency === "urgent" ? [h("span", { class: "badge urgent" }, "urgent"), " "] : null, h("b", {}, m.caller_name || "Unknown")), h("span", { class: "muted small" }, fmtDate(m.at))),
    m.callback_number ? h("div", { class: "small" }, `Call back: ${m.callback_number}`) : null,
    h("p", {}, m.message || ""));
}

function bookingItem(b) {
  return h("div", { class: "item" },
    h("div", { class: "head" }, h("b", {}, b.start_iso ? new Date(b.start_iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""), h("span", { class: "muted small" }, `Booked ${fmtDate(b.at)}`)),
    h("div", {}, b.caller_name || ""), h("div", { class: "small" }, [b.phone, b.email].filter(Boolean).join(" · ")),
    b.reason ? h("p", {}, b.reason) : null);
}

async function listView(kind) {
  const titles = { calls: "Calls", leads: "Leads", messages: "Messages", bookings: "Bookings" };
  const items = { calls: callItem, leads: leadItem, messages: messageItem, bookings: bookingItem };
  const data = await api(`/api/tenants/${state.tenantId}/${kind}?month=${state.month}`);
  return h("div", {},
    top(titles[kind], monthPicker(), h("a", { class: "btn", href: `/api/tenants/${state.tenantId}/${kind}.csv?month=${state.month}` }, "Export CSV")),
    h("div", { class: "panel" },
      data.rows.length ? data.rows.map(items[kind]) : h("div", { class: "empty" }, `No ${kind} in ${state.month}.`),
      data.total > data.rows.length ? h("p", { class: "muted small" }, `Showing the latest ${data.rows.length} of ${data.total}. Export CSV for all.`) : null));
}

// ---------- settings ----------

async function settingsView() {
  const info = await api(`/api/tenants/${state.tenantId}`);
  const t = info.tenant;
  const out = h("div");
  const f = {};
  const input = (key, value, attrs = {}) => (f[key] = h("input", { value: value ?? "", ...attrs }));
  const area = (key, value, attrs = {}) => (f[key] = h("textarea", { ...attrs }, value ?? ""));
  const field = (label, el, hint) => [h("label", {}, label, hint ? h("span", { class: "hint" }, ` ${hint}`) : null), el];

  // hours: returns { el, rows } so opening hours and booking hours stay separate
  const hoursGrid = (hours) => {
    const rows = {};
    const el = h("div", { class: "hours" },
      DAYS.map(([k, name]) => {
        const open = h("input", { type: "time", value: hours?.[k]?.[0] || "09:00" });
        const close = h("input", { type: "time", value: hours?.[k]?.[1] || "17:30" });
        const closed = h("input", { type: "checkbox", checked: !hours?.[k] });
        const sync = () => { open.disabled = close.disabled = closed.checked; };
        closed.addEventListener("change", sync); sync();
        rows[k] = { open, close, closed };
        return [h("div", { class: "day" }, name), open, close, h("label", { class: "check" }, closed, "Closed")];
      }));
    return { el, rows };
  };
  const opening = hoursGrid(t.hours);
  const readHours = (rows) => Object.fromEntries(Object.entries(rows).filter(([, r]) => !r.closed.checked).map(([k, r]) => [k, [r.open.value, r.close.value]]));

  // faqs
  const faqBox = h("div");
  const addFaq = (q = "", a = "") => {
    const row = h("div", { class: "faq" }, h("input", { placeholder: "Question", value: q }), h("textarea", { placeholder: "Answer", class: "short" }, a), h("button", { type: "button", class: "danger", onclick: () => row.remove() }, "Remove"));
    faqBox.append(row);
  };
  (t.faqs || []).forEach((x) => addFaq(x.q, x.a));

  const sections = [
    h("div", { class: "panel" }, h("h2", {}, "Business"),
      h("div", { class: "row" }, h("div", {}, field("Business name", input("name", t.name))), h("div", {}, field("Assistant's name", input("assistant_name", t.assistant_name)))),
      field("Greeting", input("greeting", t.greeting), "the first thing callers hear"),
      field("About the business", area("business_info", t.business_info), "the assistant only says what's written here"),
      field("Services", area("services", (t.services || []).join("\n")), "one per line")),
    h("div", { class: "panel" }, h("h2", {}, "Opening hours"), opening.el),
    h("div", { class: "panel" }, h("h2", {}, "Questions callers ask"), faqBox, h("button", { type: "button", onclick: () => addFaq() }, "Add question")),
    h("div", { class: "panel" }, h("h2", {}, "Lead questions"),
      field("Questions to ask new enquiries", area("questions", (t.qualification?.questions || []).join("\n")), "one per line"),
      field("What makes a hot lead?", input("hot", t.qualification?.hot_lead_criteria))),
    h("div", { class: "panel" }, h("h2", {}, "Transfers & alerts"),
      h("div", { class: "row" },
        h("div", {}, field("Transfer calls to", input("transfer_number", t.transfer_number, { placeholder: "+447700900123" }), "leave empty to turn off")),
        h("div", {}, field("Alert emails", input("emails", (t.notify?.email || []).join(", ")), "comma separated"))),
      field("When to transfer", input("transfer_rules", t.transfer_rules)),
      field("Slack or webhook URL", input("webhook", t.notify?.webhook, { placeholder: "https://hooks.slack.com/…" }), "optional"),
      h("label", { class: "check" }, (f.summaries = h("input", { type: "checkbox", checked: t.notify?.call_summaries !== false })), "Email a summary after every call"),
      field("Blocked numbers", area("blocked", (t.blocked_numbers || []).join("\n"), { class: "medium" }), "one per line")),
    calendarPanel(info),
  ];

  let booking = null; // { el, rows } when separate booking hours are on
  if (isAdmin()) {
    const c = t.calendar || {}; const b = t.billing || {};
    const bh = h("div");
    const useBh = h("input", { type: "checkbox", checked: Boolean(c.booking_hours && Object.keys(c.booking_hours).length) });
    const renderBh = () => {
      booking = useBh.checked ? hoursGrid(c.booking_hours || t.hours) : null;
      bh.replaceChildren(...(booking ? [booking.el] : []));
    };
    useBh.addEventListener("change", renderBh);
    renderBh();
    sections.push(h("div", { class: "panel" }, h("h2", {}, "DBS admin: routing, diary & billing"),
      h("div", { class: "numbar" },
        (t.phone_numbers || []).map((n) => h("span", { class: "chip" }, n, h("button", { type: "button", title: "Release number", onclick: async () => {
          if (!confirm(`Release ${n} from ${t.name}? It goes back to the pool.`)) return;
          try { await api(`/api/tenants/${t.id}/release-number`, { method: "POST", body: { number: n } }); render(); } catch (e) { alert(e.message); }
        } }, "×"))),
        h("button", { type: "button", onclick: async () => { try { const r = await api(`/api/tenants/${t.id}/assign-number`, { method: "POST", body: {} }); alert(`Assigned ${r.number}`); render(); } catch (e) { alert(e.message); } } }, "Assign number from pool"),
        t.active === false ? h("button", { type: "button", class: "primary", onclick: async () => { try { const r = await api(`/api/tenants/${t.id}/activate`, { method: "POST", body: {} }); alert(r.note || "Activated"); render(); } catch (e) { alert(e.message); } } }, "Activate client") : null),
      h("div", { class: "row" },
        h("div", {}, field("Phone numbers", area("phones", (t.phone_numbers || []).join("\n"), { class: "medium" }), "one per line, +44…")),
        h("div", {}, field("Time zone", input("timezone", t.timezone || "Europe/London")),
          h("label", { class: "check mt" }, (f.active = h("input", { type: "checkbox", checked: t.active !== false })), "Active (answering calls)"))),
      h("div", { class: "row" },
        h("div", {}, field("Google Calendar ID", input("cal_id", c.id), "empty = no booking")),
        h("div", {}, field("Appointment name", input("cal_label", c.appointment_label))),
        h("div", {}, field("Slot length (min)", input("cal_slot", c.slot_minutes || 30, { type: "number", min: 10 }))),
        h("div", {}, field("Gap between (min)", input("cal_buffer", c.buffer_minutes || 0, { type: "number", min: 0 }))),
        h("div", {}, field("Minimum notice (min)", input("cal_notice", c.min_notice_minutes ?? 120, { type: "number", min: 0 })))),
      h("label", { class: "check" }, useBh, "Use different hours for bookings"), bh,
      h("div", { class: "row" },
        h("div", {}, field("Monthly fee", input("fee", b.monthly_fee || 0, { type: "number", min: 0, step: "0.01" }))),
        h("div", {}, field("Included minutes", input("incl", b.included_minutes || 0, { type: "number", min: 0 }))),
        h("div", {}, field("Extra minute price", input("rate", b.overage_per_minute || 0, { type: "number", min: 0, step: "0.01" }))),
        h("div", {}, field("Currency", input("cur", b.currency || "GBP", { maxlength: 3 }))))));
  }

  const status = h("span");
  const save = h("button", { class: "primary", onclick: async () => {
    save.disabled = true; status.replaceChildren();
    const body = {
      name: f.name.value, assistant_name: f.assistant_name.value, greeting: f.greeting.value, business_info: f.business_info.value,
      services: f.services.value, hours: readHours(opening.rows),
      faqs: [...faqBox.children].map((row) => ({ q: row.children[0].value, a: row.children[1].value })),
      qualification: { questions: f.questions.value, hot_lead_criteria: f.hot.value },
      transfer_number: f.transfer_number.value, transfer_rules: f.transfer_rules.value,
      notify: { email: f.emails.value, webhook: f.webhook.value, call_summaries: f.summaries.checked },
      blocked_numbers: f.blocked.value,
    };
    if (isAdmin()) Object.assign(body, {
      phone_numbers: f.phones.value, timezone: f.timezone.value, active: f.active.checked,
      calendar: { id: f.cal_id.value, appointment_label: f.cal_label.value, slot_minutes: f.cal_slot.value, buffer_minutes: f.cal_buffer.value, min_notice_minutes: f.cal_notice.value, booking_hours: booking ? readHours(booking.rows) : {} },
      billing: { monthly_fee: f.fee.value, included_minutes: f.incl.value, overage_per_minute: f.rate.value, currency: f.cur.value },
    });
    try {
      const res = await api(`/api/tenants/${state.tenantId}`, { method: "PUT", body });
      const entry = state.tenants.find((x) => x.id === state.tenantId);
      if (entry) { entry.name = res.tenant.name; entry.active = res.tenant.active !== false; }
      const failed = (res.numbers_sync || []).filter((x) => !x.ok);
      status.replaceChildren(failed.length
        ? h("span", { class: "msg err" }, `Saved, but ${failed.map((x) => `${x.number}: ${x.error}`).join("; ")}`)
        : h("span", { class: "msg ok" }, (res.numbers_sync || []).length ? "Saved. New numbers are connected and answering." : "Saved. The assistant uses this from the next call."));
    } catch (e) { status.replaceChildren(h("span", { class: "msg err" }, e.message)); }
    save.disabled = false;
  } }, "Save changes");

  out.append(top("Settings"), ...sections, h("div", { class: "savebar" }, save, status));
  return out;
}

function calendarPanel(info) {
  const t = info.tenant, g = info.google;
  const q = hashQuery().get("calendar");
  const notes = { connected: ["Google Calendar connected. Callers can now book appointments.", "ok"], cancelled: ["Google connection was cancelled.", "err"], error: ["Couldn't connect to Google. Please try again.", "err"], expired: ["That link expired. Please try again.", "err"], unavailable: ["Calendar connection isn't set up on this server yet. Contact DBS Group.", "err"], denied: ["Please sign in again and retry.", "err"] };
  const note = notes[q] ? msg(notes[q][0], notes[q][1]) : null;
  let body;
  if (g.connected) {
    body = [h("p", {}, "Connected to ", h("b", {}, g.email || "your Google account"), ". The assistant checks your free times and adds bookings to your main calendar."),
      h("button", { type: "button", class: "danger", onclick: async () => { if (!confirm("Disconnect Google Calendar? The assistant will stop booking appointments.")) return; await api(`/api/tenants/${t.id}/calendar-disconnect`, { method: "POST", body: {} }); location.hash = "#/settings"; render(); } }, "Disconnect")];
  } else if (info.features.google_connect) {
    body = [g.needs_reconnect ? msg("Google access expired. Please reconnect.") : null,
      h("p", {}, "Let callers book appointments straight into your Google Calendar. The assistant only offers times you're free."),
      h("a", { class: "btn primary", href: `/oauth/google/start?tenant=${encodeURIComponent(t.id)}` }, "Connect Google Calendar")];
  } else {
    body = [h("p", { class: "muted" }, t.calendar?.id ? "Bookings are set up by DBS Group." : "Calendar booking isn't available yet. Contact DBS Group to turn it on.")];
  }
  return h("div", { class: "panel" }, h("h2", {}, "Appointments"), note, body);
}

// ---------- admin: numbers ----------

async function numbersView() {
  const data = await api("/api/numbers");
  const err = h("div");
  const num = h("input", { placeholder: "+442071234567" });
  const imp = h("input", { type: "checkbox", checked: data.can_import, disabled: !data.can_import });
  return h("div", {},
    top("Numbers"),
    !data.ready ? msg(`${data.engine} isn't fully set up yet, so new numbers can't answer calls. Finish the voice setup first.`) : null,
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("div", { class: "k" }, "In pool"), h("div", { class: "v" }, data.numbers.length)),
      h("div", { class: "stat" }, h("div", { class: "k" }, "Free"), h("div", { class: "v" }, data.free))),
    data.free === 0 ? msg("No free numbers. New sign-ups will go live without a number until you add one here.") : null,
    h("div", { class: "panel table-wrap" }, data.numbers.length ? h("table", {},
      h("thead", {}, h("tr", {}, ["Number", "Client", "Added", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, data.numbers.map((n) => h("tr", {},
        h("td", {}, h("b", {}, n.number)),
        h("td", {}, n.tenant_name || h("span", { class: "badge" }, "free")),
        h("td", { class: "muted small" }, fmtDate(n.added_at)),
        h("td", {}, n.tenant_id ? null : h("button", { class: "danger", onclick: async () => {
          if (!confirm(`Remove ${n.number} from the pool?`)) return;
          try { await api(`/api/numbers/${encodeURIComponent(n.number)}`, { method: "DELETE", body: {} }); render(); } catch (e) { err.replaceChildren(msg(e.message)); }
        } }, "Remove")))))) : h("div", { class: "empty" }, "No numbers yet.")),
    h("div", { class: "panel" }, h("h2", {}, "Add a number"), err,
      h("p", { class: "small muted" }, data.can_import ? `Tick import to bring a number in from ${data.import_from}. Untick it if the number is already in ${data.engine}.` : `Add the number in ${data.engine} first, then add it here. To import automatically, ${data.import_from} details need adding on the server.`),
      h("label", {}, "Phone number"), num,
      h("label", { class: "check mt" }, imp, `Import into ${data.engine} from ${data.import_from}`),
      h("div", { class: "mt" }, h("button", { class: "primary", onclick: async (e) => {
        err.replaceChildren(); e.target.disabled = true;
        try { await api("/api/numbers", { method: "POST", body: { number: num.value, import: imp.checked } }); render(); }
        catch (ex) { err.replaceChildren(msg(ex.message)); e.target.disabled = false; }
      } }, "Add to pool"))));
}

// ---------- admin: clients & billing ----------

async function clientsView() {
  const data = await api(`/api/tenants?month=${state.month}`);
  const err = h("div");
  const id = h("input", { placeholder: "smith-dental" });
  const name = h("input", { placeholder: "Smith Dental" });
  const phone = h("input", { placeholder: "+44…" });
  const totals = data.tenants.reduce((a, t) => ({ min: a.min + t.billed_minutes, rev: a.rev + t.invoice.total }), { min: 0, rev: 0 });
  return h("div", {},
    top("Clients & billing", monthPicker(), h("a", { class: "btn", href: `/api/tenants?month=${state.month}&format=csv` }, "Usage CSV")),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("div", { class: "k" }, "Clients"), h("div", { class: "v" }, data.tenants.length)),
      h("div", { class: "stat" }, h("div", { class: "k" }, "Minutes"), h("div", { class: "v" }, totals.min)),
      h("div", { class: "stat" }, h("div", { class: "k" }, "To invoice"), h("div", { class: "v" }, money(totals.rev)))),
    h("div", { class: "panel table-wrap" },
      h("table", {},
        h("thead", {}, h("tr", {}, ["Client", "Calls", "Minutes", "Leads", "Fee", "Extra", "Total", ""].map((x) => h("th", {}, x)))),
        h("tbody", {}, data.tenants.map((t) => h("tr", {},
          h("td", {}, h("b", {}, t.name || t.id), t.active ? null : [" ", h("span", { class: "badge off" }, "paused")], h("div", { class: "muted small" }, (t.phone_numbers || []).join(", ") || "no number yet")),
          h("td", {}, t.calls), h("td", {}, t.billed_minutes), h("td", {}, t.leads),
          h("td", {}, money(t.invoice.monthly_fee, t.invoice.currency)), h("td", {}, money(t.invoice.overage, t.invoice.currency)), h("td", {}, h("b", {}, money(t.invoice.total, t.invoice.currency))),
          h("td", {}, h("button", { onclick: () => { state.tenantId = t.id; localStorageSet("tenant", t.id); go("settings"); } }, "Open"))))))),
    h("div", { class: "panel" }, h("h2", {}, "Add a client"), err,
      h("div", { class: "row" }, h("div", {}, h("label", {}, "Client id ", h("span", { class: "hint" }, "lowercase, dashes")), id), h("div", {}, h("label", {}, "Business name"), name), h("div", {}, h("label", {}, "Phone number ", h("span", { class: "hint" }, "optional")), phone)),
      h("div", { class: "mt" }, h("button", { class: "primary", onclick: async () => {
        err.replaceChildren();
        try {
          const res = await api("/api/tenants", { method: "POST", body: { id: id.value, name: name.value, phone_numbers: phone.value } });
          state.tenants.push({ id: res.tenant.id, name: res.tenant.name, active: true });
          state.tenantId = res.tenant.id; localStorageSet("tenant", res.tenant.id);
          go("settings");
        } catch (e) { err.replaceChildren(msg(e.message)); }
      } }, "Create client"))));
}

// ---------- admin: users ----------

async function usersView() {
  const { users } = await api("/api/users");
  const err = h("div");
  const email = h("input", { type: "email" }); const name = h("input"); const pw = h("input", { type: "text", placeholder: "at least 10 characters" });
  const role = h("select", {}, h("option", { value: "client" }, "Client (one business)"), h("option", { value: "admin" }, "DBS admin (everything)"));
  const tenant = h("select", {}, state.tenants.map((t) => h("option", { value: t.id }, t.name)));
  role.addEventListener("change", () => { tenant.disabled = role.value === "admin"; });
  const nameOf = (id) => state.tenants.find((t) => t.id === id)?.name || id;
  return h("div", {},
    top("Users"),
    h("div", { class: "panel table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Email", "Name", "Access", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, users.map((u) => h("tr", {}, h("td", {}, u.email), h("td", {}, u.name), h("td", {}, u.role === "admin" ? "DBS admin" : nameOf(u.tenant_id)),
        h("td", {}, u.id === state.user.id ? h("span", { class: "muted small" }, "you") : h("button", { class: "danger", onclick: async () => {
          if (!confirm(`Remove ${u.email}?`)) return;
          try { await api(`/api/users/${u.id}`, { method: "DELETE", body: {} }); render(); } catch (e) { err.replaceChildren(msg(e.message)); }
        } }, "Remove"))))))),
    h("div", { class: "panel" }, h("h2", {}, "Add a user"), err,
      h("div", { class: "row" }, h("div", {}, h("label", {}, "Email"), email), h("div", {}, h("label", {}, "Name"), name), h("div", {}, h("label", {}, "Temporary password"), pw)),
      h("div", { class: "row" }, h("div", {}, h("label", {}, "Access"), role), h("div", {}, h("label", {}, "Business"), tenant)),
      h("p", { class: "muted small" }, "Send them the dashboard link and password, and ask them to change it under Account."),
      h("button", { class: "primary", onclick: async () => {
        err.replaceChildren();
        try { await api("/api/users", { method: "POST", body: { email: email.value, name: name.value, password: pw.value, role: role.value, tenant_id: tenant.value } }); render(); }
        catch (e) { err.replaceChildren(msg(e.message)); }
      } }, "Add user")));
}

// ---------- account ----------

function accountView() {
  const err = h("div");
  const cur = h("input", { type: "password", autocomplete: "current-password" });
  const next = h("input", { type: "password", autocomplete: "new-password" });
  return h("div", {},
    top("Account"),
    h("div", { class: "panel" }, h("dl", { class: "kv" }, h("dt", {}, "Signed in as"), h("dd", {}, state.user.email), h("dt", {}, "Access"), h("dd", {}, isAdmin() ? "DBS admin" : tenantName())),
      h("div", { class: "mt" }, h("button", { onclick: logout }, "Sign out"))),
    h("div", { class: "panel" }, h("h2", {}, "Change password"), err,
      h("label", {}, "Current password"), cur, h("label", {}, "New password ", h("span", { class: "hint" }, "at least 10 characters")), next,
      h("div", { class: "mt" }, h("button", { class: "primary", onclick: async () => {
        err.replaceChildren();
        try { await api("/api/me/password", { method: "POST", body: { current: cur.value, password: next.value } }); err.replaceChildren(msg("Password changed.", "ok")); cur.value = next.value = ""; }
        catch (e) { err.replaceChildren(msg(e.message)); }
      } }, "Change password"))));
}

boot();
