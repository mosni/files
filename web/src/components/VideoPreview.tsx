// E5 Wave F (D-144, "plays where it plays"): decide playability at RUNTIME, per browser - NEVER by
// sniffing the user agent or trusting the file extension. A container/codec combination the browser
// cannot decode falls back to the same download card `PreviewCard`'s non-inline branch already uses - one
// fallback path, not two (F0.3).
//
// F2 (MKV remux) is DEFERRED, not shipped (Hannah, 2026-08-03): the plan's pinned `mux.js` cannot parse
// Matroska at all - it transmuxes MP4/FLV/TS only, and has never had an EBML/Matroska demuxer. There is
// nothing in this repo's dependencies that can turn `.mkv` bytes into something a browser's <video> can
// play. `.mkv` stays on the inline allowlist (D-144 already covers all three widened containers together)
// and goes through the exact same D2 readiness gate as every other video - since no mainstream browser
// natively decodes Matroska today, it currently always falls through to the download card below, which is
// the honest, working behaviour until a real remux path is planned and vetted in its own session (see
// decisions.md).
//
// E5.1 Wave D (D-164 root cause, D-157, D-158): three things changed here in one pass, deliberately as one
// change (§D0 of the hand-off explicitly requires it):
//   D0 - `src` is now a STABLE PRIMITIVE (a string), never an inline object literal. The object literal
//        this used to pass (`{ src: ctx.directUrl, type: ctx.mimeType }`) was a NEW object on every
//        render, and Vidstack's React wrapper compares its source prop by identity - so an unrelated
//        re-render (the owner's Bearer re-fetch in pages/Preview.tsx guarantees one) tore the provider
//        down and never rebuilt it, leaving a ~2px <media-player> with no <video> and no `error` (finding
//        5, D-164). A signed-out visitor never re-renders that way, which is why 874 tests and every
//        anonymous check passed while this was broken for the only person using the app. If a future
//        change ever needs the object form back, it MUST be memoised (`useMemo` on `[ctx.directUrl]`) -
//        an inline object literal in this prop is a latent teardown and must never be reintroduced.
//   D1 - no `type` hint is passed at all. Vidstack refuses a source on its declared MIME type outright for
//        `video/quicktime`, `video/x-m4v` and `video/x-matroska` (measured session 035) - exactly what
//        D-144's own MIME widening produces for `.mov`/`.m4v`/`.mkv`, so the type hint was short-circuiting
//        three of the five allowlisted containers to the download card even when the BROWSER could play
//        the bytes. Dropping it lets the browser decide from the bytes, exactly as the bare <video> that
//        demonstrably works already does. Never map the exotic types to `video/mp4` to sneak them past the
//        check - that lies to the player about the container and is a different bug wearing a hat.
//   D2 - the player is optimistic no longer. It used to render unconditionally and only fall back on an
//        affirmative `error` - so a failure that raised no `error` (confirmed: a stalled source sitting at
//        readyState 0 with no error and no card) rendered as nothing at all, which is what made finding 5
//        invisible even to a code audit. It is now shown ONLY while it is affirmatively proving it works:
//        a can-play/loaded-data signal within a deadline, no error, and (once ready) a real rendered
//        height. Any candidate cause - codec stall, zero-height layout, skin failure, a provider that
//        never attaches - now produces the same correct outcome: a working player, or an honest download
//        card. It never again becomes an empty region.
//
// Vidstack styling: MediaCommunitySkin's CSS ships in the `vidstack` core package, not `@vidstack/react` -
// imported here, next to the one component that needs it, rather than globally in main.tsx.
import "vidstack/styles/base.css";
import "vidstack/styles/community-skin/video.css";

import { useEffect, useRef, useState } from "react";
import { MediaCommunitySkin, MediaOutlet, MediaPlayer } from "@vidstack/react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

// D5: `touch-action: pan-y` so a vertical touch drag over the player scrolls the page instead of being
// captured by Vidstack's gesture handling, which otherwise claims the whole media area for its own
// (horizontal scrub) gestures. Applied to both the wrapper and the player element itself.
const FIT: React.CSSProperties = { maxWidth: "100%", display: "block", touchAction: "pan-y" };

// D2: starting values, not measured ones - say so in the session log, and expect a review to challenge
// them. The deadline is RESET (not just extended) on real load activity (onLoadStart/onProgress), so a
// slow-but-progressing connection is never dumped to the card while it is visibly still loading.
const READY_DEADLINE_MS = 8000;
// A player collapsed to a couple of pixels (D-164's exact symptom before the D0 fix, and the shape any
// OTHER un-anticipated failure mode would produce too) is indistinguishable, to the user, from no player
// at all - this is what closes finding 5 without knowing every possible cause. Starting value.
const MIN_PLAYER_HEIGHT_PX = 64;

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

