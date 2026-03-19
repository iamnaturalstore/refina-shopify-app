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
    // free: AI off, kept as safety default
    free:    { monthly: 0,     maxProducts: 8,  charBudget: 14000, perMin: 6  },

    // Lite: 300 interactions/month, minimal response
    lite:    { monthly: 300,   maxProducts: 10, charBudget: 14000, perMin: 8  },

    // Growth: 1,000 interactions/month, compact mode
    growth:  { monthly: 1000,  maxProducts: 14, charBudget: 18000, perMin: 10 },

    // Pro: unlimited (monthly: 0), trimmed Awesome
    pro:     { monthly: 0,     maxProducts: 18, charBudget: 24000, perMin: 12 },

    // Premium: unlimited (monthly: 0), full Awesome — legacy tier, keep for existing subscribers
    premium: { monthly: 0,     maxProducts: 22, charBudget: 32000, perMin: 16 },

    // Plus: legacy enterprise
    plus:    { monthly: 25000, perMin: 30, maxProducts: 36, charBudget: 38000 },
  };

  const def = defaultsByLevel[level] || defaultsByLevel.free;

  const monthlyRequests = Number.isFinite(docMonthly) ? docMonthly : (def.monthly ?? 0);
  const perMinuteCeiling = Number.isFinite(docPerMin) ? docPerMin : def.perMin;

  // 2) Determine ON/OFF
  const aiEnabled = (
    level === "lite"    ||
    level === "growth"  ||
    level === "pro"     ||
    level === "premium" ||
    level === "plus"
  ) && status === "ACTIVE";

  if (!aiEnabled) {
    return {
      state: "off",
      message: 'Enable AI answers with Lite ($9), Growth ($19), or Pro ($49).',
      level,
      plan: { level },
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
  const planPeriodStartMs = periodStartTs?.toMillis ? periodStartTs.toMillis() : null;

  if (!planPeriodStartMs || !sameMonth(curWindowStartMs, planPeriodStartMs)) {
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
  const minuteKey = formatMinuteKey(nowDate);
  const minRef = db.collection("aiUsageMinute").doc(storeId);
  const minSnap = await minRef.get();
  const curMinute = minSnap.exists ? (minSnap.data()?.key || "") : "";
  const curCount = minSnap.exists ? Number(minSnap.data()?.count || 0) : 0;

  const withinSameMinute = curMinute === minuteKey;
  const minuteCount = withinSameMinute ? curCount : 0;

  if (perMinuteCeiling > 0 && minuteCount >= perMinuteCeiling) {
    return {
      state: "limited",
      message: "You've hit your plan's per-minute limit. Try again in a moment, or upgrade for more throughput.",
      level,
      plan: { level },
      trim: { maxProducts: def.maxProducts, charBudget: def.charBudget },
    };
  }

  // 5) Check monthly quota — monthly: 0 means unlimited, quota check won't fire
  const freshPlanSnap = await planRef.get();
  const freshPlan = freshPlanSnap.exists ? freshPlanSnap.data() : null;
  const curMonthly = Number(freshPlan?.usage?.requestsThisPeriod ?? 0);

  if (monthlyRequests > 0 && curMonthly >= monthlyRequests) {
    const msg = level === "lite"
      ? `You've used all ${monthlyRequests} interactions this month. Upgrade to Growth for 1,000/month.`
      : level === "growth"
        ? `You've used all ${monthlyRequests} interactions this month. Upgrade to Pro for unlimited.`
        : "You've reached this month's limit. Contact us to increase limits.";

    return {
      state: "limited",
      message: msg,
      level,
      plan: { level },
      trim: { maxProducts: def.maxProducts, charBudget: def.charBudget },
    };
  }

  // 6) OK
  return {
    state: "ok",
    message: null,
    level,
    plan: { level },
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
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}