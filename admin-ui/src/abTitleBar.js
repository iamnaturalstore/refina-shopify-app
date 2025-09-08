// admin-ui/src/abTitleBar.js
// App Bridge v4-safe TitleBar shim.
// The old TitleBar/Button .subscribe() pattern causes runtime errors in v4.
// Use Polaris Page + primaryAction in your pages for real actions.
// This shim keeps the previous createTitleBar() call sites from breaking,
// but doesn't hook into App Bridge at all.

export function createTitleBar(/* opts */) {
  function updateTitle(/* nextTitle */) {
    // no-op: handled by page components now
  }
  function updateShareContext(/* next */) {
    // no-op
  }
  function destroy() {
    // no-op
  }
  return { updateTitle, updateShareContext, destroy };
}

// Optional default export (in case some files imported default)
export default { createTitleBar };
