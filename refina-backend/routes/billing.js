// refina-backend/routes/billing.js - GOLDEN PATH subscription plans working
"use strict";

import express from "express";
import shopify from "../shopify.js";
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

const router = express.Router();

/* --------------------------- Utilities --------------------------- */

function absoluteAppUrl(req) {
  // Works in dev (ngrok) and prod behind proxies
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
 * Resolve shop/storeId with your existing guard + query fallbacks.
 * No session loading here (Firestore-only for /plan).
 * Throws 401 if shop cannot be determined.
 */
async function resolveShopContext(req, res) {
  // 1) Use guard-resolved shop from server.js
  let shop = (typeof req.shop === "string" && req.shop) ? req.shop : null;

  // 2) Fallbacks: ?shop / ?host (admin.shopify.com/store/<store> or <store>.myshopify.com/admin)
  const q = req.query || {};
  if (!shop && typeof q.shop === "string" && q.shop.endsWith(".myshopify.com")) {
    shop = q.shop;
  }
  if (!shop && typeof q.host === "string") {
    try {
      const decoded = Buffer.from(q.host, "base64").toString("utf8");
      const m1 = decoded.match(/^admin\.shopify\.com\/store\/([^/]+)/i);
      const m2 = decoded.match(/^([^/]+)\.myshopify\.com\/admin/i);
      if (m1?.[1]) shop = `${m1[1]}.myshopify.com`;
      if (!shop && m2?.[1]) shop = `${m2[1]}.myshopify.com`;
    } catch { /* no-op */ }
  }

  // 3) Cookie fallback (mirrors server.js guard)
  if (!shop && req.cookies?.storeId) {
    shop = `${req.cookies.storeId}.myshopify.com`;
  }

  if (!shop) {
    const err = new Error("Missing shop context");
    err.status = 401;
    throw err;
  }

  const storeId = shop.replace(".myshopify.com", "");
  return { shop, storeId };
}

/* ----------------------------- Routes ---------------------------- */

/**
 * GET /api/billing/plan
 * Returns { plan: { level, status } }
 */
router.get("/plan", async (req, res) => {
  try {
    const { storeId } = await resolveShopContext(req, res);
    let plan = null;
    const snap = await dbAdmin.collection("plans").doc(storeId).get();
    plan = snap.exists ? normalizePlan(snap.data()) : { level: "free", status: "NONE" };
    // Legacy migration: treat stored "pro+" as "premium"
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
 * Returns:
 *  - 200 { confirmationUrl } on success
 *  - 409 { error: "ALREADY_ACTIVE", level } if same plan clicked
 *  - 409 { error: "ALREADY_HAS_ACTIVE", message } if Shopify blocks due to active charge and cancel failed/not allowed
 *  - 400 { error, errors? } for other userErrors
 */
router.post("/subscribe", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);

    // Load OFFLINE session
    const offlineId = shopify.session.getOfflineId(shop);
    const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
    let offlineSession = storage?.loadSession ? await storage.loadSession(offlineId) : null;

    // Dev fallback: allow admin token if present
    if (!offlineSession?.accessToken && process.env.SHOPIFY_ADMIN_API_TOKEN && shopify.session?.customAppSession) {
      offlineSession = shopify.session.customAppSession(shop);
    }
    if (!offlineSession?.accessToken) {
      return res
        .status(401)
        .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
        .set("X-Shopify-API-Request-Failure-Reauthorize-Url", `/api/auth`)
        .send("reauthorize");
    }

    // Accept body OR query; normalize legacy strings to canonical keys
    const raw = String((req.body?.plan ?? req.query?.plan ?? "")).toLowerCase().trim();
// Normalize legacy spellings: pro%2B -> pro+, pro_plus/pro-plus -> pro plus
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

    // Block clicks on the already-active plan (lets UI gray-out safely)
    if (currentLevel === target) {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    // 2) Get shop currency (keeps pricing correct per shop)
    const shopQ = `query { shop { currencyCode } }`;
    const shopResp = await client.request(shopQ);
    let currencyCode = (shopResp?.data?.shop?.currencyCode || "USD").toString().toUpperCase();

    // 3) Plan catalog (prices from your listing)
    const PLAN = target === "premium"
      ? { name: "Premium", amount: "29.00" }
      : { name: "Pro",      amount: "19.00" };

    // --- Build a clean HTTPS returnUrl on your app host, no fragments for GraphQL parsing ---
    const rawHost = process.env.HOST || absoluteAppUrl(req); // e.g. https://refina.ngrok.app
    let host = String(rawHost).replace(/\/$/, "");
    if (host.startsWith("http://")) host = host.replace(/^http:\/\//, "https://");
    // Use a simple path; your UI can read query params if needed
    const returnUrl = `${host}/admin-ui/`;

    // 4) Create helper to call appSubscriptionCreate
    const amt = PLAN.amount; // Decimal scalar as string
    const cc = currencyCode.replace(/[^A-Z]/g, ""); // sanitize to enum token

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

    // First attempt: try to create directly
    let { errors, confirmationUrl } = await tryCreate();
    if (!errors.length && confirmationUrl) {
      return res.json({ confirmationUrl });
    }

    // If Shopify blocks due to already-active sub, optionally cancel and retry ONCE
    const msg = (errors || []).map(e => e?.message || "").join("; ");
    const looksLikeActiveBlock = /already.*active|existing.*active|active recurring/i.test(msg);

    if (looksLikeActiveBlock && currentSubId) {
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
 * Upserts plans/{storeId}
 */
router.post("/sync", async (req, res) => {
  try {
    const { shop, storeId } = await resolveShopContext(req, res);

    const offlineId = shopify.session.getOfflineId(shop);
    const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
    let offlineSession = storage?.loadSession ? await storage.loadSession(offlineId) : null;

    if (!offlineSession?.accessToken && process.env.SHOPIFY_ADMIN_API_TOKEN && shopify.session?.customAppSession) {
      offlineSession = shopify.session.customAppSession(shop);
    }
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

    await dbAdmin.collection("plans").doc(storeId).set(
      { level, status, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

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
