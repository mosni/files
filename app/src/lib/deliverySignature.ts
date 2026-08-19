// D-84: short-lived signed delivery URLs, so a `private` file's bytes can render in its own preview - a
// browser cannot attach a Bearer to an <img>/<video>/<iframe> subresource request, and D-33 forbids a
// cookie on dl.mosni.dev outright. Pure, I/O-free (technical-baseline.md §2): no config reading, no
// clock reads other than the `now` the caller passes in, so it is directly unit-testable.

import { createHmac, timingSafeEqual } from "node:crypto";

// Which bytes a signature authorizes. Review 060/SEC-5: until this existed the signed input was
// `${fileId}\n${expiresAt}` alone, and BOTH /s/:id and /thumb/s/:id verified against it - so a thumbnail
// signature was also a full-file signature, and stripping "/thumb" out of the path returned the original.
// Harmless while the only issuer handed both out together to a viewer already authorized for the full
// file; a landmine the first time anything wants to show a thumbnail to someone who may not have the
// source. Binding the scope makes that mistake unrepresentable rather than merely unmade.
export type DeliveryScope = "full" | "thumb";

// Signed input is exactly `${fileId}\n${expiresAt}\n${scope}` - never the display name, never the disk
// path, so renaming a file or moving a collection can never invalidate an in-flight signed URL's semantics.
function signedInput(fileId: string, expiresAt: number, scope: DeliveryScope): string {
  return `${fileId}\n${expiresAt}\n${scope}`;
}

export function signDelivery(secret: string, fileId: string, expiresAt: number, scope: DeliveryScope): string {
  return createHmac("sha256", secret).update(signedInput(fileId, expiresAt, scope)).digest("base64url");
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
  scope: DeliveryScope,
): boolean {
  if (!Number.isFinite(expiresAt) || now > expiresAt) return false;

  // Compare the base64url STRINGS as raw (ASCII-safe) bytes, rather than decoding `sig` back into binary
  // first - decoding would need the exact inverse of `digest("base64url")`'s encoding and is one more
  // place for an encoding mismatch to hide. Both sides being plain ASCII text makes utf8 exact either way.
  const expected = Buffer.from(signDelivery(secret, fileId, expiresAt, scope), "utf8");
  const provided = Buffer.from(sig, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
