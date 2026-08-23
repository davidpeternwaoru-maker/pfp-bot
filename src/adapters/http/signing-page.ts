/**
 * The page a member signs on.
 *
 * Self-contained by necessity as well as by choice: the response carries a
 * content security policy that permits no external script, style or connection,
 * so there is nothing here to load from anywhere. A signing page that pulls
 * code from a CDN is a signing page whose behaviour is decided by whoever
 * controls that CDN.
 *
 * It never asks for, hints at, or contains any field capable of receiving a
 * private key or seed phrase. The only thing it collects is a signature,
 * produced inside the member's own wallet, over a message this server wrote.
 */

/** Safe to embed in a script tag: closes no tag and starts no comment. */
function embed(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

/** Escapes text destined for HTML rather than for a script. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2rem 1.25rem; display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 32rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; }
  pre {
    white-space: pre-wrap; word-break: break-word; padding: .9rem 1rem;
    border: 1px solid currentColor; border-radius: .5rem; font-size: .82rem;
    opacity: .85; margin: 0 0 1.25rem;
  }
  button {
    font: inherit; font-weight: 600; padding: .8rem 1.2rem; width: 100%;
    border-radius: .5rem; border: 1px solid currentColor; cursor: pointer;
    background: transparent; color: inherit;
  }
  button[disabled] { opacity: .5; cursor: default; }
  #status { margin-top: 1rem; min-height: 1.5rem; }
  .warn { font-weight: 600; }
`;

/**
 * Base58 in the browser, so the wallet's raw signature bytes reach the server
 * in the encoding it verifies. Deliberately the only piece of logic on this
 * page that is not a call into the wallet or a call to the server.
 */
const BROWSER_BASE58 = String.raw`
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58(bytes) {
    const input = Array.from(bytes);
    const digits = [0];
    for (const byte of input) {
      let carry = byte;
      for (let i = 0; i < digits.length; i += 1) {
        carry += digits[i] << 8;
        digits[i] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = '';
    for (const byte of input) { if (byte === 0) { out += '1'; } else { break; } }
    for (let i = digits.length - 1; i >= 0; i -= 1) { out += ALPHABET[digits[i]]; }
    return out;
  }
`;

export interface SigningPageInput {
  /** The exact text the wallet will be asked to sign. */
  readonly message: string;
  /** Where the signature is posted back. Path only, same origin. */
  readonly verifyPath: string;
  readonly expiresAt: Date;
}

export function signingPage(input: SigningPageInput): string {
  const script =
    String.raw`
(() => {
  'use strict';
  const MESSAGE = __MESSAGE__;
  const VERIFY = __VERIFY__;
  const EXPIRES = __EXPIRES__;

  const button = document.getElementById('go');
  const status = document.getElementById('status');
  const say = (text) => { status.textContent = text; };

  if (Date.now() >= Date.parse(EXPIRES)) {
    button.disabled = true;
    say('This link has expired. Ask the bot for a new one.');
    return;
  }

  // The injected provider, which Phantom, Solflare and Backpack all supply.
  // No wallet library is loaded: bundling one would mean shipping a large
  // dependency whose behaviour this page could not state in full, and the
  // policy on this response would refuse to fetch it anyway.
  const provider = () => window.phantom?.solana ?? window.solana ?? null;

  button.addEventListener('click', async () => {
    const wallet = provider();
    if (!wallet) {
      say('No Solana wallet found in this browser. Install one, or open this link inside your wallet app.');
      return;
    }

    button.disabled = true;
    say('Waiting for your wallet...');

    try {
      const connection = await wallet.connect();
      const address = (connection?.publicKey ?? wallet.publicKey).toString();

      const encoded = new TextEncoder().encode(MESSAGE);
      const signed = await wallet.signMessage(encoded, 'utf8');
      const signature = base58(signed?.signature ?? signed);

      say('Checking your signature...');

      const response = await fetch(VERIFY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, signature }),
      });
      const body = await response.json().catch(() => ({}));

      // The server's answer is the only one that counts. This page never
      // decides that a signature was valid; it reports what it was told.
      if (response.ok && body.linked === true) {
        button.remove();
        say('Wallet linked. You can close this page and go back to the bot.');
        return;
      }

      button.disabled = false;
      say(typeof body.message === 'string' ? body.message : 'That did not work. Ask the bot for a new link.');
    } catch (error) {
      button.disabled = false;
      const text = String(error?.message ?? '');
      const rejected = error?.code === 4001 || /reject|denied|cancel/i.test(text);
      say(rejected
        ? 'You cancelled the signature. Nothing was linked.'
        : 'Your wallet could not complete that. Ask the bot for a new link.');
    }
  });
` +
    BROWSER_BASE58 +
    `})();`;

  const filled = script
    .replace('__MESSAGE__', embed(input.message))
    .replace('__VERIFY__', embed(input.verifyPath))
    .replace('__EXPIRES__', embed(input.expiresAt.toISOString()));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Link your wallet</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>Link your wallet</h1>
  <p>This proves you control the wallet. It is <strong>not</strong> a transaction:
     it moves no funds, approves no spending, and gives no access to your wallet.</p>
  <p class="warn">This page will never ask for your seed phrase or private key.
     Nothing here ever will. If any page claiming to be us asks for one, close it.</p>
  <p>You will be asked to sign exactly this:</p>
  <pre id="message">${escapeHtml(input.message)}</pre>
  <button id="go" type="button">Connect wallet and sign</button>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script>${filled}</script>
</body>
</html>`;
}

/** Shown for an unknown, expired or already-used token. Says one thing. */
export function expiredPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Link expired</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>This link is no longer usable</h1>
  <p>Wallet links last five minutes and work once. This one has expired, or it
     has already been used.</p>
  <p>Go back to the bot and ask to link a wallet again. Nothing was lost.</p>
</main>
</body>
</html>`;
}
