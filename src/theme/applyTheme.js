// frontend/src/theme/applyTheme.js
export function applyRefinaTheme(tokens = {}) {
  const root = document.querySelector(".refina-root");
  if (!root) return;

  const defaults = {
    bg:"#FFFFFF", surface:"#FFFFFF", text:"#111827", muted:"#6B7280",
    primary:"#2563EB", accent:"#10B981", border:"#E5E7EB",
    radius:"12px", shadow:"0 4px 14px rgba(0,0,0,0.05)",
    gap:"16px", pad:"16px",
  };

  const t = { ...defaults, ...tokens };
  const map = {
    "--rf-bg": t.bg, "--rf-surface": t.surface, "--rf-text": t.text, "--rf-muted": t.muted,
    "--rf-primary": t.primary, "--rf-accent": t.accent, "--rf-border": t.border,
    "--rf-radius": t.radius, "--rf-shadow": t.shadow, "--rf-gap": t.gap, "--rf-pad": t.pad,
  };

  Object.entries(map).forEach(([k, v]) => {
    if (v !== undefined && v !== null) root.style.setProperty(k, String(v));
  });
}
