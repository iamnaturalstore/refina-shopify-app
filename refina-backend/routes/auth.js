// refina-backend/routes/auth.js
"use strict";

import express from "express";
import shopify from "../shopify.js";
import { dbAdmin } from "../lib/firestore.js";

const router = express.Router();

/* ───────── helpers ───────── */

function sanitizeReturnTo(p) {
  if (!p || typeof p !== "string") return "";
  try {
    if (/^https?:\/\//i.test(p)) return "";         // disallow absolute URLs
    if (!p.startsWith("/admin-ui")) return "";       // lock to our UI scope
    return p.replace(/\/{2,}/g, "/");
  } catch {
    return "";
  }
}

function getCookie(req, name) {
  const raw = req.headers?.cookie || "";
  const parts = raw.split(/; */);

  for (const p of parts) {
    const eq = p.indexOf("=");
    const k = decodeURIComponent((eq === -1 ? p : p.slice(0, eq)).trim());
    if (k === name) {
      return decodeURIComponent((eq === -1 ? "" : p.slice(eq + 1)).trim());
    }
  }

  return "";
}

function computeHostFromShop(shop) {
  const s = String(shop || "").toLowerCase().trim();
  if (!s || !s.endsWith(".myshopify.com")) return "";
  return Buffer.from(`${s}/admin`).toString("base64");
}

function baseUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function storeFromShop(shop) {
  return String(shop || "").toLowerCase().replace(/\.myshopify\.com$/, "");
}

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  });
}

function sendTopLevelRedirectPage(res, targetUrl, title = "Loading Refina…") {
  setNoStoreHeaders(res);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, proxy-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>${title}</title>
</head>
<body>
  <script>
    window.top.location.href = ${JSON.stringify(targetUrl)};
  </script>
  <p>${title}</p>
</body>
</html>`;

  return res.status(200).send(html);
}

/* ── register APP_UNINSTALLED webhook (idempotent) ──────────── */

async function registerAppUninstalledWebhook(client, webhookUrl) {
  if (!webhookUrl) {
    console.warn("[Webhook] register APP_UNINSTALLED skipped: missing webhookUrl");
    return;
  }

  const LIST_Q = `
    query {
      webhookSubscriptions(first: 50, topics: [APP_UNINSTALLED]) {
        edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
      }
    }
  `;

  try {
    const listResp = typeof client.request === "function"
      ? await client.request(LIST_Q)
      : await client.query({ data: { query: LIST_Q } });

    const listData = listResp?.data || listResp?.body?.data || listResp;
    const existing = (listData?.webhookSubscriptions?.edges || [])
      .map((e) => e?.node)
      .filter(Boolean);

    if (existing.some((w) => w?.endpoint?.callbackUrl === webhookUrl)) {
      if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
        console.log("[Webhook] APP_UNINSTALLED already registered");
      }
      return;
    }
  } catch (e) {
    if (String(process.env.BILLING_DEBUG || "").toLowerCase() === "true") {
      console.warn("[Webhook] list APP_UNINSTALLED failed (non-fatal):", e?.message || e);
    }
  }

  const CREATE_MUT = `
    mutation CreateAppUninstallWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
      webhookSubscriptionCreate(
        topic: $topic,
        webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
      ) {
        userErrors { field message }
        webhookSubscription { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
      }
    }
  `;

  const variables = { topic: "APP_UNINSTALLED", callbackUrl: webhookUrl };

  const createResp = typeof client.request === "function"
    ? await client.request(CREATE_MUT, { variables })
    : await client.query({ data: { query: CREATE_MUT, variables } });

  const data = createResp?.data || createResp?.body?.data || createResp;
  const errs = data?.webhookSubscriptionCreate?.userErrors || [];

  if (errs.length) {
    console.warn("[Webhook] register APP_UNINSTALLED userErrors:", errs);
  } else {
    console.log(
      "[Webhook] registered APP_UNINSTALLED:",
      data?.webhookSubscriptionCreate?.webhookSubscription
    );
  }
}

/* ───────── OAuth (offline) ───────── */

router.get("/", async (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();

  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }

  const host = String(req.query.host || "") || computeHostFromShop(shop);
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  /*
    Top-level hop marker.

    Important:
    - Cookie path is preserved for browsers that accept the marker cookie.
    - top_level=1 is the fallback so OAuth is not trapped if the browser does
      not persist/read the marker during the Shopify Admin iframe → top-window hop.
  */
  const hasTop =
    String(req.query.top_level || "") === "1" ||
    getCookie(req, "shopifyTopLevelOAuth") === "1";

  if (!hasTop) {
    const toplevel = new URL("/api/auth/toplevel", baseUrl(req));
    toplevel.searchParams.set("shop", shop);
    if (host) toplevel.searchParams.set("host", host);
    if (returnTo) toplevel.searchParams.set("return_to", returnTo);

    return sendTopLevelRedirectPage(res, toplevel.toString());
  }

  // Persist deep link for after OAuth.
  if (returnTo) {
    res.cookie("refina_return_to", returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 5 * 60 * 1000,
    });
  }

  try {
    await shopify.auth.begin({
      shop,
      callbackPath: "/api/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (err) {
    const needsTop =
      err?.status === 410 ||
      /top.?level|cookie/i.test(String(err?.message || ""));

    if (needsTop) {
      const toplevel = new URL("/api/auth/toplevel", baseUrl(req));
      toplevel.searchParams.set("shop", shop);
      if (host) toplevel.searchParams.set("host", host);
      if (returnTo) toplevel.searchParams.set("return_to", returnTo);

      return sendTopLevelRedirectPage(res, toplevel.toString());
    }

    console.error("OAuth begin failed", {
      shop,
      host,
      path: req.originalUrl,
      message: err?.message,
      name: err?.name,
    });

    return res.status(500).send(`OAuth begin failed: ${err?.message || String(err)}`);
  }
});

/* Top-level handoff */

router.get("/toplevel", (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();

  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }

  setNoStoreHeaders(res);

  const host = String(req.query.host || "") || computeHostFromShop(shop);
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  res.cookie("shopifyTopLevelOAuth", "1", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 5 * 60 * 1000,
  });

  if (returnTo) {
    res.cookie("refina_return_to", returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 5 * 60 * 1000,
    });
  }

  const backToAuth =
    `/api/auth?shop=${encodeURIComponent(shop)}` +
    `&host=${encodeURIComponent(host)}` +
    `&top_level=1` +
    (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : "");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, proxy-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>Loading Refina…</title>
</head>
<body>
  <script>
    window.top.location.href = ${JSON.stringify(backToAuth)};
  </script>
  <p>Loading Refina…</p>
</body>
</html>`;

  return res.status(200).send(html);
});

