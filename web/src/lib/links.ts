// D-100/D-121: shared between FileBrowser.tsx and the preview page's breadcrumb (E5.1 Wave G) - a real
// <a href> lets copy-link-address/open-in-new-tab/refresh work; this guard is what keeps a modifier or
// middle click left to the browser instead of being swallowed by an in-SPA navigate().

// D-100: the client never constructs a URL - this only ever extracts the PATHNAME from a `previewUrl` the
// server already built, for use with react-router's navigate().
export function pathnameOf(absoluteUrl: string): string {
  return new URL(absoluteUrl).pathname;
}

// E5.1 review (session 039): the same "read what the server built, never construct one" rule applied to a
// link's TOKEN rather than its pathname. A `secret` collection's previewUrl is the `/t/<token>` shape
// (lib/fileUrls.ts's buildCollectionPreviewUrl), and that token is the only thing that makes GET /api/browse
// answer for it anonymously (D-98/D-124) - which is exactly how navigating into the row already works.
// Returns null for the `/f/<path>` shape, where no token exists and none is needed.
export function tokenOf(absoluteUrl: string): string | null {
  const segments = new URL(absoluteUrl).pathname.split("/");
  return segments.length === 3 && segments[1] === "t" && segments[2] !== "" ? decodeURIComponent(segments[2]) : null;
}

// D-121 (E4.1 Wave E findings, C3): a modified or non-primary click is the browser's to handle -
// preventDefault() here would silently break open-in-new-tab, which is half the reason breadcrumb crumbs
// and a collection's name are real <a href>s at all.
export function isPlainLeftClick(event: React.MouseEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}
