import { randomBase62 } from "./ids.ts";

// Short, human-friendly share tokens (preliminary-review P5). Deliberately base62, NOT numeric: a literal
// 5-digit numeric token is only 100 000 values - brute-forceable in minutes - and it is what guards
// `secret`/`unlisted` files, so numeric would make those levels meaningless. 5 base62 characters is ~916M
// (~30 bits) for the same "short and copyable" feel with far less brute-force surface. Anything genuinely
// sensitive must lean on `private` + auth, never on token secrecy. Length and alphabet are the one place
// to change - if you bump LINK_TOKEN_LENGTH, widen the link_token column in the migrations to match.
export const LINK_TOKEN_LENGTH = 5;
const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9]{${LINK_TOKEN_LENGTH}}$`);

export function generateLinkToken(): string {
  return randomBase62(LINK_TOKEN_LENGTH);
}

// D-98: collections and files now share one token namespace, but each lives in its own table with its
// own independent unique index - so minting a token for EITHER one must check both before it can be
// trusted unique. This stays I/O-free (technical-baseline.md §2): the existence check is injected, and
// the storage layer supplies one that actually queries both tables.
export async function mintUniqueToken(exists: (token: string) => Promise<boolean>): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const token = generateLinkToken();
    if (!(await exists(token))) return token;
  }
  throw new Error("lib/tokens: could not mint a unique token after 10 attempts");
}

// NOT YET CALLED by any production path: it existed to tell a token apart from a path segment, and D-65's
// `/t/<token>` route prefix made that distinction structural instead. Kept as the shape's single
// definition (and as the guard any future non-prefixed token lookup should use) rather than deleted.
export function isLinkTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}
