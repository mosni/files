import { randomBytes } from "node:crypto";

// The token alphabet is exactly base64url's ([A-Za-z0-9_-]) so a token can never be confused with a
// path segment (no "/") or with standard-base64 output (no "+"), letting isLinkTokenShaped() double as
// a router-level guard between "this URL segment is a token" and "this URL segment is a filename".
const TOKEN_LENGTH = 22; // 16 random bytes, base64url-encoded, no padding.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

// 16 bytes = 128 bits of entropy, generated once per file and stored in the database - unrelated to the
// file's on-disk name (see agent-docs D-59 for the protection-level context that consumes this).
export function generateLinkToken(): string {
  return randomBytes(16).toString("base64url");
}

export function isLinkTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}
