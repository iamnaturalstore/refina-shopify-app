// refina-backend/utils/planSync.js - full-domain keys only
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) throw new Error("shopDomain/storeId required");
  // Strip protocol + path
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const h = (u.hostname || "").toLowerCase();
      if (!h.endsWith(".myshopify.com")) throw new Error("Invalid shop domain");
      return h;
    }
  } catch { /* ignore */ }
  if (s.endsWith(".myshopify.com")) return s;
  if (s.includes(".")) throw new Error("Invalid shop domain");
  return `${s}.myshopify.com`;
}

function canonicalize({ storeId, shopDomain }) {
  if (shopDomain) return toMyshopifyDomain(shopDomain);
  if (storeId) return toMyshopifyDomain(storeId);
  throw new Error("storeId or shopDomain required");
}

/**
 * plans/{<shop>.myshopify.com}
 * {
 *   level: 'free' | 'starter' | 'growth' | 'premium' | 'enterprise',
 *   shopDomain: 'my-shop.myshopify.com',
 *   chargeId: 'gid://shopify/AppSubscription/12345' | null,
 *   trialEndsAt: '2025-08-23T00:00:00.000Z' | null,
 *   updatedAt: Firestore serverTimestamp()
 * }
 */
export async function setPlan({ storeId, shopDomain, level, chargeId = null, trialEndsAt = null }) {
  const db = getFirestore();
  const shopFull = canonicalize({ storeId, shopDomain });

  const payload = {
    level,
    shopDomain: shopFull,
    chargeId: chargeId ?? null,
    trialEndsAt: trialEndsAt ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await db.collection("plans").doc(shopFull).set(payload, { merge: true });
}

export async function getPlan({ storeId, shopDomain }) {
  const db = getFirestore();
  const shopFull = canonicalize({ storeId, shopDomain });

  // Read the canonical doc
  const longSnap = await db.collection("plans").doc(shopFull).get();
  if (longSnap.exists) return longSnap.data();

  // Optional rescue: if a short doc exists, migrate once
  const short = shopFull.replace(/\.myshopify\.com$/i, "");
  const shortSnap = await db.collection("plans").doc(short).get();
  if (shortSnap.exists) {
    const data = shortSnap.data();
    await db.collection("plans").doc(shopFull).set(
      { ...data, shopDomain: shopFull, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return (await db.collection("plans").doc(shopFull).get()).data();
  }

  return null;
}

export async function downgradeToFree(params) {
  const shopFull = canonicalize(params);
  return setPlan({ shopDomain: shopFull, level: "free", chargeId: null, trialEndsAt: null });
}
