import { Base58Error, base58Decode } from './base58.js';

/**
 * A Solana address, validated.
 *
 * The type exists so nothing downstream has to wonder whether the string it
 * holds has been checked. A raw string reaching a database write or an RPC call
 * is a string somebody typed, and a typed address proves nothing about who
 * controls it.
 *
 * What this deliberately does NOT check is whether the bytes are a point on the
 * ed25519 curve. Off-curve 32-byte values are legal addresses — every program
 * derived address is one — and no private key exists for them, so they can
 * never be signed for. That makes them unlinkable already: verifySignature
 * refuses them, because no valid signature over them exists to be produced.
 * An earlier version tried to reject them here by asking Node to build a key
 * from the bytes, which was worthless — Node accepts thirty-two zero bytes as
 * an Ed25519 key quite happily and only fails at verification. A check that
 * looks like a gate and passes everything is worse than no check, so it is
 * gone, and the guarantee is stated where it is actually enforced.
 */

/** An Ed25519 public key is exactly this many bytes. */
export const ADDRESS_BYTES = 32;

/**
 * Base58 of 32 bytes lands here. Bounded before decoding so a megabyte of '1's
 * cannot be handed to the decoder's quadratic inner loop.
 */
const MIN_ADDRESS_LENGTH = 32;
const MAX_ADDRESS_LENGTH = 44;

export interface SolanaAddress {
  /** Canonical base58, exactly as it must be stored and compared. */
  readonly base58: string;
  readonly bytes: Uint8Array;
}

export type AddressRejection = 'wrong-length' | 'not-base58' | 'wrong-byte-length';

export type AddressResult =
  | { readonly ok: true; readonly address: SolanaAddress }
  | { readonly ok: false; readonly reason: AddressRejection };

export function parseSolanaAddress(value: string): AddressResult {
  if (value.length < MIN_ADDRESS_LENGTH || value.length > MAX_ADDRESS_LENGTH) {
    return { ok: false, reason: 'wrong-length' };
  }

  let bytes: Uint8Array;
  try {
    bytes = base58Decode(value);
  } catch (error) {
    if (error instanceof Base58Error) {
      return { ok: false, reason: 'not-base58' };
    }
    throw error;
  }

  if (bytes.length !== ADDRESS_BYTES) {
    return { ok: false, reason: 'wrong-byte-length' };
  }

  return { ok: true, address: { base58: value, bytes } };
}
