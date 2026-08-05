// D-100's client-side half: the client never CONSTRUCTS a URL, it only reads parts out of one the server
// already built. `tokenOf` was added by the E5/E5.1 review session (039) so the archive walk can reach a
// nested `secret` collection with the token its parent's own browse response carried - see
// web/src/lib/archive.ts and FileBrowser.tsx's fetchArchiveLevel.

import { describe, expect, it } from "vitest";
import { pathnameOf, tokenOf } from "../../src/lib/links.ts";

describe("pathnameOf (D-100)", () => {
  it("keeps only the pathname of a server-built absolute URL", () => {
    expect(pathnameOf("https://files.mosni.dev/f/Holiday/beach.jpg")).toBe("/f/Holiday/beach.jpg");
  });

  it("drops a query string rather than carrying it into an in-SPA navigation", () => {
    expect(pathnameOf("https://files.mosni.dev/f/Holiday?x=1")).toBe("/f/Holiday");
  });
});

describe("tokenOf (E5/E5.1 review, session 039)", () => {
  it("extracts the token from the /t/<token> shape a secret collection's previewUrl uses", () => {
    expect(tokenOf("https://files.mosni.dev/t/aB3xQ")).toBe("aB3xQ");
  });

  it("percent-decodes, since buildCollectionPreviewUrl's segment is URL-encoded", () => {
    expect(tokenOf("https://files.mosni.dev/t/a%2Bb")).toBe("a+b");
  });

  it("returns null for the readable /f/<path> shape, which needs no token", () => {
    expect(tokenOf("https://files.mosni.dev/f/Holiday")).toBeNull();
  });

  it("returns null for a deeper path that merely starts with /t/", () => {
    // A file INSIDE a token-reached collection is still a /f/ path; only the collection document itself is
    // the two-segment /t/<token> shape. Anything longer is not a collection token and must not be sent as
    // one.
    expect(tokenOf("https://files.mosni.dev/t/aB3xQ/extra")).toBeNull();
  });

  it("returns null for a bare /t/ with no token", () => {
    expect(tokenOf("https://files.mosni.dev/t/")).toBeNull();
  });
});
