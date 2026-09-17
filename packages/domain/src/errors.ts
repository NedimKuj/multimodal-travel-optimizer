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
