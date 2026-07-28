import { describe, expect, it } from "vitest";
import { signDelivery, verifyDelivery } from "../../src/lib/deliverySignature.ts";

const SECRET = "test-secret";
const OTHER_SECRET = "a-different-secret";

describe("deliverySignature (D-84 signed delivery URLs)", () => {
  it("round-trips: a freshly signed id/exp verifies with the same secret", () => {
    const sig = signDelivery(SECRET, "file123", 1000);
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 500)).toBe(true);
  });

  it("rejects a tampered file id", () => {
    const sig = signDelivery(SECRET, "file123", 1000);
    expect(verifyDelivery(SECRET, "file456", 1000, sig, 500)).toBe(false);
  });

  it("rejects a tampered expiry", () => {
    const sig = signDelivery(SECRET, "file123", 1000);
    expect(verifyDelivery(SECRET, "file123", 2000, sig, 500)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const sig = signDelivery(OTHER_SECRET, "file123", 1000);
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 500)).toBe(false);
  });

  it("rejects once `now` passes the expiry", () => {
    const sig = signDelivery(SECRET, "file123", 1000);
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 1000)).toBe(true);
    expect(verifyDelivery(SECRET, "file123", 1000, sig, 1000.001)).toBe(false);
  });

  it("rejects a signature of the wrong length rather than throwing", () => {
    expect(verifyDelivery(SECRET, "file123", 1000, "short", 500)).toBe(false);
  });

  it("rejects malformed base64url rather than throwing", () => {
    expect(verifyDelivery(SECRET, "file123", 1000, "not base64url!!", 500)).toBe(false);
  });
});
