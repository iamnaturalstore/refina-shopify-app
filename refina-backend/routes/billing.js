// refina-backend/routes/billing.js — merged (pre-refactor + current), prod-only
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
  // Preserve exact level; do NOT remap 'pro' to 'premium'
  const level = String(data.level || "").toLowerCase();
  const status = String(data.status || "NONE").toUpperCase();
  const billingInterval = (data.billingInterval || data.interval || "").toLowerCase();
  return { level, status, billingInterval };
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
    .set("Access-Control-Allow-Origin", "*")
    .set("Access-Control-Allow-Headers", "*")
    .set(
      "Access-Control-Expose-Headers",
      "X-Shopify-API-Request-Failure-Reauthorize, X-Shopify-API-Request-Failure-Reauthorize-Url"
    )
    .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
    .set("X-Shopify-API-Request-Failure-Reauthorize-Url", authUrl.toString())
    .send("reauthorize");
}

/* --------------------------- Shop resolution --------------------------- */

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
    } catch {}
  }

  if (!shop && hdrShop) shop = toMyshop(hdrShop);

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || "")) {
    const err = new Error("Missing shop context");
    err.status = 401;
    throw err;
  }
  return { shop };
}

/* ---------- Shopify GraphQL compat ---------- */

function getGraphqlClient(session) {
  const Graphql =
    shopify?.api?.clients?.Graphql ||
    shopify?.clients?.Graphql;
  if (!Graphql) throw new Error("Shopify GraphQL client class not found");
  return new Graphql({ session });
}

async function gql(client, query, variables) {
  if (typeof client.request === "function") {
    const resp = await client.request(query, variables ? { variables } : undefined);
    return resp?.data ?? resp?.body?.data ?? resp;
  }
  if (typeof client.query === "function") {
    const resp = await client.query({ data: variables ? { query, variables } : { query } });
    return resp?.body?.data;
  }
  throw new Error("Shopify GraphQL client missing .query/.request");
}

/* ------------------------ Session helpers ------------------------ */

async function ensureOfflineSession(shop) {
  const storage =
    (shopify?.config && shopify.config.sessionStorage) ||
    shopify?.sessionStorage ||
    null;
  if (!storage?.loadSession) {
    const err = new Error("reauthorize");
    err.status = 401;
    throw err;
  }

  const candidates = [];
  try { if (shopify?.session?.getOfflineId) candidates.push(shopify.session.getOfflineId(shop)); } catch {}
  try { if (shopify?.api?.session?.getOfflineId) candidates.push(shopify.api.session.getOfflineId(shop)); } catch {}
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

async function getAdminClientForShop(_req, res, shop) {
  // offline-first
  try {
    const offline = await ensureOfflineSession(shop);
    return getGraphqlClient(offline);
  } catch {}
  // online fallback if middleware set it
  const online = res?.locals?.shopify?.session;
  if (online?.shop?.toLowerCase?.() === shop && online?.accessToken) {
    return getGraphqlClient(online);
  }
  const err = new Error("reauthorize");
  err.status = 401;
  throw err;
}

/* ------------------------- Auth gate (restored) ------------------------- */

router.use((req, _res, next) => {
  if (process.env.DEBUG_AUTH === "1" && req.baseUrl?.includes("/billing")) {
    const hasAuth = !!req.headers.authorization;
    console.log(
      `[auth-debug] ${req.method} ${req.originalUrl} auth=${hasAuth ? "present" : "missing"} shop=${req.query.shop || ""}`
    );
  }
  next();
});

/**
 * Prefer OFFLINE session for gatekeeping (prevents spurious 401s),
 * then try Admin middleware/JWT compat.
 */
async function validateAdminSessionCompat(req, res, next) {
  try {
    // 1) If we can resolve shop + have OFFLINE, allow through
    try {
      const { shop } = await resolveShopContext(req, res);
      await ensureOfflineSession(shop);
      res.locals.shopify = res.locals.shopify || {};
      res.locals.shopify.session = res.locals.shopify.session || { shop };
      return next();
    } catch {}

    // 2) Try modern admin auth helper if present
    if (shopify?.authenticate?.admin) {
      try {
        const out = await shopify.authenticate.admin(req, res);
        if (out?.session?.shop) {
          res.locals.shopify = res.locals.shopify || {};
          res.locals.shopify.session = out.session;
          return next();
        }
      } catch {}
    }

    // 3) Try JWT (App Bridge) token for shop context
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
      } catch {}
    }

    // 4) Last chance: legacy helper
    if (typeof shopify?.validateAuthenticatedSession === "function") {
      return shopify.validateAuthenticatedSession()(req, res, next);
    }

    return sendReauth(res, req, {
      return_to: encodeURIComponent("/admin-ui/billing"),
      shop: String(req.query?.shop || ""),
    });
  } catch {
    return sendReauth(res, req, { return_to: encodeURIComponent("/admin-ui/billing") });
  }
}

