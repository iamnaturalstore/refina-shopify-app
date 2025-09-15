// refina-backend/routes/billing.js — GOLDEN PATH++ (legacy + new endpoints)
// Full-domain shop keys only; preserves Firestore plan docs; adds fresh-sync plan and upgrade/downgrade
"use strict";

import express from "express";
import shopify from "../shopify.js";
import { dbAdmin, FieldValue } from "../lib/firestore.js";

const router = express.Router();

/* --------------------------- Helpers: reauth --------------------------- */

function computeHostFromShop(shop) {
  const s = String(shop || "").trim().toLowerCase();
  return s && s.endsWith(".myshopify.com")
    ? Buffer.from(`${s}/admin`).toString("base64")
    : "";
}

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

function sendReauth(res, req, opts = {}) {
  const shopParam = (opts.shop || String(req.query?.shop || "")).toLowerCase();
  let hostParam = String(opts.host || req.query?.host || "");
  if (!hostParam && shopParam) hostParam = computeHostFromShop(shopParam);

  const rawBase = process.env.HOST || `${req.protocol}://${req.get("host")}`;
  let base = String(rawBase).replace(/\/+$/, "");
  if (base.startsWith("http://")) base = base.replace(/^http:\/\//, "https://");

  const authUrl = new URL("/api/auth", base);
  if (shopParam) authUrl.searchParams.set("shop", shopParam);
  if (hostParam) authUrl.searchParams.set("host", hostParam);
  if (opts.return_to) authUrl.searchParams.set("return_to", opts.return_to);

  return res
    .status(401)
    // CORS + header exposure so the client can read reauth headers
    .set("Access-Control-Allow-Origin", "*")
    .set("Access-Control-Allow-Headers", "*")
    .set(
      "Access-Control-Expose-Headers",
      "X-Shopify-API-Request-Failure-Reauthorize, X-Shopify-API-Request-Failure-Reauthorize-Url"
    )
    // Shopify App Bridge reauth handshake
    .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
    .set("X-Shopify-API-Request-Failure-Reauthorize-Url", authUrl.toString())
    .send("reauthorize");
}

/* --------------------------- Shop resolution --------------------------- */

/** Resolve canonical shop from guard/query; throws 401 on failure. */
async function resolveShopContext(req, res) {
  const sessShop = res?.locals?.shopify?.session?.shop;
  const q = req.query || {};
  const hdrShop = (req.get("X-Shopify-Shop-Domain") || req.get("x-shopify-shop-domain") || "")
    .toLowerCase()
    .trim();

  const toMyshop = (raw) => {
    const s = String(raw || "").toLowerCase().trim();
    if (!s) return "";
    if (s.endsWith(".myshopify.com")) return s;
    if (/^[a-z0-9][a-z0-9-]*$/.test(s)) return `${s}.myshopify.com`;
    return "";
  };

  let shop =
    toMyshop(sessShop) ||
    toMyshop(req.shop) ||
    toMyshop(q.shop) ||
    toMyshop(q.storeId);

  if (!shop && typeof q.host === "string") {
    try {
      const decoded = Buffer.from(q.host, "base64").toString("utf8");
      const m1 = decoded.match(/^admin\.shopify\.com\/store\/([^/]+)/i);
      const m2 = decoded.match(/^([^/]+)\.myshopify\.com\/admin/i);
      if (m1?.[1]) shop = toMyshop(m1[1]);
      if (!shop && m2?.[1]) shop = toMyshop(m2[1]);
    } catch { /* ignore */ }
  }

  if (!shop && hdrShop) shop = toMyshop(hdrShop);

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || "")) {
    const err = new Error("Missing shop context");
    err.status = 401;
    throw err;
  }
  return { shop };
}

/* ---------- Shopify GraphQL compatibility (works across SDK shapes) ---------- */

