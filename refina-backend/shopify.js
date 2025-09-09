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
import { restResources } from "@shopify/shopify-api/rest/admin/2025-07";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";

// Keep your optional Admin token
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || undefined;

// Anchor the SQLite file next to this file (stable regardless of cwd)
const DB_PATH = path.join(__dirname, "sessions.sqlite");
const sessionStorage = new SQLiteSessionStorage(DB_PATH);
if (typeof sessionStorage.ready !== "undefined") {
  await sessionStorage.ready;
  console.log("Session storage migrations ready →", DB_PATH);
}

// Derive hostName for Shopify WITHOUT touching your env
const rawHost = process.env.HOST || process.env.APP_URL || "";
const hostName = String(rawHost).trim()
  .replace(/^https?:\/\//i, "") // strip protocol if present
  .replace(/\/+$/g, "");        // strip trailing slash(es)

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
console.log("[Shopify] hostName:", hostName || "(missing)","| apiVersion:", shopify.config.apiVersion);

export default shopify;
