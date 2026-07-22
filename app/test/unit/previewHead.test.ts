import { describe, expect, it } from "vitest";
import { renderEmbeddedContext, renderPreviewHead } from "../../src/views/PreviewHead.tsx";
import type { PreviewContext } from "../../src/lib/previewContext.ts";

const APP_ORIGIN = "https://files.mosni.dev";

function makeCtx(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    name: "photo.png",
    path: "dir/photo.png",
    bytes: 2_400_000,
    sizeLabel: "2.3 MB",
    protection: "public",
    createdAt: "2026-07-21T12:00:00.000Z",
    previewUrl: "https://files.mosni.dev/f/dir/photo.png",
    directUrl: "https://dl.mosni.dev/dir/photo.png",
    kind: "image",
    mimeType: "image/png",
    inline: true,
    width: 800,
    height: 600,
    durationSeconds: null,
    textPreview: null,
    isOwner: false,
    ...overrides,
  };
}

describe("renderPreviewHead() - ctx === null (private/anonymous case)", () => {
  const head = renderPreviewHead(null, APP_ORIGIN);

  it("emits only a generic title and a noindex robots tag", () => {
    expect(head).toContain("<title>Hannah&#x27;s File Drop</title>");
    expect(head).toContain('name="robots" content="noindex, nofollow"');
  });

  it("emits nothing else - no og:, no filename, no path, no canonical", () => {
    expect(head).not.toContain("og:");
    expect(head).not.toContain("photo.png");
    expect(head).not.toContain("dir/photo.png");
    expect(head).not.toContain("canonical");
    expect(head).not.toContain("twitter:");
    expect(head).not.toContain("application/ld+json");
    expect(head).not.toContain("preview-context");
  });
});

describe("renderPreviewHead() - document basics", () => {
  const ctx = makeCtx();
  const head = renderPreviewHead(ctx, APP_ORIGIN);

  it("renders the title with the file name", () => {
    expect(head).toContain("<title>photo.png · Hannah&#x27;s File Drop</title>");
  });

  it("renders a canonical link to the preview URL", () => {
    expect(head).toContain(`rel="canonical" href="${ctx.previewUrl}"`);
  });

  it("renders a description meta tag", () => {
    expect(head).toContain('name="description" content="PNG image · 2.3 MB · uploaded 21 Jul 2026"');
  });

  it("renders a theme-color meta tag", () => {
    expect(head).toContain('name="theme-color" content="#996bef"');
  });

  it("renders the oEmbed discovery link", () => {
    // React escapes "&" in attribute values (&amp;), same as any other attribute value.
    const expectedHref = `${APP_ORIGIN}/api/oembed?url=${encodeURIComponent(ctx.previewUrl)}&amp;format=json`;
    expect(head).toContain('type="application/json+oembed"');
    expect(head).toContain(`href="${expectedHref}"`);
    expect(head).toContain('title="photo.png"');
  });
});

describe("renderPreviewHead() - robots per protection level", () => {
  it.each(["unlisted", "secret", "private"] as const)("noindex, nofollow for %s", (protection) => {
    const head = renderPreviewHead(makeCtx({ protection }), APP_ORIGIN);
    expect(head).toContain('name="robots" content="noindex, nofollow"');
  });

  it("index, follow only for public", () => {
    const head = renderPreviewHead(makeCtx({ protection: "public" }), APP_ORIGIN);
    expect(head).toContain('name="robots" content="index, follow"');
    expect(head).not.toContain("noindex");
  });
});

describe("renderPreviewHead() - Open Graph, common tags", () => {
  const ctx = makeCtx();
  const head = renderPreviewHead(ctx, APP_ORIGIN);

  it("carries site_name, title, description, url, locale", () => {
    expect(head).toContain('property="og:site_name" content="Hannah&#x27;s File Drop"');
    expect(head).toContain(`property="og:title" content="${ctx.name}"`);
    expect(head).toContain('property="og:description"');
    expect(head).toContain(`property="og:url" content="${ctx.previewUrl}"`);
    expect(head).toContain('property="og:locale" content="en_US"');
  });

  it("og:type is website for non-video kinds", () => {
    expect(head).toContain('property="og:type" content="website"');
  });

  it("og:type is video.other for video", () => {
    const videoHead = renderPreviewHead(makeCtx({ kind: "video", mimeType: "video/mp4" }), APP_ORIGIN);
    expect(videoHead).toContain('property="og:type" content="video.other"');
  });
});