// Protect Admin-UI endpoints; **leave /plan open** (Shopify redirects to /activated without JWT)
router.use(
  ["/status", "/subscribe", "/upgrade", "/downgrade", "/sync"],
  validateAdminSessionCompat
);

/* ----------------------------- Shopify ops ----------------------------- */

// Minimal query (no billingPolicy — removed due to 2025-07 GraphQL change)
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
  const proName = String(process.env.SHOPIFY_BILLING_PRO_NAME || "Pro").toLowerCase();
  const premiumName = String(process.env.SHOPIFY_BILLING_PREMIUM_NAME || "Premium").toLowerCase();
  for (const s of subs || []) {
    const n = String(s?.name || "").toLowerCase();
    const st = String(s?.status || "UNKNOWN").toUpperCase();
    if (st !== "ACTIVE") continue;
    if (premiumName && n.includes(premiumName)) {
      level = "premium";
      status = st;
      activeId = s?.id || activeId;
      break;
    }
    if (proName && n.includes(proName)) {
      level = "pro";
      status = st;
      activeId = s?.id || activeId;
      break;
    }
  }
  return { level, status, activeId };
}

async function fetchShopCurrency(client) {
  const q = `query { shop { currencyCode } }`;
  const data = await gql(client, q);
  return (data?.shop?.currencyCode || "USD").toString().toUpperCase();
}

