// refina-backend/utils/planSync.js - pre CDN-BFF
import { getFirestore } from 'firebase-admin/firestore';

/**
 * plans/{storeId}
 * {
 *   level: 'free' | 'starter' | 'growth' | 'premium' | 'enterprise',
 *   shopDomain: 'my-shop.myshopify.com',
 *   chargeId: 'gid://shopify/AppSubscription/12345' | null,
 *   trialEndsAt: '2025-08-23T00:00:00.000Z' | null,
 *   updatedAt: 'ISO8601 string'
 * }
 */

export async function setPlan({ storeId, shopDomain, level, chargeId = null, trialEndsAt = null }) {
  const db = getFirestore();
  const shortId = (storeId || "").trim() || (shopDomain || "").replace(/\.myshopify\.com$/i, "");
  const longId  = (shopDomain || "").trim() || `${shortId}.myshopify.com`;

  const payload = {
    level,
    shopDomain: longId || undefined,
    chargeId: chargeId ?? null,
    trialEndsAt: trialEndsAt ?? null,
    updatedAt: new Date().toISOString(),
  };

  // Write to both doc IDs to keep them in sync
  await Promise.all([
    db.collection("plans").doc(shortId).set(payload, { merge: true }),
    db.collection("plans").doc(longId).set(payload, { merge: true }),
  ]);
}

export async function getPlan({ storeId, shopDomain }) {
  const db = getFirestore();
  const shortId = (storeId || "").trim() || (shopDomain || "").replace(/\.myshopify\.com$/i, "");
  const longId  = (shopDomain || "").trim() || `${shortId}.myshopify.com`;

  // Prefer short ID; fallback to full domain
  const shortSnap = await db.collection("plans").doc(shortId).get();
  if (shortSnap.exists) return shortSnap.data();

  const longSnap = await db.collection("plans").doc(longId).get();
  return longSnap.exists ? longSnap.data() : null;
}

export async function downgradeToFree({ storeId, shopDomain }) {
  return setPlan({ storeId, shopDomain, level: "free", chargeId: null, trialEndsAt: null });
}

