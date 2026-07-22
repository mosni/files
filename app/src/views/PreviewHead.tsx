// D-72/D-74: the server renders ONLY the <head> - a rich unfurl block for crawlers, which do not run
// JavaScript - and it gets spliced into the SPA's built shell (shellHtml.ts, Wave C). Markup stays in
// .tsx per D-10; this is the only file allowed to know the OG/Twitter/JSON-LD tag names.
//
// Security invariant (waves doc §0.5): user-controlled strings (the file's name/path) flow into two
// <script> bodies here - the JSON-LD block and the embedded-context block. Both are set via
// dangerouslySetInnerHTML, which does NOT get React's normal HTML-escaping, so BOTH must have their own
// `<` manually escaped to `<` before they are ever handed to dangerouslySetInnerHTML. Every other tag
// below is a plain JSX attribute/text value, which React escapes automatically (&, <, >, ", ') - that
// covers og:title, the title tag, etc. without any extra work here.

import { renderToString } from "react-dom/server";
import type { PreviewContext } from "../lib/previewContext.ts";
import { describeFile } from "../lib/previewContext.ts";

const SITE_NAME = "Hannah's File Drop";

// mosni-chrome's accent token (../mosni-chrome/src/scss/_tokens.scss: `--mosni-purple: #996bef;`) -
// Discord tints the embed's left stripe with theme-color, so this should track that design-system value.
const ACCENT = "#996bef";

// Escapes `<` so a serialised JSON blob can be safely embedded in a <script> body via
// dangerouslySetInnerHTML. Non-negotiable per the security invariant above - this is what stands between
// a filename like `</script><img onerror=...>` and it executing on the preview page.
function escapeScriptBody(json: string): string {
  return json.replace(/</g, "\\u003c");
}

function isoDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  let out = "PT";
  if (hours > 0) out += `${hours}H`;
  if (minutes > 0) out += `${minutes}M`;
  if (secs > 0 || (hours === 0 && minutes === 0)) out += `${secs}S`;
  return out;
}

function jsonLdFor(ctx: PreviewContext): string {
  const type = ctx.kind === "image" ? "ImageObject" : ctx.kind === "video" ? "VideoObject" : "MediaObject";
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
    name: ctx.name,
    contentUrl: ctx.directUrl,
    url: ctx.previewUrl,
    encodingFormat: ctx.mimeType,
    contentSize: ctx.sizeLabel,
    uploadDate: ctx.createdAt,
  };
  if (ctx.width !== null) data.width = ctx.width;
  if (ctx.height !== null) data.height = ctx.height;
  if (ctx.durationSeconds !== null) data.duration = isoDuration(ctx.durationSeconds);
  return escapeScriptBody(JSON.stringify(data));
}

function oembedHrefFor(ctx: PreviewContext, appOrigin: string): string {
  return `${appOrigin}/api/oembed?url=${encodeURIComponent(ctx.previewUrl)}&format=json`;
}

// ctx === null is the private/anonymous case (D-72/D-75): a private file's document must reveal nothing
// to an anonymous requester. No OG, no description, no canonical (a canonical URL would confirm the path
// exists), no filename anywhere.
function MinimalHead() {
  return (
    <>
      <title>{SITE_NAME}</title>
      <meta name="robots" content="noindex, nofollow" />
    </>
  );
}

function FullHead({ ctx, appOrigin }: { ctx: PreviewContext; appOrigin: string }) {
  const { name, previewUrl, directUrl, kind, mimeType, protection, width, height, durationSeconds } = ctx;
  const description = describeFile(ctx);
  // unlisted/secret must never enter a search index (D-59) - that is the level's entire purpose.
  const robots = protection === "public" ? "index, follow" : "noindex, nofollow";

  return (
    <>
      <title>{`${name} · ${SITE_NAME}`}</title>
      <link rel="canonical" href={previewUrl} />
      <meta name="description" content={description} />
      <meta name="theme-color" content={ACCENT} />
      <meta name="robots" content={robots} />

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={name} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={previewUrl} />
      <meta property="og:locale" content="en_US" />
      <meta property="og:type" content={kind === "video" ? "video.other" : "website"} />

      {kind === "image" && (
        <>
          <meta property="og:image" content={directUrl} />
          <meta property="og:image:secure_url" content={directUrl} />
          <meta property="og:image:type" content={mimeType} />
          {width !== null && <meta property="og:image:width" content={String(width)} />}
          {height !== null && <meta property="og:image:height" content={String(height)} />}
          <meta property="og:image:alt" content={name} />
        </>
      )}

      {kind === "video" && (
        <>
          <meta property="og:video" content={directUrl} />
          <meta property="og:video:secure_url" content={directUrl} />
          <meta property="og:video:type" content={mimeType} />
          {width !== null && <meta property="og:video:width" content={String(width)} />}
          {height !== null && <meta property="og:video:height" content={String(height)} />}
          {durationSeconds !== null && (
            <meta property="og:video:duration" content={String(Math.round(durationSeconds))} />
          )}
        </>
      )}

      <meta name="twitter:title" content={name} />
      <meta name="twitter:description" content={description} />
      {kind === "image" ? (
        <>
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:image" content={directUrl} />
          <meta name="twitter:image:alt" content={name} />
        </>
      ) : (
        // Deliberately never "player" (D-74): that card requires a twitter:player URL pointing at an
        // iframe-embeddable page, which this app does not have. An embeddable player route is E5's.
        <meta name="twitter:card" content="summary" />
      )}

      <link
        rel="alternate"
        type="application/json+oembed"
        href={oembedHrefFor(ctx, appOrigin)}
        title={name}
      />

      {/* biome-ignore lint: dangerouslySetInnerHTML is required for a raw JSON <script> body; the
          content is manually `<`-escaped above (escapeScriptBody), which is what makes this safe. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdFor(ctx) }} />
    </>
  );
}

export function renderPreviewHead(ctx: PreviewContext | null, appOrigin: string): string {
  if (ctx === null) return renderToString(<MinimalHead />);
  return renderToString(<FullHead ctx={ctx} appOrigin={appOrigin} />);
}

function EmbeddedContext({ ctx }: { ctx: PreviewContext }) {
  const json = escapeScriptBody(JSON.stringify(ctx));
  return (
    // Same escaping requirement as the JSON-LD block above - this is what lets the SPA read the file's
    // context with zero round trips, so it must never let a filename break out of its <script> body.
    <script type="application/json" id="preview-context" dangerouslySetInnerHTML={{ __html: json }} />
  );
}

export function renderEmbeddedContext(ctx: PreviewContext): string {
  return renderToString(<EmbeddedContext ctx={ctx} />);
}
