// refina-backend/server.js — Production-ready (App Proxy + BFF + Webhooks)

import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import cookieParser from "cookie-parser";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import shopify from "./shopify.js";
import semanticRouter from "./routes/semantic.js";
import billingRoutes from "./routes/billing.js";
import mountAdminSettingsRoutes from "./routes/adminSettings.js";
import analyticsRouter from "./routes/analytics.js";
import { dbAdmin, FieldValue } from "./firebaseAdmin.js";

dotenv.config({ path: "../.env" });

// ───────────────────────────────────────────────────────────────────────────────
// Paths
// ───────────────────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADMIN_UI_DIR = path.join(__dirname, "admin-ui-dist");
const ADMIN_UI_INDEX = path.join(ADMIN_UI_DIR, "index.html");

// Config
const PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 3000);
const HOST = (process.env.HOST || "").replace(/\/$/, "");
const PROXY_SLUG = (process.env.PROXY_SLUG || "refina").trim();

const DEV_CONCIERGE_ORIGIN = process.env.DEV_CONCIERGE_ORIGIN || ""; // e.g. https://xyz.ngrok.app
const DEV_CONCIERGE_ENTRY =
  process.env.DEV_CONCIERGE_ENTRY || "/src/concierge/main.jsx";
const ASSETS_BASE_URL = (process.env.ASSETS_BASE_URL || "").replace(/\/$/, ""); // e.g. https://assets.refina.app

// Utility
const cdnHost =
  ASSETS_BASE_URL ? (() => { try { return new URL(ASSETS_BASE_URL).origin; } catch { return ""; } })() : "";

// ───────────────────────────────────────────────────────────────────────────────
// App
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Basic logging early
app.use(morgan("tiny"));

// Security headers
app.use(
  helmet({
    frameguard: false, // we'll set frame-ancestors via CSP ourselves
    referrerPolicy: { policy: "no-referrer-when-downgrade" },
  })
);

// Global CSP allowing Shopify frames (Admin + Storefront)
// (We tighten per-response CSP on the App Proxy HTML shell below.)
app.use((_, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.use(compression());

// ───────────────────────────────────────────────────────────────────────────────
function shopFromHostB64(hostB64) {
  try {
    const decoded = Buffer.from(hostB64, "base64").toString("utf8");
    const m1 = decoded.match(/^admin\.shopify\.com\/store\/([^\/]+)/i);
    if (m1?.[1]) return `${m1[1]}.myshopify.com`;
    const m2 = decoded.match(/^([^\/]+)\.myshopify\.com\/admin/i);
    if (m2?.[1]) return `${m2[1]}.myshopify.com`;
  } catch {}
  return "";
}

function inferShop(req) {
  if (typeof req.query?.shop === "string" && req.query.shop)
    return req.query.shop.toLowerCase();
  if (typeof req.query?.host === "string" && req.query.host) {
    const s = shopFromHostB64(req.query.host);
    if (s) return s.toLowerCase();
  }
  if (typeof req.shop === "string" && req.shop) return req.shop.toLowerCase();
  const h = req.get?.("X-Shopify-Shop-Domain");
  if (typeof h === "string" && h) return h.toLowerCase();
  if (req.cookies?.storeId)
    return `${req.cookies.storeId}.myshopify.com`.toLowerCase();
  return "";
}

function storeIdFromShop(shop = "") {
  return (shop || "").toLowerCase().replace(".myshopify.com", "");
}

// ───────────────────────────────────────────────────────────────────────────────
// Webhooks (RAW) — must be before any JSON body parser
// ───────────────────────────────────────────────────────────────────────────────

// Billing webhook (RAW + verify HMAC manually)
app.post(
  "/api/webhooks/app_subscriptions_update",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
      const topic = req.get("X-Shopify-Topic") || "";
      const shop = (req.get("X-Shopify-Shop-Domain") || "").toLowerCase();

      const digest = crypto
        .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
        .update(req.body, "utf8")
        .digest("base64");

      if (!hmac || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
        return res.status(401).send("Unauthorized");
      }
      if (topic !== "APP_SUBSCRIPTIONS_UPDATE") {
        return res.status(400).send("Wrong topic");
      }

      const payload = JSON.parse(req.body.toString("utf8"));
      const sub = payload?.app_subscription || {};
      const planName = (sub.name || "").toLowerCase();
      const isPremium =
        /\bpremium\b/.test(planName) ||
        /\bpro\s*\+|\bpro\W*plus\b/.test(planName);
      const isPro = /\bpro\b/.test(planName) && !isPremium;
      const level = isPremium ? "premium" : isPro ? "pro" : "free";
      const status = (sub.status || "ACTIVE").toUpperCase();
      const storeId = storeIdFromShop(shop);

      await dbAdmin.doc(`plans/${storeId}`).set(
        {
          level,
          status,
          subscriptionId: sub.id || null,
          lastWebhook: "APP_SUBSCRIPTIONS_UPDATE",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).send("ok");
    } catch (e) {
      console.error("billing webhook error:", e);
      if (!res.headersSent) return res.status(500).send("error");
    }
  }
);

// Generic webhooks via the Shopify lib (RAW)
app.post("/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    await shopify.webhooks.process({ rawBody: req.body, rawRequest: req, rawResponse: res });
    if (!res.headersSent) res.status(200).end();
  } catch (e) {
    console.error("❌ Webhook processing failed", e?.message || e);
    if (!res.headersSent) res.status(200).end();
  }
});

