// refina-backend/bff/ai/guard.js
// Centralized AI gate: plan on/off, per-minute ceiling, monthly quota, trims.
// No env reads. Safe defaults if plan doc is sparse.

// Use the same admin singleton as billing.js to avoid init-order issues
import { dbAdmin as db, FieldValue } from "../../lib/firestore.js";
import { Timestamp } from "firebase-admin/firestore";


/**
 * Return shape:
 * {
 *   state: "off" | "limited" | "ok",
 *   message: string | null,
 *   trim: { maxProducts: number, charBudget: number }
 * }
 */
export async function aiGuard({ storeId, intent, longForm = false, expectedPromptChars = 0 }) {


  // 1) Read plan (server-authoritative)
  const planRef = db.collection("plans").doc(storeId);
  const planSnap = await planRef.get();
  const plan = planSnap.exists ? planSnap.data() : null;

  // Helper: normalize level
  const level = String(plan?.level || "free").toLowerCase();
  const status = String(plan?.status || "NONE").toUpperCase();

  // Plan-derived entitlements (prefer doc; else safe defaults)
  const docMonthly = Number(plan?.entitlements?.quota?.monthlyRequests ?? NaN);
  const docPerMin = Number(plan?.entitlements?.quota?.perMinuteCeiling ?? NaN);

  const defaultsByLevel = {
    free:    { monthly: 0,     perMin: 0,  maxProducts: 0,  charBudget: 8000 },
    pro:     { monthly: 2000,  perMin: 10, maxProducts: 14, charBudget: 18000 },
    premium: { monthly: 10000, perMin: 20, maxProducts: 24, charBudget: 28000 },
    plus:    { monthly: 25000, perMin: 30, maxProducts: 36, charBudget: 38000 }, // 32–40 → pick 36 center
  };
  const def = defaultsByLevel[level] || defaultsByLevel.free;

  const monthlyRequests = Number.isFinite(docMonthly) ? docMonthly : def.monthly;
  const perMinuteCeiling = Number.isFinite(docPerMin) ? docPerMin : def.perMin;

  // 2) Determine ON/OFF
  const aiEnabled = (level === "pro" || level === "premium" || level === "plus") && status === "ACTIVE";
  if (!aiEnabled) {
    return {
      state: "off",
      message:
        'Turn on AI answers with Pro — 2,000 AI requests/mo, $19. 7-day trial.',
      trim: { maxProducts: def.maxProducts, charBudget: def.charBudget },
    };
  }

  // 3) Reset monthly window if calendar month changed
  //    - usage.periodStart: Timestamp of current monthly window start
  //    - usage.requestsThisPeriod: number
  const now = Timestamp.now();
  const nowDate = now.toDate();
  const curWindowStart = monthStart(nowDate);
  const curWindowStartMs = curWindowStart.getTime();

  const periodStartTs = plan?.usage?.periodStart || null;
  const requestsThisPeriod = Number(plan?.usage?.requestsThisPeriod ?? 0);
  const planPeriodStartMs = periodStartTs?.toMillis ? periodStartTs.toMillis() : null;

  if (!planPeriodStartMs || !sameMonth(curWindowStartMs, planPeriodStartMs)) {
    // Reset monthly usage at month boundary, but only usage fields.
    await planRef.set(
      {
        usage: {
          periodStart: Timestamp.fromDate(curWindowStart),
          requestsThisPeriod: 0,
        },
        updatedAt: FieldValue.serverTimestamp(),
        _source: "bff:month-rollover",
      },
      { merge: true }
    );
  }

  // 4) Check per-minute window in a separate runtime doc
  const minuteKey = formatMinuteKey(nowDate); // e.g., "2025-10-06T12:34"
  const minRef = db.collection("aiUsageMinute").doc(storeId);
  const minSnap = await minRef.get();
  const curMinute = minSnap.exists ? (minSnap.data()?.key || "") : "";
  const curCount = minSnap.exists ? Number(minSnap.data()?.count || 0) : 0;

  const withinSameMinute = curMinute === minuteKey;
  const minuteCount = withinSameMinute ? curCount : 0;

  if (perMinuteCeiling > 0 && minuteCount >= perMinuteCeiling) {
    return {
      state: "limited",
      message:
        "You’ve hit your plan’s per-minute limit. Try again in a moment, or upgrade for more throughput.",
      trim: { maxProducts: def.maxProducts, charBudget: def.charBudget },
    };
  }

  // 5) Check monthly quota from plan doc (after potential month reset)
  const freshPlanSnap = await planRef.get();
  const freshPlan = freshPlanSnap.exists ? freshPlanSnap.data() : null;
  const curMonthly = Number(freshPlan?.usage?.requestsThisPeriod ?? 0);

  if (monthlyRequests > 0 && curMonthly >= monthlyRequests) {
    const msg =
      level === "premium"
        ? "You’re above 80% this month. Talk to us about Plus."
        : "You’ve reached your plan’s monthly limit. Consider upgrading for more AI answers.";
    return {
      state: "limited",
      message: msg,
      trim: { maxProducts: def.maxProducts, charBudget: def.charBudget },
    };
  }

  // 6) OK — return trims (could be used to clamp finalists/prompt size)
  return {
    state: "ok",
    message: null,
    trim: { maxProducts: def.maxProducts, charBudget: def.charBudget },
  };
}

// Helpers

function monthStart(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function sameMonth(aMs, bMs) {
  const a = new Date(aMs), b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
function formatMinuteKey(d) {
  // YYYY-MM-DDTHH:MM (minute granularity)
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
