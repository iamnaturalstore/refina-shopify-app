// refina-backend/lib/usage.js
import { dbAdmin as db, FieldValue } from "../bff/lib/firestore.js";
import { Timestamp } from "firebase-admin/firestore";

export async function incrementOnInvoke(storeId, { count = 1 } = {}) {
  if (!storeId) return;

  const planRef   = db.collection("plans").doc(storeId);
  const minuteRef = db.collection("aiUsageMinute").doc(storeId);
  const now       = Timestamp.now().toDate();
  const minuteKey = formatMinuteKey(now);

  try {
    await db.runTransaction(async (tx) => {

  // ── ALL READS FIRST ──
  const planSnap = await tx.get(planRef);
  const minSnap  = await tx.get(minuteRef);

  // ── COMPUTE ──
  const plan    = planSnap.exists ? planSnap.data() : {};
  const usage   = plan?.usage || {};
  const current = Number(usage.requestsThisPeriod || 0);

  const periodStartTs  = usage.periodStart || null;
  const periodStartMs  = periodStartTs?.toMillis ? periodStartTs.toMillis() : null;
  const curStart       = monthStart(now);
  const monthChanged   = !periodStartMs || !sameMonth(periodStartMs, curStart.getTime());
  const nextRequests   = monthChanged ? count : current + count;

  const curKey           = minSnap.exists ? (minSnap.data()?.key || "") : "";
  const curCount         = minSnap.exists ? Number(minSnap.data()?.count || 0) : 0;
  const withinSameMinute = curKey === minuteKey;
  const nextMinuteCount  = withinSameMinute ? curCount + count : count;

  // ── ALL WRITES AFTER ──
  tx.set(planRef, {
    usage: {
      periodStart:         monthChanged
                             ? Timestamp.fromDate(curStart)
                             : periodStartTs || Timestamp.fromDate(curStart),
      requestsThisPeriod:  nextRequests,
    },
    updatedAt: FieldValue.serverTimestamp(),
    _source:   "bff:usage-increment",
  }, { merge: true });

  tx.set(minuteRef, {
    key:   minuteKey,
    count: nextMinuteCount,
    ts:    FieldValue.serverTimestamp(),
  }, { merge: true });
});

  } catch (e) {
    console.error("[usage] TRANSACTION FAILED:", e?.code, e?.message, String(e));
  }
}

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