// D-100/D-121: shared between FileBrowser.tsx and the preview page's breadcrumb (E5.1 Wave G) - a real
// <a href> lets copy-link-address/open-in-new-tab/refresh work; this guard is what keeps a modifier or
// middle click left to the browser instead of being swallowed by an in-SPA navigate().

// D-100: the client never constructs a URL - this only ever extracts the PATHNAME from a `previewUrl` the
// server already built, for use with react-router's navigate().
export function pathnameOf(absoluteUrl: string): string {
  return new URL(absoluteUrl).pathname;
}

// D-121 (E4.1 Wave E findings, C3): a modified or non-primary click is the browser's to handle -
// preventDefault() here would silently break open-in-new-tab, which is half the reason breadcrumb crumbs
// and a collection's name are real <a href>s at all.
export function isPlainLeftClick(event: React.MouseEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}
