// refina-backend/routes/auth.js
"use strict";

import express from "express";
import shopify from "../shopify.js";

const router = express.Router();

/* ─────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────── */

function sanitizeReturnTo(p) {
  if (!p || typeof p !== "string") return "";
  try {
    if (/^https?:\/\//i.test(p)) return "";      // disallow absolute URLs
    if (!p.startsWith("/admin-ui")) return "";   // only allow our UI scope
    return p.replace(/\/{2,}/g, "/");            // normalize
  } catch { return ""; }
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
  const host  = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function storeFromShop(shop) {
  return String(shop || "").toLowerCase().replace(/\.myshopify\.com$/, "");
}

/* ─────────────────────────────────────────────────────────────
   Begin OAuth (OFFLINE)
   ───────────────────────────────────────────────────────────── */

router.get("/", async (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }

  const host = String(req.query.host || "") || computeHostFromShop(shop);
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  // Persist deep link for after OAuth (top frame cannot safely carry dynamic redirect_uri)
  if (returnTo) {
    res.cookie("refina_return_to", returnTo, {
      httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 5 * 60 * 1000,
    });
  }

  try {
    await shopify.auth.begin({
      shop,
      callbackPath: "/api/auth/callback",   // STATIC — must match your app’s whitelist
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
    // Redirect to accounts.shopify.com handled by SDK
  } catch (err) {
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

/* ─────────────────────────────────────────────────────────────
   Top-level handoff required by Shopify OAuth
   ───────────────────────────────────────────────────────────── */

router.get("/toplevel", (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }
  const host = String(req.query.host || "") || computeHostFromShop(shop);
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  // Shopify SDK marker for top-level initiation
  res.cookie("shopifyTopLevelOAuth", "1", { httpOnly: true, secure: true, sameSite: "strict" });

  // Also persist our deep link here (if flow starts at toplevel)
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

/* ─────────────────────────────────────────────────────────────
   OAuth callback (OFFLINE complete) → send TOP FRAME to Admin apps/refina
   ───────────────────────────────────────────────────────────── */

router.get("/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({ rawRequest: req, rawResponse: res });

    const shop = session.shop;
    const store = storeFromShop(shop);

    // Don’t send the top frame to our domain (App Bridge would try /apps/admin-ui and 404).
    // Send it directly to the Shopify Admin app handle instead.
    const adminUrl = new URL(`/store/${store}/apps/refina`, "https://admin.shopify.com");
    return res.redirect(302, adminUrl.toString());
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return res.status(401).send("OAuth failed");
  }
});

/* ─────────────────────────────────────────────────────────────
   Embedded entrypoint (application_url in shopify.app.toml)
   Convert to our SPA route and pass along any deep link
   ───────────────────────────────────────────────────────────── */

router.get("/embedded", (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    // Basic guard; embedded hits always carry shop/host
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }
  const host = String(req.query.host || "") || computeHostFromShop(shop);

  // Pull and clear deep-link cookie
  const returnTo = sanitizeReturnTo(getCookie(req, "refina_return_to"));
  if (returnTo) {
    res.cookie("refina_return_to", "", { path: "/", maxAge: 0 });
  }

  // Now safely move the IFRAME to our SPA, inside our domain
  const target = new URL("/admin-ui/", baseUrl(req));
  target.searchParams.set("shop", shop);
  target.searchParams.set("host", host);
  target.searchParams.set("embedded", "1");
  if (returnTo) target.searchParams.set("return_to", returnTo);

  return res.redirect(302, target.toString());
});

export default router;
