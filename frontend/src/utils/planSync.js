// refina-backend/utils/planSync.js
import { getFirestore } from 'firebase-admin/firestore';

/**
 * plans/{storeId}
 * {
 *   level: 'free' | 'starter' | 'growth' | 'pro+' | 'enterprise',
 *   shopDomain: 'my-shop.myshopify.com',
 *   chargeId: 'gid://shopify/AppSubscription/12345' | null,
 *   trialEndsAt: '2025-08-23T00:00:00.000Z' | null,
 *   updatedAt: 'ISO8601 string'
 * }
 */

export async function setPlan({ storeId, shopDomain, level, chargeId = null, trialEndsAt = null }) {
  const db = getFirestore();
  const ref = db.collection('plans').doc(storeId);
  await ref.set(
    {
      level,
      shopDomain,
      chargeId: chargeId ?? null,
      trialEndsAt: trialEndsAt ?? null,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

export async function getPlan({ storeId }) {
  const db = getFirestore();
  const snap = await db.collection('plans').doc(storeId).get();
  return snap.exists ? snap.data() : null;
}

export async function downgradeToFree({ storeId, shopDomain }) {
  return setPlan({ storeId, shopDomain, level: 'free', chargeId: null, trialEndsAt: null });
}
