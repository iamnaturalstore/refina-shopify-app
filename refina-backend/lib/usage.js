// refina-backend/lib/usage.js
// Atomic usage increment when the model is actually invoked.
// - Monthly counter lives on plans/{storeId}.usage.requestsThisPeriod
// - Per-minute counter lives on aiUsageMinute/{storeId} (runtime doc)

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

export async function incrementOnInvoke(storeId, { count = 1 } = {}) {
  if (!storeId) return;
  const db = getFirestore();

  const planRef = db.collection("plans").doc(storeId);
  const minuteRef = db.collection("aiUsageMinute").doc(storeId);

  const now = Timestamp.now().toDate();
  const minuteKey = formatMinuteKey(now);

  try {
    await db.runTransaction(async (tx) => {
      // Read plan for monthly usage
      const planSnap = await tx.get(planRef);
      const plan = planSnap.exists ? planSnap.data() : {};
      const usage = plan?.usage || {};
      const current = Number(usage.requestsThisPeriod || 0);

      // If month flipped and guard hasn’t reset yet, perform a lazy reset here.
      const periodStartTs = usage.periodStart || null;
      const periodStartMs = periodStartTs?.toMillis ? periodStartTs.toMillis() : null;
      const curStart = monthStart(now);
      const curStartMs = curStart.getTime();
      const monthChanged = !periodStartMs || !sameMonth(periodStartMs, curStartMs);

      const nextRequests = monthChanged ? count : current + count;

      tx.set(
        planRef,
        {
          usage: {
            periodStart: monthChanged ? Timestamp.fromDate(curStart) : periodStartTs || Timestamp.fromDate(curStart),
            requestsThisPeriod: nextRequests,
          },
          updatedAt: FieldValue.serverTimestamp(),
          _source: "bff:usage-increment",
        },
        { merge: true }
      );

      // Per-minute counter (runtime doc)
      const minSnap = await tx.get(minuteRef);
      const curKey = minSnap.exists ? (minSnap.data()?.key || "") : "";
      const curCount = minSnap.exists ? Number(minSnap.data()?.count || 0) : 0;
      const withinSameMinute = curKey === minuteKey;
      const nextMinuteCount = withinSameMinute ? curCount + count : count;

      tx.set(
        minuteRef,
        {
          key: minuteKey,
          count: nextMinuteCount,
          ts: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  } catch {
    // Swallow increment errors — recommendation should not fail on metering issues
  }
}

// Helpers (same as guard)
function monthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function sameMonth(aMs, bMs) {
  const a = new Date(aMs), b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
function formatMinuteKey(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
