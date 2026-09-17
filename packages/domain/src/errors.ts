/**
 * A single invariant violation reported by a validator that checks several
 * rules at once (for example, trip candidate validation). Validators return
 * every issue they find instead of stopping at the first one.
 */
export interface DomainIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * Base class for violations of domain invariants.
 *
 * `code` is stable and machine-readable; `message` is for humans.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
