// refina-backend/routes/billing.js
import express from "express";
import shopify from "../shopify.js";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config({ path: "../.env" });

// --- Firebase Admin (keep your pattern) ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_KEY)),
  });
}
const db = admin.firestore();

const router = express.Router();

// --- Config ---
const BILLING_TEST_MODE = String(process.env.BILLING_TEST_MODE ?? "true") === "true";
const CURRENCY = process.env.BILLING_CURRENCY || "AUD";
const RETURN_PATH = process.env.BILLING_RETURN_PATH || "/api/billing/thanks";

// --- App Plans (AUD) ---
const PLAN_DEFS = {
  starter: { name: "Refina Starter", amount: 19.99, interval: "EVERY_30_DAYS", trialDays: 0 },
  growth:  { name: "Refina Growth",  amount: 39.99, interval: "EVERY_30_DAYS", trialDays: 0 },
  "pro+":  { name: "Refina Pro+",    amount: 79.99, interval: "EVERY_30_DAYS", trialDays: 14 },
};

// Helper: normalize storeId from shop domain
function toStoreId(shopDomain) {
  return shopDomain.replace(".myshopify.com", "");
}

// --- STEP 1: Start billing (redirect merchant to Shopify confirmation) ---
// Accepts: GET /start?plan=starter|growth|pro+
router.get("/start", async (req, res) => {
  const session = res.locals.shopify?.session;
  if (!session) {
    console.warn("⚠️ /billing/start without valid Shopify session");
    return res.status(401).send("Missing Shopify session. Open from inside Shopify Admin.");
  }

  const planKey = (req.query.plan || "").toLowerCase();
  const def = PLAN_DEFS[planKey];
  if (!def) {
    return res.status(400).send("Unknown or missing plan. Use ?plan=starter|growth|pro+");
  }

  try {
    const client = new shopify.api.clients.Graphql({ session });
    const returnUrl = `https://${session.shop}${RETURN_PATH}`;

    const mutation = `
      mutation appSubscriptionCreate(
        $name: String!,
        $returnUrl: URL!,
        $test: Boolean!,
        $trialDays: Int!,
        $lineItems: [AppSubscriptionLineItemInput!]!
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          trialDays: $trialDays
          lineItems: $lineItems
        ) {
          userErrors { field message }
          confirmationUrl
        }
      }
    `;

    const variables = {
      name: def.name,
      returnUrl,
      test: BILLING_TEST_MODE,
      trialDays: def.trialDays,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: def.amount, currencyCode: CURRENCY },
              interval: def.interval,
            },
          },
        },
      ],
    };

    const resp = await client.request(mutation, variables);
    const result = resp?.data?.appSubscriptionCreate;
    if (result?.userErrors?.length) {
      console.error("appSubscriptionCreate errors", result.userErrors);
      return res.status(400).send(result.userErrors.map(e => e.message).join(", "));
    }

    const confirmationUrl = result?.confirmationUrl;
    if (!confirmationUrl) return res.status(500).send("No confirmation URL returned from Shopify.");

    // Redirect to Shopify confirmation screen
    return res.redirect(confirmationUrl);
  } catch (err) {
    console.error("❌ Billing /start error:", err);
    return res.status(500).send("Error creating billing session");
  }
});

// --- STEP 2: After confirmation, Shopify redirects back to RETURN_PATH ---
// This route queries active subscriptions, maps to our plan, and writes Firestore plans/{storeId}
router.get("/thanks", async (req, res) => {
  const session = res.locals.shopify?.session;
  if (!session) {
    // Fallback for cases where session isn't injected (rare); try loading by shop param
    const { shop } = req.query;
    if (!shop) {
      console.warn("⚠️ /billing/thanks without session or shop");
      return res.status(401).send("Missing Shopify session.");
    }
    try {
      const found = await shopify.api.session.storage.findByShop(shop);
      if (!found) return res.status(401).send("Missing Shopify session for shop");
      res.locals.shopify = { session: found };
    } catch (e) {
      console.error("❌ Could not recover session:", e);
      return res.status(401).send("Missing Shopify session.");
    }
  }

  try {
    const { session: s } = res.locals.shopify;
    const client = new shopify.api.clients.Graphql({ session: s });

    const query = `
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            trialDays
            trialEndAt
            createdAt
            lineItems {
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    price { amount currencyCode }
                    interval
                  }
                }
              }
            }
          }
        }
      }
    `;

    const r = await client.request(query);
    const subs = r?.data?.currentAppInstallation?.activeSubscriptions || [];

    const storeId = toStoreId(s.shop);

    if (!subs.length) {
      // nothing active -> free
      await db.collection("plans").doc(storeId).set(
        {
          level: "free",
          shopDomain: s.shop,
          chargeId: null,
          trialEndsAt: null,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      return res.redirect(`/admin?plan=free`);
    }

    // most recent active sub
    subs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const sub = subs[0];

    // Map by name (preferred) or price fallback
    const byName =
      (sub.name?.includes("Refina Pro+") && "pro+") ||
      (sub.name?.includes("Refina Growth") && "growth") ||
      (sub.name?.includes("Refina Starter") && "starter") ||
      null;

    let level = byName;
    if (!level) {
      const p = sub.lineItems?.[0]?.plan?.pricingDetails;
      const amt = p?.price?.amount;
      if (amt === 79.99) level = "pro+";
      else if (amt === 39.99) level = "growth";
      else if (amt === 19.99) level = "starter";
      else level = "free";
    }

    await db.collection("plans").doc(storeId).set(
      {
        level,
        shopDomain: s.shop,
        chargeId: sub.id,
        trialEndsAt: sub.trialEndAt ?? null,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    // Back to your admin (adjust if your admin route differs)
    return res.redirect(`/admin?plan=${encodeURIComponent(level)}`);
  } catch (err) {
    console.error("❌ Billing /thanks error:", err);
    return res.redirect(`/admin?billingError=1`);
  }
});

// --- STEP 3: Read current plan (for Admin UI) ---
router.get("/current", async (_req, res) => {
  try {
    const session = res.locals.shopify?.session;
    if (!session) return res.json({ ok: true, plan: { level: "free" } });

    const storeId = toStoreId(session.shop);
    const snap = await db.collection("plans").doc(storeId).get();
    const plan = snap.exists ? snap.data() : { level: "free" };
    return res.json({ ok: true, plan });
  } catch (e) {
    console.error("❌ Billing /current error:", e);
    return res.status(500).json({ ok: false, error: "Failed to fetch plan" });
  }
});

export default router;
