import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { Logger } from '../../logging/logger.js';

/**
 * Every command this bot answers, in one place.
 *
 * This table is the source of truth for two things that must never disagree:
 * which commands have handlers, and which commands Telegram shows in the menu.
 * When those drift, the failure is invisible in the worst direction — a
 * command that works but nobody can discover, or one in the menu that does
 * nothing when tapped.
 *
 * So the table comes first and the handlers are keyed off it. `CommandName` is
 * derived from this array, and bot.ts registers handlers through a map typed
 * by that union: a handler for a command not listed here will not compile, and
 * a command listed here with no handler fails an assertion at startup. Neither
 * mistake can reach a member.
 */

export type CommandAudience = 'member' | 'admin';

export interface CommandSpec {
  readonly name: string;
  /** Shown in the client's menu. Telegram allows 1–256 characters. */
  readonly description: string;
  readonly audience: CommandAudience;
}

export const COMMANDS = [
  {
    name: 'start',
    description: 'Open a collection and roll a profile picture',
    audience: 'member',
  },
  {
    name: 'mine',
    description: 'Get the full-resolution file of a claim you hold',
    audience: 'member',
  },
  {
    name: 'collection',
    description: 'Everything you hold, across every collection',
    audience: 'member',
  },
  {
    name: 'commission',
    description: 'Order artwork drawn for you alone, or check on one',
    audience: 'member',
  },
  {
    name: 'wallet',
    description: 'Link or unlink a Solana wallet (optional)',
    audience: 'member',
  },
  {
    name: 'queue',
    description: 'Work the commission queue',
    audience: 'admin',
  },
] as const satisfies readonly CommandSpec[];

export type CommandName = (typeof COMMANDS)[number]['name'];

/** Telegram's own shape, which wants the description and nothing else. */
function toBotCommand(spec: CommandSpec): BotCommand {
  return { command: spec.name, description: spec.description };
}

const memberCommands = COMMANDS.filter((spec) => spec.audience === 'member').map(toBotCommand);

/**
 * Admins see their own commands alongside the member ones.
 *
 * Both, not only the admin ones: an operator is also a member, and a menu that
 * hid /commission from the person running the drop would be a menu that lies
 * about what the bot does.
 */
const adminCommands = COMMANDS.map(toBotCommand);

export interface CommandMenuTarget {
  readonly platform: string;
  readonly externalId: string;
}

/**
 * Publishes the menu to Telegram.
 *
 * Two scopes rather than one list. The default scope carries member commands
 * only, so an ordinary member's client never lists an admin command — not
 * because it is hidden, but because it was never sent to them.
 *
 * The menu is presentation and nothing more. Every admin command still checks
 * the allowlist server-side when it runs, so somebody who learns the name of
 * one by other means gains nothing by typing it. That separation is why a
 * stale menu is a cosmetic problem rather than a security one: an operator
 * removed from ADMIN_IDS keeps the menu entry until their client refreshes,
 * and the command refuses them anyway.
 *
 * Never throws. A menu that cannot be published is a bot with no menu, which
 * is a worse product but a working one — and taking the process down over it
 * would turn a cosmetic failure into an outage.
 */
export async function syncCommandMenu(
  api: Api,
  admins: readonly CommandMenuTarget[],
  logger: Logger,
): Promise<void> {
  try {
    await api.setMyCommands(memberCommands, { scope: { type: 'default' } });
  } catch (error) {
    logger.warn('commands.default_scope_failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    // Deliberately continues. Failing to publish the default menu is no
    // reason to leave operators without theirs.
  }

  for (const admin of admins) {
    // Only Telegram admins get a Telegram menu. An id belonging to another
    // platform is somebody else entirely, and scoping a menu to it would
    // publish an admin menu to whichever Telegram user happens to hold that
    // number.
    if (admin.platform !== 'telegram') {
      continue;
    }

    const chatId = Number(admin.externalId);
    if (!Number.isSafeInteger(chatId)) {
      logger.warn('commands.admin_id_unusable');
      continue;
    }

    try {
      await api.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: chatId } });
    } catch (error) {
      // A scope fails when the admin has never opened a chat with the bot,
      // which is ordinary and not worth an error line.
      logger.info('commands.admin_scope_skipped', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('commands.published', {
    member: memberCommands.length,
    admin: adminCommands.length,
  });
}

/**
 * Fails loudly when a listed command has no handler.
 *
 * The other half of the guarantee. TypeScript already refuses a handler for a
 * command that is not listed; this catches the reverse, where a command is
 * listed, published into everybody's menu, and does nothing when tapped.
 * Checked at startup so it is impossible to ship, and it costs nothing.
 */
export function assertEveryCommandHandled(registered: ReadonlySet<string>): void {
  const missing = COMMANDS.filter((spec) => !registered.has(spec.name)).map((spec) => spec.name);

  if (missing.length > 0) {
    throw new Error(
      `These commands are published in the menu but have no handler: ${missing.join(', ')}. ` +
        'Either add a handler or remove them from COMMANDS.',
    );
  }
}
