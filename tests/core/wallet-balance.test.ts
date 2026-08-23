import { describe, expect, it } from 'vitest';
import { meetsThreshold, readTokenBalance, scaleThreshold } from '../../src/core/wallet/balance.js';
import type { BalanceOutcome } from '../../src/core/wallet/balance.js';

/**
 * Token gating, where the two ways to be wrong are not symmetric.
 *
 * Denying a real holder is a support message. Granting a non-holder is the gate
 * not existing. So every ambiguous path here has to resolve to "no", and the
 * arithmetic has to be exact — a holder must never be refused because 0.1 is
 * not 0.1 in binary.
 */

const OWNER = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC = 'https://rpc.example.invalid/?api-key=not-a-real-key';

/** A getTokenAccountsByOwner reply carrying the given accounts. */
function reply(accounts: readonly { amount: string; decimals: number }[]): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        value: accounts.map((account) => ({
          account: {
            data: {
              parsed: {
                info: {
                  tokenAmount: {
                    amount: account.amount,
                    decimals: account.decimals,
                    uiAmountString: 'ignored',
                  },
                },
              },
            },
          },
        })),
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function withReply(response: Response | (() => Promise<Response>)): typeof fetch {
  return async () => (typeof response === 'function' ? response() : response);
}

async function read(fetchImpl: typeof fetch): Promise<BalanceOutcome> {
  return readTokenBalance({ rpcUrl: RPC, owner: OWNER, mint: MINT, fetchImpl });
}

describe('scaleThreshold', () => {
  it('scales a six-decimal threshold exactly', () => {
    // USDC. "1000" tokens is a thousand million smallest units.
    expect(scaleThreshold('1000', 6)).toBe(1_000_000_000n);
    expect(scaleThreshold('0.000001', 6)).toBe(1n);
    expect(scaleThreshold('1.5', 6)).toBe(1_500_000n);
  });

  it('scales a nine-decimal threshold exactly', () => {
    // Wrapped SOL and most SPL launches.
    expect(scaleThreshold('1000', 9)).toBe(1_000_000_000_000n);
    expect(scaleThreshold('0.000000001', 9)).toBe(1n);
    expect(scaleThreshold('1.5', 9)).toBe(1_500_000_000n);
  });

  it('does not lose a fraction a float would', () => {
    // 0.1 + 0.2 !== 0.3 in binary. Parsed as a decimal string, it is exact,
    // and a holder sitting on the threshold is not refused by an artefact.
    expect(scaleThreshold('0.3', 9)).toBe(300_000_000n);
    expect(scaleThreshold('0.1', 6)).toBe(100_000n);
    expect(scaleThreshold('123456789.123456789', 9)).toBe(123_456_789_123_456_789n);
  });

  it('survives amounts past what a double can represent', () => {
    // Beyond Number.MAX_SAFE_INTEGER, where a float silently rounds.
    expect(scaleThreshold('9007199254740993', 9)).toBe(9_007_199_254_740_993_000_000_000n);
  });

  it('refuses more precision than the mint has, rather than truncating', () => {
    // Truncating would quietly move the threshold the project configured.
    expect(scaleThreshold('0.0000001', 6)).toBeNull();
    expect(scaleThreshold('1.9999999999', 9)).toBeNull();
  });

  it('refuses anything that is not a plain decimal number', () => {
    for (const bad of ['', 'abc', '-1', '1e6', '1,000', '0x10', ' ', '1.2.3', 'Infinity']) {
      expect(scaleThreshold(bad, 6)).toBeNull();
    }
  });
});

