// src/components/AdminLayout.jsx
import {useMemo, useState, useCallback} from "react";
import {Frame, Navigation} from "@shopify/polaris";
import {useNavigate, useLocation} from "react-router-dom";

export default function AdminLayout({children}) {
  const navigate = useNavigate();
  const location = useLocation();

  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const toggleMobileNav = useCallback(() => setIsMobileNavOpen(o => !o), []);

  // With HashRouter, location.pathname is the internal path ("/", "/analytics", etc.)
  const path = location.pathname;

  const items = useMemo(() => ([
    { url: "#/",          label: "Home",      selected: path === "/" },
    { url: "#/analytics", label: "Analytics", selected: path.startsWith("/analytics") },
    { url: "#/settings",  label: "Settings",  selected: path.startsWith("/settings") },
    { url: "#/billing",   label: "Billing",   selected: path.startsWith("/billing") },
  ]), [path]);

  const navigationMarkup = (
    <Navigation location={path}>
      <Navigation.Section
        title="Refina"
        items={items.map(i => ({
          ...i,
          onClick: (e) => {
            e?.preventDefault?.();
            // Strip the leading "#"
            const to = i.url.startsWith("#") ? i.url.slice(1) : i.url;
            navigate(to);
            setIsMobileNavOpen(false);
          }
        }))}
      />
    </Navigation>
  );

  return (
    <Frame
      navigation={navigationMarkup}
      showMobileNavigation={isMobileNavOpen}
      onNavigationDismiss={() => setIsMobileNavOpen(false)}
    >
      {children}
    </Frame>
  );
}
