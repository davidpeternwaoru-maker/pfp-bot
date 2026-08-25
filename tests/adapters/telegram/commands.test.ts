import { describe, expect, it } from 'vitest';
import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';
import {
  assertEveryCommandHandled,
  COMMANDS,
  syncCommandMenu,
} from '../../../src/adapters/telegram/commands.js';
import { createLogger } from '../../../src/logging/logger.js';
import { createHarness, project } from './harness.js';

/**
 * The command menu.
 *
 * One property carries this: an admin command must never appear in an ordinary
 * member's client. That is not achieved by hiding it — it is achieved by never
 * sending it to them, which is a different and stronger thing, and the test
 * checks the payload rather than the appearance.
 */

const logger = createLogger({ level: 'error', write: () => undefined });

interface Published {
  readonly commands: readonly BotCommand[];
  readonly scope: { readonly type: string; readonly chat_id?: number };
}

/** Captures what would be sent to Telegram, without a network. */
function recordingApi(failOn?: (scopeType: string) => boolean): {
  api: Api;
  published: Published[];
} {
  const published: Published[] = [];
  const api = {
    setMyCommands: (commands: readonly BotCommand[], options: { scope: Published['scope'] }) => {
      if (failOn?.(options.scope.type) === true) {
        return Promise.reject(new Error('Bad Request: chat not found'));
      }
      published.push({ commands, scope: options.scope });
      return Promise.resolve(true);
    },
  } as unknown as Api;

  return { api, published };
}

const ADMINS = [{ platform: 'telegram', externalId: '999' }] as const;

describe('what each audience is sent', () => {
  it('never sends an admin command to the default scope', async () => {
    const { api, published } = recordingApi();
    await syncCommandMenu(api, ADMINS, logger);

    const fallback = published.find((entry) => entry.scope.type === 'default');
    expect(fallback).toBeDefined();

    const names = (fallback?.commands ?? []).map((command) => command.command);
    const adminNames = COMMANDS.filter((spec) => spec.audience === 'admin').map(
      (spec) => spec.name,
    );

    // Not hidden — never sent. An ordinary client has no way to list what it
    // was never given.
    expect(adminNames.length).toBeGreaterThan(0);
    for (const admin of adminNames) {
      expect(names).not.toContain(admin);
    }
  });

  it('sends every member command to the default scope', async () => {
    const { api, published } = recordingApi();
    await syncCommandMenu(api, ADMINS, logger);

    const names = (published.find((entry) => entry.scope.type === 'default')?.commands ?? []).map(
      (command) => command.command,
    );
    for (const spec of COMMANDS.filter((entry) => entry.audience === 'member')) {
      expect(names).toContain(spec.name);
    }
  });

  it('gives an operator both sets, scoped to their own chat', async () => {
    const { api, published } = recordingApi();
    await syncCommandMenu(api, ADMINS, logger);

    const scoped = published.find((entry) => entry.scope.type === 'chat');
    expect(scoped?.scope.chat_id).toBe(999);

    const names = (scoped?.commands ?? []).map((command) => command.command);
    // Both, because an operator is also a member — a menu that hid
    // /commission from the person running the drop would misrepresent the bot.
    for (const spec of COMMANDS) {
      expect(names).toContain(spec.name);
    }
  });

  it('scopes nothing to an id from another platform', async () => {
    const { api, published } = recordingApi();
    await syncCommandMenu(api, [{ platform: 'discord', externalId: '4711' }], logger);

    // The same number belongs to somebody else entirely on Telegram, and
    // scoping to it would publish an admin menu to a stranger.
    expect(published.some((entry) => entry.scope.type === 'chat')).toBe(false);
  });

  it('ignores an admin id that is not a usable chat id', async () => {
    const { api, published } = recordingApi();
    await syncCommandMenu(api, [{ platform: 'telegram', externalId: 'not-a-number' }], logger);

    expect(published.some((entry) => entry.scope.type === 'chat')).toBe(false);
  });

  it('publishes nothing to anybody when there are no operators', async () => {
    const { api, published } = recordingApi();
    await syncCommandMenu(api, [], logger);

    expect(published.filter((entry) => entry.scope.type === 'chat')).toHaveLength(0);
    expect(published.filter((entry) => entry.scope.type === 'default')).toHaveLength(1);
  });
});

