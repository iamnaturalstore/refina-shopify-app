// admin-ui/src/api/analytics.js
// Tiny helpers to talk to the backend Analytics endpoints from the Admin UI.
// DEPRECATED as a standalone client: now delegates to adminApi/api to avoid drift.
import { api, adminApi } from "../api/client.js";

function getShopAndHost() {
  const sp = new URLSearchParams(location.search || "");
  const shop = (sp.get("shop") || "").toLowerCase();
  const host = sp.get("host") || "";
  return { shop, host };
}

export async function submitAnalyticsEvent(input) {
  const body = {
    type: input?.type || "concern",
    concern: input?.concern,
    productIds: Array.isArray(input?.productIds) ? input.productIds : [],
    plan: input?.plan || "unknown",
    sessionId: input?.sessionId,
    model: input?.model,
    explanation: input?.explanation,
  };

  const out = await api(`/api/admin/analytics/ingest`, {
    method: "POST",
    body,
  });

  // Success: broadcast so any open dashboard can refresh immediately.
  try {
    window.dispatchEvent(new CustomEvent("rf:analytics:ingested", { detail: out }));
  } catch {}
  return out;
}

export async function fetchAnalyticsOverview(days = 30) {
  return adminApi.getAnalyticsSummary({ days });
}

export async function fetchAnalyticsLogs(limit = 25) {
  return adminApi.getAnalyticsEvents({ limit });
}

export { getShopAndHost };
