/** Codes d'erreur stables, repris tels quels dans le contrat `ahub --json`. */
export type ErrorCode =
  | 'USAGE'
  | 'MANIFEST_INVALID'
  | 'LOCK_INVALID'
  | 'LOCK_MISMATCH'
  | 'NOT_FOUND'
  | 'RESOLUTION_FAILED'
  | 'GIT_FAILED'
  | 'PACKAGE_INVALID'
  | 'SCAN_BLOCKED'
  | 'FILE_MODIFIED'
  | 'CONFLICT'
  | 'CONFIRMATION_REQUIRED'
  | 'PLAN_CHANGED'
  | 'NO_TARGET'
  | 'UNSUPPORTED'
  | 'REGISTRY_FAILED'
  | 'INTERNAL';

export class AhubError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AhubError';
    this.code = code;
    this.details = details;
  }
}

/** Message non bloquant : toujours affiché, jamais avalé en silence. */
export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}

export function isAhubError(e: unknown): e is AhubError {
  return e instanceof AhubError;
}
