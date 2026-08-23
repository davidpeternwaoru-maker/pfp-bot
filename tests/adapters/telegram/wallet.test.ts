import { describe, expect, it } from 'vitest';
import { createHarness, project } from './harness.js';
import type { FakeDatabase } from './harness.js';

/**
 * The /wallet command.
 *
 * Two properties matter more than the mechanics. Linking must stay optional —
 * a bot with no wallet configuration at all has to answer the command rather
 * than look broken — and the one-time link must never leave the chat by any
 * route the member did not take deliberately.
 */

const DB: FakeDatabase = {
  projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
  claimsByProjectAndMember: new Map(),
};

const BASE_URL = 'https://pfp.example.com';

function harness(overrides: Partial<Parameters<typeof createHarness>[0]> = {}) {
  return createHarness({ db: DB, publicBaseUrl: BASE_URL, ...overrides });
}

describe('/wallet when linking is switched off', () => {
  it('answers plainly instead of looking broken', async () => {
    // No PUBLIC_BASE_URL: the ordinary state for a project that has no token.
    const h = createHarness({ db: DB });
    await h.send('/wallet link');

    const reply = h.sent.join('\n');
    expect(reply).toContain('not switched on');
    // And it says the thing a member actually needs to know.
    expect(reply).toContain('claiming works without a wallet');
  });

  it('still reports that nothing is linked', async () => {
    const h = createHarness({ db: DB });
    await h.send('/wallet');

    expect(h.sent.join('\n')).toContain('No wallet linked');
  });
});

describe('/wallet link', () => {
  it('sends a one-time link and disables the preview that would spend it', async () => {
    const h = harness();
    await h.send('/wallet link');

    const call = h.calls.find((entry) => entry.method === 'sendMessage');
    expect(call?.text).toContain(`${BASE_URL}/link/`);

    // Telegram fetches a URL to build a preview. On a single-use link that
    // fetch spends it before the member has opened anything.
    const raw = h.rawCalls.find((entry) => entry.method === 'sendMessage');
    expect(raw?.payload).toMatchObject({ link_preview_options: { is_disabled: true } });
  });

  it('puts an opaque token in the URL and nothing that names the member', async () => {
    const h = harness();
    await h.send('/wallet link', 555);

    const text = h.sent.join('\n');
    const url = /https:\/\/pfp\.example\.com\/link\/([A-Za-z0-9_-]+)/.exec(text);

    expect(url).not.toBeNull();
    // 32 random bytes as base64url. Long enough not to be worth guessing.
    expect(url?.[1]).toHaveLength(43);
    // A member id in a URL identifies a person to anyone who sees the link.
    expect(url?.[1]).not.toContain('555');
    expect(text).not.toMatch(/\b555\b/);
  });

  it('warns about seed phrases in the message itself, not only on the page', async () => {
    const h = harness();
    await h.send('/wallet link');

    const text = h.sent.join('\n');
    // A member who reads this here is inoculated before they ever reach a
    // page — including a convincing fake of ours that they reach later.
    expect(text).toContain('never ask for your seed phrase');
    expect(text).toContain('not a transaction');
  });

  it('says how long the link lasts and that it works once', async () => {
    const h = harness();
    await h.send('/wallet link');

    const text = h.sent.join('\n');
    expect(text).toContain('works once');
    expect(text).toContain('5 minutes');
  });

  it('rate limits repeated attempts and names when to retry', async () => {
    const h = harness();

    for (let i = 0; i < 5; i += 1) {
      await h.send('/wallet link');
    }
    const before = h.sent.length;
    await h.send('/wallet link');

    expect(h.sent.slice(before).join('\n')).toMatch(/Try again in \d+ minute/);
  });
});

describe('/wallet status and unlink', () => {
  it('shows a linked wallet and how to remove it', async () => {
    const linkedAt = new Date('2026-08-23T12:00:00.000Z');
    const h = harness({
      db: {
        ...DB,
        wallets: new Map([[555, { walletAddress: 'SoLaNaAddr111', walletLinkedAt: linkedAt }]]),
      },
    });

    await h.send('/wallet', 555);

    const text = h.sent.join('\n');
    expect(text).toContain('SoLaNaAddr111');
    expect(text).toContain('/wallet unlink');
  });

  it('unlinks, and says a fresh signature is needed to link again', async () => {
    const h = harness({
      db: {
        ...DB,
        wallets: new Map([[555, { walletAddress: 'SoLaNaAddr111', walletLinkedAt: new Date() }]]),
      },
    });

    await h.send('/wallet unlink', 555);
    expect(h.sent.join('\n')).toContain('fresh signature');

    // And it is genuinely gone, rather than remembered as a shortcut back.
    await h.send('/wallet', 555);
    expect(h.sent.join('\n')).toContain('No wallet linked');
  });

  it('does not pretend to remove a wallet that was never there', async () => {
    const h = harness();
    await h.send('/wallet unlink', 555);

    expect(h.sent.join('\n')).toContain('nothing to remove');
  });
});
