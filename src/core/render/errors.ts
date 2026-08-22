/** A trait pack that cannot produce deterministic renders. */
export class TraitPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraitPackError';
  }
}

/** A single trait image that failed validation. Always names the file. */
export class TraitImageError extends Error {
  readonly imagePath: string;

  constructor(imagePath: string, reason: string) {
    super(`${imagePath}: ${reason}`);
    this.name = 'TraitImageError';
    this.imagePath = imagePath;
  }
}

/** No open-tier option exists for a slot, so no combination can be built. */
export class EmptySlotError extends Error {
  readonly slot: string;

  constructor(slot: string) {
    super(`slot "${slot}" has no open-tier traits to choose from`);
    this.name = 'EmptySlotError';
    this.slot = slot;
  }
}
