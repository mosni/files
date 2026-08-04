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
import type { CollectionLocation } from "../lib/browseContext.ts";
import { thumbDimensionsFor } from "../lib/thumbs.ts";

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

// E5 Wave H (D-140): the embeddable player route's URL for this file. `ctx.path` is already the display
// path (collection names + the file's own name, D-100-redacted when it must be); re-splitting and
// re-encoding each segment mirrors lib/fileUrls.ts's own encodeSegments() exactly, since a display name can
// never itself contain "/" (safeSegment() rules that out elsewhere).
function embedUrlFor(ctx: PreviewContext, appOrigin: string): string {
  const encoded = ctx.path.split("/").map(encodeURIComponent).join("/");
  return `${appOrigin}/embed/f/${encoded}`;
}

// twitter:player is only valid when the embed route can ACTUALLY serve this file (controllers/embed.ts's
// own gate: readable path, not private, video kind) and both dimensions are known - Twitter's Player Card
// requires twitter:player:width/height, so a missing probe result must fall back to "summary" rather than
// publish an invalid card. `secret`/`private` are excluded even though a secret file's FullHead otherwise
// renders (D-72's private-only MinimalHead gate) - a secret file's display path is redacted to its bare
// name (D-100), which the embed route's readable-path resolution would not reliably resolve back to this
// same file, and H2 requires secret to never render there regardless.
//
// A thumbnail is required too (added in review session 034): the Player Card spec also mandates
// `twitter:image` - the still shown in place of the player wherever an iframe cannot run. Emitting a
// player card without one publishes an INVALID card, which is strictly worse than the "summary" fallback,
// so a video with no thumbnail (a pre-E5 upload - D-138 never backfills) correctly stays on summary.
function isPlayerEmbeddable(ctx: PreviewContext): boolean {
  return (
    ctx.kind === "video" &&
    (ctx.protection === "public" || ctx.protection === "unlisted") &&
    ctx.width !== null &&
    ctx.height !== null &&
    ctx.thumbUrl !== null
  );
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
  const { name, previewUrl, directUrl, thumbUrl, kind, mimeType, protection, width, height, durationSeconds } = ctx;
  const description = describeFile(ctx);
  // unlisted/secret must never enter a search index (D-59) - that is the level's entire purpose.
  const robots = protection === "public" ? "index, follow" : "noindex, nofollow";

  // B2/D-137: og:image/twitter:image prefer the thumbnail when one exists, falling back to directUrl for
  // a pre-E5 file (D-138: never backfilled). og:image:width/height MUST then describe the THUMBNAIL, not
  // the source - emitting the source's real dimensions alongside a thumbnail URL is exactly the mismatch
  // that makes Discord render a bare link instead of a card (see lib/thumbs.ts's thumbDimensionsFor).
  const imageUrl = thumbUrl ?? directUrl;
  const imageDimensions =
    thumbUrl !== null ? (thumbDimensionsFor(width, height) ?? { width: null, height: null }) : { width, height };
  const imageType = thumbUrl !== null ? "image/webp" : mimeType;

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
          <meta property="og:image" content={imageUrl} />
          <meta property="og:image:secure_url" content={imageUrl} />
          <meta property="og:image:type" content={imageType} />
          {imageDimensions.width !== null && (
            <meta property="og:image:width" content={String(imageDimensions.width)} />
          )}
          {imageDimensions.height !== null && (
            <meta property="og:image:height" content={String(imageDimensions.height)} />
          )}
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
          {/* D-137 amended (video thumbnails) + review session 034: a video's keyframe thumbnail was
              being GENERATED and then used by nothing - og:image was emitted for images only, so an
              unfurled video had no poster frame at all. og:image alongside og:video is what gives Discord
              (and every other consumer that cannot play the video inline) a still to show. Dimensions
              describe the THUMBNAIL, exactly as the image branch above does. Omitted entirely for a
              pre-E5 video with no thumbnail - never falls back to directUrl here, which for a video would
              hand a consumer a multi-MB video file in an <img> slot. */}
          {thumbUrl !== null && (
            <>
              <meta property="og:image" content={thumbUrl} />
              <meta property="og:image:secure_url" content={thumbUrl} />
              <meta property="og:image:type" content="image/webp" />
              {imageDimensions.width !== null && (
                <meta property="og:image:width" content={String(imageDimensions.width)} />
              )}
              {imageDimensions.height !== null && (
                <meta property="og:image:height" content={String(imageDimensions.height)} />
              )}
              <meta property="og:image:alt" content={name} />
            </>
          )}
        </>
      )}

      <meta name="twitter:title" content={name} />
      <meta name="twitter:description" content={description} />
      {kind === "image" ? (
        <>
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:image" content={imageUrl} />
          <meta name="twitter:image:alt" content={name} />
        </>
      ) : isPlayerEmbeddable(ctx) ? (
        // H3 (E5 Wave H, D-140): now that the embeddable player route exists, emit the "player" card D-74
        // deliberately dropped for lack of one. width/height are the file's real probed dimensions - same
        // source og:video:width/height already uses.
        <>
          <meta name="twitter:card" content="player" />
          <meta name="twitter:player" content={embedUrlFor(ctx, appOrigin)} />
          <meta name="twitter:player:width" content={String(width)} />
          <meta name="twitter:player:height" content={String(height)} />
          {/* Required by the Player Card spec, not optional decoration: the still shown wherever the
              iframe cannot run. isPlayerEmbeddable() guarantees thumbUrl is non-null here. */}
          <meta name="twitter:image" content={imageUrl} />
          <meta name="twitter:image:alt" content={name} />
        </>
      ) : (
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

// D-160 (E5.1 Wave B, finding 3): `embeddedFor` is a property of the EMBEDDING (the request pathname this
// document was rendered for), not of the file - so it is stamped onto the wrapper serialized here rather
// than added to PreviewContext itself, which is also the /api/preview response body and has no embedding
// to describe. The client (web/src/pages/Preview.tsx) compares its own current pathname against this
// stamp, never against wherever it happens to have mounted - see that file's comment for why the previous
// mount-path-ref approach could paint stale content after a remount.
function EmbeddedContext({ ctx, embeddedFor }: { ctx: PreviewContext; embeddedFor: string }) {
  const json = escapeScriptBody(JSON.stringify({ ...ctx, embeddedFor }));
  return (
    // Same escaping requirement as the JSON-LD block above - this is what lets the SPA read the file's
    // context with zero round trips, so it must never let a filename break out of its <script> body.
    <script type="application/json" id="preview-context" dangerouslySetInnerHTML={{ __html: json }} />
  );
}

export function renderEmbeddedContext(ctx: PreviewContext, embeddedFor: string): string {
  return renderToString(<EmbeddedContext ctx={ctx} embeddedFor={embeddedFor} />);
}

// D-107/§1.2: the collection counterpart of FullHead/MinimalHead above. No OG/JSON-LD unfurl richness -
// that is out of E4.1's scope - just a real title and the same public/non-public robots split a file
// gets. The name is safe to reveal here: by the time this renders, the caller (preview.ts) has already
// gated the requester as authorized (owner/superuser/ACL-granted) or the collection is public, so showing
// its own name back to the person who is allowed to see it leaks nothing new.
function CollectionHead({ name, isPublic }: { name: string; isPublic: boolean }) {
  return (
    <>
      <title>{`${name} · ${SITE_NAME}`}</title>
      <meta name="robots" content={isPublic ? "index, follow" : "noindex, nofollow"} />
    </>
  );
}

export function renderCollectionHead(name: string, isPublic: boolean): string {
  return renderToString(<CollectionHead name={name} isPublic={isPublic} />);
}

// Reuses the SAME #preview-context script id/type EmbeddedContext above uses (waves hand-off: "reuse the
// existing mechanism, do not add a second one") - CollectionLocation's `kind: "collection"` is what lets
// the client tell the two shapes apart from that one element. Same D-160 `embeddedFor` stamp as
// EmbeddedContext above, for the same reason - a collection's own page can go stale across a remount too.
function EmbeddedCollectionLocation({ location, embeddedFor }: { location: CollectionLocation; embeddedFor: string }) {
  const json = escapeScriptBody(JSON.stringify({ ...location, embeddedFor }));
  return (
    // biome-ignore lint: same dangerouslySetInnerHTML requirement and escaping as EmbeddedContext above.
    <script type="application/json" id="preview-context" dangerouslySetInnerHTML={{ __html: json }} />
  );
}

export function renderEmbeddedCollectionLocation(location: CollectionLocation, embeddedFor: string): string {
  return renderToString(<EmbeddedCollectionLocation location={location} embeddedFor={embeddedFor} />);
}
