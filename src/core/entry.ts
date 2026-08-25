import type { ProjectStatus } from '../generated/prisma/enums.js';

/**
 * Decides what a member sees when they open a deep link. Pure, so every
 * entry state is testable without a bot, a database, or a network.
 */

export interface EntryProject {
  readonly id: number;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly claimOpensAt: Date | null;
  readonly claimClosesAt: Date | null;
  /**
   * The project's own rule about who may roll, as stored.
   *
   * Unknown rather than a parsed type: it is JSON from a column, and parsing
   * it is the eligibility module's job. resolveEntry does not read it — the
   * window and the existing claim are decided without a network, and the rule
   * needs one — so it is carried through rather than acted on here.
   */
  readonly eligibilityRule?: unknown;
}

export interface EntryExistingClaim {
  readonly editionNumber: number;
}

export interface EntryInput {
  /** null when the payload was absent, malformed, or matched no project. */
  readonly project: EntryProject | null;
  readonly existingClaim: EntryExistingClaim | null;
  readonly now: Date;
}

export type EntryOutcome =
  | { readonly kind: 'unknown-project' }
  | { readonly kind: 'not-open'; readonly projectName: string; readonly status: ProjectStatus }
  | { readonly kind: 'not-yet-open'; readonly projectName: string; readonly opensAt: Date }
  | { readonly kind: 'window-closed'; readonly projectName: string }
  | {
      readonly kind: 'already-claimed';
      readonly projectName: string;
      readonly editionNumber: number;
    }
  | { readonly kind: 'ready'; readonly projectId: number; readonly projectName: string };

export function resolveEntry(input: EntryInput): EntryOutcome {
  const { project } = input;

  if (project === null) {
    return { kind: 'unknown-project' };
  }

  if (project.status !== 'live') {
    return { kind: 'not-open', projectName: project.name, status: project.status };
  }

  // An existing claim wins over the window: a member who already holds one
  // should always be able to see it, even after the drop closes.
  if (input.existingClaim !== null) {
    return {
      kind: 'already-claimed',
      projectName: project.name,
      editionNumber: input.existingClaim.editionNumber,
    };
  }

  // A live project is still gated by its window. Skipping this check would let
  // members roll before a drop opens or after it ends, which is the one thing
  // the schema's window columns exist to prevent.
  if (project.claimOpensAt !== null && input.now < project.claimOpensAt) {
    return { kind: 'not-yet-open', projectName: project.name, opensAt: project.claimOpensAt };
  }

  if (project.claimClosesAt !== null && input.now >= project.claimClosesAt) {
    return { kind: 'window-closed', projectName: project.name };
  }

  return { kind: 'ready', projectId: project.id, projectName: project.name };
}
