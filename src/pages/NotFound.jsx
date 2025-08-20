import { Page, Layout, Card, Text } from "@shopify/polaris";
import { useTitleBar } from "../lib/useTitleBar";
import { copyCurrentDeepLink } from "../lib/copyLink";

export default function NotFound() {
  useTitleBar("Not found", {
    primaryAction: {
      content: "Copy link",
      onAction: () => copyCurrentDeepLink(),
    },
  });

  return (
    <Page title="Not found">
      <Layout>
        <Layout.Section>
          <Card>
            <Text as="p" variant="bodyMd">Not Found ❌</Text>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
