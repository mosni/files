import { randomInt } from "node:crypto";

// Short, human-friendly share tokens (preliminary-review P5). Deliberately base62, NOT numeric: a literal
// 5-digit numeric token is only 100 000 values - brute-forceable in minutes - and it is what guards
// `secret`/`unlisted` files, so numeric would make those levels meaningless. 5 base62 characters is ~916M
// (~30 bits) for the same "short and copyable" feel with far less brute-force surface. Anything genuinely
// sensitive must lean on `private` + auth, never on token secrecy. Length and alphabet are the one place
// to change - if you bump LINK_TOKEN_LENGTH, widen the link_token column in schema.sql to match.
export const LINK_TOKEN_LENGTH = 5;
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9]{${LINK_TOKEN_LENGTH}}$`);

export function generateLinkToken(): string {
  // crypto.randomInt is uniform over [0, n) - no modulo bias, unlike `randomBytes % 62`.
  let token = "";
  for (let i = 0; i < LINK_TOKEN_LENGTH; i++) {
    token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  }
  return token;
}

// NOT YET CALLED by any production path: it existed to tell a token apart from a path segment, and D-65's
// `/t/<token>` route prefix made that distinction structural instead. Kept as the shape's single
// definition (and as the guard any future non-prefixed token lookup should use) rather than deleted.
export function isLinkTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}
