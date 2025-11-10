import React, { useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  List,
} from "@shopify/polaris";
import { api, getShop } from "../api/client";

// --- helpers -------------------------------------------------------

function getCurrentHost() {
  const search = new URLSearchParams(window.location.search || "");
  const hashQ = (window.location.hash || "").split("?")[1] || "";
  const hash = new URLSearchParams(hashQ);
  return search.get("host") || hash.get("host") || "";
}

function buildQS() {
  const shop = getShop();
  const host = getCurrentHost();
  const params = new URLSearchParams();
  if (host) params.set("host", host);
  if (shop) params.set("shop", shop);
  const s = params.toString();
  return s ? `?${s}` : "";
}

// --- component -----------------------------------------------------

export default function Welcome() {
  console.log("[Refina] Welcome page mounted");

  const qs = useMemo(buildQS, []);
  const billingUrl = `#/billing${qs || ""}`;

  return (
    <Page title="Welcome to Refina">
      <Layout>
        {/* Hero */}
        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="400">
                <BlockStack gap="200">
                  <Text as="h1" variant="headingLg">
                    🎯 Stop the guessing. Refina tells shoppers what to buy.
                  </Text>
                  <Text as="p" tone="subdued">
                    AI product recommendations with a clear “Why” — powered by
                    your catalog and enriched facts, right inside your theme.
                  </Text>
                  <Text as="p" tone="subdued">
                    Get Refina live in minutes: start your free trial in Shopify,
                    we build your product knowledge base, and you switch Refina
                    on in your theme.
                  </Text>
                </BlockStack>

                <InlineStack gap="200" blockAlign="center">
                  <Button
                    variant="primary"
                    size="large"
                    url={billingUrl}
                  >
                    Start free trial &amp; choose plan
                  </Button>
                </InlineStack>

                <Text as="p" tone="subdued">
                  Opens Shopify’s secure billing page. 7-day free trial • Pro
                  $19/mo • Premium $49/mo • Cancel anytime in Shopify.
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>

        {/* How it works */}
        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  How Refina works
                </Text>
                <BlockStack gap="200">
                  <BlockStack gap="050">
                    <Text as="h3" variant="headingSm">
                      1️⃣ Start your free trial in Shopify
                    </Text>
                    <Text as="p" tone="subdued">
                      Confirm your Refina plan on Shopify’s billing page. No
                      charges until your trial ends.
                    </Text>
                  </BlockStack>

                  <BlockStack gap="050">
                    <Text as="h3" variant="headingSm">
                      2️⃣ Refina builds your product knowledge
                    </Text>
                    <Text as="p" tone="subdued">
                      We scan your catalog, extract key attributes and
                      ingredients, and build a store-specific knowledge base so
                      recommendations stay accurate and explainable.
                    </Text>
                  </BlockStack>

                  <BlockStack gap="050">
                    <Text as="h3" variant="headingSm">
                      3️⃣ Add Refina to your theme &amp; go live
                    </Text>
                    <Text as="p" tone="subdued">
                      Enable the Refina app embed and PDP prompt in your Theme
                      Editor. Shoppers ask in plain language and see ranked
                      best-fit options with the “Why”.
                    </Text>
                  </BlockStack>
                </BlockStack>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>

        {/* Why Refina */}
        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Why merchants choose Refina
                </Text>
                <List type="bullet">
                  <List.Item>
                    Reduce choice overload with a guided “this is for me” experience.
                  </List.Item>
                  <List.Item>
                    Increase conversion and AOV with ranked best-fit products plus concise “Why”.
                  </List.Item>
                  <List.Item>
                    Cut repetitive pre-sale questions using your product knowledge.
                  </List.Item>
                  <List.Item>
                    Theme-native, fast setup; no quiz build or heavy config.
                  </List.Item>
                  <List.Item>
                    Privacy-first: your catalog is the source of truth; no customer PII required.
                  </List.Item>
                </List>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>

        {/* Closing CTA */}
        <Layout.Section>
          <Card>
            <Box padding="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">
                    Ready to see Refina against your catalog?
                  </Text>
                  <Text as="p" tone="subdued">
                    Start your free trial, then choose Pro ($19/mo) or Premium
                    ($49/mo) if it’s a fit.
                  </Text>
                </BlockStack>
                <Button
                  variant="primary"
                  size="medium"
                  url={billingUrl}
                >
                  Start free trial &amp; choose plan
                </Button>
              </InlineStack>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
