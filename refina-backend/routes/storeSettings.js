// refina-backend/routes/storeSettings.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin'); // must be initialized elsewhere
const db = admin.firestore();

function getStoreId(req) {
  // Adapt to your auth/session shape
  return (
    req.user?.shop ||
    req.session?.shop ||
    req.query.shop ||
    req.headers['x-shop'] ||
    null
  );
}

async function getFeatureFlags(storeId) {
  const globalRef = db.collection('flags').doc('global');
  const storeRef = storeId ? db.collection('flags').doc(storeId) : null;

  const [globalSnap, storeSnap] = await Promise.all([
    globalRef.get().catch(() => null),
    storeRef ? storeRef.get().catch(() => null) : [null],
  ]);

  const global = globalSnap?.exists ? globalSnap.data() : {};
  const store = storeSnap?.exists ? storeSnap.data() : {};

  return {
    enableTheming: Boolean(store.enableTheming ?? global.enableTheming ?? false),
    enableAIControls: Boolean(store.enableAIControls ?? global.enableAIControls ?? false),
  };
}

function sanitizeTheme(input = {}) {
  // Whitelist allowed keys; ignore anything else
  const t = input.tokens || {};
  const tokens = {
    bg: t.bg, surface: t.surface, text: t.text, muted: t.muted,
    primary: t.primary, accent: t.accent, border: t.border,
    radius: t.radius, shadow: t.shadow, gap: t.gap, pad: t.pad,
    fontBody: t.fontBody, fontHeadings: t.fontHeadings,
    fontSize: t.fontSize, lineHeight: t.lineHeight,
  };
  // drop undefined keys
  Object.keys(tokens).forEach(k => tokens[k] === undefined && delete tokens[k]);
  return {
    preset: input.preset || 'Classic',
    version: Number(input.version || 1),
    tokens,
  };
}

// GET current store settings (+ flags)
router.get('/store-settings', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'Missing storeId' });

    const ref = db.collection('storeSettings').doc(storeId);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};

    const featureFlags = await getFeatureFlags(storeId);

    // Additive: always include these keys (may be empty)
    const payload = {
      category: data.category || '',
      tone: data.tone || 'expert',
      theme: data.theme || null,
      themeDraft: data.themeDraft || null,
      aiControls: data.aiControls || null,
      featureFlags,
    };
    res.json(payload);
  } catch (err) {
    console.error('GET /admin/store-settings error', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// POST upsert settings (supports partial updates)
router.post('/store-settings', express.json(), async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'Missing storeId' });

    const { category, tone, theme, themeDraft, aiControls } = req.body || {};
    const ref = db.collection('storeSettings').doc(storeId);
    const updates = {};

    if (category !== undefined) updates.category = String(category || '');
    if (tone !== undefined) updates.tone = String(tone || 'expert');

    if (themeDraft !== undefined) {
      updates.themeDraft = sanitizeTheme(themeDraft);
      updates.themeDraft.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    if (theme !== undefined) {
      // rarely used directly; normally applied via /theme/apply
      updates.theme = sanitizeTheme(theme);
      updates.theme.appliedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    if (aiControls !== undefined) {
      // store as-is, but guard against huge payloads
      updates.aiControls = {
        promptStrictness: aiControls.promptStrictness ?? 'balanced',
        exclusions: Array.isArray(aiControls.exclusions) ? aiControls.exclusions.slice(0, 50) : [],
        enableFollowUps: Boolean(aiControls.enableFollowUps),
        safetyTone: Boolean(aiControls.safetyTone),
      };
    }

    await ref.set(updates, { merge: true });
    const snap = await ref.get();
    res.json(snap.data());
  } catch (err) {
    console.error('POST /admin/store-settings error', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// APPLY: copy themeDraft → theme, push to themeHistory (max 5)
router.post('/store-settings/theme/apply', async (req, res) => {
  try {
    const storeId = getStoreId(req);
    if (!storeId) return res.status(400).json({ error: 'Missing storeId' });

    const ref = db.collection('storeSettings').doc(storeId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'No settings to apply' });

    const data = snap.data();
    const draft = data.themeDraft;
    if (!draft) return res.status(400).json({ error: 'No themeDraft found' });

    const history = Array.isArray(data.themeHistory) ? data.themeHistory : [];
    const newHistory = [
      {
        theme: data.theme || null,
        at: admin.firestore.FieldValue.serverTimestamp(),
      },
      ...history,
    ].slice(0, 5);

    const finalTheme = sanitizeTheme(draft);
    finalTheme.appliedAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(
      { theme: finalTheme, themeHistory: newHistory },
      { merge: true }
    );

    const fresh = await ref.get();
    res.json({ theme: fresh.data().theme, themeHistory: fresh.data().themeHistory });
  } catch (err) {
    console.error('POST /admin/store-settings/theme/apply error', err);
    res.status(500).json({ error: 'Failed to apply theme' });
  }
});

module.exports = router;
