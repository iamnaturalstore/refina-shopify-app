// admin-ui/src/abTitleBar.js
import { buildShareHref, copyToClipboard } from "./utils/shareHref";

export function createTitleBar({ app, actions, title, shop, host, storeId }) {
  const { TitleBar, Button, Toast } = actions;

  // Force full-domain ID locally; prevents stale/short leakage
  storeId = shop;

  // Primary action: Copy link
  const copyBtn = Button.create(app, { label: "Copy link" });
  copyBtn.subscribe(Button.Action.CLICK, async () => {
    const href = buildShareHref({ shop, host, storeId: shop });
    await copyToClipboard(href);
    const toast = Toast.create(app, { message: "Link copied", duration: 2000 });
    toast.dispatch(Toast.Action.SHOW);
  });

  // Build the TitleBar
  const tb = TitleBar.create(app, {
    title: title || "Refina",
    buttons: { primary: copyBtn },
  });

  // Helpers to keep it fresh on route/title changes
  function updateTitle(nextTitle) {
    try {
      tb.set({ title: nextTitle });
    } catch {
      tb.dispatch(TitleBar.Action.UPDATE, { title: nextTitle });
    }
  }

  function updateShareContext(next) {
    if (next?.shop) {
      shop = next.shop;
      storeId = shop; // lock to full-domain
    }
    if (next?.host) host = next.host;
    // NOTE: intentionally ignore next.storeId to prevent short-id reintroduction
  }

  return { updateTitle, updateShareContext, destroy: () => tb.unsubscribe && tb.unsubscribe() };
}
