// Pricing comes from the same plans as sign-up, so the page never goes out of date.
(async () => {
  const box = document.getElementById("plans");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  try {
    const r = await fetch("/api/plans");
    const { plans, demo_number } = await r.json();
    if (demo_number) {
      const a = document.getElementById("demo-number");
      a.textContent = demo_number.replace(/^\+44(\d{2})(\d{4})(\d+)$/, "0$1 $2 $3");
      a.href = `tel:${demo_number}`;
      document.getElementById("demo").hidden = false;
    }
    const money = (n, c) => new Intl.NumberFormat("en-GB", { style: "currency", currency: c || "GBP", maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
    box.replaceChildren(...plans.map((p) => {
      const card = el("article", `plan${p.popular ? " popular" : ""}`);
      if (p.popular) card.append(el("p", "tag", "Most chosen"));
      card.append(el("h3", "", p.name));
      const price = el("p", "price", money(p.monthly_fee, p.currency));
      price.append(el("span", "", " a month"));
      card.append(price);
      card.append(el("p", "extra", `${p.included_minutes.toLocaleString("en-GB")} minutes included, then ${money(p.overage_per_minute, p.currency)} a minute`));
      const ul = el("ul");
      for (const f of p.features) ul.append(el("li", "", f));
      card.append(ul);
      const a = el("a", `btn${p.popular ? "" : " ghost"}`, `Choose ${p.name}`);
      a.href = `/app#/signup?plan=${encodeURIComponent(p.id)}`;
      card.append(a);
      return card;
    }));
  } catch {
    box.replaceChildren(el("p", "loading", "Plans couldn't load. Refresh the page, or sign up to see them."));
  }
})();
