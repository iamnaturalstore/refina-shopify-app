import React from "react";

export default function Billing() {
  const [shop, setShop] = React.useState("");
  const [plan, setPlan] = React.useState("free");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  // Read shop from query (embedded admin usually provides it)
  React.useEffect(() => {
    const u = new URL(window.location.href);
    const s = u.searchParams.get("shop") || window.__SHOP__ || "";
    setShop(s);

    // Reflect successful return (hash params from server redirect)
    if (u.hash.includes("billing=ok")) {
      const h = new URLSearchParams(u.hash.slice(1));
      const p = h.get("plan");
      if (p) setPlan(p);
    }

    // Fetch current plan from backend
    if (s) {
      fetch(`/admin/api/plan?shop=${encodeURIComponent(s)}`, { credentials: "include" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`plan ${r.status}`)))
        .then(json => setPlan(json.plan || "free"))
        .catch(e => setError(e.message || "Failed to load plan"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  async function start(planKey) {
    try {
      setError("");
      const r = await fetch(`/admin/api/billing/checkout?shop=${encodeURIComponent(shop)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ plan: planKey }),
      });
      if (!r.ok) throw new Error(`checkout ${r.status}`);
      const { confirmationUrl } = await r.json();
      // Break out of the embedded iframe into Shopify’s top window for the confirmation
      window.top.location.href = confirmationUrl;
    } catch (e) {
      setError(e.message || "Failed to start checkout");
    }
  }

  const plans = [
    { key: "pro",     label: "Pro ($19/mo)" },
    { key: "premium", label: "Premium ($39/mo)" },
  ];

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.4 }}>
      <h1>Billing</h1>
      {shop ? <p style={{ marginTop: 0, color: "#666" }}>Shop: <b>{shop}</b></p> : <p style={{ color: "#666" }}>Shop not detected.</p>}
      {loading ? <p>Loading…</p> : <p>Current plan: <b>{plan}</b></p>}
      {error ? <p style={{ color: "#c00" }}>{error}</p> : null}

      <div style={{ display: "grid", gap: 12, maxWidth: 420, marginTop: 16 }}>
        {plans.map(p => (
          <button
            key={p.key}
            onClick={() => start(p.key)}
            disabled={!shop || plan === p.key}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #ccc",
              background: plan === p.key ? "#f3f3f3" : "#fff",
              cursor: !shop || plan === p.key ? "not-allowed" : "pointer"
            }}
          >
            {p.label}{plan === p.key ? " ✓" : ""}
          </button>
        ))}
      </div>

      <p style={{ marginTop: 12, color: "#666" }}>
        Trial: {Number(import.meta?.env?.VITE_BILLING_TRIAL_DAYS || 7)} days. You can upgrade or cancel anytime.
      </p>
    </div>
  );
}
