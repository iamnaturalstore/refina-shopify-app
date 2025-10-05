// refina-backend/lib/session/firestoreSessionStorage.js
"use strict";

import { Session } from "@shopify/shopify-api";
// Uses the unified Firestore initializer (same app/project as BFF)
import { dbAdmin, FieldValue } from "../firestore.js"; // you already have this

const COLL = "shopify_sessions";

/**
 * Firestore-backed CustomSessionStorage for Shopify.
 * Stores both online/offline sessions in a shared collection.
 */
export function createFirestoreSessionStorage() {
  return {
    /** @param {Session} session */
    async storeSession(session) {
      // Persist plain JSON + timestamps
      const data = {
        id: session.id,
        shop: session.shop,
        state: session.state,
        isOnline: !!session.isOnline,
        scope: session.scope || null,
        accessToken: session.accessToken || null,
        expires: session.expires ? session.expires.toISOString() : null,
        onlineAccessInfo: session.onlineAccessInfo || null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await dbAdmin.collection(COLL).doc(session.id).set(data, { merge: true });
      return true;
    },

    /** @param {string} id */
    async loadSession(id) {
      const snap = await dbAdmin.collection(COLL).doc(id).get();
      if (!snap.exists) return undefined;
      const s = snap.data();

      // Rehydrate to a real Session instance
      const sess = new Session({
        id: s.id,
        shop: s.shop,
        state: s.state,
        isOnline: !!s.isOnline,
        scope: s.scope || undefined,
        accessToken: s.accessToken || undefined,
        expires: s.expires ? new Date(s.expires) : undefined,
        onlineAccessInfo: s.onlineAccessInfo || undefined,
      });
      return sess;
    },

    /** @param {string} id */
    async deleteSession(id) {
      await dbAdmin.collection(COLL).doc(id).delete();
      return true;
    },

    /** Optional but helpful for cleanup */
    async deleteSessions(shop) {
      const qs = await dbAdmin.collection(COLL).where("shop", "==", shop).get();
      const batch = dbAdmin.batch();
      qs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      return true;
    },

    /** Optional: list sessions for a shop */
    async findSessionsByShop(shop) {
      const qs = await dbAdmin.collection(COLL).where("shop", "==", shop).get();
      return qs.docs.map((d) => d.data());
    },
  };
}