function getGraphqlClient(session) {
  const Graphql =
    shopify?.api?.clients?.Graphql ||
    shopify?.clients?.Graphql;
  if (!Graphql) {
    throw new Error(
      "Shopify GraphQL client class not found (api.clients.Graphql / clients.Graphql)."
    );
  }
  return new Graphql({ session });
}

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
  // Support both modern and legacy SDK shapes
  const storage =
    (shopify?.config && shopify.config.sessionStorage) ||
    shopify?.sessionStorage ||
    null;

  if (!storage?.loadSession) {
    const err = new Error("reauthorize");
    err.status = 401;
    throw err;
  }

  // Try multiple candidate IDs for the offline session across SDK versions
  const candidates = [];
  try {
    if (shopify?.session?.getOfflineId) {
      candidates.push(shopify.session.getOfflineId(shop));
    }
  } catch {}
  try {
    if (shopify?.api?.session?.getOfflineId) {
      candidates.push(shopify.api.session.getOfflineId(shop));
    }
  } catch {}
  // Canonical fallback
  candidates.push(`offline_${shop}`);

  const seen = new Set();
  for (const id of candidates) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const sess = await storage.loadSession(id);
      if (sess?.accessToken) return sess;
    } catch {}
  }

  const err = new Error("reauthorize");
  err.status = 401;
  throw err;
}

router.use((req, _res, next) => {
  if (process.env.DEBUG_AUTH === "1" && req.path.startsWith("/billing/")) {
    const hasAuth = !!req.headers.authorization;
    console.log(`[auth-debug] ${req.method} ${req.path} auth=${hasAuth ? "present" : "missing"} shop=${req.query.shop || ""}`);
  }
  next();
});

/**
 * Prefer OFFLINE session for gatekeeping (prevents spurious 401s), then try the
 * official middleware, then manual JWT decode. Only reauth if all fail.
 */
async function validateAdminSessionCompat(req, res, next) {
  try {
    // 0) If we can resolve the shop and have an OFFLINE session, let it through.
    // The actual Shopify calls will still use that offline token.
    let shopForGate = "";
    try {
      const { shop } = await resolveShopContext(req, res);
      shopForGate = shop;
      await ensureOfflineSession(shop); // throws if missing
      res.locals.shopify = res.locals.shopify || {};
      res.locals.shopify.session = res.locals.shopify.session || { shop };
      return next();
    } catch {
      // fall through to online/JWT validation
    }

    // 1) Best: official middleware (validates App Bridge JWT, handles skew)
    if (shopify?.authenticate?.admin) {
      try {
        const out = await shopify.authenticate.admin(req, res);
        if (out?.session?.shop) {
          res.locals.shopify = res.locals.shopify || {};
          res.locals.shopify.session = out.session;
          return next();
        }
      } catch {
        // continue
      }
    }

    // 2) Fallback: decode Authorization: Bearer <AB session token>
    const authz = req.get("Authorization") || req.headers.authorization || "";
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (m) {
      try {
        const token = m[1];
        const payload = await shopify.api.session.decodeSessionToken(token);
        const hostish = String(payload.dest || payload.iss || "");
        const shopFromDest = hostish.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
        if (/\.myshopify\.com$/i.test(shopFromDest)) {
          res.locals.shopify = res.locals.shopify || {};
          res.locals.shopify.session = { shop: shopFromDest };
          return next();
        }
      } catch {
        // continue
      }
    }

    // 3) Legacy cookie-based validator
    if (typeof shopify?.validateAuthenticatedSession === "function") {
      return shopify.validateAuthenticatedSession()(req, res, next);
    }

    // 4) No joy → reauth
    return sendReauth(res, req, {
      return_to: encodeURIComponent("/admin-ui/billing"),
      shop: shopForGate || String(req.query?.shop || ""),
    });
  } catch {
    return sendReauth(res, req, {
      return_to: encodeURIComponent("/admin-ui/billing"),
    });
  }
}

// Protect Admin-UI endpoints; **leave /plan open** (Shopify redirects to /activated without JWT)
router.use(
  ["/status", "/subscribe", "/upgrade", "/downgrade", "/sync"],
  validateAdminSessionCompat
);

/* ----------------------------- Admin client ---------------------------- */

/**
 * Try offline first; if missing, fall back to the ONLINE Admin session
 * attached by the guard. Only force reauth if neither exists.
 */
async function getAdminClientForShop(req, res, shop) {
  // 1) Preferred: offline
  try {
    const offline = await ensureOfflineSession(shop);
    return getGraphqlClient(offline);
  } catch {
    // continue to online fallback
  }
  // 2) Fallback: online session from guard (must include accessToken)
  const online = res?.locals?.shopify?.session;
  if (online?.shop?.toLowerCase?.() === shop && online?.accessToken) {
    return getGraphqlClient(online);
  }
  // 3) Neither available → reauth
  const err = new Error("reauthorize");
  err.status = 401;
  throw err;
}

/* ----------------------------- Shopify ops ----------------------------- */

