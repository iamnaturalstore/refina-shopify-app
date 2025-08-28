// refina-backend/utils/planSync.js - full-domain keys only
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) throw new Error("shopDomain required");
  // Accept full domain or URL with full domain; reject bare handles
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const h = (u.hostname || "").toLowerCase();
      if (!h.endsWith(".myshopify.com")) throw new Error("Invalid shop domain");
      return h;
    }
  } catch { /* ignore */ }
  if (s.endsWith(".myshopify.com")) return s;
  throw new Error("Invalid shop domain");
}

function canonicalize({ shopDomain }) {
  if (shopDomain) return toMyshopifyDomain(shopDomain);
  throw new Error("shopDomain required");
}

/**
 * plans/{<shop>.myshopify.com}
 * {
 *   level: 'free' | 'starter' | 'growth' | 'premium' | 'enterprise',
 *   shopDomain: 'my-shop.myshopify.com',
 *   chargeId: 'gid://shopify/AppSubscription/12345' | null,
 *   trialEndsAt: '2025-08-23T00:00:00.000Z' | null,
 *   updatedAt: FieldValue.serverTimestamp()
 * }
 */
export async function setPlan({ shopDomain, level, chargeId = null, trialEndsAt = null }) {
  const db = getFirestore();
  const shopFull = canonicalize({ shopDomain });

  const payload = {
    level,
    shopDomain: shopFull,
    chargeId: chargeId ?? null,
    trialEndsAt: trialEndsAt ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await db.collection("plans").doc(shopFull).set(payload, { merge: true });
}

export async function getPlan({ shopDomain }) {
  const db = getFirestore();
  const shopFull = canonicalize({ shopDomain });

  // Read the canonical doc only (no short-ID migration)
  const longSnap = await db.collection("plans").doc(shopFull).get();
  if (longSnap.exists) return longSnap.data();

  return null;
}

export async function downgradeToFree(params) {
  const shopFull = canonicalize({ shopDomain: params.shopDomain });
  return setPlan({ shopDomain: shopFull, level: "free", chargeId: null, trialEndsAt: null });
}
