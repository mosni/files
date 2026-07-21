// D-9/D-54: server-rendered so messenger crawlers (which do not run JavaScript) get a real OG unfurl.
// Rendered identically for everyone. The session-aware island probe (old D-41/D-63) was dropped in
// session 007 - E5a ships no island, so it was speculative build-ahead; E5 adds hydration when a real
// island exists. Only the design-system chrome loads here (for styling + the copy toast); the auth SDK
// does not, since nothing on this page reads a session.

import { renderToString } from "react-dom/server";
import type { FileRecord } from "../storage/files.ts";
import { isInlineAllowed } from "../lib/mime.ts";
import { stripStrategyFor } from "../lib/media.ts";

type PreviewUrls = { previewUrl: string; directUrl: string };

function OgTags({ file, directUrl }: { file: FileRecord; directUrl: string }) {
  const strategy = stripStrategyFor(file.name);
  return (
    <>
      <meta property="og:title" content={file.name} />
      <meta property="og:description" content="Shared via Hannah's File Drop" />
      <meta property="og:type" content="website" />
      {strategy === "image" && <meta property="og:image" content={directUrl} />}
      {strategy === "video" && (
        <>
          <meta property="og:video" content={directUrl} />
          <meta name="twitter:card" content="player" />
        </>
      )}
    </>
  );
}

function InlineMedia({ file, directUrl }: { file: FileRecord; directUrl: string }) {
  const strategy = stripStrategyFor(file.name);
  if (strategy === "video") {
    // biome-ignore lint: plain <video>, Vidstack is E5's
    return <video src={directUrl} controls style={{ maxWidth: "100%" }} />;
  }
  if (strategy === "image") {
    return <img src={directUrl} alt={file.name} style={{ maxWidth: "100%" }} />;
  }
  // isInlineAllowed also covers pdf/txt - a plain iframe embed rather than an image/video tag.
  return <iframe src={directUrl} title={file.name} style={{ width: "100%", height: "80vh", border: 0 }} />;
}

function PreviewPage({ file, previewUrl, directUrl }: { file: FileRecord } & PreviewUrls) {
  const inline = isInlineAllowed(file.name);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${file.name} · Hannah's File Drop`}</title>
        <OgTags file={file} directUrl={directUrl} />
        <script src="https://ui.mosni.dev/mosnicat.js"></script>
      </head>
      <body>
        <main>
          <h1>{file.name}</h1>
          {inline ? (
            <InlineMedia file={file} directUrl={directUrl} />
          ) : (
            <div className="panel">
              <p>This file type does not preview inline.</p>
              <a className="btn" href={directUrl}>
                Download {file.name}
              </a>
            </div>
          )}
          <div className="panel">
            {/* D-1 + preliminary-review P9: a read-only link input with a copy button, not two rival
                buttons. The preview link (which unfurls) is primary; the direct link is a smaller,
                secondary read-only input below it. */}
            <label>
              Share link
              <input type="text" readOnly value={previewUrl} data-copy-source="preview" />
            </label>
            <button type="button" className="btn" data-copy-for="preview">
              Copy
            </button>
            <label>
              Direct link
              <input type="text" readOnly value={directUrl} data-copy-source="direct" />
            </label>
            <button type="button" data-copy-for="direct">
              Copy direct
            </button>
          </div>
        </main>
        <script
          // Vanilla copy handler (no framework on the SSR page). Guards every step so a missing/failed
          // chrome never breaks the copy itself - the toast is a nicety, not a requirement.
          dangerouslySetInnerHTML={{
            __html: `
(function () {
  document.querySelectorAll("[data-copy-for]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-copy-for");
      var input = document.querySelector("[data-copy-source='" + key + "']");
      if (!input) return;
      navigator.clipboard.writeText(input.value).then(function () {
        input.select();
        if (window.mosni && window.mosni.toast) window.mosni.toast("Link copied", { variant: "success" });
      }).catch(function () {});
    });
  });
})();
`,
          }}
        />
      </body>
    </html>
  );
}

export function renderPreviewPage(file: FileRecord, urls: PreviewUrls): string {
  return `<!DOCTYPE html>${renderToString(
    <PreviewPage file={file} previewUrl={urls.previewUrl} directUrl={urls.directUrl} />,
  )}`;
}
