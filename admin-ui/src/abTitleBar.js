// admin-ui/src/abTitleBar.js
import { buildShareHref, copyToClipboard } from "./utils/shareHref";

export function createTitleBar({ app, actions, title, shop, host, storeId }) {
  const { TitleBar, Button, Toast } = actions;

  // Primary action: Copy link
  const copyBtn = Button.create(app, { label: "Copy link" });
  copyBtn.subscribe(Button.Action.CLICK, async () => {
    const href = buildShareHref({ shop, host, storeId });
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
    // If you need to swap shop/host/storeId dynamically (rare):
    if (next?.shop) shop = next.shop;
    if (next?.host) host = next.host;
    if (next?.storeId) storeId = next.storeId;
  }

  return { updateTitle, updateShareContext, destroy: () => tb.unsubscribe && tb.unsubscribe() };
}
