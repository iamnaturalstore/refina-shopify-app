import { useEffect } from "react";
import { getAppBridge, getActions } from "./appBridge";

export function useTitleBar(title, { primaryAction } = {}) {
  useEffect(() => {
    const app = getAppBridge();
    const actions = getActions();
    if (!app || !actions) return;

    const { TitleBar } = actions;
    const tb = TitleBar.create(app, {
      title,
      ...(primaryAction
        ? { primaryAction: { content: primaryAction.content || "Action" } }
        : {}),
    });

    let unsubscribe;
    if (primaryAction?.onAction) {
      unsubscribe = tb.subscribe(TitleBar.Action.PRIMARY, primaryAction.onAction);
    }

    // Clean up: unsubscribe the handler; AB handles replacing TitleBars between pages
    return () => {
      if (unsubscribe) tb.unsubscribe(TitleBar.Action.PRIMARY, unsubscribe);
    };
  }, [title, primaryAction?.content, primaryAction?.onAction]);
}
