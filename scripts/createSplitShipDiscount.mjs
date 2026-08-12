// scripts/createSplitShipDiscount.mjs
// One-off script: creates the SplitShip automatic discount on a store.
// Usage: node scripts/createSplitShipDiscount.mjs [shop]
//   shop defaults to i-am-natural-shopify-trial.myshopify.com

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHOP = (process.argv[2] || "i-am-natural-shopify-trial.myshopify.com")
  .toLowerCase().trim();
const SESSION_ID = `offline_${SHOP}`;
const API_VERSION = "2025-07";
const GQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const credsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(__dirname, "..", "refina-backend", "secure", "service-account.json");
  const json = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(json) });
  return admin.app();
}

async function gql(token, query, variables) {
  const body = variables ? { query, variables } : { query };
  const resp = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  initFirebase();
  const db = getFirestore();

  console.log(`\nLoading offline session for: ${SHOP}`);
  const snap = await db.collection("shopify_sessions").doc(SESSION_ID).get();
  if (!snap.exists) {
    console.error(`No session found (doc: ${SESSION_ID}). Has the Refina app been installed on this store?`);
    process.exit(1);
  }

  const { accessToken, scope } = snap.data();
  if (!accessToken) {
    console.error("Session exists but has no accessToken.");
    process.exit(1);
  }

  console.log("Session scopes:", scope || "(none recorded)");

  // Step 1: find the SplitShip function GID
  console.log("\nQuerying shopifyFunctions…");
  const fnData = await gql(accessToken, `{
    shopifyFunctions(first: 50) {
      nodes { id title apiType }
    }
  }`);

  const nodes = fnData?.shopifyFunctions?.nodes || [];
  console.log("Functions found:", nodes.map(n => `${n.title} (${n.apiType})`).join(", ") || "(none)");

  const fn = nodes.find(n => n.title === "SplitShip Delivery Discount");
  if (!fn) {
    console.error('\nFunction "SplitShip Delivery Discount" not found. Is the extension deployed to this store?');
    process.exit(1);
  }
  console.log("Function GID:", fn.id);

  // Step 2: create the automatic discount
  console.log("\nCreating automatic discount…");
  const result = await gql(
    accessToken,
    `mutation ($input: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $input) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: "SplitShip Free Shipping",
        functionId: fn.id,
        startsAt: "2025-01-01T00:00:00Z",
      },
    }
  );

  const { automaticAppDiscount, userErrors } = result.discountAutomaticAppCreate;

  if (userErrors?.length) {
    const isDupe = userErrors.some(e => /already exists|duplicate/i.test(e.message));
    if (isDupe) {
      console.log("\nA SplitShip discount already exists on this store. Nothing to do.");
    } else {
      console.error("\nUserErrors:", JSON.stringify(userErrors, null, 2));
      process.exit(1);
    }
    return;
  }

  const discountId = automaticAppDiscount?.discountId;
  const numericId = discountId?.split("/").pop();
  console.log(`\nSplitShip activated!`);
  console.log(`Discount GID : ${discountId}`);
  console.log(`Admin URL   : https://${SHOP}/admin/discounts/${numericId}`);
}

main().catch(e => { console.error(e); process.exit(1); });
