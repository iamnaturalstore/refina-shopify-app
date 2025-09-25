// refina-backend/shopify.js

// Load ONLY the repo-root .env (../.env)
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ─────────────────────────────────────────────────────────────
// Shopify SDK wiring (no env mutation)
// ─────────────────────────────────────────────────────────────
import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";

// 🔁 Firestore-backed session storage (shared across instances)
import { createFirestoreSessionStorage } from "./lib/session/firestoreSessionStorage.js";

// Keep your optional Admin token
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || undefined;

// Derive hostName for Shopify WITHOUT touching your env
const rawHost = process.env.HOST || process.env.APP_URL || "";
const hostName = String(rawHost).trim()
  .replace(/^https?:\/\//i, "") // strip protocol if present
  .replace(/\/+$/g, "");        // strip trailing slash(es)

// Use Firestore-backed storage so sessions are shared across instances
const sessionStorage = createFirestoreSessionStorage();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: (process.env.SCOPES || "read_products").split(","),
  hostName, // computed from your HOST/APP_URL, env left intact
  isEmbeddedApp: true,
  apiVersion: LATEST_API_VERSION,
  restResources,
  sessionStorage,
  ...(ADMIN_TOKEN ? { adminApiAccessToken: ADMIN_TOKEN } : {}),
});

// Minimal visibility (no secrets logged)
console.log(
  "[Shopify] hostName:",
  hostName || "(missing)",
  "| apiVersion:",
  shopify.config.apiVersion,
  "| storage: Firestore"
);

export default shopify;
