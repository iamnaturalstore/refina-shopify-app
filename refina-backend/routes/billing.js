// refina-backend/routes/billing.js — GOLDEN PATH++ (legacy + new endpoints)
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

/* ---------- Shopify GraphQL compatibility ---------- */

function getGraphqlClient(session) {
  const Graphql = shopify?.api?.clients?.Graphql || shopify?.clients?.Graphql;
  if (!Graphql) throw new Error("Graphql client class not found");
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

/* ---------- Plan writers ---------- */

// Downgrade-only reconciliation writer
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

/* ---------- Sessions ---------- */

// Purge offline session(s) (hoisted to top-level so all routes can use it)
async function purgeOfflineSession(shop) {
  const storage =
    (shopify?.config && shopify.config.sessionStorage) ||
    shopify?.sessionStorage ||
    null;

  if (!storage?.deleteSession) return;

  const ids = [];
  try { if (shopify?.session?.getOfflineId) ids.push(shopify.session.getOfflineId(shop)); } catch {}
  try { if (shopify?.api?.session?.getOfflineId) ids.push(shopify.api.session.getOfflineId(shop)); } catch {}
  ids.push(`offline_${shop}`);

  const seen = new Set();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try { await storage.deleteSession(id); } catch {}
  }
}

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

router.use((req, _res, next) => {
  if (process.env.DEBUG_AUTH === "1" && req.path.startsWith("/billing/")) {
    const hasAuth = !!req.headers.authorization;
    console.log(`[auth-debug] ${req.method} ${req.path} auth=${hasAuth ? "present" : "missing"} shop=${req.query.shop || ""}`);
  }
  next();
});

/**
 * Prefer OFFLINE session for gatekeeping (prevents spurious 401s), then try middleware/JWT.
 */
async function validateAdminSessionCompat(req, res, next) {
  try {
    let shopForGate = "";
    try {
      const { shop } = await resolveShopContext(req, res);
      shopForGate = shop;
      await ensureOfflineSession(shop);
      res.locals.shopify = res.locals.shopify || {};
      res.locals.shopify.session = res.locals.shopify.session || { shop };
      return next();
    } catch {}

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

    if (typeof shopify?.validateAuthenticatedSession === "function") {
      return shopify.validateAuthenticatedSession()(req, res, next);
    }

    return sendReauth(res, req, {
      return_to: encodeURIComponent("/admin-ui/billing"),
      shop: shopForGate || String(req.query?.shop || ""),
    });
  } catch {
    return sendReauth(res, req, { return_to: encodeURIComponent("/admin-ui/billing") });
  }
}

router.use(
  ["/status", "/subscribe", "/upgrade", "/downgrade", "/sync"],
  validateAdminSessionCompat
);

/* ----------------------------- Shopify ops ----------------------------- */

