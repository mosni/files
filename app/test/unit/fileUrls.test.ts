import { describe, expect, it } from "vitest";
import { buildFileUrls } from "../../src/lib/fileUrls.ts";

const origins = { appOrigin: "https://files.mosni.dev", dlOrigin: "https://dl.mosni.dev" };

describe("buildFileUrls (P6 URL shapes)", () => {
  it.each(["public", "unlisted", "private"] as const)(
    "%s uses the /f/ preview and plain dl path, encoding each segment but keeping slashes",
    (protection) => {
      const urls = buildFileUrls(origins, protection, "hannah/a b/c.png", "ABCDE");
      expect(urls.previewUrl).toBe("https://files.mosni.dev/f/hannah/a%20b/c.png");
      expect(urls.directUrl).toBe("https://dl.mosni.dev/hannah/a%20b/c.png");
    },
  );

  it("secret uses the unguessable token URL on both hosts (the readable path 404s)", () => {
    const urls = buildFileUrls(origins, "secret", "hannah/x.png", "ABCDE");
    expect(urls.previewUrl).toBe("https://files.mosni.dev/t/ABCDE");
    expect(urls.directUrl).toBe("https://dl.mosni.dev/t/ABCDE");
  });
});
