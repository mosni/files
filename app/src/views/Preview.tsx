// D-9/D-54: server-rendered so messenger crawlers (which do not run JavaScript) get a real OG unfurl.
// Rendered identically for everyone, anonymous-shaped (D-63) - the session-aware island probe is a small
// inline script, not server-side branching, so the HTML this view produces never depends on who asked.

import { renderToString } from "react-dom/server";
import type { FileRecord } from "../storage/files.ts";
import { isInlineAllowed } from "../lib/mime.ts";
import { stripStrategyFor } from "../lib/media.ts";

type PreviewUrls = { previewUrl: string; directUrl: string };

function escapeForInlineScript(value: string): string {
  // This value is interpolated into a <script> body, not HTML - `<` is the only character that can break
  // out (via "</script>"), but escape defensively rather than assume the token/URL shapes never contain it.
  return value.replace(/</g, "\\u003c");
}

function OgTags({ file, directUrl }: { file: FileRecord; directUrl: string }) {
  const strategy = stripStrategyFor(file.name);
  return (
    <>
      <meta property="og:title" content={file.name} />
      <meta property="og:description" content="Shared via files.mosni.dev" />
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
  // isInlineAllowed also covers pdf/txt - a plain object/iframe embed rather than an image/video tag.
  return <iframe src={directUrl} title={file.name} style={{ width: "100%", height: "80vh", border: 0 }} />;
}

function PreviewPage({ file, previewUrl, directUrl }: { file: FileRecord } & PreviewUrls) {
  const inline = isInlineAllowed(file.name);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${file.name} · files.mosni.dev`}</title>
        <OgTags file={file} directUrl={directUrl} />
        {/* F3's load-order rule applies here too: sdk.js first, so mosnicat.js's window.mosni ??= {}
            merge (and now sdk.js's own merge, D-63) never races. */}
        <script src="https://auth.mosni.dev/sdk.js"></script>
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
            {/* D-1: one primary copy button (the preview link, which unfurls), the direct link secondary. */}
            <button type="button" className="btn" data-copy-link={previewUrl}>
              Copy link
            </button>
            <a className="btn" href={directUrl}>
              Direct link
            </a>
          </div>
        </main>
        <script
          // D-63's mechanism: read the token client-side, call the context endpoint, but hydrate
          // nothing yet (E5a ships no island). Guards every step so a missing/failed auth SDK never
          // breaks the page - this script's failure must be invisible, not console-noisy on every load.
          dangerouslySetInnerHTML={{
            __html: `
(function () {
  var copyBtn = document.querySelector("[data-copy-link]");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(copyBtn.getAttribute("data-copy-link")).then(function () {
        if (window.mosni && window.mosni.toast) window.mosni.toast("Link copied", { variant: "success" });
      }).catch(function () {});
    });
  }
  try {
    if (!window.mosni || typeof window.mosni.token !== "function") return;
    var token = window.mosni.token();
    if (!token) return;
    fetch("/api/f/${escapeForInlineScript(file.linkToken)}/context", {
      headers: { Authorization: "Bearer " + token },
    }).catch(function () {});
  } catch (e) {}
})();
`,
          }}
        />
      </body>
    </html>
  );
}

export function renderPreviewPage(file: FileRecord, urls: PreviewUrls): string {
  return `<!DOCTYPE html>${renderToString(<PreviewPage file={file} previewUrl={urls.previewUrl} directUrl={urls.directUrl} />)}`;
}