async function createSubscription(client, { name, amount, currency, returnUrl, test = false, interval = "EVERY_30_DAYS" }) {
  let mutation = `
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
        trialDays: $trialDays
        replacementBehavior: $replacementBehavior
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: $amount, currencyCode: $currency }
              interval: EVERY_30_DAYS
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
  if (String(interval).toUpperCase() === "ANNUAL") {
    mutation = mutation.replace("interval: EVERY_30_DAYS", "interval: ANNUAL");
  }

  const variables = {
    name,
    returnUrl,
    test: !!test,
    amount: typeof amount === "number" ? amount : Number(amount),
    currency,
    trialDays: Number(
    process.env.BILLING_TRIAL_DAYS ||
    (/[?&]shop=(?:refina-app-demo\.myshopify\.com|jqr0b0-je\.myshopify\.com)/i.test(String(returnUrl))
      ? (process.env.DEMO_TRIAL_DAYS || 365)
      : 7
    )
  ),
    replacementBehavior: process.env.BILLING_REPLACEMENT_BEHAVIOR || null,
  };

  if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
    console.log("[Billing] appSubscriptionCreate vars", {
      name: variables.name,
      amount: variables.amount,
      currency: variables.currency,
      returnUrl: variables.returnUrl,
      test: variables.test,
      trialDays: variables.trialDays,
      replacementBehavior: variables.replacementBehavior,
    });
  }

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

/* --------------------------- Plan writers --------------------------- */

// Server-authoritative plan write (used by /activated and manual actions)
async function writePlan(shop, level, status, billingInterval /* optional */) {
  await dbAdmin.collection("plans").doc(shop).set(
    {
      level,
      status,
      ...(billingInterval !== undefined ? { billingInterval } : {}),
      updatedAt: FieldValue.serverTimestamp(),
      _source: "billing:activated",
    },
    { merge: true }
  );
}

// Downgrade-only (used by /plan?fresh=1 and /sync)
async function writePlanDowngradeOnly(shop, inferredLevel, inferredStatus) {
  const ref = dbAdmin.collection("plans").doc(shop);
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : null;
  const curLevel = String(cur?.level || "free").toLowerCase();
  const curStatus = String(cur?.status || "NONE").toUpperCase();

  if (String(inferredLevel).toLowerCase() === "free" && String(inferredStatus).toUpperCase() === "NONE") {
    await ref.set(
      {
        level: "free",
        status: "NONE",
        billingInterval: "",
        updatedAt: FieldValue.serverTimestamp(),
        _source: "sync:downgrade",
      },
      { merge: true }
    );
    return { changed: curLevel !== "free" || curStatus !== "NONE" };
  }
  return { changed: false };
}

/* ----------------------------- Routes ---------------------------- */

/** GET /api/billing/plan
 * Supports fresh=1 to sync **downgrade only** from Shopify → Firestore.
 * This endpoint never upgrades the plan.
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
        await writePlanDowngradeOnly(shop, level, status);
      } catch (err) {
        if (err?.status === 401) return sendReauth(res, req, { shop });
        throw err;
      }
    }

    const snap = await dbAdmin.collection("plans").doc(shop).get();
    const raw = snap.exists ? snap.data() : null;
    const plan = raw ? normalizePlan(raw) : { level: "free", status: "NONE" };
    return res.json({ plan });
  } catch (err) {
    if (err?.status === 401 || err?.response?.code === 401) return sendReauth(res, req);
    console.error("GET /api/billing/plan error", err);
    return res.status(500).json({ error: "Plan lookup failed" });
  }
});

/** GET /api/billing/activated → set plan, then 303 back to embedded Admin UI */
router.get("/activated", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    const subs = await readActiveSubscriptions(client);
    const { level, status } = inferPlanFromSubs(subs);

    // interval comes from your returnUrl (&interval=monthly|annual)
    const rawInterval = String(req.query.interval || "").toLowerCase();
    const billingInterval = rawInterval === "annual" ? "annual" : rawInterval === "monthly" ? "monthly" : "";

    await writePlan(shop, level, status, billingInterval);

    const hostParam = String(req.query.host || "") || computeHostFromShop(shop);
    const storeSlug = String(shop).replace(/\.myshopify\.com$/i, "");
    const appHandle = process.env.SHOPIFY_APP_HANDLE || "refina";

    const adminEmbedUrl =
      `https://admin.shopify.com/store/${encodeURIComponent(storeSlug)}` +
      `/apps/${encodeURIComponent(appHandle)}` +
      `?host=${encodeURIComponent(hostParam)}` +
      `&shop=${encodeURIComponent(shop)}` +
      `&billing=success`;

    return res.redirect(303, adminEmbedUrl);
  } catch (err) {
    console.error("GET /api/billing/activated error", err);

    const shopParam = String(req.query?.shop || "");
    const hostParam = String(req.query?.host || "") || computeHostFromShop(shopParam);
    const storeSlug = String(shopParam).replace(/\.myshopify\.com$/i, "");
    const appHandle = process.env.SHOPIFY_APP_HANDLE || "refina";

    const adminEmbedUrlFallback =
      `https://admin.shopify.com/store/${encodeURIComponent(storeSlug)}` +
      `/apps/${encodeURIComponent(appHandle)}` +
      `?host=${encodeURIComponent(hostParam)}` +
      `&shop=${encodeURIComponent(shopParam)}` +
      `&billing=error`;

    return res.redirect(303, adminEmbedUrlFallback);
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
    if (err?.status === 401 || err?.response?.code === 401 || err?.response?.status === 401) {
      return sendReauth(res, req);
    }
    console.error("GET /api/billing/status error", err);
    return res.status(500).json({ error: "Status failed" });
  }
});

