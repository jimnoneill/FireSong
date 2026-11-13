/** A short, log-safe description of a thrown value for `diag`. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
