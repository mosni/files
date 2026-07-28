// D-84: short-lived signed delivery URLs, so a `private` file's bytes can render in its own preview - a
// browser cannot attach a Bearer to an <img>/<video>/<iframe> subresource request, and D-33 forbids a
// cookie on dl.mosni.dev outright. Pure, I/O-free (technical-baseline.md §2): no config reading, no
// clock reads other than the `now` the caller passes in, so it is directly unit-testable.

import { createHmac, timingSafeEqual } from "node:crypto";

// Signed input is exactly `${fileId}\n${expiresAt}` - never the display name, never the disk path, so
// renaming a file or moving a collection can never invalidate an in-flight signed URL's semantics.
function signedInput(fileId: string, expiresAt: number): string {
  return `${fileId}\n${expiresAt}`;
}

export function signDelivery(secret: string, fileId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(signedInput(fileId, expiresAt)).digest("base64url");
}

// `now` is a unix-seconds timestamp, passed in rather than read here, so expiry is deterministic under
// test. Comparison uses timingSafeEqual on equal-length buffers (checked first, since it throws on a
// length mismatch rather than returning false).
export function verifyDelivery(
  secret: string,
  fileId: string,
  expiresAt: number,
  sig: string,
  now: number,
): boolean {
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;

  // Compare the base64url STRINGS as raw (ASCII-safe) bytes, rather than decoding `sig` back into binary
  // first - decoding would need the exact inverse of `digest("base64url")`'s encoding and is one more
  // place for an encoding mismatch to hide. Both sides being plain ASCII text makes utf8 exact either way.
  const expected = Buffer.from(signDelivery(secret, fileId, expiresAt), "utf8");
  const provided = Buffer.from(sig, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
