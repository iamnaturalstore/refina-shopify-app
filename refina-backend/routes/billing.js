// refina-backend/routes/billing.js — GOLDEN PATH++ (legacy + new endpoints)
// Full-domain shop keys only; preserves Firestore plan docs; adds fresh-sync plan and upgrade/downgrade
"use strict";

import express from "express";
import shopify from "../shopify.js";
import { dbAdmin, FieldValue } from "../lib/firestore.js";

const router = express.Router();

/* --------------------------- Utilities --------------------------- */

function absoluteAppUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function normalizePlan(data) {
  if (!data) return null;
  let level = String(data.level || "").toLowerCase();
  const status = data.status || "NONE";
  if (level === "pro" || level === "pro+") level = "premium";
  return { level, status };
}

/** Resolve canonical shop from guard/query; throws 401 on failure. */
async function resolveShopContext(req, _res) {
  let shop =
    typeof req.shop === "string" && req.shop ? req.shop.toLowerCase() : null;

  const q = req.query || {};
  if (!shop && typeof q.shop === "string" && q.shop.toLowerCase().endsWith(".myshopify.com")) {
    shop = q.shop.toLowerCase();
  }
  if (!shop && typeof q.host === "string") {
    try {
      const decoded = Buffer.from(q.host, "base64").toString("utf8");
      const m1 = decoded.match(/^admin\.shopify\.com\/store\/([^/]+)/i);
      const m2 = decoded.match(/^([^/]+)\.myshopify\.com\/admin/i);
      if (m1?.[1]) shop = `${m1[1].toLowerCase()}.myshopify.com`;
      if (!shop && m2?.[1]) shop = `${m2[1].toLowerCase()}.myshopify.com`;
    } catch { /* no-op */ }
  }

  if (!shop) {
    const err = new Error("Missing shop context");
    err.status = 401;
    throw err;
  }
  return { shop };
}

/* ---------- Shopify GraphQL compatibility (works across SDK shapes) ---------- */

function getGraphqlClient(session) {
  const Graphql =
    shopify?.api?.clients?.Graphql || // newer shape
    shopify?.clients?.Graphql;        // older shape
  if (!Graphql) {
    throw new Error(
      "Shopify GraphQL client class not found (api.clients.Graphql / clients.Graphql)."
    );
  }
  return new Graphql({ session });
}

/**
 * gql(client, query, variables?) → data
 * Normalizes .query({data:{...}}) vs .request(query,{variables}) across SDK versions.
 */
async function gql(client, query, variables) {
  if (typeof client.query === "function") {
    const resp = await client.query({
      data: variables ? { query, variables } : { query },
    });
    return resp?.body?.data;
  }
  if (typeof client.request === "function") {
    const resp = await client.request(query, variables ? { variables } : undefined);
    return resp?.data ?? resp?.body?.data ?? resp;
  }
  throw new Error("Shopify GraphQL client missing .query/.request");
}

/* ------------------------ Shared helpers ------------------------ */

async function ensureOfflineSession(shop) {
  const offlineId = shopify.session.getOfflineId(shop);
  const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
  const offlineSession = storage?.loadSession
    ? await storage.loadSession(offlineId)
    : null;
  if (!offlineSession?.accessToken) {
    const err = new Error("reauthorize");
    err.status = 401;
    throw err;
  }
  return offlineSession;
}

async function readActiveSubscriptions(client) {
  const q = `
    query AppInstall {
      currentAppInstallation {
        activeSubscriptions { id name status test }
      }
    }
  `;
  const data = await gql(client, q);
  const subs = data?.currentAppInstallation?.activeSubscriptions || [];
  return subs;
}

function inferPlanFromSubs(subs) {
  let level = "free";
  let status = "NONE";
  let activeId = null;
  for (const s of subs) {
    const n = String(s?.name || "").toLowerCase();
    const st = String(s?.status || "UNKNOWN").toUpperCase();
    if (st !== "ACTIVE") continue;
    if (/\bpremium\b/.test(n) || /\bpro\s*\+|\bpro\W*plus\b|\bpro\b/.test(n)) {
      level = "premium";
      status = st;
      activeId = s?.id || activeId;
      break;
    }
  }
  return { level, status, activeId };
}

