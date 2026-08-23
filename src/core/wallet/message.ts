/**
 * The exact text a member is asked to sign.
 *
 * Three jobs, and all three are security rather than presentation.
 *
 * It says in plain words what signing does and does not do, because a member
 * approving an opaque blob in a wallet popup has been trained to approve
 * anything. It carries the domain, so a signature collected by one site cannot
 * be replayed at another. And it carries a nonce bound to one member with a
 * short life, so a signature captured once cannot be used twice.
 *
 * It is deliberately not, and must never become, anything a wallet could
 * interpret as a transaction. This is text; signing it moves nothing.
 */

export interface ChallengeMessageInput {
  /** Host members see in the address bar, e.g. "pfp.example.com". */
  readonly domain: string;
  readonly nonce: string;
  readonly expiresAt: Date;
}

/**
 * Built from the stored challenge on both sides — shown to the member, then
 * rebuilt server-side to verify against. Neither side sends the other the
 * message text, so there is nothing to substitute: a signature only checks out
 * against the exact string this function produces for that stored nonce.
 */
export function challengeMessage(input: ChallengeMessageInput): string {
  return [
    `${input.domain} wants you to prove you control this wallet.`,
    '',
    'This signature proves ownership only. It is not a transaction:',
    'it authorises nothing, moves no funds, and grants no spending approval.',
    '',
    `Nonce: ${input.nonce}`,
    `Expires: ${input.expiresAt.toISOString()}`,
  ].join('\n');
}
