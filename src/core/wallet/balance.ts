/**
 * Reading an SPL token balance, and deciding whether it clears a threshold.
 *
 * Read-only throughout. This never signs, never sends, never escrows and never
 * holds anything — it asks an RPC endpoint what a public address owns, at one
 * moment, and forgets.
 *
 * Fails closed everywhere. On a timeout, a malformed reply, an RPC error, a
 * mint whose decimals disagree between accounts, or anything else ambiguous,
 * the answer is "does not qualify". An access check that grants on error is
 * worse than one that is occasionally slow, because the failure is silent and
 * points the wrong way.
 */

/** Decimal amounts are compared as scaled integers; floats cannot do this. */
export interface TokenBalance {
  /** Smallest units, exactly as the chain stores them. */
  readonly raw: bigint;
  readonly decimals: number;
}

export type BalanceOutcome =
  | { readonly kind: 'read'; readonly balance: TokenBalance }
  /** Anything that is not a definite reading. Treated as not qualifying. */
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface BalanceOptions {
  readonly rpcUrl: string;
  readonly owner: string;
  readonly mint: string;
  readonly timeoutMs?: number;
  /** Injected so tests never reach the network. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Long enough for a healthy RPC under load, short enough that a member is not
 * left watching a spinner while a provider decides whether it is up.
 */
const DEFAULT_TIMEOUT_MS = 6_000;

interface ParsedTokenAccount {
  readonly amount: string;
  readonly decimals: number;
}

/** Pulls the amounts out of a getTokenAccountsByOwner reply, or gives up. */
function readAccounts(payload: unknown): readonly ParsedTokenAccount[] | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const result = (payload as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) {
    return null;
  }

  const value = (result as { value?: unknown }).value;
  if (!Array.isArray(value)) {
    return null;
  }

  const accounts: ParsedTokenAccount[] = [];
  for (const entry of value) {
    const info = (entry as { account?: { data?: { parsed?: { info?: unknown } } } })?.account?.data
      ?.parsed?.info;
    const amount = (info as { tokenAmount?: { amount?: unknown; decimals?: unknown } })
      ?.tokenAmount;

    if (typeof amount?.amount !== 'string' || typeof amount.decimals !== 'number') {
      // One unreadable account makes the total unknowable, and an
      // underreported total is a denial we cannot distinguish from a real one.
      return null;
    }
    accounts.push({ amount: amount.amount, decimals: amount.decimals });
  }

  return accounts;
}

/**
 * Total balance of one mint held by one owner.
 *
 * Summed across token accounts rather than read from one: a wallet may hold
 * several accounts for the same mint, and taking the first would understate
 * what somebody owns and deny them access they have paid for.
 */
export async function readTokenBalance(options: BalanceOptions): Promise<BalanceOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [options.owner, { mint: options.mint }, { encoding: 'jsonParsed' }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { kind: 'unavailable', reason: `rpc responded ${String(response.status)}` };
    }

    const payload: unknown = await response.json();

    // A JSON-RPC error is a successful HTTP request carrying a refusal.
    if (typeof payload === 'object' && payload !== null && 'error' in payload) {
      return { kind: 'unavailable', reason: 'rpc returned an error' };
    }

    const accounts = readAccounts(payload);
    if (accounts === null) {
      return { kind: 'unavailable', reason: 'rpc reply was not in the expected shape' };
    }

    // No token account for this mint is a definite answer, not a failure: it
    // means zero, and zero is a reading rather than an absence of one.
    if (accounts.length === 0) {
      return { kind: 'read', balance: { raw: 0n, decimals: 0 } };
    }

    const decimals = accounts[0]?.decimals ?? 0;
    let raw = 0n;

    for (const account of accounts) {
      // Every account for one mint reports that mint's decimals. Disagreement
      // means this is not the reply we think it is, and guessing which scale
      // applies would silently change what the threshold means.
      if (account.decimals !== decimals) {
        return { kind: 'unavailable', reason: 'accounts disagree about decimals' };
      }
      try {
        raw += BigInt(account.amount);
      } catch {
        return { kind: 'unavailable', reason: 'amount was not an integer' };
      }
    }

    return { kind: 'read', balance: { raw, decimals } };
  } catch (error) {
    // Includes the abort. Nothing here distinguishes "down" from "slow", and
    // neither grants access.
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'rpc timed out'
        : 'rpc could not be reached';
    return { kind: 'unavailable', reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scales a human threshold into the chain's smallest units.
 *
 * Thresholds are configured the way a project says them out loud — "1000
 * tokens" — while balances arrive as integers of the smallest unit. Converting
 * the threshold up rather than the balance down is what keeps this exact: the
 * other direction divides, and dividing loses the fraction that decides
 * somebody holding 999.999999 of a 1000 threshold.
 *
 * Parsed as a decimal string rather than through a float, because 0.1 is not
 * 0.1 in binary and a holder should never be denied by a rounding artefact.
 */
export function scaleThreshold(humanAmount: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(humanAmount.trim());
  if (match === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return null;
  }

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';

  // More precision than the mint has cannot be represented, and silently
  // truncating it would move the threshold the project configured.
  if (fraction.length > decimals) {
    return null;
  }

  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/**
 * Whether a balance clears a threshold expressed in human units.
 *
 * Every not-a-definite-yes is a no. There is no "assume they qualify while the
 * RPC recovers" path, and there must not be one.
 */
export function meetsThreshold(outcome: BalanceOutcome, humanThreshold: string): boolean {
  if (outcome.kind !== 'read') {
    return false;
  }

  const scaled = scaleThreshold(humanThreshold, outcome.balance.decimals);
  if (scaled === null) {
    return false;
  }

  return outcome.balance.raw >= scaled;
}