describe("renderPreviewHead() - image kind", () => {
  const ctx = makeCtx({ kind: "image", mimeType: "image/png", width: 800, height: 600 });
  const head = renderPreviewHead(ctx, APP_ORIGIN);

  it("carries og:image, secure_url, type, dimensions and alt", () => {
    expect(head).toContain(`property="og:image" content="${ctx.directUrl}"`);
    expect(head).toContain(`property="og:image:secure_url" content="${ctx.directUrl}"`);
    expect(head).toContain('property="og:image:type" content="image/png"');
    expect(head).toContain('property="og:image:width" content="800"');
    expect(head).toContain('property="og:image:height" content="600"');
    expect(head).toContain(`property="og:image:alt" content="${ctx.name}"`);
  });

  it("does not carry any og:video tag", () => {
    expect(head).not.toContain("og:video");
  });

  it("uses summary_large_image for twitter:card, with twitter:image and alt", () => {
    expect(head).toContain('name="twitter:card" content="summary_large_image"');
    expect(head).toContain(`name="twitter:image" content="${ctx.directUrl}"`);
    expect(head).toContain(`name="twitter:image:alt" content="${ctx.name}"`);
  });

  it("omits og:image:width/height entirely when dimensions are null - never empty", () => {
    const noDims = renderPreviewHead(makeCtx({ kind: "image", width: null, height: null }), APP_ORIGIN);
    expect(noDims).not.toContain("og:image:width");
    expect(noDims).not.toContain("og:image:height");
    expect(noDims).not.toContain('content=""');
  });
});

describe("renderPreviewHead() - video kind", () => {
  const ctx = makeCtx({
    name: "clip.mp4",
    kind: "video",
    mimeType: "video/mp4",
    width: 1920,
    height: 1080,
    durationSeconds: 90,
  });
  const head = renderPreviewHead(ctx, APP_ORIGIN);

  it("carries og:video, secure_url, type, dimensions and duration", () => {
    expect(head).toContain(`property="og:video" content="${ctx.directUrl}"`);
    expect(head).toContain(`property="og:video:secure_url" content="${ctx.directUrl}"`);
    expect(head).toContain('property="og:video:type" content="video/mp4"');
    expect(head).toContain('property="og:video:width" content="1920"');
    expect(head).toContain('property="og:video:height" content="1080"');
    expect(head).toContain('property="og:video:duration" content="90"');
  });

  it("does not carry any og:image tag", () => {
    expect(head).not.toContain("og:image");
  });

  it("uses twitter:card=summary, never player", () => {
    expect(head).toContain('name="twitter:card" content="summary"');
    expect(head).not.toContain("player");
  });

  it("omits og:video:duration when durationSeconds is null", () => {
    const noDuration = renderPreviewHead(makeCtx({ kind: "video", durationSeconds: null }), APP_ORIGIN);
    expect(noDuration).not.toContain("og:video:duration");
  });

  it("omits og:video:width/height entirely when dimensions are null", () => {
    const noDims = renderPreviewHead(
      makeCtx({ kind: "video", width: null, height: null, durationSeconds: null }),
      APP_ORIGIN,
    );
    expect(noDims).not.toContain("og:video:width");
    expect(noDims).not.toContain("og:video:height");
  });
});

describe("renderPreviewHead() - pdf/text/other kinds (twitter:card=summary, no image/video tags)", () => {
  it.each(["pdf", "text", "other"] as const)("kind %s uses twitter:card=summary and no og:image/og:video", (kind) => {
    const head = renderPreviewHead(makeCtx({ kind, width: null, height: null }), APP_ORIGIN);
    expect(head).toContain('name="twitter:card" content="summary"');
    expect(head).not.toContain("og:image");
    expect(head).not.toContain("og:video");
  });
});

