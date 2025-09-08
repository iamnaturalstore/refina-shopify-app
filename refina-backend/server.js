// refina-backend/server.js (ESM, PROD-ONLY, Admin API & UI)
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";

import shopify from "./shopify.js";
import billingRoutes from "./routes/billing.js";
import settingsRoutes from "./routes/settings.js";

// --- Config ------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "8081", 10);

// Resolve dist relative to this file (not process.cwd())
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_DIST_PATH = join(__dirname, "admin-ui-dist");

// --- App Initialization ------------------------------------------------------
const app = express();

// --- Shopify Auth & Webhook Routes (Public) ----------------------------------
// These routes must come BEFORE any session validation or body parsing.
app.get("/api/auth", async (req, res) => {
  try {
    await shopify.auth.begin({
      shop: shopify.utils.sanitizeShop(req.query.shop, true),
      callbackPath: "/api/auth/callback",
      isOnline: false,
      req,
      res,
    });
  } catch (e) {
    console.error("Auth begin error:", e);
    res.status(500).send(e.message);
  }
});

app.get("/api/auth/callback", async (req, res) => {
  try {
    const callback = await shopify.auth.callback({ req, res });
    res.redirect(`/?shop=${callback.session.shop}&host=${req.query.host}`);
  } catch (e) {
    console.error("Auth callback error:", e);
    res.status(500).send(e.message);
  }
});

// Webhooks require raw body for signature validation.
app.post(
  "/api/webhooks",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      await shopify.webhooks.process({ req, res });
      console.log("Webhook processed successfully.");
    } catch (e) {
      console.error(`Failed to process webhook: ${e.message}`);
      if (!res.headersSent) res.status(500).send(e.message);
    }
  }
);

// --- Security Checkpoint for Shopify Admin API -------------------------------
// All API routes below require a valid session (embedded Admin).
app.use("/api/*", shopify.validateAuthenticatedSession());

// --- Protected Shopify Admin API Routes --------------------------------------
app.use(express.json());
app.use(cors());

// Mount your existing billing routes (unchanged)
app.use("/api/billing", billingRoutes);
app.use("/api/settings", settingsRoutes);

// (Add other Admin API routes here, e.g.)
// app.use("/api/settings", settingsRoutes);
// app.use("/api/analytics", analyticsRoutes);

// --- Admin UI static + SPA mounts -------------------------------------------
// 1) Serve versioned assets (JS/CSS/maps) at /assets
app.use(
  "/assets",
  express.static(join(UI_DIST_PATH, "assets"), {
    immutable: true,
    maxAge: "365d",
  })
);

// 2) Minimal CSP to allow embedding in Shopify Admin (for /admin pages)
app.use(["/admin", "/admin/*"], (_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
  );
  next();
});

// 3) Serve the Admin SPA at /admin (and nested)
app.get(["/admin", "/admin/*"], (_req, res) => {
  res.sendFile(join(UI_DIST_PATH, "index.html"));
});

// --- Server Listen -----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[Admin] Refina Admin API & UI running on :${PORT}`);
  console.log(`[Admin] UI_DIST_PATH → ${UI_DIST_PATH}`);
});
