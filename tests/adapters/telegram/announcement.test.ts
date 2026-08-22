import { describe, expect, it } from 'vitest';
import { announcementText } from '../../../src/adapters/telegram/replies.js';
import { normaliseUsername } from '../../../src/adapters/telegram/payload.js';
import { trait } from '../../helpers/fixtures.js';

const TRAITS = [
  trait({ slot: 'background', name: 'midnight' }),
  trait({ slot: 'hat', name: 'visor' }),
];

describe('announcementText', () => {
  it('names the claimant when they have a username', () => {
    const text = announcementText('Drop', 7, TRAITS, 'someone');
    expect(text).toContain('@someone');
    expect(text).toContain('edition #7 of Drop');
    expect(text).toContain('midnight · visor');
  });

  it('still announces a member who has no username', () => {
    const text = announcementText('Drop', 7, TRAITS, null);
    expect(text).toContain('A member');
    expect(text).not.toContain('@');
    expect(text).toContain('edition #7 of Drop');
  });

  it('only ever carries a handle that passed validation', () => {
    // A crafted username reaches announcementText as null, so it can never
    // become markup or an injected mention in a public group message.
    for (const hostile of ['bad name', 'a@b', '*bold*', '[x](y)', '', 'a'.repeat(33)]) {
      expect(normaliseUsername(hostile)).toBeNull();
    }
    expect(normaliseUsername('good_name_1')).toBe('good_name_1');
  });

  it('renders a validated handle literally', () => {
    const text = announcementText('Drop', 1, TRAITS, normaliseUsername('good_name_1') ?? null);
    expect(text).toContain('@good_name_1');

    // Underscores are legal in Telegram usernames and stay literal because no
    // reply sets a parse mode. The characters that would matter under markdown
    // cannot survive normaliseUsername in the first place.
    expect(text).not.toMatch(/[*~`[\]]/);
  });
});