describe("renderPreviewHead() - JSON-LD", () => {
  it("emits an ImageObject with contentUrl/url/encodingFormat/contentSize/uploadDate and dimensions", () => {
    const ctx = makeCtx();
    const head = renderPreviewHead(ctx, APP_ORIGIN);
    const match = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(head);
    expect(match).not.toBeNull();
    const data = JSON.parse(match![1]);
    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@type": "ImageObject",
      name: ctx.name,
      contentUrl: ctx.directUrl,
      url: ctx.previewUrl,
      encodingFormat: ctx.mimeType,
      contentSize: ctx.sizeLabel,
      uploadDate: ctx.createdAt,
      width: 800,
      height: 600,
    });
  });

  it("emits a VideoObject with an ISO-8601 duration for a video", () => {
    const ctx = makeCtx({ kind: "video", mimeType: "video/mp4", durationSeconds: 90 });
    const head = renderPreviewHead(ctx, APP_ORIGIN);
    const match = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(head);
    const data = JSON.parse(match![1]);
    expect(data["@type"]).toBe("VideoObject");
    expect(data.duration).toBe("PT1M30S");
  });

  it("emits a MediaObject for other kinds, and omits width/height/duration when null", () => {
    const ctx = makeCtx({ kind: "other", width: null, height: null, durationSeconds: null });
    const head = renderPreviewHead(ctx, APP_ORIGIN);
    const match = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(head);
    const data = JSON.parse(match![1]);
    expect(data["@type"]).toBe("MediaObject");
    expect(data).not.toHaveProperty("width");
    expect(data).not.toHaveProperty("height");
    expect(data).not.toHaveProperty("duration");
  });
});

describe("XSS: a filename containing </script> and an onerror payload", () => {
  const evilName = "a</script><img src=x onerror=alert(1)>.png";

  it("produces no literal </script> in the JSON-LD block", () => {
    const ctx = makeCtx({ name: evilName });
    const head = renderPreviewHead(ctx, APP_ORIGIN);
    const ldMatch = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(head);
    expect(ldMatch).not.toBeNull();
    expect(ldMatch![1]).not.toContain("</script>");
    // Only `<` is escaped (per the invariant) - that alone breaks the closing-tag boundary a browser's
    // HTML parser looks for, so the trailing `>` does not need escaping too.
    expect(ldMatch![1]).toContain("\\u003c/script>");
  });

  it("produces no literal </script> in the embedded-context block", () => {
    const ctx = makeCtx({ name: evilName });
    const embedded = renderEmbeddedContext(ctx);
    const ctxMatch = /<script type="application\/json" id="preview-context">(.*?)<\/script>/.exec(embedded);
    expect(ctxMatch).not.toBeNull();
    expect(ctxMatch![1]).not.toContain("</script>");
    expect(ctxMatch![1]).toContain("\\u003c/script>");
    // parses back to the original (unescaped) name once JSON-decoded
    expect(JSON.parse(ctxMatch![1]).name).toBe(evilName);
  });

  it("the full head string never contains the literal payload's closing tag", () => {
    const ctx = makeCtx({ name: evilName });
    const head = renderPreviewHead(ctx, APP_ORIGIN);
    const embedded = renderEmbeddedContext(ctx);
    expect(head + embedded).not.toContain("</script><img");
  });
});

describe("renderEmbeddedContext()", () => {
  it("emits a script tag with type application/json and id preview-context", () => {
    const ctx = makeCtx();
    const embedded = renderEmbeddedContext(ctx);
    expect(embedded).toContain('<script type="application/json" id="preview-context">');
    expect(embedded.trim().endsWith("</script>")).toBe(true);
  });

  it("round-trips to a PreviewContext with isOwner false and matching urls", () => {
    const ctx = makeCtx();
    const embedded = renderEmbeddedContext(ctx);
    const match = /<script type="application\/json" id="preview-context">(.*?)<\/script>/.exec(embedded);
    const parsed = JSON.parse(match![1]);
    expect(parsed).toEqual(ctx);
    expect(parsed.isOwner).toBe(false);
  });
});
