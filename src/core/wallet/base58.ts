/**
 * Base58, the encoding Solana addresses and signatures arrive in.
 *
 * Written here rather than taken as a dependency because Node has no base58
 * codec at all and this one is forty lines with unambiguous published test
 * vectors. That is the whole justification — it is an encoding, not a cipher,
 * and rolling one's own encoding with known-answer tests is a different
 * proposition from rolling one's own crypto.
 *
 * What it does not do is as important as what it does. It never skips a
 * character it does not recognise, never trims whitespace, and never guesses a
 * length. An address that decodes "nearly" is an address belonging to somebody
 * else, and every one of those leniencies is a way to arrive at one.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Reverse lookup, built once. -1 marks a character outside the alphabet. */
const VALUES: readonly number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export class Base58Error extends Error {
  constructor(reason: string) {
    super(`not valid base58: ${reason}`);
    this.name = 'Base58Error';
  }
}

/**
 * Decodes base58 into bytes, or throws.
 *
 * Leading '1' characters are leading zero bytes, which is why they are counted
 * separately rather than falling out of the arithmetic: 32 zero bytes is a real
 * Solana address (the system program) and it is all ones.
 */
export function base58Decode(value: string): Uint8Array {
  if (value.length === 0) {
    throw new Base58Error('empty string');
  }

  const bytes: number[] = [];

  for (const character of value) {
    const code = character.codePointAt(0) ?? -1;
    const digit = code < 128 ? (VALUES[code] ?? -1) : -1;
    if (digit === -1) {
      // Named without echoing the whole input: this value may be attacker
      // supplied and ends up in logs.
      throw new Base58Error(`character ${JSON.stringify(character)} is not in the alphabet`);
    }

    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === '1') {
    leadingZeros += 1;
  }

  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[leadingZeros + i] = bytes[bytes.length - 1 - i] ?? 0;
  }
  return out;
}

/** Encodes bytes as base58. Present so decoding can be round-trip tested. */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] ?? 0) << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }

  let out = '1'.repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += ALPHABET[digits[i] ?? 0];
  }
  return out;
}
