const BACKEND = "https://refina.ngrok.app"; // update if your tunnel changes

export default function Billing() {
  const plans = [
    { key: "starter", label: "Starter (A$19.99/mo)" },
    { key: "growth",  label: "Growth (A$39.99/mo)" },
    { key: "pro+",    label: "Pro+ (A$79.99/mo, 14-day trial)" },
  ];
  const start = (key) => {
    window.top.location.href = `${BACKEND}/api/billing/start?plan=${encodeURIComponent(key)}`;
  };
  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Billing</h1>
      <p>Choose a plan to continue in Shopify.</p>
      <div style={{ display: "grid", gap: 12, maxWidth: 420, marginTop: 16 }}>
        {plans.map(p => (
          <button key={p.key} onClick={() => start(p.key)} style={{ padding: "10px 14px" }}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
