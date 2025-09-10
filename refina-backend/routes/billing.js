// refina-backend/routes/billing.js - GOLDEN PATH subscription plans (full-domain keys)
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
  let level = String(data.level || "").toLowerCase(); // "free" | "premium" | (legacy) "pro", "pro+"
  const status = data.status || "NONE";
  // Map any legacy "pro" or "pro+" to "premium"
  if (level === "pro" || level === "pro+") level = "premium";
  return { level, status };
}

/** Resolve canonical shop from guard/query; throws 401 on failure. */
async function resolveShopContext(req, _res) {
  let shop = (typeof req.shop === "string" && req.shop) ? req.shop.toLowerCase() : null;

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
    throw new Error("Shopify GraphQL client class not found (api.clients.Graphql / clients.Graphql).");
  }
  return new Graphql({ session });
}

/**
 * gql(client, query, variables?) → data
 * Normalizes .query({data:{...}}) vs .request(query,{variables}) across SDK versions.
 */
async function gql(client, query, variables) {
  if (typeof client.query === "function") {
    const resp = await client.query({ data: variables ? { query, variables } : { query } });
    return resp?.body?.data;
  }
  if (typeof client.request === "function") {
    // older clients
    const resp = await client.request(query, variables ? { variables } : undefined);
    return resp?.data ?? resp?.body?.data ?? resp;
  }
  throw new Error("Shopify GraphQL client missing .query/.request");
}

/* ----------------------------- Routes ---------------------------- */

/**
 * GET /api/billing/plan
 * Returns { plan: { level, status } }
 */
router.get("/plan", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);

    const plans = dbAdmin.collection("plans");
    const longSnap = await plans.doc(shop).get();
    let raw = longSnap.exists ? longSnap.data() : null;

    // Legacy migration: map "pro" / "pro+" → "premium"
    let plan = raw ? normalizePlan(raw) : { level: "free", status: "NONE" };

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

/**
 * GET /api/billing/activated
 * After Shopify confirmation, read activeSubscriptions → write plans/{shop} → redirect to Admin UI.
 */