describe('when Telegram will not take it', () => {
  it('still publishes the operator menu when the default scope fails', async () => {
    const { api, published } = recordingApi((scope) => scope === 'default');
    await syncCommandMenu(api, ADMINS, logger);

    // Failing to publish the member menu is no reason to leave operators
    // without theirs.
    expect(published.some((entry) => entry.scope.type === 'chat')).toBe(true);
  });

  it('does not throw when an operator has never opened a chat', async () => {
    // Ordinary, not exceptional: Telegram refuses a chat scope for somebody
    // who has never messaged the bot.
    const { api } = recordingApi((scope) => scope === 'chat');
    await expect(syncCommandMenu(api, ADMINS, logger)).resolves.toBeUndefined();
  });

  it('never takes the process down over a menu', async () => {
    const api = {
      setMyCommands: () => Promise.reject(new Error('network down')),
    } as unknown as Api;

    // A bot with no menu is a worse product but a working one. Failing here
    // would turn a cosmetic problem into an outage.
    await expect(syncCommandMenu(api, ADMINS, logger)).resolves.toBeUndefined();
  });
});

describe('the menu and the handlers cannot drift', () => {
  it('refuses to start when a published command has no handler', () => {
    // The direction TypeScript cannot catch: a command listed, published into
    // everybody's menu, and doing nothing when tapped.
    expect(() => {
      assertEveryCommandHandled(new Set(['start']));
    }).toThrow(/no handler/);
  });

  it('names which ones are missing, not merely that some are', () => {
    try {
      assertEveryCommandHandled(new Set());
      throw new Error('expected it to refuse');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      for (const spec of COMMANDS) {
        expect(message).toContain(spec.name);
      }
    }
  });

  it('passes for the bot as it is actually built', () => {
    // The real assertion runs inside createBot, so building one is the test:
    // a command added to COMMANDS without a handler fails here.
    expect(() =>
      createHarness({
        db: {
          projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
          claimsByProjectAndMember: new Map(),
        },
      }),
    ).not.toThrow();
  });
});

describe('the table itself', () => {
  it('describes every command within Telegram’s limits', () => {
    for (const spec of COMMANDS) {
      // Telegram refuses a command outside these bounds, and a refusal here
      // would mean no menu at all rather than one bad entry.
      expect(spec.name).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('lists each command once', () => {
    const names = COMMANDS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('every published command actually dispatches', () => {
  /**
   * The gap that let /collection die for a whole phase.
   *
   * It was registered after a `bot.on('message:text')` handler that returned
   * without calling next(), which ends the middleware chain — so the command
   * was never reached. Nothing caught it, because the collection tests
   * exercised the paging functions directly and never sent the command.
   *
   * This drives every command in the menu through the bot and asserts each one
   * produces something. It does not care what: only that a command published
   * into everybody's client is not silently inert.
   */
  it('answers something for each one', async () => {
    for (const spec of COMMANDS) {
      const h = createHarness({
        db: {
          projectsBySlug: new Map([['drop', project({ id: 1, name: 'Drop' })]]),
          claimsByProjectAndMember: new Map(),
          groupBinding: { groupId: '-100999', projectId: 1, name: 'Drop' },
        },
        adminIds: ['555'],
      });

      // /verify only runs in a group; everything else in a private chat.
      if (spec.name === 'verify') {
        await h.sendInGroup(`/${spec.name} @tester`, -100999, 555);
      } else {
        await h.send(`/${spec.name}`, 555);
      }

      expect(h.sent.length, `/${spec.name} is in the menu but answered nothing`).toBeGreaterThan(0);
    }
  });
});
