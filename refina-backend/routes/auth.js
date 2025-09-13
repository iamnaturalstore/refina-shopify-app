// refina-backend/routes/auth.js
"use strict";

import express from "express";
import shopify from "../shopify.js";

const router = express.Router();

/**
 * Kick off OAuth for a shop.
 * Example: GET /api/auth?shop=refina-demo.myshopify.com
 */
router.get("/", async (req, res) => {
  const shop = String(req.query.shop || "").toLowerCase();
  if (!shop.endsWith(".myshopify.com")) {
    return res.status(400).send("Missing or invalid ?shop=<shop>.myshopify.com");
  }

  // Keep host param for deep-link friendliness during redirects
  const host = req.query.host || Buffer.from(`${shop}/admin`).toString("base64");

  try {
    // Start OAuth (offline session)
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
      const to = `\ /api/auth/toplevel?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(
        host
      )}`.replace(" ", "");
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

  // Cookie name/value expected by the Shopify SDK for top-level initiation
  res.cookie("shopifyTopLevelOAuth", "1", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });

  const backToAuth = `/api/auth?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(
    host
  )}`;

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
 * Finishes OAuth then redirects to your embedded Admin UI.
 */
router.get("/callback", async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const shop = session.shop;
    const host = req.query.host || Buffer.from(`${shop}/admin`).toString("base64");

    // Land on the app handle (/apps/refina) and instruct Admin to load /admin-ui/ inside the app
    const appLoadPath = encodeURIComponent("/admin-ui");
    return res.redirect(
      302,
      `/admin-ui/?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(host)}`
    );
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return res.status(401).send("OAuth failed");
  }
});

export default router;