router.get("/activated", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);

    const offlineId = shopify.session.getOfflineId(shop);
    const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
    const offlineSession = storage?.loadSession ? await storage.loadSession(offlineId) : null;
    if (!offlineSession?.accessToken) {
      return res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`)
        .send("reauthorize");
    }

    const client = getGraphqlClient(offlineSession);
    const q = `
      query AppInstall {
        currentAppInstallation {
          activeSubscriptions { id name status }
        }
      }
    `;
    const data = await gql(client, q);
    const subs = data?.currentAppInstallation?.activeSubscriptions || [];

    // Treat any "premium" or legacy "pro/pro+" active sub as PREMIUM
    let level = "free";
    let status = "NONE";
    for (const s of subs) {
      const n = String(s?.name || "").toLowerCase();
      const st = s?.status || "UNKNOWN";
      if (st !== "ACTIVE") continue;
      if (/\bpremium\b/.test(n) || /\bpro\s*\+|\bpro\W*plus\b|\bpro\b/.test(n)) { level = "premium"; status = st; break; }
    }

    await dbAdmin.collection("plans").doc(shop).set(
      { level, status, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    const hostParam = String(req.query.host || "");
    const redirect = `/embedded?host=${encodeURIComponent(hostParam)}&shop=${encodeURIComponent(shop)}&billing=success`;
    return res.redirect(303, redirect);
  } catch (err) {
    console.error("GET /api/billing/activated error", err);
    const fallback = `/admin-ui/?billing=error`;
    return res.redirect(303, fallback);
  }
});

/**
 * POST /api/billing/subscribe
 * Body: { plan: "premium" }  (also accepts legacy: "pro+", "pro plus", "pro_plus" → mapped to "premium")
 * Response: { confirmationUrl }
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);

    // Load OFFLINE session
    const offlineId = shopify.session.getOfflineId(shop);
    const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
    let offlineSession = storage?.loadSession ? await storage.loadSession(offlineId) : null;

    if (!offlineSession?.accessToken) {
      return res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`)
        .send("reauthorize");
    }

    // Accept body OR query; normalize legacy strings to canonical keys
    const raw = String((req.body?.plan ?? req.query?.plan ?? "")).toLowerCase().trim();
    const normalized = raw
      .replace(/%2b/gi, "+")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Only "premium" is available. Legacy "pro+" maps to "premium". Plain "pro" is not available.
    const target =
      /\bpremium\b/.test(normalized) || /\bpro\s*\+|\bpro\s*plus\b|^proplus$/.test(normalized)
        ? "premium"
        : "";

    if (target !== "premium") {
      return res.status(410).json({ error: "This plan is no longer available." });
    }

    const client = getGraphqlClient(offlineSession);

    // 1) Determine current active level + current sub id (if any)
    const currentQ = `
      query AppInstall {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
          }
        }
      }
    `;
    const currentData = await gql(client, currentQ);
    const subs = currentData?.currentAppInstallation?.activeSubscriptions || [];

    let currentLevel = "free";
    let currentSubId = null;
    for (const s of subs) {
      const n = String(s?.name || "").toLowerCase();
      if (s.status !== "ACTIVE") continue; // Only consider active subscriptions
      if (/\bpremium\b/.test(n) || /\bpro\s*\+|\bpro\s*plus\b|\bpro\b/.test(n)) {
        currentLevel = "premium";
        currentSubId = s?.id || currentSubId;
        break;
      }
    }

    // Block clicks on the already-active plan
    if (currentLevel === target) {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    // 2) Get shop currency
    const shopQ = `query { shop { currencyCode } }`;
    const shopData = await gql(client, shopQ);
    let currencyCode = (shopData?.shop?.currencyCode || "USD").toString().toUpperCase();

    // 3) Plan catalog (Premium only)
    const PLAN = { name: "Premium", amount: "49.00" };

    // 4) Return URL (activation handler updates Firestore, then redirects to Admin UI)
    const rawHost = process.env.HOST || absoluteAppUrl(req);
    let hostBase = String(rawHost).replace(/\/$/, "");
    if (hostBase.startsWith("http://")) hostBase = hostBase.replace(/^http:\/\//, "https://");
    const hostParam = String(req.query.host || "");
    const returnUrl = `${hostBase}/api/billing/activated?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(hostParam)}`;

    // 5) Create subscription with replacementBehavior:
    //    Upgrades apply immediately (only premium is available now).
    const amt = PLAN.amount;
    const cc = currencyCode.replace(/[^A-Z]/g, "");
    const replacementBehavior = "APPLY_IMMEDIATELY";

    const createMutation = `
      mutation AppSubscribe(
        $name: String!
        $returnUrl: URL!
        $test: Boolean
        $lineItems: [AppSubscriptionLineItemInput!]!
        $replacementBehavior: AppSubscriptionReplacementBehavior
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          replacementBehavior: $replacementBehavior
          test: $test
          lineItems: $lineItems
        ) {
          userErrors { field message }
          confirmationUrl
          appSubscription { id }
        }
      }
    `;
    const createVars = {
      name: PLAN.name,
      returnUrl,
      test: process.env.NODE_ENV !== "production",
      lineItems: [{
        plan: { appRecurringPricingDetails: { price: { amount: amt, currencyCode: cc }, interval: "EVERY_30_DAYS" } }
      }],
      replacementBehavior
    };

    const createData = await gql(client, createMutation, createVars);
    const payload = createData?.appSubscriptionCreate;
    const errors = payload?.userErrors || [];
    const confirmationUrl = payload?.confirmationUrl || null;

    if (!errors.length && confirmationUrl) {
      return res.json({ confirmationUrl });
    }

    // Handle "already-active" block (fallback safety; usually unnecessary with replacementBehavior)
    const msg = (errors || []).map(e => e?.message || "").join("; ");
    const looksLikeActiveBlock = /already.*active|existing.*active|active recurring/i.test(msg);

    if (looksLikeActiveBlock) {
      if (!currentSubId) {
        console.error("[Billing] Shopify reports an active sub, but we couldn't find its ID.", { shop });
        return res.status(409).json({ error: "ALREADY_HAS_ACTIVE", message: "Existing active subscription could not be identified for cancellation." });
      }

      console.log(`[Billing] Active subscription found (${currentSubId}). Attempting to cancel before creating new one.`);

      const cancelMutation = `
        mutation CancelSub($id: ID!) {
          appSubscriptionCancel(id: $id) {
            userErrors { field message }
            appSubscription { id status }
          }
        }
      `;
      const cancelData = await gql(client, cancelMutation, { id: currentSubId });
      const cancelErrors = cancelData?.appSubscriptionCancel?.userErrors || [];

      if (cancelErrors.length) {
        console.error("[Billing] Failed to cancel existing subscription:", { shop, errors: cancelErrors });
        return res.status(409).json({
          error: "CANCEL_FAILED",
          message: cancelErrors.map(e => e?.message || "Cancel failed").join("; "),
        });
      }

      console.log(`[Billing] Successfully cancelled. Retrying subscription creation for ${target}...`);
      const retryData = await gql(client, createMutation, createVars);
      const retryPayload = retryData?.appSubscriptionCreate;
      if (!retryPayload?.userErrors?.length && retryPayload?.confirmationUrl) {
        return res.json({ confirmationUrl: retryPayload.confirmationUrl });
      }

      console.error("[Billing] Failed to create subscription AFTER successful cancel:", { shop, errors: retryPayload?.userErrors });
      return res.status(400).json({
        error: "CREATE_AFTER_CANCEL_FAILED",
        errors: retryPayload?.userErrors,
      });
    }

    if (errors.length) {
      console.error("[Billing] Subscription creation failed with errors:", { shop, errors });
      return res.status(400).json({ error: "Subscription creation failed", errors });
    }

    console.error("[Billing] Unknown error: No confirmationUrl returned.", { shop });
    return res.status(500).json({ error: "No confirmationUrl returned" });
  } catch (err) {
    if (err?.status === 401 || err.response?.code === 401) {
      res
        .status(401)
        .set("Access-Control-Allow-Origin", "*")
        .set("Access-Control-Allow-Headers", "*")
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("POST /api/billing/subscribe unhandled error", { shop: req.query?.shop, error: err });
    return res.status(500).json({ error: "Subscribe failed" });
  }
});

