import { describe, expect, it } from "vitest";
import { buildCollectionPreviewUrl, buildFileUrls, buildSignedDeliveryUrls } from "../../src/lib/fileUrls.ts";
import { verifyDelivery } from "../../src/lib/deliverySignature.ts";

const origins = { appOrigin: "https://files.mosni.dev", dlOrigin: "https://dl.mosni.dev" };

describe("buildFileUrls (D-81/D-82: display-name segments, not an on-disk path)", () => {
  it.each(["public", "unlisted", "private"] as const)(
    "%s uses the /f/ preview and plain dl path, encoding each segment but keeping slashes",
    (protection) => {
      const urls = buildFileUrls(origins, protection, ["hannah", "a b", "c.png"], "ABCDE");
      expect(urls.previewUrl).toBe("https://files.mosni.dev/f/hannah/a%20b/c.png");
      expect(urls.directUrl).toBe("https://dl.mosni.dev/hannah/a%20b/c.png");
    },
  );

  it("secret uses the unguessable token URL on both hosts (the readable path 404s)", () => {
    const urls = buildFileUrls(origins, "secret", ["hannah", "x.png"], "ABCDE");
    expect(urls.previewUrl).toBe("https://files.mosni.dev/t/ABCDE");
    expect(urls.directUrl).toBe("https://dl.mosni.dev/t/ABCDE");
  });

  it("a rename changes only the segments passed in - the URL follows the CURRENT name", () => {
    const before = buildFileUrls(origins, "public", ["hannah", "old.png"], "ABCDE");
    const after = buildFileUrls(origins, "public", ["hannah", "new.png"], "ABCDE");
    expect(before.previewUrl).toBe("https://files.mosni.dev/f/hannah/old.png");
    expect(after.previewUrl).toBe("https://files.mosni.dev/f/hannah/new.png");
  });
});

// D-98: a collection's own share link - same shape as a file's previewUrl, on the /f/ or /t/ host it
// shares with files.mosni.dev (collections have no bytes of their own, so there is no directUrl).
// E7-QA1 round 3 (Hannah): "the thumbnail does not load for private files ... changing it to unlisted
// fixed it". A `private` file's path URLs reach routes that run authorizePrivate(), and dl.mosni.dev has
// no session to authorize with (D-33), so an `<img src>` could never satisfy them. The signature IS the
// authorization for that level - this helper is the one place both the preview page and the browse
// listing build it, so the two cannot drift apart the way they had.
describe("buildSignedDeliveryUrls (D-84/D-137)", () => {
  const config = {
    dlOrigin: "https://dl.mosni.dev",
    deliverySigningSecret: "test-secret",
    deliveryUrlTtlSeconds: 3600,
  };

  it("signs the /s/ direct URL and the matching /thumb/s/ URL with one signature", () => {
    const urls = buildSignedDeliveryUrls(config, "fileid1234567890", true, 1_000_000);

    expect(urls.directUrl).toBe(
      `https://dl.mosni.dev/s/fileid1234567890?exp=1003600&sig=${new URL(urls.directUrl).searchParams.get("sig")}`,
    );
    expect(urls.thumbUrl).toContain("/thumb/s/fileid1234567890");
    // The signature covers the fileId, not anything thumbnail-specific, so both carry the same one.
    expect(new URL(urls.thumbUrl!).searchParams.get("sig")).toBe(new URL(urls.directUrl).searchParams.get("sig"));
    expect(new URL(urls.thumbUrl!).searchParams.get("exp")).toBe("1003600");
  });

  it("produces a signature the delivery verifier actually accepts", () => {
    const urls = buildSignedDeliveryUrls(config, "fileid1234567890", false, 1_000_000);
    const params = new URL(urls.directUrl).searchParams;

    expect(
      verifyDelivery(
        config.deliverySigningSecret,
        "fileid1234567890",
        Number(params.get("exp")),
        params.get("sig")!,
        1_000_100, // still inside the TTL
      ),
    ).toBe(true);
  });

  it("expires: the same signature is refused once the TTL has passed", () => {
    const urls = buildSignedDeliveryUrls(config, "fileid1234567890", false, 1_000_000);
    const params = new URL(urls.directUrl).searchParams;

    expect(
      verifyDelivery(
        config.deliverySigningSecret,
        "fileid1234567890",
        Number(params.get("exp")),
        params.get("sig")!,
        1_003_601, // one second past exp
      ),
    ).toBe(false);
  });

  it("returns a null thumbUrl when the record has no thumbnail, never a URL for bytes that don't exist", () => {
    expect(buildSignedDeliveryUrls(config, "fileid1234567890", false, 1_000_000).thumbUrl).toBeNull();
  });

  it("a different file id yields a different signature", () => {
    const a = buildSignedDeliveryUrls(config, "fileidAAAAAAAAAA", true, 1_000_000);
    const b = buildSignedDeliveryUrls(config, "fileidBBBBBBBBBB", true, 1_000_000);
    expect(new URL(a.directUrl).searchParams.get("sig")).not.toBe(new URL(b.directUrl).searchParams.get("sig"));
  });
});

describe("buildCollectionPreviewUrl", () => {
  it.each(["public", "unlisted", "private"] as const)("%s uses the /f/ path", (protection) => {
    expect(buildCollectionPreviewUrl(origins, protection, ["hannah", "photos"], "ZZZZZ")).toBe(
      "https://files.mosni.dev/f/hannah/photos",
    );
  });

  it("secret uses the unguessable token URL - the readable path 404s", () => {
    expect(buildCollectionPreviewUrl(origins, "secret", ["hannah", "photos"], "ZZZZZ")).toBe(
      "https://files.mosni.dev/t/ZZZZZ",
    );
  });

  it("encodes each segment but keeps slashes", () => {
    expect(buildCollectionPreviewUrl(origins, "public", ["a b", "c/d"], "ZZZZZ")).toBe(
      "https://files.mosni.dev/f/a%20b/c%2Fd",
    );
  });
});