/* OAuth callback (OFFLINE complete) */

router.get("/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    // Force-persist offline session.
    try {
      const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;

      if (storage?.storeSession) {
        await storage.storeSession(session);
      }

      console.log("[OAuth] stored session:", {
        id: session?.id,
        isOnline: session?.isOnline,
        shop: session?.shop,
        hasToken: !!session?.accessToken,
      });
    } catch (e) {
      console.warn("[OAuth] storeSession warning:", e?.message || e);
    }

    const shop = session.shop;
    const store = storeFromShop(shop);

    // Register APP_UNINSTALLED using the offline session.
    try {
      const Graphql = shopify?.api?.clients?.Graphql || shopify?.clients?.Graphql;

      if (Graphql) {
        const client = new Graphql({ session });
        const publicBase = (process.env.APP_URL || process.env.HOST || "").replace(/\/$/, "");

        if (publicBase) {
          await registerAppUninstalledWebhook(
            client,
            `${publicBase}/api/privacy/app_uninstalled`
          );
        } else {
          console.warn("[Webhook] APP_URL/HOST not set; skipped APP_UNINSTALLED registration");
        }
      } else {
        console.warn("[Webhook] Graphql client class not found; skipped registration");
      }
    } catch (e) {
      console.warn("[Webhook] APP_UNINSTALLED registration failed:", e?.message || e);
    }

    // Seed storeSettings if missing (non-blocking).
    (async () => {
      try {
        const ref = dbAdmin.doc(`storeSettings/${shop}`);
        const snap = await ref.get();

        if (!snap.exists) {
          const defaults = {
            storeId: shop,
            category: "Beauty",
            aiTone: "professional",
            theme: {
              primaryColor: "#111827",
              accentColor: "#10B981",
              borderRadius: "lg",
              gridColumns: 3,
              buttonStyle: "solid",
            },
            ui: {
              showBadges: true,
              showPrices: true,
              enableModal: true,
            },
            copy: {
              heading: "Find the perfect routine",
              subheading: "Tell Refina your concern and we’ll match expert picks.",
              ctaText: "Ask Refina",
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          await ref.set(defaults, { merge: true });
          console.log("[install] seeded storeSettings for", shop);
        }
      } catch (se) {
        console.warn("[install] storeSettings seed skipped:", se?.message || se);
      }
    })();

    // Redirect to embedded Admin app.
    const adminUrl = new URL(
      `/store/${store}/apps/${process.env.SHOPIFY_APP_HANDLE || "refina"}`,
      "https://admin.shopify.com"
    );

    return res.redirect(302, adminUrl.toString());
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return res.status(401).send("OAuth failed");
  }
});

export default router;