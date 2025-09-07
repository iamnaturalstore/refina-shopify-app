
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

/* Load env from <repo>/.env BEFORE importing shopify.js */
dotenv.config({ path: path.join(repoRoot, ".env") });

const { default: shopify } = await import("../refina-backend/shopify.js");

const s = shopify;
const graphqlClientPath =
  (s?.api?.clients?.Graphql && "api.clients.Graphql") ||
  (s?.clients?.Graphql && "clients.Graphql") ||
  "MISSING";

console.log({
  hasApi: !!s.api,
  hasApiClients: !!s?.api?.clients,
  hasClients: !!s.clients,
  graphqlClientPath,
});

const pkg = await import("@shopify/shopify-api/package.json");
console.log({ shopifyApiVersion: pkg.version });
