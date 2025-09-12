// admin-ui/src/pages/Setup.jsx
// Polaris Setup page with deep links to enable the App Embed and add the App Block.
// Uses full <shop>.myshopify.com and your VITE_SHOPIFY_API_KEY at build time.

import React, { useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  InlineStack,
} from "@shopify/polaris";

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

export default function Setup() {
  const apiKey = import.meta.env.VITE_SHOPIFY_API_KEY;
  const embedHandle =
    import.meta.env.VITE_REFINA_EMBED_HANDLE || "refina-embed"; // <- confirm handle
  const blockHandle =
    import.meta.env.VITE_REFINA_BLOCK_HANDLE || "refina-launcher"; // <- confirm handle

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

  if (!apiKey) {
    return (
      <Page title="Setup">
        <Layout>
          <Layout.Section>
            <Banner title="Missing API key" tone="critical">
              <p>
                VITE_SHOPIFY_API_KEY is not defined. Add it to your Admin UI
                build environment.
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

  const embedUrl = `https://${shop}/admin/themes/current/editor?context=apps&template=index&activateAppId=${apiKey}/${embedHandle}`;
  const blockUrl = `https://${shop}/admin/themes/current/editor?template=product&addAppBlockId=${apiKey}/${blockHandle}&target=mainSection`;

  const openTop = (url) => {
    try {
      // Ensure we escape the iframe and land in the Theme Editor
      window.top.location.href = url;
    } catch {
      window.location.href = url;
    }
  };

  return (
    <Page title="Set up Refina">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="p" variant="bodyLg">
                Enable the Refina launcher and (optionally) add the Refina block
                to your product template. After you click a button, the Theme
                Editor opens — make sure to click <strong>Save</strong>.
              </Text>

              <InlineStack gap="300" wrap={false}>
                <Button onClick={() => openTop(embedUrl)} variant="primary">
                  Enable App Embed (launcher)
                </Button>
                <Button onClick={() => openTop(blockUrl)}>
                  Add App Block (product template)
                </Button>
              </InlineStack>

              <BlockStack gap="150">
                <Text as="h3" variant="headingSm">
                  Checklist
                </Text>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Click one of the buttons above.</li>
                  <li>In the Theme Editor, toggle the embed or add the block.</li>
                  <li>Click <strong>Save</strong>, then Preview your store.</li>
                </ol>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
