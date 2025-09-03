// refina-backend/routes/adminSettings.js
import { Router } from "express";
// NOTE: I'm assuming dbAdmin is your correctly initialized Firestore instance.
// The file you provided calls it 'db', so ensure this import is correct.
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

/* ───────── Store resolution (No changes needed here) ───────── */
// ... (all the existing shop resolution functions are perfect) ...
const sanitize = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9\-_.]/g, "");
const FULL_SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
function toMyshopifyDomain(raw) { /* ... */ }
function shopFromHostB64(hostB64) { /* ... */ }
function shopFromIdToken(idToken) { /* ... */ }
function resolveShop(source = {}) { /* ... */ }


/* ───────── Router ───────── */

const router = Router();

/** GET /api/admin/store-settings
 * Returns { storeId, settings }.
 */
router.get("/store-settings", async (req, res) => {
  const shop = resolveShop({ ...(req.query || {}), ...(req.headers || {}) });
  if (!shop) return res.status(400).json({ error: "shop required" });

  try {
    const ref = dbAdmin.collection("storeSettings").doc(shop);
    const snap = await ref.get();
    const settings = snap.exists ? (snap.data() || {}) : { plan: "free" };
    res.set("Cache-Control", "no-store");
    return res.json({ storeId: shop, settings });
  } catch (e) {
    console.error("GET /api/admin/store-settings error:", e?.message || e);
    
    // CHANGED: This now correctly reports a server error.
    return res.status(500).json({ error: "read_failed", message: e.message });
  }
});

/** PUT /api/admin/store-settings
 * (No changes needed here, the PUT route is already correct)
 */
router.put("/store-settings", async (req, res) => {
  try {
    const shop = resolveShop({ ...(req.query || {}), ...(req.body || {}), ...(req.headers || {}) });
    if (!shop) return res.status(400).json({ error: "shop required" });

    const settings = req.body?.settings || {};
    const ref = dbAdmin.collection("storeSettings").doc(shop);

    await ref.set({ ...settings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    const fresh = await ref.get();
    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      storeId: shop,
      settings: fresh.exists ? fresh.data() : settings,
    });
  } catch (e) {
    console.error("PUT /api/admin/store-settings error:", e?.message || e);
    return res.status(500).json({ error: "update_failed" });
  }
});

export default router;