async function readActiveSubscriptions(client) {
  const q = `
    query AppInstall {
      currentAppInstallation {
        activeSubscriptions { id name status test }
      }
    }
  `;
  const data = await gql(client, q);
  return data?.currentAppInstallation?.activeSubscriptions || [];
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
  return {
    confirmationUrl: payload?.confirmationUrl || null,
    userErrors: payload?.userErrors || [],
  };
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
  return { canceled: payload?.appSubscription || null, userErrors: payload?.userErrors || [] };
}

/* ----------------------------- Routes ---------------------------- */

/** GET /api/billing/plan → { plan: {level, status} }
 *  Supports `fresh=1` to sync from Shopify → Firestore before returning.
 *  NOTE: This route is NOT behind the global JWT guard; we only require auth when fresh=1.
 */
router.get("/plan", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const wantsFresh = String(req.query.fresh || "0") === "1";

    if (wantsFresh) {
      try {
        const offlineSession = await ensureOfflineSession(shop);
        const client = getGraphqlClient(offlineSession);
        const subs = await readActiveSubscriptions(client);
        const { level, status } = inferPlanFromSubs(subs);
        await writePlan(shop, level, status);
      } catch (err) {
        if (err?.status === 401) {
          return sendReauth(res, req, { shop });
        }
        throw err;
      }
    }

    const snap = await dbAdmin.collection("plans").doc(shop).get();
    const raw = snap.exists ? snap.data() : null;
    const plan = raw ? normalizePlan(raw) : { level: "free", status: "NONE" };
    return res.json({ plan });
  } catch (err) {
    if (err?.status === 401 || err?.response?.code === 401) {
      return sendReauth(res, req);
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

    const hostParam = String(req.query.host || "") || computeHostFromShop(shop);
    const redirect = `/admin-ui/?host=${encodeURIComponent(hostParam)}&shop=${encodeURIComponent(
      shop
    )}&billing=success`;

    return res.redirect(303, redirect);
  } catch (err) {
    console.error("GET /api/billing/activated error", err);
    const shopParam = String(req.query?.shop || "");
    const hostParam = String(req.query?.host || "") || computeHostFromShop(shopParam);
    const fallback = `/admin-ui/?host=${encodeURIComponent(hostParam)}&shop=${encodeURIComponent(
      shopParam
    )}&billing=error`;
    return res.redirect(303, fallback);
  }
});

/** POST /api/billing/subscribe (legacy) → { confirmationUrl } */
router.post("/subscribe", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    const raw = String((req.body?.plan ?? req.query?.plan ?? "")).toLowerCase().trim();
    const normalized = raw.replace(/%2b/gi, "+").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    const target =
      /\bpremium\b/.test(normalized) || /\bpro\s*\+|\bpro\s*plus\b|^proplus$/.test(normalized)
        ? "premium"
        : "";

    if (target !== "premium") {
      return res.status(410).json({ error: "This plan is no longer available." });
    }

    const existing = await readActiveSubscriptions(client);
    const { level: currentLevel, activeId: currentSubId } = inferPlanFromSubs(existing);
    if (currentLevel === "premium") {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    const currency = await fetchShopCurrency(client);
    let hostBase = (process.env.HOST || absoluteAppUrl(req)).replace(/\/$/, "");
    if (hostBase.startsWith("http://")) hostBase = hostBase.replace(/^http:\/\//, "https://");
    const hostParam = String(req.query.host || "") || computeHostFromShop(shop);
    const returnUrl = `${hostBase}/api/billing/activated?shop=${encodeURIComponent(
      shop
    )}&host=${encodeURIComponent(hostParam)}`;

    const PLAN = { name: "Premium", amount: "49.00" };
    const { confirmationUrl, userErrors } = await createSubscription(client, {
      name: PLAN.name,
      amount: PLAN.amount,
      currency,
      returnUrl,
      test: (["BILLING_TEST","BILLING_TEST_MODE","SHOPIFY_BILLING_TEST","SHOPIFY_BILLING_TEST_MODE"]
            .some(k => String(process.env[k] || "").toLowerCase() === "true")
            || process.env.NODE_ENV !== "production"),
    });

    if (confirmationUrl) return res.json({ confirmationUrl });

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
          test: (["BILLING_TEST","BILLING_TEST_MODE","SHOPIFY_BILLING_TEST","SHOPIFY_BILLING_TEST_MODE"]
              .some(k => String(process.env[k] || "").toLowerCase() === "true")
              || process.env.NODE_ENV !== "production"),
        });
        if (retry.confirmationUrl) return res.json({ confirmationUrl: retry.confirmationUrl });
      }
    }

    return res.status(400).json({ error: "Subscription creation failed", userErrors });
  } catch (err) {
    if (err?.status === 401) {
      return sendReauth(res, req, {
        return_to: encodeURIComponent("/admin-ui/billing"),
      });
    }
    console.error("POST /api/billing/subscribe unhandled error", {
      shop: req.query?.shop,
      error: err,
    });
    return res.status(500).json({ error: "Subscribe failed" });
  }
});

