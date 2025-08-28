// refina-backend/routes/billing.js - GOLDEN PATH subscription plans (full-domain keys)
"use strict";

import express from "express";
import shopify from "../shopify.js";
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

const router = express.Router();

/* --------------------------- Utilities --------------------------- */

function absoluteAppUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function normalizePlan(data) {
  if (!data) return null;
  const level = String(data.level || "").toLowerCase(); // "free" | "pro" | "premium" | (legacy) "pro+"
  const status = data.status || "NONE";
  return { level, status };
}

/**
 * Resolve canonical shop from guard/query; no short IDs; throws 401 on failure.
 */
async function resolveShopContext(req, _res) {
  // 1) Use guard-resolved shop from server.js (preferred)
  let shop = (typeof req.shop === "string" && req.shop) ? req.shop.toLowerCase() : null;

  // 2) Fallbacks: ?shop=<full>, or derive from ?host (base64)
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

/* ----------------------------- Routes ---------------------------- */

/**
 * GET /api/billing/plan
 * Returns { plan: { level, status } }
 */
router.get("/plan", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);

    // Single source of truth: plans/<shop>.myshopify.com
    const plans = dbAdmin.collection("plans");
    const longSnap = await plans.doc(shop).get();
    let raw = longSnap.exists ? longSnap.data() : null;

    // Legacy migration: if "pro+" -> "premium"
    let plan = raw ? normalizePlan(raw) : { level: "free", status: "NONE" };
    if (plan && typeof plan.level === "string" && plan.level.toLowerCase() === "pro+") {
      plan = { ...plan, level: "premium" };
    }

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
 * POST /api/billing/subscribe
 * Body: { plan: "pro" | "premium" }  (also accepts legacy: "pro+", "pro plus", "pro_plus")
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

    const target =
      /\bpremium\b/.test(normalized)
        ? "premium"
        : /\bpro\s*\+|\bpro\s*plus\b|^proplus$/.test(normalized)
        ? "premium" // legacy names map to premium
        : /^pro\b/.test(normalized)
        ? "pro"
        : "";

    if (!["pro", "premium"].includes(target)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const client = new shopify.clients.Graphql({ session: offlineSession });

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
    const currentResp = await client.request(currentQ);
    const subs = currentResp?.data?.currentAppInstallation?.activeSubscriptions || [];

    let currentLevel = "free";
    let currentSubId = null;
    for (const s of subs) {
      const n = String(s?.name || "").toLowerCase();
      if (n.includes("premium") || n.includes("pro+") || n.includes("pro plus")) {
        currentLevel = "premium";
        currentSubId = s?.id || currentSubId;
        break;
      }
      if (n.includes("pro")) {
        if (currentLevel !== "premium") {
          currentLevel = "pro";
          currentSubId = s?.id || currentSubId;
        }
      }
    }

    // Block clicks on the already-active plan
    if (currentLevel === target) {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    // 2) Get shop currency
    const shopQ = `query { shop { currencyCode } }`;
    const shopResp = await client.request(shopQ);
    let currencyCode = (shopResp?.data?.shop?.currencyCode || "USD").toString().toUpperCase();

    // 3) Plan catalog
    const PLAN = target === "premium"
      ? { name: "Premium", amount: "29.00" }
      : { name: "Pro",      amount: "9.00" };

    // 4) Return URL
    const rawHost = process.env.HOST || absoluteAppUrl(req);
    let host = String(rawHost).replace(/\/$/, "");
    if (host.startsWith("http://")) host = host.replace(/^http:\/\//, "https://");
    const returnUrl = `${host}/admin-ui/`;

    // 5) Create subscription
    const amt = PLAN.amount;
    const cc = currencyCode.replace(/[^A-Z]/g, "");
    const createMutation = `
      mutation AppSubscribe {
        appSubscriptionCreate(
          name: "${PLAN.name}"
          returnUrl: "${returnUrl}"
          test: ${process.env.NODE_ENV !== "production"}
          lineItems: [{
            plan: { appRecurringPricingDetails: { price: { amount: "${amt}", currencyCode: ${cc} }, interval: EVERY_30_DAYS } }
          }]
        ) {
          userErrors { field message }
          confirmationUrl
          appSubscription { id }
        }
      }
    `;

    const tryCreate = async () => {
      const resp = await client.request(createMutation);
      const payload = resp?.data?.appSubscriptionCreate;
      const errors = payload?.userErrors || [];
      const confirmationUrl = payload?.confirmationUrl || null;
      return { errors, confirmationUrl };
    };

    let { errors, confirmationUrl } = await tryCreate();
    if (!errors.length && confirmationUrl) {
      return res.json({ confirmationUrl });
    }

    // Handle "already-active" block
    const msg = (errors || []).map(e => e?.message || "").join("; ");
    const looksLikeActiveBlock = /already.*active|existing.*active|active recurring/i.test(msg);

    if (looksLikeActiveBlock) {
      const currentQ2 = `
        query AppInstall {
          currentAppInstallation {
            activeSubscriptions { id name status }
          }
        }
      `;
      const currentResp2 = await client.request(currentQ2);
      const subs2 = currentResp2?.data?.currentAppInstallation?.activeSubscriptions || [];
      const match = subs2.find(s => (String(s?.name || "").toLowerCase().includes("premium") && target === "premium")
                                 || (String(s?.name || "").toLowerCase().includes("pro") && target === "pro"));
      const currentSubId = match?.id || null;

      if (!currentSubId) {
        return res.status(409).json({ error: "ALREADY_HAS_ACTIVE", message: "Existing active subscription" });
      }

      const cancelMutation = `
        mutation CancelSub($id: ID!) {
          appSubscriptionCancel(id: $id) {
            userErrors { field message }
            appSubscription { id }
          }
        }
      `;
      const cancelResp = await client.request(cancelMutation, { id: currentSubId });
      const cancelErrors = cancelResp?.data?.appSubscriptionCancel?.userErrors || [];

      if (cancelErrors.length) {
        return res.status(409).json({
          error: "ALREADY_HAS_ACTIVE",
          message: cancelErrors.map(e => e?.message || "Cancel failed").join("; "),
        });
      }

      const retry = await tryCreate();
      if (!retry.errors.length && retry.confirmationUrl) {
        return res.json({ confirmationUrl: retry.confirmationUrl });
      }

      return res.status(400).json({
        error: "CREATE_AFTER_CANCEL_FAILED",
        errors: retry.errors,
      });
    }

    if (errors.length) {
      return res.status(400).json({ error: "Subscription creation failed", errors });
    }

    return res.status(500).json({ error: "No confirmationUrl returned" });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("POST /api/billing/subscribe error", err);
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

    const client = new shopify.clients.Graphql({ session: offlineSession });
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
    const result = await client.request(query);
    const subs = result?.data?.currentAppInstallation?.activeSubscriptions || [];

    let level = "free";
    let status = "NONE";
    for (const s of subs) {
      const n = String(s?.name || "").toLowerCase();
      const st = s?.status || "UNKNOWN";
      if (/\bpremium\b/.test(n) || /\bpro\s*\+|\bpro\W*plus\b/.test(n)) { level = "premium"; status = st; break; }
      if (/\bpro\b/.test(n)) { if (level !== "premium") { level = "pro"; status = st; } }
    }

    // Write only to full-domain doc
    const payload = { level, status, updatedAt: FieldValue.serverTimestamp() };
    await dbAdmin.collection("plans").doc(shop).set(payload, { merge: true });

    return res.json({ ok: true, level, status });
  } catch (err) {
    if (err?.status === 401) {
      res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`);
      return res.send("reauthorize");
    }
    console.error("POST /api/billing/sync error", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

export default router;