describe('readTokenBalance', () => {
  it('reads a six-decimal balance', async () => {
    const outcome = await read(withReply(reply([{ amount: '1500000', decimals: 6 }])));
    expect(outcome).toEqual({ kind: 'read', balance: { raw: 1_500_000n, decimals: 6 } });
    expect(meetsThreshold(outcome, '1.5')).toBe(true);
    expect(meetsThreshold(outcome, '1.500001')).toBe(false);
  });

  it('reads a nine-decimal balance', async () => {
    const outcome = await read(withReply(reply([{ amount: '1500000000', decimals: 9 }])));
    expect(outcome).toEqual({ kind: 'read', balance: { raw: 1_500_000_000n, decimals: 9 } });
    expect(meetsThreshold(outcome, '1.5')).toBe(true);
    expect(meetsThreshold(outcome, '2')).toBe(false);
  });

  it('does not confuse the two scales', async () => {
    // The same integer means a thousand times more at six decimals than at
    // nine. Reading the decimals off the wrong mint is how a gate lets in
    // somebody holding a thousandth of what it asks for.
    const sixDecimals = await read(withReply(reply([{ amount: '1000000000', decimals: 6 }])));
    const nineDecimals = await read(withReply(reply([{ amount: '1000000000', decimals: 9 }])));

    expect(meetsThreshold(sixDecimals, '1000')).toBe(true);
    expect(meetsThreshold(nineDecimals, '1000')).toBe(false);
    expect(meetsThreshold(nineDecimals, '1')).toBe(true);
  });

  it('sums every token account for the mint', async () => {
    // A wallet may hold several accounts for one mint. Taking the first would
    // understate what somebody owns and deny access they have paid for.
    const outcome = await read(
      withReply(
        reply([
          { amount: '400000', decimals: 6 },
          { amount: '600000', decimals: 6 },
          { amount: '1', decimals: 6 },
        ]),
      ),
    );

    expect(outcome).toEqual({ kind: 'read', balance: { raw: 1_000_001n, decimals: 6 } });
    expect(meetsThreshold(outcome, '1')).toBe(true);
  });

  it('treats no token account as a balance of zero, not as a failure', async () => {
    const outcome = await read(withReply(reply([])));

    // Definite, and it is a reading rather than the absence of one.
    expect(outcome.kind).toBe('read');
    expect(meetsThreshold(outcome, '0.000001')).toBe(false);
  });

  it('handles balances far beyond a double without rounding', async () => {
    const huge = '340282366920938463463374607431768211455';
    const outcome = await read(withReply(reply([{ amount: huge, decimals: 9 }])));

    expect(outcome).toEqual({ kind: 'read', balance: { raw: BigInt(huge), decimals: 9 } });
  });
});

describe('failing closed', () => {
  const cases: readonly { readonly name: string; readonly fetchImpl: typeof fetch }[] = [
    {
      name: 'an HTTP error',
      fetchImpl: withReply(new Response('nope', { status: 500 })),
    },
    {
      name: 'a rate limit',
      fetchImpl: withReply(new Response('slow down', { status: 429 })),
    },
    {
      name: 'a JSON-RPC error inside a 200',
      fetchImpl: withReply(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000 } }), {
          status: 200,
        }),
      ),
    },
    {
      name: 'a reply that is not JSON',
      fetchImpl: withReply(new Response('<html>gateway</html>', { status: 200 })),
    },
    {
      name: 'a reply missing the shape entirely',
      fetchImpl: withReply(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), { status: 200 }),
      ),
    },
    {
      name: 'an account with no readable amount',
      fetchImpl: withReply(
        new Response(
          JSON.stringify({ result: { value: [{ account: { data: { parsed: { info: {} } } } }] } }),
          { status: 200 },
        ),
      ),
    },
    {
      name: 'accounts that disagree about decimals',
      fetchImpl: withReply(
        reply([
          { amount: '1', decimals: 6 },
          { amount: '1', decimals: 9 },
        ]),
      ),
    },
    {
      name: 'an amount that is not an integer',
      fetchImpl: withReply(reply([{ amount: '1.5', decimals: 6 }])),
    },
    {
      name: 'the network being unreachable',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    },
  ];

  for (const { name, fetchImpl } of cases) {
    it(`denies on ${name}`, async () => {
      const outcome = await read(fetchImpl);

      expect(outcome.kind).toBe('unavailable');
      // The threshold is irrelevant. Nothing that is not a definite reading
      // grants access, however generous the threshold happens to be.
      expect(meetsThreshold(outcome, '0')).toBe(false);
      expect(meetsThreshold(outcome, '1000')).toBe(false);
    });
  }

  it('denies on a timeout rather than waiting for a provider to decide', async () => {
    const never: typeof fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;

    const outcome = await readTokenBalance({
      rpcUrl: RPC,
      owner: OWNER,
      mint: MINT,
      timeoutMs: 20,
      fetchImpl: never,
    });

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'rpc timed out' });
    expect(meetsThreshold(outcome, '1')).toBe(false);
  });

  it('denies when the threshold itself is unusable', async () => {
    const outcome = await read(withReply(reply([{ amount: '999999999', decimals: 6 }])));

    // A misconfigured threshold must not open the gate. Refusing is the only
    // reading of "this project's rule cannot be evaluated" that is safe.
    expect(meetsThreshold(outcome, 'lots')).toBe(false);
    expect(meetsThreshold(outcome, '')).toBe(false);
    expect(meetsThreshold(outcome, '0.0000001')).toBe(false);
  });
});
