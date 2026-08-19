import { describe, expect, it } from "vitest";
import { signDelivery, verifyDelivery } from "../../src/lib/deliverySignature.ts";

const SECRET = "test-secret";
const OTHER_SECRET = "a-different-secret";

describe("deliverySignature (D-84 signed delivery URLs)", () => {
  it("round-trips: a freshly signed id/exp verifies with the same secret", () => {
    const sig = signDelivery(SECRET, "file123", 1000, "full");
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 500, "full")).toBe(true);
  });

  it("rejects a tampered file id", () => {
    const sig = signDelivery(SECRET, "file123", 1000, "full");
    expect(verifyDelivery(SECRET, "file456", 1000, sig, 500, "full")).toBe(false);
  });

  it("rejects a tampered expiry", () => {
    const sig = signDelivery(SECRET, "file123", 1000, "full");
    expect(verifyDelivery(SECRET, "file123", 2000, sig, 500, "full")).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const sig = signDelivery(OTHER_SECRET, "file123", 1000, "full");
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 500, "full")).toBe(false);
  });

  it("rejects once `now` passes the expiry", () => {
    const sig = signDelivery(SECRET, "file123", 1000, "full");
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 1000, "full")).toBe(true);
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 1000.001, "full")).toBe(false);
  });

  it("rejects a signature of the wrong length rather than throwing", () => {
    expect(verifyDelivery(SECRET, "file123", 1000, "short", 500, "full")).toBe(false);
  });

  it("rejects malformed base64url rather than throwing", () => {
    expect(verifyDelivery(SECRET, "file123", 1000, "not base64url!!", 500, "full")).toBe(false);
  });

  // Review 060/SEC-5. Before the scope became part of the signed input, these two assertions BOTH failed:
  // one signature verified for either route, so a thumbnail URL was a full-file URL with "/thumb" removed.
  it("a `thumb` signature never verifies as `full`, and vice versa", () => {
    const thumbSig = signDelivery(SECRET, "file123", 1000, "thumb");
    expect(verifyDelivery(SECRET, "file123", 1000, thumbSig, 500, "thumb")).toBe(true);
    expect(verifyDelivery(SECRET, "file123", 1000, thumbSig, 500, "full")).toBe(false);

    const fullSig = signDelivery(SECRET, "file123", 1000, "full");
    expect(verifyDelivery(SECRET, "file123", 1000, fullSig, 500, "full")).toBe(true);
    expect(verifyDelivery(SECRET, "file123", 1000, fullSig, 500, "thumb")).toBe(false);
  });

  it("the two scopes produce different signatures for the same id and expiry", () => {
    expect(signDelivery(SECRET, "file123", 1000, "full")).not.toBe(
      signDelivery(SECRET, "file123", 1000, "thumb"),
    );
  });
});
