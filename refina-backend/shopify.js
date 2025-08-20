// refina-backend/shopify.js
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import "@shopify/shopify-api/adapters/node";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import { restResources } from "@shopify/shopify-api/rest/admin/2025-07"; // aligned with LATEST_API_VERSION
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import path from "path";
import { fileURLToPath } from "url";

const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN || undefined;

console.log("✅ HOST from .env:", process.env.HOST);

// Anchor the SQLite file next to this file (stable regardless of cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "sessions.sqlite");

// Initialize SQLite storage and await readiness if exposed
const sessionStorage = new SQLiteSessionStorage(DB_PATH);
if (typeof sessionStorage.ready !== "undefined") {
  await sessionStorage.ready;
  console.log("Session storage migrations ready →", DB_PATH);
}

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: (process.env.SCOPES || "read_products").split(","),
  hostName: (process.env.HOST || "").replace(/^https?:\/\//, ""),
  isEmbeddedApp: true,
  apiVersion: LATEST_API_VERSION,
  restResources,
  sessionStorage,

  // Dev-only: allows customAppSession if token present; not used in prod flows.
  ...(ADMIN_TOKEN ? { adminApiAccessToken: ADMIN_TOKEN } : {}),
});

console.log(
  "Session storage:",
  shopify.config?.sessionStorage?.constructor?.name,
  "→",
  DB_PATH
);

export default shopify;