/** POST /api/billing/sync → reconcile plans/{shop} (DOWNGRADE-ONLY) */
router.post("/sync", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const client = await getAdminClientForShop(req, res, shop); // offline-first, online fallback
    const subs = await readActiveSubscriptions(client);
    const { level, status } = inferPlanFromSubs(subs);

    // 🔒 Never upgrade from /sync. Only /activated may upgrade.
    await writePlanDowngradeOnly(shop, level, status);

    return res.json({ ok: true, level, status });
  } catch (err) {
    if (err?.status === 401 || err?.response?.code === 401) return sendReauth(res, req);
    console.error("POST /api/billing/sync error", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

/** POST /api/billing/subscribe → { confirmationUrl } (supports pro|premium) */
router.post("/subscribe", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    const raw = String((req.body?.plan ?? req.query?.plan ?? "")).toLowerCase().trim();
    const normalized = raw.replace(/%2b/gi, "+").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    const target = normalized === "pro" ? "pro" : "premium";

    const existing = await readActiveSubscriptions(client);
    const { level: currentLevel, activeId: currentSubId } = inferPlanFromSubs(existing);
    if (currentLevel === target) {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    const currency = await fetchShopCurrency(client);

    const originCandidate = (process.env.APP_URL || process.env.HOST || absoluteAppUrl(req) || "")
      .trim()
      .replace(/\/$/, "");
    let origin = originCandidate;
    try { origin = new URL(originCandidate).origin; } catch { origin = originCandidate.replace(/^(https?:\/\/[^\/?#]+).*/, "$1"); }

    const returnUrl = `${origin}/api/billing/activated?shop=${encodeURIComponent(shop)}`;

    const PLAN = target === "pro"
      ? {
          name: process.env.SHOPIFY_BILLING_PRO_NAME || "Pro",
          amount: String(process.env.SHOPIFY_BILLING_PRO_PRICE || "19.00"),
        }
      : {
          name: process.env.SHOPIFY_BILLING_PREMIUM_NAME || "Premium",
          amount: String(process.env.SHOPIFY_BILLING_PREMIUM_PRICE || "49.00"),
        };

    const testFlag =
      ["BILLING_TEST", "BILLING_TEST_MODE", "SHOPIFY_BILLING_TEST", "SHOPIFY_BILLING_TEST_MODE"]
        .some((k) => String(process.env[k] || "").toLowerCase() === "true") ||
      process.env.NODE_ENV !== "production";

    let confirmationUrl = null;
    let userErrors = [];
    try {
      ({ confirmationUrl, userErrors = [] } = await createSubscription(client, {
        name: PLAN.name,
        amount: PLAN.amount,
        currency,
        returnUrl,
        test: testFlag,
      }));
    } catch (e) {
      console.error("POST /api/billing/subscribe createSubscription error", e?.response?.errors || e?.errors || e);
      return res.status(500).json({ error: "Subscribe failed" });
    }

    if (confirmationUrl) return res.json({ confirmationUrl });

    const looksLikeActiveBlock = (userErrors || [])
      .map((e) => e?.message || "")
      .join("; ")
      .match(/already.*active|existing.*active|active recurring/i);

    if (looksLikeActiveBlock && currentSubId) {
      try {
        const cancelled = await cancelSubscription(client, currentSubId, true);
        if (!cancelled.userErrors?.length) {
          const retry = await createSubscription(client, {
            name: PLAN.name,
            amount: PLAN.amount,
            currency,
            returnUrl,
            test: testFlag,
          });
          if (retry.confirmationUrl) return res.json({ confirmationUrl: retry.confirmationUrl });
        }
      } catch (e) {
        console.error("POST /api/billing/subscribe retry error", e?.response?.errors || e?.errors || e);
      }
    }

    return res.status(400).json({ error: "Subscription creation failed", userErrors });
  } catch (err) {
    if (err?.status === 401) {
      return sendReauth(res, req, { return_to: encodeURIComponent("/admin-ui/billing") });
    }
    console.error("POST /api/billing/subscribe unhandled error", { shop: req.query?.shop, error: err });
    return res.status(500).json({ error: "Subscribe failed" });
  }
});

/** POST /api/billing/upgrade → { confirmationUrl } */
const isUnauthorized = (e) =>
  e?.status === 401 || e?.response?.code === 401 || e?.response?.status === 401;

router.post("/upgrade", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const client = await getAdminClientForShop(req, res, shop);

    const subs = await readActiveSubscriptions(client);
    const { level: currentLevel, activeId: currentSubId } = inferPlanFromSubs(subs);
    if (currentLevel === "premium") {
      return res.status(409).json({ error: "ALREADY_ACTIVE", level: currentLevel });
    }

    const currency = await fetchShopCurrency(client);

    const originCandidate = (process.env.APP_URL || process.env.HOST || absoluteAppUrl(req) || "")
      .trim()
      .replace(/\/$/, "");
    let origin = originCandidate;
    try { origin = new URL(originCandidate).origin; } catch { origin = originCandidate.replace(/^(https?:\/\/[^\/?#]+).*/, "$1"); }

    const requestedInterval = String(req.body?.interval || "").toLowerCase();
    const requestedPlan = String(req.body?.plan || "").toLowerCase();
    const target = requestedPlan === "pro" ? "pro" : "premium";
    const intervalEnum = requestedInterval === "annual" ? "ANNUAL" : "EVERY_30_DAYS";
    const isAnnual = intervalEnum === "ANNUAL";
    const returnUrl =
      `${origin}/api/billing/activated?shop=${encodeURIComponent(shop)}` +
      `&interval=${isAnnual ? "annual" : "monthly"}`;

    const PLAN = (target === "pro")
      ? {
          name: process.env.SHOPIFY_BILLING_PRO_NAME || "Pro",
          // Pro annual not offered at launch; use monthly price
          amount: String(process.env.SHOPIFY_BILLING_PRO_PRICE || "19.00"),
        }
      : {
          name: process.env.SHOPIFY_BILLING_PREMIUM_NAME || "Premium",
          amount: isAnnual ? "490.00" : "49.00", // preserve existing Premium annual logic
        };
    const testFlag =
      ["BILLING_TEST", "BILLING_TEST_MODE", "SHOPIFY_BILLING_TEST", "SHOPIFY_BILLING_TEST_MODE"]
        .some((k) => String(process.env[k] || "").toLowerCase() === "true") ||
      process.env.NODE_ENV !== "production";

    let confirmationUrl = null;
    let userErrors = [];
    try {
      ({ confirmationUrl, userErrors = [] } = await createSubscription(client, {
        name: PLAN.name,
        amount: PLAN.amount,
        currency,
        returnUrl,
        test: testFlag,
        interval: intervalEnum,
      }));
    } catch (e) {
      if (isUnauthorized(e)) return sendReauth(res, req);
      console.error("POST /api/billing/upgrade createSubscription error", e?.response?.errors || e?.errors || e);
      return res.status(500).json({ error: "Upgrade failed" });
    }

    if (confirmationUrl) return res.json({ confirmationUrl });

    const looksLikeActiveBlock = (userErrors || [])
      .map((e) => e?.message || "")
      .join("; ")
      .match(/already.*active|existing.*active|active recurring/i);

    if (looksLikeActiveBlock && currentSubId) {
      try {
        const cancelled = await cancelSubscription(client, currentSubId, true);
        if (!cancelled.userErrors?.length) {
          const retry = await createSubscription(client, {
            name: PLAN.name,
            amount: PLAN.amount,
            currency,
            returnUrl,
            test: testFlag,
            interval: intervalEnum,
          });
          if (retry.confirmationUrl) return res.json({ confirmationUrl: retry.confirmationUrl });
        }
      } catch (e) {
        if (isUnauthorized(e)) return sendReauth(res, req);
        console.error("POST /api/billing/upgrade retry error", e?.response?.errors || e?.errors || e);
      }
    }

    return res.status(400).json({ error: "Upgrade failed", userErrors });
  } catch (err) {
    if (isUnauthorized(err)) return sendReauth(res, req);
    console.error("POST /api/billing/upgrade error", err);
    return res.status(500).json({ error: "Upgrade failed" });
  }
});

/** POST /api/billing/downgrade → cancels active subscription(s); sets Free */
router.post("/downgrade", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const client = await getAdminClientForShop(req, res, shop);

    const subs = await readActiveSubscriptions(client);
    const activeIds = (subs || [])
      .filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE")
      .map((s) => s?.id)
      .filter(Boolean);

    if (activeIds.length === 0) {
      await writePlan(shop, "free", "NONE");
      return res.json({ ok: true, message: "No active subscription" });
    }

    const canceled = [];
    for (const id of activeIds) {
      const { canceled: c, userErrors } = await cancelSubscription(client, id, true);
      if (userErrors?.length) {
        return res.status(400).json({
          error: "CANCEL_FAILED",
          message: userErrors.map((u) => u?.message || "Cancel failed").join("; "),
          id,
        });
      }
      if (c) canceled.push(c);
    }

    await writePlan(shop, "free", "NONE");
    return res.json({ ok: true, canceled });
  } catch (err) {
    if (isUnauthorized(err)) {
      return sendReauth(res, req, { return_to: encodeURIComponent("/admin-ui/billing") });
    }
    console.error("POST /api/billing/downgrade error", err);
    return res.status(500).json({ error: "Downgrade failed" });
  }
});

export default router;
