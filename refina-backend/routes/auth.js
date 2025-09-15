// refina-backend/routes/auth.js
"use strict";

import express from "express";
import shopify from "../shopify.js";

const router = express.Router();

/** Guard against open redirects; only allow deep links under /admin-ui */
function sanitizeReturnTo(p) {
  if (!p || typeof p !== "string") return "";
  try {
    if (/^https?:\/\//i.test(p)) return "";   // disallow absolute URLs
    if (!p.startsWith("/admin-ui")) return ""; // only allow our UI scope
    return p.replace(/\/{2,}/g, "/");          // normalize
  } catch {
    return "";
  }
}

/** Minimal cookie reader (no cookie-parser required) */
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

/**
 * Kick off OAuth for a shop.
 * Example: GET /api/auth?shop=refina-demo.myshopify.com[&return_to=/admin-ui/billing]
 */
router.get("/", async (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }

  // Keep host + optional deep-link path for redirects
  const host = req.query.host || Buffer.from(`${shop}/admin`).toString("base64");
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  // Store desired deep link in a short-lived, httpOnly cookie; keep redirect_uri static.
  if (returnTo) {
    res.cookie("refina_return_to", returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 5 * 60 * 1000, // 5 minutes
    });
  }

  try {
    // STATIC callbackPath (must match your Shopify app's whitelisted redirect URLs)
    await shopify.auth.begin({
      shop,
      callbackPath: "/api/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
    // shopify.auth.begin handles the redirect to accounts.shopify.com
  } catch (err) {
    // If Shopify requires a top-level OAuth handoff, bounce to /toplevel
    const needsTop =
      err?.status === 410 || /top.?level|cookie/i.test(String(err?.message || ""));
    if (needsTop) {
      const to =
        `/api/auth/toplevel?shop=${encodeURIComponent(shop)}` +
        `&host=${encodeURIComponent(host)}` +
        (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : "");
      return res.redirect(302, to);
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

/**
 * Top-level handoff required by Shopify OAuth.
 * Sets the cookie the SDK expects, then top-frame redirects back to /api/auth.
 */
router.get("/toplevel", (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }
  const host = req.query.host || Buffer.from(`${shop}/admin`).toString("base64");
  const returnTo = sanitizeReturnTo(String(req.query.return_to || ""));

  // Cookie name/value expected by the Shopify SDK for top-level initiation
  res.cookie("shopifyTopLevelOAuth", "1", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });

  // Persist our deep link here too (when flow starts at /toplevel)
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
    (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : "");

  // Escape the iframe and continue OAuth at top-window
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Redirecting…</title></head>
<body>
<script>window.top.location.href=${JSON.stringify(backToAuth)};</script>
<p>Redirecting…</p>
</body></html>`;
  return res.status(200).send(html);
});

/**
 * OAuth callback target configured in the Partner app.
 * Finishes OAuth then redirects to your embedded Admin UI (deep-link aware).
 *
 * Always redirect TOP FRAME to /admin-ui/, and if a deep link was requested,
 * pass it via ?return_to=... for the SPA to consume.
 */
router.get("/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const shop = session.shop;
    const host = req.query.host || Buffer.from(`${shop}/admin`).toString("base64");

    // Retrieve and clear the deep-link cookie
    const returnToCookie = sanitizeReturnTo(getCookie(req, "refina_return_to"));
    if (returnToCookie) {
      res.cookie("refina_return_to", "", { path: "/", maxAge: 0 });
    }

    // Always send top-frame to app root; carry deep link as a param for the SPA to consume.
    const basePath = "/admin-ui/"; // iframe entry point
    const sep = basePath.includes("?") ? "&" : "?";
    let redirectUrl =
      `${basePath}${sep}shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(host)}&embedded=1`;
    if (returnToCookie) {
      redirectUrl += `&return_to=${encodeURIComponent(returnToCookie)}`;
    }

    return res.redirect(302, redirectUrl);
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return res.status(401).send("OAuth failed");
  }
});

export default router;
