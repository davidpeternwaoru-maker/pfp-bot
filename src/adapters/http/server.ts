import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { challengeMessage, completeLink, findPendingChallenge } from '../../core/ports.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Logger } from '../../logging/logger.js';
import { expiredPage, signingPage } from './signing-page.js';

/**
 * The signing page, served from this process.
 *
 * A second front end, and it obeys the same boundary the Telegram adapter
 * does: it translates HTTP into plain arguments and calls core, and core never
 * learns that a request, a header or a status code exists.
 *
 * Every response is deliberately unhelpful about what exists. An unknown
 * token, a spent one and an expired one produce the same page and the same
 * status, because distinguishing them tells whoever guessed a token that they
 * guessed one.
 */

/** base64url of 32 bytes. Checked before the value reaches a query. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LINK_PATH = /^\/link\/([A-Za-z0-9_-]{1,64})$/;
const VERIFY_PATH = /^\/link\/([A-Za-z0-9_-]{1,64})\/verify$/;

/** A signature and an address; nothing else is read from the body. */
const MAX_BODY_BYTES = 4 * 1024;

export interface HttpDependencies {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  /** Host as members see it, used to build and verify the signed message. */
  readonly publicBaseUrl: string;
}

/**
 * Refuses every external origin for script, style, connection and frame.
 *
 * The page is entirely self-contained, so this costs nothing and removes the
 * whole class of attack where injected markup reaches out to somewhere else.
 * `connect-src 'self'` is what stops a compromised page posting a captured
 * signature anywhere but back here.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // The URL carries a one-time token, so it must not be kept anywhere.
  'cache-control': 'no-store, no-cache, must-revalidate, private',
};

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  send(response, status, 'text/html; charset=utf-8', body);
}

/** Reads a bounded JSON body, or gives up. Never buffers without a limit. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('body too large');
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** A string field of sane length, or null. Nothing here is trusted. */
function readField(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/** Tight: a probe is answered on every deploy and every few seconds after. */
const READINESS_TIMEOUT_MS = 3_000;

export function createHttpServer(deps: HttpDependencies): Server {
  const domain = new URL(deps.publicBaseUrl).host;

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      // Never leaks a stack, a path or an internal id to the browser.
      deps.logger.error('http.unhandled', {
        reason: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { linked: false, message: 'Something went wrong. Try again.' });
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', deps.publicBaseUrl).pathname;

    // Liveness, not readiness, and deliberately not a database check.
    //
    // The question a platform asks here is "should I restart this process",
    // and a sleeping or throttled database is not something restarting fixes —
    // it would turn a slow database into a restart loop that also takes the
    // bot down. What this asserts is narrow and true: the process is up and
    // its event loop is turning.
    if (path === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { ok: false });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    // Readiness, which is a different question from liveness.
    //
    // "Should traffic come here" rather than "should this be restarted". A
    // process whose database is unreachable is up but cannot serve, so this
    // fails while /health passes — and that difference is the whole point of
    // having both. Restarting would not reach a sleeping database; routing
    // around this instance until it recovers would.
    if (path === '/ready') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { ready: false });
        return;
      }
      const ready = await databaseReachable();
      // 503 rather than 200-with-a-flag: a load balancer reads the status
      // code, and a body nobody parses is a check nobody performs.
      sendJson(response, ready ? 200 : 503, { ready });
      return;
    }

    const verify = VERIFY_PATH.exec(path);
    if (verify !== null) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { linked: false, message: 'Use POST.' });
        return;
      }
      await handleVerify(request, response, verify[1] ?? '');
      return;
    }

    const link = LINK_PATH.exec(path);
    if (link !== null) {
      if (request.method !== 'GET') {
        sendHtml(response, 405, expiredPage());
        return;
      }
      await handleLinkPage(response, link[1] ?? '');
      return;
    }

    // No directory listing, no hints, no 404 body worth reading.
    sendHtml(response, 404, expiredPage());
  }

  /**
   * One cheap query, with a deadline.
   *
   * Bounded because an unbounded readiness check on a hung database is a
   * readiness check that hangs — and a probe that never answers is worse than
   * one that answers no, since a platform reads the silence as neither.
   */
  async function databaseReachable(): Promise<boolean> {
    const deadline = new Promise<false>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, READINESS_TIMEOUT_MS).unref();
    });

    try {
      return await Promise.race([deps.prisma.$queryRaw`SELECT 1`.then(() => true), deadline]);
    } catch (error) {
      deps.logger.warn('http.not_ready', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function handleLinkPage(response: ServerResponse, token: string): Promise<void> {
    if (!TOKEN_PATTERN.test(token)) {
      sendHtml(response, 404, expiredPage());
      return;
    }

    const pending = await findPendingChallenge(deps.prisma, token);
    if (pending === null) {
      // Unknown, spent, expired: one answer, so a guessed token learns nothing.
      sendHtml(response, 404, expiredPage());
      return;
    }

    // The member id is not in the URL and is not in the page. The browser is
    // told the nonce and nothing that identifies whose nonce it is.
    sendHtml(
      response,
      200,
      signingPage({
        message: challengeMessage({ domain, nonce: pending.nonce, expiresAt: pending.expiresAt }),
        verifyPath: `/link/${token}/verify`,
        expiresAt: pending.expiresAt,
      }),
    );
  }

  async function handleVerify(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    if (!TOKEN_PATTERN.test(token)) {
      sendJson(response, 400, { linked: false, message: 'That link is no longer usable.' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { linked: false, message: 'That request could not be read.' });
      return;
    }

    const address = readField(body, 'address');
    const signature = readField(body, 'signature');

    if (address === null || signature === null) {
      sendJson(response, 400, { linked: false, message: 'That request was incomplete.' });
      return;
    }

    const outcome = await completeLink({
      prisma: deps.prisma,
      logger: deps.logger,
      domain,
      token,
      claimedAddress: address,
      signature,
    });

    if (outcome.kind === 'linked') {
      sendJson(response, 200, { linked: true });
      return;
    }

    // Each reason names what the member can do next. None of them says
    // anything about who else might hold an address.
    const message =
      outcome.reason === 'address-taken'
        ? 'That wallet is already linked to another account. Use a different wallet.'
        : outcome.reason === 'challenge-unusable'
          ? 'This link has expired or was already used. Ask the bot for a new one.'
          : 'That signature did not check out. Ask the bot for a new link and try again.';

    sendJson(response, 400, { linked: false, message });
  }
}
