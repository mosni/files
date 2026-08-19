// Review 060/BUG-1 + BUG-3 + SEC-5: buildSignedDeliveryUrls is the ONE place a D-84 signed URL is built,
// shared by controllers/preview.ts and (new in this review) controllers/browse.ts. Before it existed the
// listing had no signing at all, which is what left every private file's thumbnail 401ing in its own
// owner's browser and every private file skipped by "Download all".

import { describe, expect, it } from "vitest";
import { buildSignedDeliveryUrls } from "../../src/lib/fileUrls.ts";
import { verifyDelivery } from "../../src/lib/deliverySignature.ts";

const config = {
  dlOrigin: "https://dl.mosni.dev",
  deliverySigningSecret: "test-secret",
  deliveryUrlTtlSeconds: 300,
};

const NOW = 1_000_000;

describe("buildSignedDeliveryUrls()", () => {
  it("builds a /s/<id> URL whose signature verifies at the `full` scope", () => {
    const { directUrl, expiresAt } = buildSignedDeliveryUrls(config, "file0000000000id", false, null, NOW);

    const url = new URL(directUrl);
    expect(url.origin).toBe("https://dl.mosni.dev");
    expect(url.pathname).toBe("/s/file0000000000id");
    expect(Number(url.searchParams.get("exp"))).toBe(expiresAt);
    expect(
      verifyDelivery(config.deliverySigningSecret, "file0000000000id", expiresAt, url.searchParams.get("sig")!, NOW, "full"),
    ).toBe(true);
  });

  it("builds a /thumb/s/<id> URL signed at the `thumb` scope, and null when there is no thumbnail", () => {
    const withThumb = buildSignedDeliveryUrls(config, "file0000000000id", true, null, NOW);
    const url = new URL(withThumb.thumbUrl!);
    expect(url.pathname).toBe("/thumb/s/file0000000000id");
    expect(
      verifyDelivery(config.deliverySigningSecret, "file0000000000id", withThumb.expiresAt, url.searchParams.get("sig")!, NOW, "thumb"),
    ).toBe(true);

    expect(buildSignedDeliveryUrls(config, "file0000000000id", false, null, NOW).thumbUrl).toBeNull();
  });

  it("SEC-5: the two URLs carry DIFFERENT signatures, so neither is usable at the other's route", () => {
    const { directUrl, thumbUrl } = buildSignedDeliveryUrls(config, "file0000000000id", true, null, NOW);
    const directSig = new URL(directUrl).searchParams.get("sig");
    const thumbSig = new URL(thumbUrl!).searchParams.get("sig");
    expect(directSig).not.toBe(thumbSig);
  });

  describe("lifetime (BUG-3)", () => {
    it("uses the configured TTL when there is no duration to cover", () => {
      expect(buildSignedDeliveryUrls(config, "f", false, null, NOW).expiresAt).toBe(NOW + 300);
    });

    it("ignores a duration that is already inside the configured TTL", () => {
      // 60s of video + the 15-minute margin is 960s, which is LONGER than the 300s default - so this case
      // has to use a duration short enough that the margin still lands under it. With a 30-minute TTL:
      const longTtl = { ...config, deliveryUrlTtlSeconds: 30 * 60 };
      expect(buildSignedDeliveryUrls(longTtl, "f", false, 60, NOW).expiresAt).toBe(NOW + 30 * 60);
    });

    it("extends past the configured TTL to cover a long video, plus a margin", () => {
      // A 40-minute video against the 5-minute default: 2400 + 900 (margin) = 3300s.
      expect(buildSignedDeliveryUrls(config, "f", false, 40 * 60, NOW).expiresAt).toBe(NOW + 40 * 60 + 15 * 60);
    });

    it("caps the extension, so a very long upload cannot mint an open-ended credential", () => {
      expect(buildSignedDeliveryUrls(config, "f", false, 48 * 60 * 60, NOW).expiresAt).toBe(NOW + 6 * 60 * 60);
    });

    it("the cap never SHORTENS a deliberately-raised configured TTL", () => {
      const longTtl = { ...config, deliveryUrlTtlSeconds: 12 * 60 * 60 };
      expect(buildSignedDeliveryUrls(longTtl, "f", false, null, NOW).expiresAt).toBe(NOW + 12 * 60 * 60);
      // ...even when a duration is present and the cap would otherwise bite.
      expect(buildSignedDeliveryUrls(longTtl, "f", false, 48 * 60 * 60, NOW).expiresAt).toBe(NOW + 12 * 60 * 60);
    });

    it("treats a zero, negative or non-finite duration as no duration at all", () => {
      for (const duration of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(buildSignedDeliveryUrls(config, "f", false, duration, NOW).expiresAt).toBe(NOW + 300);
      }
    });
  });
});
