import express from "express";
import { dbAdmin, FieldValue } from "../firebaseAdmin.js";

const router = express.Router();

// POST /api/admin/analytics/ingest
router.post("/ingest", async (req, res) => {
  try {
    const { storeId, type, concern, product, createdAt } = req.body || {};

    if (!storeId || !storeId.endsWith(".myshopify.com")) {
      return res.status(400).json({ ok: false, error: "Invalid storeId" });
    }

    await dbAdmin.collection("analyticsLogs").add({
      storeId,
      type: type || "concern",
      concern: concern ?? null,
      product: product ?? null,
      productIds: [],
      summary: "",
      createdAt: createdAt || new Date().toISOString(),
      ts: FieldValue.serverTimestamp(),
      plan: "unknown",
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[analytics ingest] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
