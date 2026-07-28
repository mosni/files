import { describe, expect, it } from "vitest";
import { buildCollectionPreviewUrl, buildFileUrls } from "../../src/lib/fileUrls.ts";

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
