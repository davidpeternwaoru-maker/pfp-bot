import { createPublicKey, verify } from 'node:crypto';
import { Base58Error, base58Decode } from './base58.js';
import { ADDRESS_BYTES } from './address.js';

/**
 * Ed25519 signature verification. Server-side, and there is no other side.
 *
 * A wallet adapter in a browser will happily report that a signature checked
 * out. That report is a value sent by a page an attacker can rewrite, so it is
 * worth exactly nothing — the only thing that establishes control of an address
 * is this process verifying the bytes itself.
 *
 * Uses Node's own Ed25519 rather than a library. The platform's implementation
 * is the audited one, and the only thing standing between a raw 32-byte Solana
 * key and `crypto.verify` is a fixed twelve-byte SPKI header.
 */

/**
 * DER prefix for an Ed25519 SubjectPublicKeyInfo. Fixed by RFC 8410: the
 * algorithm identifier is constant, so the whole header is constant and the
 * key is simply appended.
 */
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** An Ed25519 signature is exactly this many bytes. */
const SIGNATURE_BYTES = 64;

/**
 * Wraps a raw 32-byte public key so Node will accept it.
 * Throws if the bytes are not a valid curve point, which is what
 * parseSolanaAddress uses to tell an addressable key from a derived address.
 */
export function ed25519PublicKey(raw: Uint8Array): ReturnType<typeof createPublicKey> {
  if (raw.length !== ADDRESS_BYTES) {
    throw new TypeError(`ed25519 public key must be ${String(ADDRESS_BYTES)} bytes`);
  }

  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + raw.length);
  der.set(ED25519_SPKI_PREFIX, 0);
  der.set(raw, ED25519_SPKI_PREFIX.length);

  return createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
}

export type SignatureRejection =
  'signature-not-base58' | 'signature-wrong-length' | 'key-unusable' | 'does-not-verify';

export type SignatureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureRejection };

/**
 * Whether `signature` is this key's signature over exactly `message`.
 *
 * Fails closed on every path. Anything that is not a definite yes — malformed
 * signature, unusable key, a throw from the platform — is a no, because the
 * only safe reading of "I could not tell" is that ownership was not proved.
 */
export function verifySignature(
  message: string,
  signatureBase58: string,
  publicKeyBytes: Uint8Array,
): SignatureResult {
  let signature: Uint8Array;
  try {
    signature = base58Decode(signatureBase58);
  } catch (error) {
    if (error instanceof Base58Error) {
      return { ok: false, reason: 'signature-not-base58' };
    }
    throw error;
  }

  if (signature.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: 'signature-wrong-length' };
  }

  let key: ReturnType<typeof createPublicKey>;
  try {
    key = ed25519PublicKey(publicKeyBytes);
  } catch {
    return { ok: false, reason: 'key-unusable' };
  }

  // The message is compared as the exact UTF-8 bytes the wallet was asked to
  // sign. No trimming, no normalising: a signature over "nearly" the message is
  // a signature over a different message.
  const verified = verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature));

  return verified ? { ok: true } : { ok: false, reason: 'does-not-verify' };
}
