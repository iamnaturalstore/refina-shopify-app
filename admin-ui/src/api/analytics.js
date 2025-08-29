// admin-ui/src/api/analytics.js
// Tiny helpers to talk to the backend Analytics endpoints from the Admin UI.

function getShopAndHost() {
  const sp = new URLSearchParams(location.search);
  const shop = (sp.get("shop") || "").toLowerCase();
  const host = sp.get("host") || "";
  return { shop, host };
}

export async function submitAnalyticsEvent(input) {
  const { shop, host } = getShopAndHost();
  const body = {
    type: input.type || "concern",
    concern: input.concern,
    productIds: Array.isArray(input.productIds) ? input.productIds : [],
    plan: input.plan || "unknown",
    sessionId: input.sessionId,
    model: input.model,
    explanation: input.explanation,
  };

  const res = await fetch(
    `/api/admin/analytics/ingest?host=${encodeURIComponent(host)}&shop=${encodeURIComponent(shop)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Shop-Domain": shop, // backend accepts header or query
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`ingest failed: ${res.status} ${err}`);
  }

  // Success: broadcast so any open dashboard can refresh immediately.
  const out = await res.json(); // { ok:true, id:"..." }
  try {
    window.dispatchEvent(new CustomEvent("rf:analytics:ingested", { detail: out }));
  } catch {}
  return out;
}

export async function fetchAnalyticsOverview(days = 30) {
  const { shop, host } = getShopAndHost();
  const res = await fetch(
    `/api/admin/analytics/overview?days=${days}&host=${encodeURIComponent(host)}&shop=${encodeURIComponent(shop)}`,
    { headers: { "X-Shopify-Shop-Domain": shop } }
  );
  if (!res.ok) throw new Error("overview fetch failed");
  return res.json();
}

export async function fetchAnalyticsLogs(limit = 25) {
  const { shop, host } = getShopAndHost();
  const res = await fetch(
    `/api/admin/analytics/logs?limit=${limit}&host=${encodeURIComponent(host)}&shop=${encodeURIComponent(shop)}`,
    { headers: { "X-Shopify-Shop-Domain": shop } }
  );
  if (!res.ok) throw new Error("logs fetch failed");
  return res.json();
}

export { getShopAndHost };