async function writePlan(shop, level, status) {
  await dbAdmin
    .collection("plans")
    .doc(shop)
    .set({ level, status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

async function fetchShopCurrency(client) {
  const q = `query { shop { currencyCode } }`;
  const data = await gql(client, q);
  return (data?.shop?.currencyCode || "USD").toString().toUpperCase();
}

async function createSubscription(client, { name, amount, currency, returnUrl, test = false }) {
  const mutation = `
    mutation AppSubscribe(
      $name: String!,
      $returnUrl: URL!,
      $test: Boolean,
      $amount: Decimal!,
      $currency: CurrencyCode!,
      $replacementBehavior: AppSubscriptionReplacementBehavior,
      $trialDays: Int!
    ) {
      appSubscriptionCreate(
        name: $name
        returnUrl: $returnUrl
        test: $test
        replacementBehavior: $replacementBehavior
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: $amount, currencyCode: $currency }
              interval: EVERY_30_DAYS
              trialDays: $trialDays
            }
          }
        }]
      ) {
        userErrors { field message }
        confirmationUrl
        appSubscription { id }
      }
    }
  `;
  const variables = {
    name,
    returnUrl,
    test,
    amount,
    currency,
    trialDays: 7,
    replacementBehavior: "APPLY_IMMEDIATELY",
  };
  const data = await gql(client, mutation, variables);
  const payload = data?.appSubscriptionCreate || {};
  const errs = payload?.userErrors || [];
  const confirmationUrl = payload?.confirmationUrl || null;
  return { confirmationUrl, userErrors: errs };
}

async function cancelSubscription(client, id, prorate = true) {
  const mutation = `
    mutation CancelSub($id: ID!, $prorate: Boolean!) {
      appSubscriptionCancel(id: $id, prorate: $prorate) {
        appSubscription { id status }
        userErrors { field message }
      }
    }
  `;
  const data = await gql(client, mutation, { id, prorate });
  const payload = data?.appSubscriptionCancel || {};
  const errs = payload?.userErrors || [];
  return { canceled: payload?.appSubscription || null, userErrors: errs };
}

/* ----------------------------- Routes ---------------------------- */

/** GET /api/billing/plan → { plan: {level, status} }
 *  Supports `fresh=1` to sync from Shopify → Firestore before returning.
 */
router.get("/plan", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const fresh = String(req.query.fresh || "0") === "1";

    if (fresh) {
      const offlineSession = await ensureOfflineSession(shop);
      const client = getGraphqlClient(offlineSession);
      const subs = await readActiveSubscriptions(client);
      const { level, status } = inferPlanFromSubs(subs);
      await writePlan(shop, level, status);
    }

    const snap = await dbAdmin.collection("plans").doc(shop).get();
    const raw = snap.exists ? snap.data() : null;
    const plan = raw ? normalizePlan(raw) : { level: "free", status: "NONE" };
    return res.json({ plan });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("GET /api/billing/plan error", err);
    return res.status(500).json({ error: "Plan lookup failed" });
  }
});

/** GET /api/billing/activated → reads activeSubscriptions, writes Firestore, redirects back to Admin UI */
router.get("/activated", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    const subs = await readActiveSubscriptions(client);
    const { level, status } = inferPlanFromSubs(subs);
    await writePlan(shop, level, status);

    const hostParam = String(req.query.host || "");
    const redirect = `/embedded?host=${encodeURIComponent(hostParam)}&shop=${encodeURIComponent(shop)}&billing=success`;
    return res.redirect(303, redirect);
  } catch (err) {
    console.error("GET /api/billing/activated error", err);
    const fallback = `/admin-ui/?billing=error`;
    return res.redirect(303, fallback);
  }
});

/** POST /api/billing/subscribe (legacy) → { confirmationUrl } */
router.post("/subscribe", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    // Normalize requested plan, map legacy pro/pro+ → premium
    const raw = String((req.body?.plan ?? req.query?.plan ?? "")).toLowerCase().trim();
    const normalized = raw
      .replace(/%2b/gi, "+")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const target =
      /\bpremium\b/.test(normalized) || /\bpro\s*\+|\bpro\s*plus\b|^proplus$/.test(normalized)
        ? "premium"
        : "";

    if (target !== "premium") {
      return res.status(410).json({ error: "This plan is no longer available." });
    }

    // Short-circuit if already active
    const existing = await readActiveSubscriptions(client);
    const { level: currentLevel, activeId: currentSubId } = inferPlanFromSubs(existing);
    if (currentLevel === "premium") {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    // Currency + returnUrl
    const currency = await fetchShopCurrency(client);
    const rawHost = process.env.HOST || absoluteAppUrl(req);
    let hostBase = String(rawHost).replace(/\/$/, "");
    if (hostBase.startsWith("http://")) hostBase = hostBase.replace(/^http:\/\//, "https://");
    const hostParam = String(req.query.host || "");
    const returnUrl = `${hostBase}/api/billing/activated?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(hostParam)}`;

    // Create sub (trialDays + test flag)
    const PLAN = { name: "Premium", amount: "49.00" };
    const { confirmationUrl, userErrors } = await createSubscription(client, {
      name: PLAN.name,
      amount: PLAN.amount,
      currency,
      returnUrl,
      test: process.env.NODE_ENV !== "production",
    });

    if (confirmationUrl) return res.json({ confirmationUrl });

    // If Shopify complains about an existing active sub without id, try to cancel and retry
    const looksLikeActiveBlock = (userErrors || [])
      .map((e) => e?.message || "")
      .join("; ")
      .match(/already.*active|existing.*active|active recurring/i);

    if (looksLikeActiveBlock && currentSubId) {
      const cancelled = await cancelSubscription(client, currentSubId, true);
      if (!cancelled.userErrors?.length) {
        const retry = await createSubscription(client, {
          name: PLAN.name,
          amount: PLAN.amount,
          currency,
          returnUrl,
          test: process.env.NODE_ENV !== "production",
        });
        if (retry.confirmationUrl) return res.json({ confirmationUrl: retry.confirmationUrl });
      }
    }

    return res.status(400).json({ error: "Subscription creation failed", userErrors });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("Access-Control-Allow-Origin", "*")
        .set("Access-Control-Allow-Headers", "*")
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("POST /api/billing/subscribe unhandled error", {
      shop: req.query?.shop,
      error: err,
    });
    return res.status(500).json({ error: "Subscribe failed" });
  }
});

