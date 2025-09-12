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

  // Start OAuth (offline session)
  await shopify.auth.begin({
    shop,
    callbackPath: "/api/auth/callback",
    isOnline: false,
    rawRequest: req,
    rawResponse: res,
  });
  // shopify.auth.begin handles the redirect to accounts.shopify.com
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
    const appLoadPath = encodeURIComponent("/admin-ui/");
    return res.redirect(
      302,
      `/?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(host)}&appLoadPath=${appLoadPath}`
    );
  } catch (err) {
    console.error("OAuth callback failed:", err);
    return res.status(401).send("OAuth failed");
  }
});

export default router;
