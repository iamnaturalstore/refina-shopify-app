// refina-backend/routes/auth.js
"use strict";

import express from "express";
import shopify from "../shopify.js";

const router = express.Router();

/* ───────── helpers ───────── */

function sanitizeReturnTo(p) {
  if (!p || typeof p !== "string") return "";
  try {
    if (/^https?:\/\//i.test(p)) return "";     // disallow absolute URLs
    if (!p.startsWith("/admin-ui")) return "";  // only allow our UI scope
    return p.replace(/\/{2,}/g, "/");           // normalize
  } catch { return ""; }
}

function getCookie(req, name) {
  const raw = req.headers?.cookie || "";
  const parts = raw.split(/; */);
  for (const p of parts) {
    const eq = p.indexOf("=");
    const k = decodeURIComponent((eq === -1 ? p : p.slice(0, eq)).trim());
    if (k === name) return decodeURIComponent((eq === -1 ? "" : p.slice(eq + 1)).trim());
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
  const host  = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function storeFromShop(shop) {
  return String(shop || "").toLowerCase().replace(/\.myshopify\.com$/, "");
}

/* ───────── OAuth (offline) ───────── */

router.get("/", async (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }

  const host = String(req.query.host || "") || computeHostFromShop(shop);
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  // ✅ Proactive top-level hop: if the marker cookie isn't set, go to /toplevel first.
  const hasTop = getCookie(req, "shopifyTopLevelOAuth") === "1";
  if (!hasTop) {
    const toplevel = new URL("/api/auth/toplevel", baseUrl(req));
    toplevel.searchParams.set("shop", shop);
    if (host) toplevel.searchParams.set("host", host);
    if (returnTo) toplevel.searchParams.set("return_to", returnTo);
    return res.redirect(302, toplevel.toString());
  }

  // Persist deep link for after OAuth; keep redirect_uri static.
  if (returnTo) {
    res.cookie("refina_return_to", returnTo, {
      httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 5 * 60 * 1000,
    });
  }

  try {
    await shopify.auth.begin({
      shop,
      callbackPath: "/api/auth/callback",   // STATIC (must be whitelisted)
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (err) {
    // If something still complains about top-level/cookies, bounce once more.
    const needsTop = err?.status === 410 || /top.?level|cookie/i.test(String(err?.message || ""));
    if (needsTop) {
      const to =
        `/api/auth/toplevel?shop=${encodeURIComponent(shop)}` +
        `&host=${encodeURIComponent(host)}` +
        (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : "");
      return res.redirect(302, to);
    }
    console.error("OAuth begin failed", { shop, host, path: req.originalUrl, message: err?.message, name: err?.name });
    return res.status(500).send(`OAuth begin failed: ${err?.message || String(err)}`);
  }
});


/* Top-level handoff required by Shopify OAuth */
router.get("/toplevel", (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }
  const host = String(req.query.host || "") || computeHostFromShop(shop);
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  res.cookie("shopifyTopLevelOAuth", "1", { httpOnly: true, secure: true, sameSite: "strict" });

  if (returnTo) {
    res.cookie("refina_return_to", returnTo, {
      httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 5 * 60 * 1000,
    });
  }

  const backToAuth =
    `/api/auth?shop=${encodeURIComponent(shop)}` +
    `&host=${encodeURIComponent(host)}` +
    (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : "");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Redirecting…</title></head>
<body>
<script>window.top.location.href=${JSON.stringify(backToAuth)};</script>
<p>Redirecting…</p>
</body></html>`;
  return res.status(200).send(html);
});

/* OAuth callback (OFFLINE complete) → send TOP FRAME to Admin /apps/refina */
router.get("/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({ rawRequest: req, rawResponse: res });

    // ── NEW: force-persist the session, just in case the SDK didn’t.
    try {
      const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
      if (storage?.storeSession) await storage.storeSession(session);
      console.log("[OAuth] stored session:", {
        id: session?.id, isOnline: session?.isOnline, shop: session?.shop, hasToken: !!session?.accessToken,
      });
    } catch (e) {
      console.warn("[OAuth] storeSession warning:", e?.message || e);
    }

    const shop = session.shop;
    const store = storeFromShop(shop);

    // Send the TOP FRAME to Shopify Admin app handle (avoids /apps/admin-ui 404s).
    const adminUrl = new URL(`/store/${store}/apps/refina`, "https://admin.shopify.com");
    return res.redirect(302, adminUrl.toString());
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return res.status(401).send("OAuth failed");
  }
});

/* Embedded entrypoint (application_url in shopify.app.toml) */
router.get("/embedded", (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }
  const host = String(req.query.host || "") || computeHostFromShop(shop);

  const returnTo = sanitizeReturnTo(getCookie(req, "refina_return_to"));
  if (returnTo) res.cookie("refina_return_to", "", { path: "/", maxAge: 0 });

  const target = new URL("/admin-ui/", baseUrl(req));
  target.searchParams.set("shop", shop);
  target.searchParams.set("host", host);
  target.searchParams.set("embedded", "1");
  if (returnTo) target.searchParams.set("return_to", returnTo);

  return res.redirect(302, target.toString());
});

/* ───────── OPTIONAL: debug-only endpoint to confirm offline session exists ─────────
   Enable by setting env ENABLE_DEBUG_ROUTES=1 in Render.
   Does NOT require JWT; safe to disable afterward.
*/
if (String(process.env.ENABLE_DEBUG_ROUTES || "") === "1") {
  router.get("/debug/offline", async (req, res) => {
    try {
      const shop = String(req.query.shop || "").toLowerCase();
      if (!shop.endsWith(".myshopify.com")) return res.status(400).json({ error: "bad shop" });
      const id = shopify.session.getOfflineId(shop);
      const storage = shopify.sessionStorage ?? shopify.config?.sessionStorage;
      const sess = storage?.loadSession ? await storage.loadSession(id) : null;
      return res.json({
        shop,
        offlineId: id,
        hasSession: !!sess,
        hasToken: !!sess?.accessToken,
        isOnline: !!sess?.isOnline,
        expires: sess?.expires ?? null,
      });
    } catch (e) {
      console.error("/debug/offline error", e);
      return res.status(500).json({ error: "debug failed" });
    }
  });
}

export default router;