/** POST /api/billing/sync → upserts plans/{shop} from activeSubscriptions */
router.post("/sync", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    const subs = await readActiveSubscriptions(client);
    const { level, status } = inferPlanFromSubs(subs);
    await writePlan(shop, level, status);

    return res.json({ ok: true, level, status });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("Access-Control-Allow-Origin", "*")
        .set("Access-Control-Allow-Headers", "*")
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("POST /api/billing/sync error", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

/* ----------------------------- New endpoints (reviewer-friendly) ---------------------------- */

/** GET /api/billing/status → { activeSubscriptions: [...] } */
router.get("/status", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);
    const subs = await readActiveSubscriptions(client);
    return res.json({ shop, activeSubscriptions: subs });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("GET /api/billing/status error", err);
    return res.status(500).json({ error: "Status failed" });
  }
});

/** POST /api/billing/upgrade → { confirmationUrl } */
router.post("/upgrade", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    // If already premium, short-circuit
    const subs = await readActiveSubscriptions(client);
    const { level: currentLevel, activeId: currentSubId } = inferPlanFromSubs(subs);
    if (currentLevel === "premium") {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    const currency = await fetchShopCurrency(client);

    // Prefer explicit returnUrl from client (used by your Admin UI to add ?billing=success)
    const explicitReturn = String(req.body?.returnUrl || "");
    let returnUrl = explicitReturn;
    if (!returnUrl) {
      const rawHost = process.env.HOST || absoluteAppUrl(req);
      let hostBase = String(rawHost).replace(/\/$/, "");
      if (hostBase.startsWith("http://")) hostBase = hostBase.replace(/^http:\/\//, "https://");
      const hostParam = String(req.query.host || "");
      returnUrl = `${hostBase}/api/billing/activated?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(hostParam)}`;
    }

    const PLAN = { name: "Premium", amount: "49.00" };
    const test = process.env.NODE_ENV !== "production";

    const { confirmationUrl, userErrors } = await createSubscription(client, {
      name: PLAN.name,
      amount: PLAN.amount,
      currency,
      returnUrl,
      test,
    });

    if (confirmationUrl) return res.json({ confirmationUrl });

    // Attempt cancel & retry if Shopify blocks due to existing active sub
    const looksLikeActiveBlock = (userErrors || [])
      .map((e) => e?.message || "")
      .join("; ")
      .match(/already.*active|existing.*active|active recurring/i);

    if (looksLikeActiveBlock && currentSubId) {
      const cancelled = await cancelSubscription(client, currentSubId, true);
      if (!cancelled.userErrors?.length) {
        const retry = await createSubscription(client, {
          name: PLAN.name,
          amount: PLAN.amount,
          currency,
          returnUrl,
          test,
        });
        if (retry.confirmationUrl) return res.json({ confirmationUrl: retry.confirmationUrl });
      }
    }

    return res.status(400).json({ error: "Upgrade failed", userErrors });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("POST /api/billing/upgrade error", err);
    return res.status(500).json({ error: "Upgrade failed" });
  }
});

/** POST /api/billing/downgrade → cancels active subscription; sets plan Free */
router.post("/downgrade", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    // Find active sub
    const subs = await readActiveSubscriptions(client);
    const { activeId } = inferPlanFromSubs(subs);
    if (!activeId) {
      // Already free
      await writePlan(shop, "free", "NONE");
      return res.json({ ok: true, message: "No active subscription" });
    }

    const { canceled, userErrors } = await cancelSubscription(client, activeId, true);
    if (userErrors?.length) {
      return res.status(400).json({
        error: "CANCEL_FAILED",
        message: userErrors.map((u) => u?.message || "Cancel failed").join("; "),
      });
    }

    await writePlan(shop, "free", "NONE");
    return res.json({ ok: true, canceled });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("POST /api/billing/downgrade error", err);
    return res.status(500).json({ error: "Downgrade failed" });
  }
});

export default router;