async function readActiveSubscriptions(client) {
  // Include billingPolicy.interval so /activated can derive monthly vs annual
  const q = `
    query AppInstall {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          test
          billingPolicy { interval }   # <— added
        }
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

  const variables = {
    name,
    returnUrl,
    test: !!test,
    amount: typeof amount === "number" ? amount : Number(amount),
    currency,
    trialDays: Number(process.env.BILLING_TRIAL_DAYS || 7),
    replacementBehavior: process.env.BILLING_REPLACEMENT_BEHAVIOR || null,
  };

  if (String(interval).toUpperCase() === "ANNUAL") {
    mutation = mutation.replace("interval: EVERY_30_DAYS", "interval: ANNUAL");
  }

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
  if ((payload?.userErrors || []).length) {
    console.error("[Billing] userErrors", payload.userErrors);
  }

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

async function ensureAppUninstalledWebhook(client) {
  const LIST_Q = `
    query {
      webhookSubscriptions(first: 50, topics: [APP_UNINSTALLED]) {
        edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
      }
    }
  `;
  let existing = [];
  try {
    const resp = typeof client.request === "function"
      ? await client.request(LIST_Q)
      : await client.query({ data: { query: LIST_Q } });
    const data = resp?.data || resp?.body?.data || resp;
    existing = (data?.webhookSubscriptions?.edges || []).map(e => e.node);
  } catch (e) {
    if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
      console.warn("[Webhook] list APP_UNINSTALLED failed (non-fatal):", e?.message || e);
    }
  }

  const base = (process.env.APP_URL || process.env.HOST || "").replace(/\/$/, "");
  if (!base) return;
  const wantUrl = `${base}/api/privacy/app_uninstalled`;
  if (existing.some(w => w?.endpoint?.callbackUrl === wantUrl)) return;

  const CREATE_MUT = `
    mutation CreateAppUninstallWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
      webhookSubscriptionCreate(
        topic: $topic,
        webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
      ) {
        userErrors { field message }
        webhookSubscription {
          id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
        }
      }
    }
  `;
  const variables = { topic: "APP_UNINSTALLED", callbackUrl: wantUrl };
  try {
    const resp = typeof client.request === "function"
      ? await client.request(CREATE_MUT, { variables })
      : await client.query({ data: { query: CREATE_MUT, variables } });
    const data = resp?.data || resp?.body?.data || resp;
    const errs = data?.webhookSubscriptionCreate?.userErrors || [];
    if (errs.length && String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
      console.warn("[Webhook] register APP_UNINSTALLED userErrors:", errs);
    }
  } catch (e) {
    if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
      console.warn("[Webhook] register APP_UNINSTALLED failed (non-fatal):", e?.message || e);
    }
  }
}

/** GET /api/billing/plan → { plan } (fresh=1 → reconcile with downgrade-only) */
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
        await writePlanDowngradeOnly(shop, level, status); // ← NEVER upgrade here
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

/** GET /api/billing/activated → set plan (from Shopify) then 303 to embedded Admin URL */
router.get("/activated", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const offlineSession = await ensureOfflineSession(shop);
    const client = getGraphqlClient(offlineSession);

    const subs = await readActiveSubscriptions(client);
    const { level, status } = inferPlanFromSubs(subs);

    // Derive interval from the active subscription (not from req.query)
    const firstActive = Array.isArray(subs) ? subs.find(s => (s?.status || s?.node?.status) === "ACTIVE") : null;
    const rawInterval = firstActive?.billingPolicy?.interval ?? firstActive?.node?.billingPolicy?.interval ?? "";
    let billingInterval = "";
    if (typeof rawInterval === "string") {
      const i = rawInterval.toLowerCase();
      billingInterval =
        i.includes("annual") || i.includes("year") ? "annual" :
        i.includes("month")  || i.includes("30")   ? "monthly" :
        "";
    }

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

    const originCandidate = (process.env.APP_URL || process.env.HOST || absoluteAppUrl(req) || "")
      .trim()
      .replace(/\/$/, "");

    let origin = originCandidate;
    try { origin = new URL(originCandidate).origin; } catch {
      origin = originCandidate.replace(/^(https?:\/\/[^\/?#]+).*/, "$1");
    }

    const returnUrl = `${origin}/api/billing/activated?shop=${encodeURIComponent(shop)}`;

    const PLAN = { name: "Premium", amount: "49.00" };
    const testFlag =
      ["BILLING_TEST", "BILLING_TEST_MODE", "SHOPIFY_BILLING_TEST", "SHOPIFY_BILLING_TEST_MODE"]
        .some((k) => String(process.env[k] || "").toLowerCase() === "true") ||
      process.env.NODE_ENV !== "production";

    if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
      console.log("[Billing]/subscribe origin", { originCandidate, origin });
      console.log("[Billing]/subscribe returnUrl", returnUrl.length, returnUrl);
      console.log("[Billing]/subscribe vars", { shop, amount: PLAN.amount, currency, test: testFlag });
    }

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
      if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
        return res.status(500).json({
          error: "Subscribe failed",
          message: e?.message,
          graphqlErrors: e?.response?.errors || e?.errors || null,
        });
      }
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
          let retry = await createSubscription(client, {
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

/** POST /api/billing/sync → reconcile plans/{shop} (DOWNGRADE-ONLY) */
router.post("/sync", async (req, res) => {
  try {
    const { shop } = await resolveShopContext(req, res);
    const client = await getAdminClientForShop(req, res, shop);

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

const isUnauthorized = (e) =>
  e?.status === 401 || e?.response?.code === 401 || e?.response?.status === 401;

/** POST /api/billing/upgrade → { confirmationUrl } */
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
    try { origin = new URL(originCandidate).origin; } catch {
      origin = originCandidate.replace(/^(https?:\/\/[^\/?#]+).*/, "$1");
    }

    const requestedInterval = String(req.body?.interval || "").toLowerCase();
    const intervalEnum = requestedInterval === "annual" ? "ANNUAL" : "EVERY_30_DAYS";
    const isAnnual = intervalEnum === "ANNUAL";
    const returnUrl =
      `${origin}/api/billing/activated?shop=${encodeURIComponent(shop)}` +
      `&interval=${isAnnual ? "annual" : "monthly"}`;

    const PLAN = { name: "Premium", amount: isAnnual ? "490.00" : "49.00" };
    const testFlag =
      ["BILLING_TEST", "BILLING_TEST_MODE", "SHOPIFY_BILLING_TEST", "SHOPIFY_BILLING_TEST_MODE"]
        .some((k) => String(process.env[k] || "").toLowerCase() === "true") ||
      process.env.NODE_ENV !== "production";

    if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
      console.log("[Billing]/upgrade origin", { originCandidate, origin });
      console.log("[Billing]/upgrade returnUrl", returnUrl.length, returnUrl);
      console.log("[Billing]/upgrade vars", { shop, amount: PLAN.amount, currency, test: testFlag });
    }

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
      if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
        return res.status(500).json({
          error: "Upgrade failed",
          message: e?.message,
          graphqlErrors: e?.response?.errors || e?.errors || null,
        });
      }
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

/** POST /api/billing/downgrade → cancels active subscription(s); sets plan Free */
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
      await writePlan(shop, "free", "NONE", "");
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

    await writePlan(shop, "free", "NONE", "");
    return res.json({ ok: true, canceled });
  } catch (err) {
    if (err?.status === 401 || err?.response?.code === 401 || err?.response?.status === 401) {
      const shopParam = String(req.query?.shop || "");
      if (shopParam) {
        try { await purgeOfflineSession(shopParam); } catch {}
      }
      return sendReauth(res, req, {
        shop: shopParam,
        return_to: encodeURIComponent("/admin-ui/billing"),
      });
    }
    console.error("POST /api/billing/downgrade error", err);
    return res.status(500).json({ error: "Downgrade failed" });
  }
});

export default router;
