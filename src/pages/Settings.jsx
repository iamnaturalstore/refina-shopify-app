import { Page, Layout, Card, Text } from "@shopify/polaris";
import { useTitleBar } from "../lib/useTitleBar";
import { copyCurrentDeepLink } from "../lib/copyLink";

export default function Settings() {
  useTitleBar("Settings", {
    primaryAction: {
      content: "Copy link",
      onAction: () => copyCurrentDeepLink(),
    },
  });

  return (
    <Page title="Settings">
      <Layout>
        <Layout.Section>
          <Card>
            <Text as="p" variant="bodyMd">Settings ✅</Text>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
