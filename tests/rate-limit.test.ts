import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/bot/rate-limit.js';

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('allows up to the limit and blocks the next action', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    expect(limiter.check('user').allowed).toBe(true);
    expect(limiter.check('user').allowed).toBe(true);
    expect(limiter.check('user').allowed).toBe(true);
    expect(limiter.check('user').allowed).toBe(false);
  });

  it('tells the caller how long to wait rather than dropping silently', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    limiter.check('user');
    clock.advance(15_000);
    const blocked = limiter.check('user');

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(45);
  });

  it('never reports a wait of zero seconds while blocked', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock.now });

    limiter.check('user');
    clock.advance(999);
    expect(limiter.check('user').retryAfterSeconds).toBe(1);
  });

  it('lets the user through again once the window rolls over', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });

    limiter.check('user');
    limiter.check('user');
    expect(limiter.check('user').allowed).toBe(false);

    clock.advance(60_000);
    expect(limiter.check('user').allowed).toBe(true);
  });

  it('counts each user separately, so one member cannot lock out another', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    expect(limiter.check('noisy').allowed).toBe(true);
    expect(limiter.check('noisy').allowed).toBe(false);
    expect(limiter.check('quiet').allowed).toBe(true);
  });

  it('does not grow without bound as one-off users come and go', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, now: clock.now });

    for (let i = 0; i < 2000; i += 1) {
      limiter.check(`user-${String(i)}`);
    }
    const beforeExpiry = limiter.size();

    clock.advance(5000);
    for (let i = 0; i < 2000; i += 1) {
      limiter.check(`later-${String(i)}`);
    }

    // The first cohort has expired and been swept, so the map did not simply
    // double.
    expect(limiter.size()).toBeLessThan(beforeExpiry * 2);
  });

  it('refuses a nonsensical configuration rather than admitting everyone', () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
  });
});