if ((userErrors || []).length) console.error("[Billing] userErrors", userErrors);

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
    if (err?.status === 401) return sendReauth(res, req);
    console.error("POST /api/billing/sync error", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

/** GET /api/billing/status → { activeSubscriptions: [...] } */
router.get("/status", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);
    const subs = await readActiveSubscriptions(client);
    return res.json({ shop, activeSubscriptions: subs });
  } catch (err) {
    if (err?.status === 401) return sendReauth(res, req);
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

    const subs = await readActiveSubscriptions(client);
    const { level: currentLevel, activeId: currentSubId } = inferPlanFromSubs(subs);
    if (currentLevel === "premium") {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    const currency = await fetchShopCurrency(client);

    const explicitReturn = String(req.body?.returnUrl || "");
    let returnUrl = explicitReturn;
    if (!returnUrl) {
      let hostBase = (process.env.HOST || absoluteAppUrl(req)).replace(/\/$/, "");
      if (hostBase.startsWith("http://")) hostBase = hostBase.replace(/^http:\/\//, "https://");
      const hostParam = String(req.query.host || "") || computeHostFromShop(shop);
      returnUrl = `${hostBase}/api/billing/activated?shop=${encodeURIComponent(
        shop
      )}&host=${encodeURIComponent(hostParam)}`;
    }

    const PLAN = { name: "Premium", amount: "49.00" };
    const test =
      ["BILLING_TEST", "BILLING_TEST_MODE", "SHOPIFY_BILLING_TEST", "SHOPIFY_BILLING_TEST_MODE"]
        .some((k) => String(process.env[k] || "").toLowerCase() === "true") ||
      process.env.NODE_ENV !== "production";


    const { confirmationUrl, userErrors } = await createSubscription(client, {
      name: PLAN.name,
      amount: PLAN.amount,
      currency,
      returnUrl,
      test,
    });

    if (confirmationUrl) return res.json({ confirmationUrl });

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
    if (err?.status === 401) return sendReauth(res, req);
    console.error("POST /api/billing/upgrade error", err);
    return res.status(500).json({ error: "Upgrade failed" });
  }
});

/** POST /api/billing/downgrade → cancels active subscription(s); sets plan Free */
router.post("/downgrade", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);

    // Try OFFLINE first, then ONLINE (from guard). Reauth only if neither exists.
    const client = await getAdminClientForShop(req, res, shop);

    const subs = await readActiveSubscriptions(client);
    const activeIds = (subs || [])
      .filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE")
      .map((s) => s?.id)
      .filter(Boolean);

    // Idempotent: if nothing to cancel, just mark Free + return
    if (activeIds.length === 0) {
      await writePlan(shop, "free", "NONE");
      return res.json({ ok: true, message: "No active subscription" });
    }

    // Cancel all active subscriptions (sequential = safer for Shopify)
    const canceled = [];
    for (const id of activeIds) {
      const { canceled: c, userErrors } = await cancelSubscription(client, id, true);
      if (userErrors?.length) {
        // Surface first error (usually enough context for UI)
        return res.status(400).json({
          error: "CANCEL_FAILED",
          message: userErrors.map((u) => u?.message || "Cancel failed").join("; "),
          id,
        });
      }
      if (c) canceled.push(c);
    }

    // Persist plan state last
    await writePlan(shop, "free", "NONE");
    return res.json({ ok: true, canceled });
  } catch (err) {
    if (err?.status === 401) {
      // Ask the client to reauth and come back to Billing
      return sendReauth(res, req, {
        shop: String(req.query?.shop || ""),
        return_to: encodeURIComponent("/admin-ui/billing"),
      });
    }
    console.error("POST /api/billing/downgrade error", err);
    return res.status(500).json({ error: "Downgrade failed" });
  }
});

export default router;
