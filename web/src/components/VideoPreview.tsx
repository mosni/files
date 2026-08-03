// E5 Wave F (D-144, "plays where it plays"): decide playability at RUNTIME, per browser, via
// `canPlayType()` plus the player's own `error` event - NEVER by sniffing the user agent or trusting the
// file extension. A container/codec combination the browser cannot decode falls back to the same download
// card `PreviewCard`'s non-inline branch already uses - one fallback path, not two (F0.3).
//
// F2 (MKV remux) is DEFERRED, not shipped (Hannah, 2026-08-03): the plan's pinned `mux.js` cannot parse
// Matroska at all - it transmuxes MP4/FLV/TS only, and has never had an EBML/Matroska demuxer. There is
// nothing in this repo's dependencies that can turn `.mkv` bytes into something a browser's <video> can
// play. `.mkv` stays on the inline allowlist (D-144 already covers all three widened containers together)
// and goes through the exact same capability probe as every other video - since no mainstream browser
// natively decodes Matroska today, it currently always falls through to the download card below, which is
// the honest, working behaviour until a real remux path is planned and vetted in its own session (see
// decisions.md).
//
// Vidstack styling: MediaCommunitySkin's CSS ships in the `vidstack` core package, not `@vidstack/react` -
// imported here, next to the one component that needs it, rather than globally in main.tsx.
import "vidstack/styles/base.css";
import "vidstack/styles/community-skin/video.css";

import { useState } from "react";
import { MediaCommunitySkin, MediaOutlet, MediaPlayer } from "@vidstack/react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

const FIT: React.CSSProperties = { maxWidth: "100%", display: "block" };

// A fresh, unmounted probe element - never appended to the document. `canPlayType` is a synchronous,
// per-browser capability answer (RFC: MediaError's own "is this format usable" gate), not a UA sniff -
// calling it on a bare element (rather than the real player instance) costs nothing and lets the
// authoritatively-negative case ("" - Matroska in every mainstream browser today) skip mounting the
// heavier Vidstack player entirely.
function canDefinitelyNotPlay(mimeType: string): boolean {
  if (typeof document === "undefined") return false;
  return document.createElement("video").canPlayType(mimeType) === "";
}

// Inline-styled, not `.panel`/`.btn` - confirmed by the D-79 visual check that the embeddable player route
// (web/embed.html, H1) deliberately never loads mosni-chrome's stylesheet, so a class-based fallback here
// rendered as an unstyled bare link on a black background. This component is shared by both the ordinary
// preview page (which DOES have the design system) and the embed route (which does not), so it has to
// carry its own minimal presentation rather than assuming an ambient stylesheet.
const FALLBACK_STYLE: React.CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "1.25rem",
  border: "1px solid #55555a",
  borderRadius: "8px",
  color: "#e8e8ea",
  background: "#232326",
  fontFamily: "system-ui, sans-serif",
};

const FALLBACK_LINK_STYLE: React.CSSProperties = {
  justifySelf: "start",
  padding: "0.5rem 1rem",
  borderRadius: "6px",
  background: "#996bef",
  color: "#fff",
  textDecoration: "none",
  fontWeight: 600,
};

function DownloadFallback({ directUrl }: { directUrl: string }) {
  return (
    <div style={FALLBACK_STYLE}>
      <p style={{ margin: 0 }}>This video can&apos;t play in this browser.</p>
      <a href={directUrl} style={FALLBACK_LINK_STYLE}>
        Download
      </a>
    </div>
  );
}

export function VideoPreview({ ctx }: { ctx: PreviewContext }) {
  // Scoped to the specific `directUrl` that errored, not a bare boolean - so a stale fallback from a
  // PREVIOUS file can never leak onto a new one (no effect/reset dance needed: a new file's directUrl
  // simply never matches an old error record).
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);
  // Synchronous and cheap - recomputed every render rather than cached in state, so it is never stale
  // either.
  const unsupported = canDefinitelyNotPlay(ctx.mimeType) || erroredUrl === ctx.directUrl;

  if (unsupported) {
    return <DownloadFallback directUrl={ctx.directUrl} />;
  }

  return (
    <MediaPlayer
      key={ctx.directUrl}
      src={{ src: ctx.directUrl, type: ctx.mimeType }}
      playsInline
      style={FIT}
      // F0.2/F0.3: a container `canPlayType()` reported as merely "maybe"/"probably" (it cannot see inside
      // a bare container MIME type - no `codecs=` parameter is known here) still fails for real once the
      // browser actually opens it - e.g. HEVC inside a `.mp4`/`.mov` in a browser without HEVC decoding.
      // That failure arrives as this `error` event, and the fallback is the exact same download card.
      onError={() => setErroredUrl(ctx.directUrl)}
    >
      <MediaOutlet />
      <MediaCommunitySkin />
    </MediaPlayer>
  );
}
