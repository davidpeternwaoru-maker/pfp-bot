/**
 * Who a project will let roll, beyond the claim window.
 *
 * The rule lives in the database as JSON, so it arrives here as an unknown and
 * is parsed rather than trusted. A rule nobody can read is not treated as an
 * absent rule: it refuses, because the alternative is a project that meant to
 * gate its drop quietly admitting everybody after a typo.
 *
 * Pure, and deliberately ignorant of Telegram. Whether somebody is in a group
 * is a fact the adapter establishes and passes in; what to do about it is
 * decided here. That split is what lets a Discord front end enforce the same
 * rules without this file learning what a chat is.
 *
 * Token-holding eligibility is not here. It lives with the wallet code, needs
 * an RPC endpoint, and gates commissions rather than rolling.
 */

export type EligibilityRule =
  /** The default. Anybody who can open the link may roll. */
  | { readonly kind: 'open' }
  /** Must be in the project's group right now. */
  | { readonly kind: 'group-member'; readonly groupId: string }
  /** Must have been known to the group for long enough. */
  | { readonly kind: 'group-tenure'; readonly groupId: string; readonly minimumDays: number };

/**
 * What the adapter found out.
 *
 * `unknown` is its own case rather than a false, because the two mean opposite
 * things to a member: one says "join the group", the other says "we could not
 * check". Collapsing them would send somebody to join a group they are already
 * in.
 */
export type MembershipFact =
  | { readonly kind: 'member'; readonly knownSince: Date | null }
  | { readonly kind: 'not-member' }
  | { readonly kind: 'unknown' };

export type EligibilityRefusal =
  /** Not in the group. Names the group so they can go and join it. */
  | { readonly kind: 'must-join'; readonly groupId: string }
  /** In the group, but not for long enough yet. */
  | {
      readonly kind: 'too-new';
      readonly minimumDays: number;
      readonly heldDays: number;
      readonly eligibleAt: Date;
    }
  /** The check failed, or the rule could not be read. Always a refusal. */
  | { readonly kind: 'unverifiable' };

export type EligibilityDecision =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'refused'; readonly refusal: EligibilityRefusal };

/** Anything longer than this is almost certainly a typo, not a policy. */
const MAX_TENURE_DAYS = 3650;

/**
 * Reads a stored rule, or returns null when it cannot be read.
 *
 * Null means "refuse", never "allow". A project with a malformed rule has said
 * something about who may enter and been misunderstood, and the safe reading
 * of a misunderstood restriction is the restrictive one.
 */
export function parseEligibilityRule(value: unknown): EligibilityRule | null {
  // An absent rule is the ordinary case: most projects gate on nothing, and
  // the column defaults to an empty object.
  if (value === null || value === undefined) {
    return { kind: 'open' };
  }
  if (typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const kind = record['kind'];

  if (kind === undefined && Object.keys(record).length === 0) {
    return { kind: 'open' };
  }

  if (kind === 'open') {
    return { kind: 'open' };
  }

  const groupId = record['groupId'];
  if (typeof groupId !== 'string' || groupId.length === 0) {
    return null;
  }

  if (kind === 'group-member') {
    return { kind: 'group-member', groupId };
  }

  if (kind === 'group-tenure') {
    const minimumDays = record['minimumDays'];
    if (
      typeof minimumDays !== 'number' ||
      !Number.isInteger(minimumDays) ||
      minimumDays < 0 ||
      minimumDays > MAX_TENURE_DAYS
    ) {
      return null;
    }
    return { kind: 'group-tenure', groupId, minimumDays };
  }

  return null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decides, given the rule and what the adapter established.
 *
 * Every path that is not a definite yes is a no. There is no "let them through
 * while the check recovers" branch, and there must not be one: a gate that
 * opens on error is a gate that opens exactly when something is wrong.
 */
export function decideEligibility(
  rule: EligibilityRule | null,
  fact: MembershipFact,
  now: Date,
): EligibilityDecision {
  // Unreadable rule. Refuse, and say we could not check rather than inventing
  // a requirement the project never set.
  if (rule === null) {
    return { kind: 'refused', refusal: { kind: 'unverifiable' } };
  }

  if (rule.kind === 'open') {
    return { kind: 'eligible' };
  }

  if (fact.kind === 'unknown') {
    return { kind: 'refused', refusal: { kind: 'unverifiable' } };
  }

  if (fact.kind === 'not-member') {
    return { kind: 'refused', refusal: { kind: 'must-join', groupId: rule.groupId } };
  }

  if (rule.kind === 'group-member') {
    return { kind: 'eligible' };
  }

  // Tenure, and nothing to measure it from. Refused rather than waved
  // through: a project asking for thirty days did not mean "or none at all".
  if (fact.knownSince === null) {
    return { kind: 'refused', refusal: { kind: 'unverifiable' } };
  }

  const heldMs = now.getTime() - fact.knownSince.getTime();
  const heldDays = Math.floor(heldMs / MS_PER_DAY);

  if (heldDays >= rule.minimumDays) {
    return { kind: 'eligible' };
  }

  return {
    kind: 'refused',
    refusal: {
      kind: 'too-new',
      minimumDays: rule.minimumDays,
      heldDays: Math.max(0, heldDays),
      eligibleAt: new Date(fact.knownSince.getTime() + rule.minimumDays * MS_PER_DAY),
    },
  };
}

/** The group a rule refers to, if any. Adapters use it to know what to ask. */
export function ruleGroupId(rule: EligibilityRule | null): string | null {
  if (rule === null || rule.kind === 'open') {
    return null;
  }
  return rule.groupId;
}