// Exported: D6/D-166 reuses this exact fallback for a failed lazy-chunk load (PreviewCard.tsx's error
// boundary) - one fallback path/presentation, not a second one reimplemented with `.panel`/`.btn`, which
// would be wrong here for the same reason it is wrong below (no ambient stylesheet on the embed route).
export function DownloadFallback({ directUrl }: { directUrl: string }) {
  return (
    <div style={FALLBACK_STYLE}>
      <p style={{ margin: 0 }}>This video can&apos;t play in this browser.</p>
      <a href={directUrl} style={FALLBACK_LINK_STYLE}>
        Download
      </a>
    </div>
  );
}

type ReadinessStatus = "checking" | "confirmed" | "fallback";

export function VideoPreview({ ctx }: { ctx: PreviewContext }) {
  // Scoped to the specific `directUrl` that errored, not a bare boolean - so a stale fallback from a
  // PREVIOUS file can never leak onto a new one (no effect/reset dance needed: a new file's directUrl
  // simply never matches an old error record).
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<ReadinessStatus>("checking");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const deadlineTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const errored = erroredUrl === ctx.directUrl;

  // A fresh file always re-enters "checking" with its own deadline - never carries over a previous file's
  // confirmed/fallback state (VideoPreview itself does not remount across files; only MediaPlayer does,
  // via its own `key` below).
  useEffect(() => {
    setStatus("checking");
  }, [ctx.directUrl]);

  function armDeadline() {
    clearTimeout(deadlineTimer.current);
    deadlineTimer.current = setTimeout(() => {
      setStatus((current) => (current === "checking" ? "fallback" : current));
    }, READY_DEADLINE_MS);
  }

  // D2's core: the player must PROVE it works within a bounded time, or the card renders - this is what
  // closes finding 5 without needing to know its cause. Runs once per file, only while still checking.
  useEffect(() => {
    if (errored || status !== "checking") return;
    armDeadline();
    return () => clearTimeout(deadlineTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.directUrl, errored, status]);

  function reportReady() {
    clearTimeout(deadlineTimer.current);
    setStatus((current) => (current === "checking" ? "confirmed" : current));
  }

  function reportProgress() {
    // Still loading and making progress - not a stall. Reset (not merely extend) the same deadline rather
    // than accumulate a second timer.
    if (status === "checking") armDeadline();
  }

  // D2's visibility check: once the player reports ready, confirm it is actually rendering at a sane
  // size - see MIN_PLAYER_HEIGHT_PX above. ResizeObserver, not a poll (an observer that only ever needs
  // ONE reading, then disconnects). Guarded for an environment with no ResizeObserver (none of this
  // project's test tiers provide one) - a real browser always has it.
  useEffect(() => {
    if (status !== "confirmed") return;
    const el = wrapperRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    let settled = false;
    const observer = new ResizeObserver((entries) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      const height = entries[0]?.contentRect.height ?? 0;
      if (height < MIN_PLAYER_HEIGHT_PX) setStatus("fallback");
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [status]);

  if (errored || status === "fallback") {
    return <DownloadFallback directUrl={ctx.directUrl} />;
  }

  return (
    <div ref={wrapperRef} style={FIT}>
      <MediaPlayer
        key={ctx.directUrl}
        src={ctx.directUrl}
        playsInline
        style={FIT}
        // F0.2/F0.3: a container `canPlayType()` reported as merely "maybe"/"probably" (it cannot see
        // inside a bare container MIME type - no `codecs=` parameter is known here) still fails for real
        // once the browser actually opens it - e.g. HEVC inside a `.mp4`/`.mov` in a browser without HEVC
        // decoding. That failure arrives as this `error` event, and the fallback is the exact same
        // download card. D4 (D-166): a failed lazy-chunk asset is handled by an error boundary in
        // PreviewCard.tsx, one level up - this `onError` is only the player's OWN runtime failures.
        onError={() => setErroredUrl(ctx.directUrl)}
        onCanPlay={reportReady}
        onLoadedData={reportReady}
        onLoadStart={reportProgress}
        onProgress={reportProgress}
      >
        <MediaOutlet />
        <MediaCommunitySkin />
      </MediaPlayer>
    </div>
  );
}
