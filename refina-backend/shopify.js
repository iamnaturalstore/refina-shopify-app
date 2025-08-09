// refina/backend/shopify.js

import dotenv from "dotenv"
dotenv.config({ path: "../.env" })

// ✅ Register the required runtime adapter
import "@shopify/shopify-api/adapters/node"

import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api"
import { restResources } from "@shopify/shopify-api/rest/admin/2024-04"
import { MemorySessionStorage } from "./lib/memory-storage.js"

console.log("✅ HOST from .env:", process.env.HOST)

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SCOPES?.split(",") || ["read_products"],
  hostName: (process.env.HOST || "").replace(/^https?:\/\//, ""),
  isEmbeddedApp: true,
  apiVersion: LATEST_API_VERSION,
  restResources,
  sessionStorage: new MemorySessionStorage()
})

export default shopify