// Register common handlers
await shopify.webhooks.addHandlers({
  APP_UNINSTALLED: {
    deliveryMethod: 0,
    callbackUrl: "/webhooks",
    callback: async (_topic, shop) => {
      try {
        const storeId = storeIdFromShop(shop);
        await dbAdmin.doc(`plans/${storeId}`).set(
          { status: "UNINSTALLED", level: "free", updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      } catch (e) {
        console.warn("APP_UNINSTALLED handler error:", e?.message || e);
      }
    },
  },
  SHOP_REDACT: { deliveryMethod: 0, callbackUrl: "/webhooks" },
  CUSTOMERS_REDACT: { deliveryMethod: 0, callbackUrl: "/webhooks" },
  CUSTOMERS_DATA_REQUEST: { deliveryMethod: 0, callbackUrl: "/webhooks" },
});

// ───────────────────────────────────────────────────────────────────────────────
// Core middleware (after RAW routes)
// ───────────────────────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json());

// Debug tracer for /api
app.use("/api", (req, _res, next) => {
  console.log("API HIT →", req.method, req.path);
  next();
});

// Normalize admin/api requests; opportunistic webhook registration
async function ensureWebhooksRegistered(shop) {
  try {
    const storeId = storeIdFromShop(shop);
    if (!storeId) return;

    const flagRef = dbAdmin.doc(`shops/${storeId}`);
    const snap = await flagRef.get();
    if (snap.exists && snap.data()?.webhooksRegistered) return;

    const api = shopify?.api;
    if (!api?.sessionStorage?.loadSession || !api?.session?.getOfflineId) return;

    const offlineId = api.session.getOfflineId(shop);
    const offlineSession = await api.sessionStorage.loadSession(offlineId);
    if (!offlineSession?.accessToken) return;

    await shopify.webhooks.register({ session: offlineSession });

    if (HOST) {
      const address = `${HOST}/api/webhooks/app_subscriptions_update`;
      const resp = await fetch(
        `https://${shop}/admin/api/${shopify.config.apiVersion}/webhooks.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": offlineSession.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            webhook: { topic: "app_subscriptions/update", address, format: "json" },
          }),
        }
      );
      if (![200, 201, 422].includes(resp.status)) {
        console.warn("Billing webhook register resp:", await resp.text());
      }
    }

    await flagRef.set(
      { webhooksRegistered: true, registeredAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`✅ Webhooks registered for ${shop}`);
  } catch (e) {
    console.warn("ensureWebhooksRegistered error:", e?.message || e);
  }
}

// Guard API + Admin UI shell; derive shop; register webhooks lazily
app.use(async (req, _res, next) => {
  try {
    if (req.path.startsWith("/api/webhooks")) return next();
    const isAppShell = req.path === "/" || req.path.startsWith("/admin-ui");
    const isApi = req.path.startsWith("/api/");
    if (!isAppShell && !isApi) return next();

    const shop = inferShop(req);
    if (shop) {
      req.shop = shop;
      await ensureWebhooksRegistered(shop);
    }
  } catch (e) {
    console.warn("auth guard skip:", e?.message || e);
  }
  next();
});

// ───────────────────────────────────────────────────────────────────────────────
// OAuth
// ───────────────────────────────────────────────────────────────────────────────
async function oauthBegin(req, res, next) {
  try {
    const shop = inferShop(req);
    if (!shop) return res.status(400).send("Missing ?shop for OAuth (open the app from Shopify Admin).");

    const callbackPath = req.path.startsWith("/auth") ? "/auth/callback" : "/api/auth/callback";

    await shopify.auth.begin({
      shop,
      callbackPath,
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (e) {
    next(e);
  }
}

async function oauthCallback(req, res, next) {
  try {
    const { session } = await shopify.auth.callback({
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });

    const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
    await storage.storeSession(session);

    const shop = (session?.shop || req.query?.shop || inferShop(req) || "").toLowerCase();
    const storeId = storeIdFromShop(shop);

    if (storeId) {
      await dbAdmin.doc(`shops/${storeId}`).set(
        { installed: true, installedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      res.cookie("storeId", storeId, {
        httpOnly: true,
        sameSite: "Lax",
        secure: true,
        maxAge: 1000 * 60 * 60 * 24 * 30,
      });
    }

    const hostB64 =
      req.query.host ||
      (storeId ? Buffer.from(`admin.shopify.com/store/${storeId}`).toString("base64") : "");

    const redirectUrl = hostB64
      ? `/admin-ui/?host=${encodeURIComponent(hostB64)}${shop ? `&shop=${encodeURIComponent(shop)}` : ""}`
      : `/admin-ui/`;

    return res.redirect(redirectUrl);
  } catch (e) {
    next(e);
  }
}

app.get("/api/auth", oauthBegin);
app.get("/api/auth/callback", oauthCallback);
app.get("/auth", oauthBegin);
app.get("/auth/callback", oauthCallback);

// ───────────────────────────────────────────────────────────────────────────────
// Admin APIs
// ───────────────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "development" });
});

app.use("/api/search", semanticRouter);
app.use("/api/billing", billingRoutes);
mountAdminSettingsRoutes(app);
app.use("/api/admin", analyticsRouter);

app.all("/api/*", (req, res) =>
  res.status(404).json({ ok: false, error: "No such API route", path: req.originalUrl })
);

// ───────────────────────────────────────────────────────────────────────────────
// App Proxy (storefront)
// ───────────────────────────────────────────────────────────────────────────────
function computeExpectedSignature(query) {
  const { signature, ...params } = query || {};
  const msg = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");
  return crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(msg).digest("hex");
}

function verifyAppProxy(req, res, next) {
  try {
    if (!process.env.SHOPIFY_API_SECRET) return res.status(500).send("Missing API secret");

    const expected = computeExpectedSignature(req.query);
    const provided = (req.query?.signature || "").toLowerCase();
    if (!provided) return res.status(401).send("Missing signature");

    if (expected !== provided) return res.status(401).send("Invalid signature");

    req.shop = (req.get("x-shopify-shop-domain") || req.query.shop || "").toLowerCase();
    return next();
  } catch {
    return res.status(401).send("Invalid signature");
  }
}

function allowShopifyFrame(res) {
  res.removeHeader("X-Frame-Options");
  // We add per-response CSP below where needed.
}

const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

function assertSlug(req, res, next) {
  if ((req.params?.slug || "").toLowerCase() !== PROXY_SLUG.toLowerCase()) {
    return res.status(404).send("Not found");
  }
  next();
}

function setProxyHtmlCSP(res) {
  // Tight CSP for the App Proxy HTML shell
  const pieces = [
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com",
    `script-src 'self' ${cdnHost || ""}`.trim(),
    `style-src 'self' 'unsafe-inline' ${cdnHost || ""}`.trim(),
    "connect-src 'self'",
    "img-src * data:",
    "font-src * data:",
  ];
  res.setHeader("Content-Security-Policy", pieces.join("; ") + ";");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

// HTML shell at base proxy path
app.get(["/proxy/:slug", "/proxy/:slug/"], assertSlug, verifyAppProxy, (req, res) => {
  allowShopifyFrame(res);
  setProxyHtmlCSP(res);

  const shop = inferShop(req);
  const storeId = storeIdFromShop(shop);

  const useDev =
    !!DEV_CONCIERGE_ORIGIN &&
    (req.query.dev === "1" || process.env.FORCE_DEV === "1");

  const devBase = `/apps/${PROXY_SLUG}/dev`;
  const entry = DEV_CONCIERGE_ENTRY.replace(/^\//, "");
  const signedQs = new URLSearchParams(req.query || {}).toString();

  const scripts = useDev
    ? [
        `<script type="module" src="${devBase}/@vite/client?${signedQs}"></script>`,
        `<script type="module" src="${devBase}/${entry}?${signedQs}"></script>`,
      ].join("\n")
    : ASSETS_BASE_URL
    ? `<link rel="preconnect" href="${ASSETS_BASE_URL}" />
<link rel="stylesheet" href="${ASSETS_BASE_URL}/concierge.css" />
<script type="module" src="${ASSETS_BASE_URL}/concierge.js"></script>`
    : "";

  res.type("html").send(`<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Refina Concierge</title>
<style>
  body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Ubuntu,sans-serif}
  .wrap{padding:16px}
  .muted{opacity:.65;font-size:12px}
</style>
</head><body>
  <div id="root" data-shop="${shop || ""}" data-store-id="${storeId}"></div>
  ${scripts}
  ${!scripts ? `<div class="wrap"><h1>Hello from Refina 👋</h1>
    <p class="muted">Set ASSETS_BASE_URL to load the concierge bundle, or use ?dev=1 with DEV_CONCIERGE_ORIGIN.</p></div>` : ""}
</body></html>`);
});

// ── Dev asset forwarder — HMR proxied through app proxy
app.get("/proxy/:slug/dev/*", assertSlug, async (req, res) => {
  allowShopifyFrame(res);

  if (!DEV_CONCIERGE_ORIGIN) {
    return res.status(500).send("DEV_CONCIERGE_ORIGIN not set");
  }

  // In dev, optionally allow assets without strict signature to avoid 403 churn
  const devBypass = process.env.FORCE_DEV === "1";

  if (!devBypass) {
    const provided = (req.query?.signature || "").toLowerCase();
    if (!provided) return res.status(401).send("Missing signature");
    const expected = computeExpectedSignature(req.query);
    if (expected !== provided) return res.status(401).send("Invalid signature");
  }

  try {
    const star = req.path.split(`/proxy/${PROXY_SLUG}/dev/`)[1] || "";
    const forwardPath = `/${star}`;

    const upstream = new URL(DEV_CONCIERGE_ORIGIN);
    upstream.pathname = forwardPath;

    for (const [k, v] of Object.entries(req.query || {})) {
      upstream.searchParams.set(k, String(v));
    }

    if (upstream.hostname.includes(".ngrok.app")) {
      upstream.searchParams.set("ngrok-skip-browser-warning", "true");
    }

    const upstreamResp = await fetch(upstream.toString(), {
      method: "GET",
      headers: { accept: req.headers.accept || "*/*" },
    });

    res.status(upstreamResp.status);
    const ct = upstreamResp.headers.get("content-type") || "";
    if (ct) res.setHeader("content-type", ct);

    const buf = Buffer.from(await upstreamResp.arrayBuffer());
    const isJsLike =
      ct.includes("javascript") ||
      /\.(m?js|jsx|ts|tsx)$/.test(forwardPath) ||
      forwardPath === "/@vite/client";

    if (isJsLike) {
      let code = buf.toString("utf8");
      const devBase = `/apps/${PROXY_SLUG}/dev`;
      const signedQs = new URLSearchParams(req.query || {}).toString();
      const withQs = (p) => `${p}${p.includes("?") ? "&" : "?"}${signedQs}`;

      code = code
        .replaceAll('"/@vite/client"', `"${withQs(`${devBase}/@vite/client`)}"`)
        .replaceAll("'/@vite/client'", `'${withQs(`${devBase}/@vite/client`)}'`)
        .replace(/(["'`])\/@id\//g, (_m, q) => `${q}${withQs(`${devBase}/@id/`)}`)
        .replace(/(["'`])\/src\//g, (_m, q) => `${q}${withQs(`${devBase}/src/`)}`);

      return res.send(code);
    }

    return res.send(buf);
  } catch (e) {
    console.error("Dev asset forward error:", e?.message || e);
    res.status(502).send("Dev asset forward failed");
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// BFF endpoints under the App Proxy (storefront)
// ───────────────────────────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
});

function getStoreIdFromReq(req) {
  const shop = inferShop(req);
  return storeIdFromShop(shop);
}

function toLowerId(p) {
  return String(p.id || p.name || "").toLowerCase().trim();
}

function productDisplayShape(p) {
  return {
    id: p.id || p.name,
    name: p.name,
    description: p.description || "",
    tags: Array.isArray(p.tags) ? p.tags : [],
    productType: p.productType || "",
    category: p.category || "",
    ingredients: Array.isArray(p.ingredients) ? p.ingredients : [],
    image: p.image || p.imageUrl || "",
    price: p.price ?? null,
    link: p.link || p.url || (p.handle ? `/products/${p.handle}` : "#"),
  };
}

// quick-n-simple fallback score (server-side)
function scoreProductAgainstConcern(p, tokens) {
  const hay = [
    p.name,
    p.description,
    (p.tags || []).join(" "),
    p.productType,
    p.category,
    (p.ingredients || []).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const matches = hay.match(re);
    if (matches) score += matches.length * 3;
  }

  // mild boost if sunscreen / serum etc appears in type
  if (/\bsunscreen|spf\b/i.test(p.productType || "")) score += 2;
  if (/\bserum\b/i.test(p.productType || "")) score += 2;
  if (/\bcleanser\b/i.test(p.productType || "")) score += 1;

  return score;
}

// GET bootstrap → plan/ui/concerns (server-side; products fetched on-demand in /recommend)
app.get(
  "/proxy/:slug/api/bootstrap",
  assertSlug,
  verifyAppProxy,
  apiLimiter,
  async (req, res) => {
    allowShopifyFrame(res);
    const storeId = getStoreIdFromReq(req);
    if (!storeId) return res.status(400).json({ ok: false, error: "Missing storeId" });

    try {
      const [settingsSnap, planSnap, concernsSnap] = await Promise.all([
        dbAdmin.doc(`storeSettings/${storeId}`).get(),
        dbAdmin.doc(`plans/${storeId}`).get(),
        dbAdmin.collection(`commonConcerns/${storeId}/items`).get(),
      ]);

      const storeSettings = settingsSnap.exists ? settingsSnap.data() : {};
      const plan = (planSnap.exists ? String(planSnap.data()?.level || "free") : "free").toLowerCase();
      const commonConcerns = concernsSnap.docs.map((d) => d.data()?.text).filter(Boolean);

      return res.json({
        ok: true,
        storeId,
        plan,
        storeSettings,
        commonConcerns,
      });
    } catch (e) {
      console.error("bootstrap error:", e);
      return res.status(500).json({ ok: false, error: "bootstrap_failed" });
    }
  }
);

// POST recommend → cache hit OR fallback (AI can be added behind the scenes later)
app.post(
  "/proxy/:slug/api/recommend",
  assertSlug,
  verifyAppProxy,
  apiLimiter,
  async (req, res) => {
    allowShopifyFrame(res);
    const storeId = getStoreIdFromReq(req);
    if (!storeId) return res.status(400).json({ ok: false, error: "Missing storeId" });

    try {
      const {
        concern = "",
        context = {},
        plan = "free",
        sessionId = "",
        turn = 0,
      } = req.body || {};
      const normalizedConcern = String(concern || "").toLowerCase().trim();
      if (!normalizedConcern) return res.status(400).json({ ok: false, error: "Empty concern" });

      // 1) cache hit?
      const mappingRef = dbAdmin.doc(`mappings/${storeId}/concernToProducts/${normalizedConcern}`);
      const mappingSnap = await mappingRef.get();

      // Always load products (we need to return renderable data)
      const productsSnap = await dbAdmin.collection(`products/${storeId}/items`).get();
      const allProducts = productsSnap.docs.map((d) => productDisplayShape(d.data()));

      const byLowerId = new Map(allProducts.map((p) => [toLowerId(p), p]));

      if (mappingSnap.exists) {
        const m = mappingSnap.data();
        const ids = Array.isArray(m.productIds) ? m.productIds : [];
        const chosen = ids
          .map((id) => byLowerId.get(String(id || "").toLowerCase().trim()))
          .filter(Boolean);

        // Log cache turn
        await dbAdmin.collection(`conversations/${storeId}/logs`).add({
          sessionId: sessionId || `sess_${Date.now()}`,
          turn: Number(turn) || 1,
          plan: String(plan || "free"),
          concern,
          context,
          response: m.explanation || "",
          productIds: ids,
          followUps: [],
          source: "cache",
          timestamp: FieldValue.serverTimestamp(),
        });

        return res.json({
          ok: true,
          explanation: m.explanation || "Here's what we recommend.",
          followUps: [],
          products: chosen,
          reasonsById: {}, // client can synthesize bullets if needed
          scoresById: {},
          source: "cache",
        });
      }

      // 2) (AI path would go here for pro/premium; omitted for now)
      // 3) fallback match
      const tokens = normalizedConcern.split(/\s+/g).filter(Boolean);
      const scored = allProducts
        .map((p) => ({ p, s: scoreProductAgainstConcern(p, tokens) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 8)
        .map((x) => x.p);

      const explanation = scored.length
        ? "Here are the most relevant products based on your request."
        : "We couldn’t find an exact match, but we’re working on it.";

      // Log fallback turn
      await dbAdmin.collection(`conversations/${storeId}/logs`).add({
        sessionId: sessionId || `sess_${Date.now()}`,
        turn: Number(turn) || 1,
        plan: String(plan || "free"),
        concern,
        context,
        response: explanation,
        productIds: scored.map((p) => p.id || p.name),
        followUps: [],
        source: "fallback",
        timestamp: FieldValue.serverTimestamp(),
      });

      return res.json({
        ok: true,
        explanation,
        followUps: [], // can be added server-side when AI is wired
        products: scored,
        reasonsById: {},
        scoresById: {},
        source: "fallback",
      });
    } catch (e) {
      console.error("recommend error:", e);
      return res.status(500).json({ ok: false, error: "recommend_failed" });
    }
  }
);

// GET common-concerns (separate, though bootstrap also returns them)
app.get(
  "/proxy/:slug/api/common-concerns",
  assertSlug,
  verifyAppProxy,
  apiLimiter,
  async (req, res) => {
    allowShopifyFrame(res);
    const storeId = getStoreIdFromReq(req);
    if (!storeId) return res.status(400).json({ ok: false, error: "Missing storeId" });

    try {
      const snap = await dbAdmin.collection(`commonConcerns/${storeId}/items`).get();
      const items = snap.docs.map((d) => d.data()?.text).filter(Boolean);
      res.json({ ok: true, storeId, items });
    } catch (e) {
      console.error("common-concerns error:", e);
      res.status(500).json({ ok: false, error: "common_concerns_failed" });
    }
  }
);

// (Optional) POST log — if you want extra client events beyond /recommend
app.post(
  "/proxy/:slug/api/log",
  assertSlug,
  verifyAppProxy,
  apiLimiter,
  async (req, res) => {
    allowShopifyFrame(res);
    const storeId = getStoreIdFromReq(req);
    if (!storeId) return res.status(400).json({ ok: false, error: "Missing storeId" });

    try {
      const payload = req.body || {};
      await dbAdmin.collection(`conversations/${storeId}/logs`).add({
        ...payload,
        timestamp: FieldValue.serverTimestamp(),
      });
      res.json({ ok: true });
    } catch (e) {
      console.error("log error:", e);
      res.status(500).json({ ok: false, error: "log_failed" });
    }
  }
);

// Keep ping for quick checks
app.get("/proxy/:slug/api/ping", assertSlug, verifyAppProxy, apiLimiter, (req, res) => {
  allowShopifyFrame(res);
  res.json({ ok: true, shop: inferShop(req) || null, source: "app-proxy" });
});

// 404 for other proxy paths (keeps headers consistent)
app.all("/proxy/:slug/*", assertSlug, verifyAppProxy, (req, res) => {
  allowShopifyFrame(res);
  res.status(404).json({ ok: false, error: "Not found", path: req.originalUrl });
});

// ───────────────────────────────────────────────────────────────────────────────
// Admin UI static (after APIs)
// ───────────────────────────────────────────────────────────────────────────────
app.use("/admin-ui/assets", express.static(path.join(ADMIN_UI_DIR, "assets")));
app.get(["/admin-ui", "/"], (_req, res) => {
  if (!fs.existsSync(ADMIN_UI_INDEX)) return res.status(500).send("Admin UI not built.");
  res.sendFile(ADMIN_UI_INDEX);
});

// ───────────────────────────────────────────────────────────────────────────────
// Error handler (last)
// ───────────────────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: "Server error" });
});

// ───────────────────────────────────────────────────────────────────────────────
// Start
// ───────────────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log("🧩 DEV_CONCIERGE_ORIGIN:", process.env.DEV_CONCIERGE_ORIGIN || "(unset)");
  console.log("🧩 DEV_CONCIERGE_ENTRY:", DEV_CONCIERGE_ENTRY);
  console.log("🧩 ASSETS_BASE_URL:", process.env.ASSETS_BASE_URL || "(unset)");
  console.log("🧩 FORCE_DEV:", process.env.FORCE_DEV || "(unset)");
  console.log("✅ HOST from .env:", HOST);
  console.log("✅ PROXY_SLUG:", PROXY_SLUG);
  console.log(`🚀 Backend on http://localhost:${PORT}`);
  console.log(`🧱 Admin UI dir: ${ADMIN_UI_DIR}`);
});
