// admin-ui/src/pages/Setup.jsx
// Reviewer-friendly Setup page with:
//  • Enable Theme App Embed (Redirect to Theme Editor)
//  • Choose/store Category (writes via /api/admin/store-settings)
//  • Verify launcher (open storefront preview)
//  • Start plan/trial (link to Billing)
// All links preserve host/shop; Admin paths use App Bridge Redirect with safe fallbacks.

import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  InlineStack,
  TextField,
  Divider,
  Badge,
} from "@shopify/polaris";
import { buildEmbeddedUrl, api } from "../api/client"; // buildEmbeddedUrl for top-frame redirects; api for save
import { initAppBridge } from "../appBridge";

function getFromQS(key) {
  const q = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const h = new URLSearchParams(hashQ);
  return q.get(key) || h.get(key) || null;
}

function getStored(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function toMyshopifyDomain(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

function getHostShopQS() {
  const search = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const hash = new URLSearchParams(hashQ);
  const host = hash.get("host") || search.get("host") || "";
  const shop = hash.get("shop") || search.get("shop") || "";
  const params = new URLSearchParams();
  if (host) params.set("host", host);
  if (shop) params.set("shop", shop);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export default function Setup() {
  const apiKey = import.meta.env.VITE_SHOPIFY_API_KEY; // (kept for future use if needed)
  const themeExtId = import.meta.env.VITE_THEME_EXTENSION_ID; // NEW: Theme app extension UUID
  const embedHandle = import.meta.env.VITE_REFINA_EMBED_HANDLE || "refina-launcher"; // default updated

  const shop = useMemo(() => {
    return (
      toMyshopifyDomain(
        getStored("shopify-shop") ||
          getFromQS("shop") ||
          getFromQS("shopify-shop") ||
          ""
      ) || ""
    );
  }, []);
  const qs = useMemo(getHostShopQS, []);

  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [err, setErr] = useState("");

  // Load current store settings so we can prefill Category
  useEffect(() => {
    let on = true;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const { data } = await api.get(`/api/admin/store-settings`);
        // accept either {settings:{category}} or {category}
        const current =
          data?.settings?.category ?? data?.category ?? "";
        if (on) setCategory(String(current || ""));
      } catch (e) {
        if (on) setErr(`Failed to load settings: ${e?.message || "Unknown error"}`);
      } finally {
        if (on) setLoading(false);
      }
    })();
    return () => {
      on = false;
    };
  }, []);

  // Admin redirects with App Bridge (preferred) + graceful fallback to top
  const redirectAdmin = useCallback((adminPathWithQuery) => {
    // E.g. "themes/current/editor?context=apps&activateAppId=<extId>/<handle>"
    try {
      const ctx = initAppBridge();
      const Redirect = ctx?.actions?.Redirect;
      if (ctx?.app && Redirect) {
        const r = Redirect.create(ctx.app);
        r.dispatch(Redirect.Action.ADMIN_PATH, adminPathWithQuery);
        return;
      }
    } catch {
      /* ignore and fall back */
    }
    // Fallback: direct top navigation (stays safe in review)
    const abs = buildEmbeddedUrl(`/admin/${adminPathWithQuery}`);
    try {
      window.top.location.href = abs;
    } catch {
      window.location.href = abs;
    }
  }, []);

  const openThemeEmbed = useCallback(() => {
    const path = `themes/current/editor?context=apps&template=index&activateAppId=${themeExtId}/${embedHandle}&target=newAppsSection/app-embed`;
    redirectAdmin(path);
  }, [themeExtId, embedHandle, redirectAdmin]);

  // (Storefront preview handled via a real link in JSX; keep helper only if needed elsewhere)
  const openStorefrontPreview = useCallback(() => {
    if (!shop) return;
    const url = `https://${shop}/?refina_preview=1`;
    window.open(url, "_blank", "noopener");
  }, [shop]);

  const saveCategory = useCallback(async () => {
    setSaveBusy(true);
    setSaveOk(false);
    setErr("");
    try {
      // Prefer a structured payload; backend will merge into store settings
      await api.post(`/api/admin/store-settings`, {
        settings: { category: String(category || "").trim() },
      });
      setSaveOk(true);
    } catch (e) {
      setErr(`Failed to save category: ${e?.message || "Unknown error"}`);
    } finally {
      setSaveBusy(false);
      // Hide success after a short delay (visual feedback only)
      setTimeout(() => setSaveOk(false), 1800);
    }
  }, [category]);

  // Guardrails for missing config (use Theme Extension ID as the gate)
  if (!themeExtId) {
    return (
      <Page title="Setup">
        <Layout>
          <Layout.Section>
            <Banner title="Missing Theme Extension ID" tone="critical">
              <p>
                <code>VITE_THEME_EXTENSION_ID</code> is not defined. Add it to your Admin UI
                build environment so the Theme Editor deep link can activate the Refina app embed.
              </p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  if (!shop) {
    return (
      <Page title="Setup">
        <Layout>
          <Layout.Section>
            <Banner title="Missing shop parameter" tone="critical">
              <p>
                We couldn’t detect the shop domain. Please open the app from the
                Shopify Admin so we receive the <code>host</code> and{" "}
                <code>shop</code> parameters.
              </p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="Set up Refina" subtitle="3 quick steps to get your app live">
      <Layout>
        <Layout.Section>
          {err && (
            <Banner tone="critical" title="Something went wrong" onDismiss={() => setErr("")}>
              <p>{err}</p>
            </Banner>
          )}
        </Layout.Section>

        {/* Step 1: Enable Theme App Embed */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">1) Enable the Theme App Embed</Text>
                <Badge tone="subdued">Required</Badge>
              </InlineStack>
              <Text as="p">
                We’ll open the Theme Editor in Shopify. Toggle the Refina <strong>App embed</strong>, then click <strong>Save</strong>.
              </Text>
              <InlineStack gap="300" wrap={false}>
                <Button variant="primary" onClick={openThemeEmbed}>Open Theme Editor</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Step 2: Choose your Category */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">2) Choose your store category</Text>
                {saveOk ? <Badge tone="success">Saved</Badge> : <Badge tone="attention">Pending</Badge>}
              </InlineStack>
              <Text as="p" tone="subdued">
                This helps Refina tailor recommendations to your catalog.
              </Text>
              <TextField
                label="Category"
                autoComplete="off"
                value={category}
                onChange={setCategory}
                placeholder="e.g., Beauty, Skincare, Supplements"
                disabled={loading}
              />
              <InlineStack gap="200">
                <Button onClick={saveCategory} loading={saveBusy} variant="primary">
                  Save category
                </Button>
                <Button url={`#/${qs}`} tone="subdued">
                  Back to Home
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Step 3: Verify launcher */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">3) Verify the launcher is visible</Text>
                <Badge tone="subdued">Check</Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Open your storefront preview and look for the Refina launcher (usually bottom-right). If it’s hidden, ensure the App embed is enabled and saved.
              </Text>
              <InlineStack gap="300" wrap={false}>
                <Button url={`https://${shop}/?refina_preview=1`} external>Open storefront preview</Button>
                <Button url={`#/billing${qs}`} variant="tertiary">Start plan / trial</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Helpful footer */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                Tip: All admin links are embedded. Theme Editor opens as a Shopify Admin page; storefront opens in a new tab.
              </Text>
              <Divider />
              <InlineStack gap="200">
                <Button url={`#/${qs}`} variant="secondary">Back to Home</Button>
                <Button url={`#/billing${qs}`} variant="secondary">Go to Billing</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
