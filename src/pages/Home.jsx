import { Page, Layout, Card, Text } from "@shopify/polaris";
import { useTitleBar } from "../lib/useTitleBar";
import { copyCurrentDeepLink } from "../lib/copyLink";

export default function Home() {
  useTitleBar("Home", {
    primaryAction: {
      content: "Copy link",
      onAction: () => copyCurrentDeepLink(),
    },
  });

  return (
    <Page title="Home">
      <Layout>
        <Layout.Section>
          <Card>
            <Text as="p" variant="bodyMd">Home ✅</Text>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
