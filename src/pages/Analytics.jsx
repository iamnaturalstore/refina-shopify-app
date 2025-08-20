import { Page, Layout, Card, Text } from "@shopify/polaris";
import { useTitleBar } from "../lib/useTitleBar";
import { copyCurrentDeepLink } from "../lib/copyLink";

export default function Analytics() {
  useTitleBar("Analytics", {
    primaryAction: {
      content: "Copy link",
      onAction: () => copyCurrentDeepLink(),
    },
  });

  return (
    <Page title="Analytics">
      <Layout>
        <Layout.Section>
          <Card>
            <Text as="p" variant="bodyMd">Analytics ✅</Text>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
