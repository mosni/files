import { randomInt } from "node:crypto";

// The shared base62 CSPRNG generator - lib/tokens.ts's short link tokens use the same alphabet and the
// same uniform-without-bias approach (crypto.randomInt, not `randomBytes() % 62`, which would bias toward
// the low end of the alphabet).
const BASE62_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomBase62(length: number): string {
  let value = "";
  for (let i = 0; i < length; i++) {
    value += BASE62_ALPHABET[randomInt(BASE62_ALPHABET.length)];
  }
  return value;
}

// D-81: a file's (and a collection's) identity is a surrogate id, not its path. Base62, 16 chars
// (~95 bits) - opaque and non-enumerable, but NOT itself a security boundary (link_token still guards
// `secret`, D-67); it only needs to be unguessable enough that ids can't be enumerated in sequence.
export const ID_LENGTH = 16;

export function generateId(): string {
  return randomBase62(ID_LENGTH);
}