/**
 * POST /api/billing/sync
 * Upserts plans/{<shop>.myshopify.com}
 */
router.post("/sync", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);

    const offlineId = shopify.session.getOfflineId(shop);
    const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
    let offlineSession = storage?.loadSession ? await storage.loadSession(offlineId) : null;

    if (!offlineSession?.accessToken) {
      return res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`)
        .send("reauthorize");
    }

    const client = getGraphqlClient(offlineSession);
    const query = `
      query AppInstall {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
          }
        }
      }
    `;
    const data = await gql(client, query);
    const subs = data?.currentAppInstallation?.activeSubscriptions || [];

    // Treat any "premium" or legacy "pro/pro+" active sub as PREMIUM
    let level = "free";
    let status = "NONE";
    for (const s of subs) {
      const n = String(s?.name || "").toLowerCase();
      const st = s?.status || "UNKNOWN";
      if (st !== "ACTIVE") continue;
      if (/\bpremium\b/.test(n) || /\bpro\s*\+|\bpro\W*plus\b|\bpro\b/.test(n)) { level = "premium"; status = st; break; }
    }

    const payload = { level, status, updatedAt: FieldValue.serverTimestamp() };
    await dbAdmin.collection("plans").doc(shop).set(payload, { merge: true });

    return res.json({ ok: true, level, status });
  } catch (err) {
    if (err?.status === 401 || err.response?.code === 401) {
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

export default router;
