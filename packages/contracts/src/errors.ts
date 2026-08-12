/**
 * Typed error taxonomy shared by every service and by the console.
 *
 * The audit called out ambiguous empty states and silent redirects as a real
 * operational cost: an operator could not tell "no data" from "no permission"
 * from "filtered out". Every failure here carries a machine-readable code, an
 * owner and a remediation, so the UI can always say WHY.
 */
export type ErrorCode =
  | 'VALIDATION'
  | 'PERMISSION'
  | 'STALE_VERSION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INCOMPLETE_MAPPING'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'CIRCUIT_OPEN'
  | 'POLICY_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'STEP_UP_REQUIRED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'OFFER_EXPIRED'
  | 'OFFER_TAMPERED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL';

export interface DomainErrorPayload {
  code: ErrorCode;
  message: string;
  /** Which team owns fixing this. Straight from the audit's ownership matrix. */
  owner?: string;
  remediation?: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly owner?: string;
  readonly remediation?: string;
  readonly details?: Record<string, unknown>;
  correlationId?: string;

  constructor(p: DomainErrorPayload) {
    super(p.message);
    this.name = 'DomainError';
    this.code = p.code;
    this.owner = p.owner;
    this.remediation = p.remediation;
    this.details = p.details;
    this.correlationId = p.correlationId;
  }

  toJSON(): DomainErrorPayload {
    return {
      code: this.code,
      message: this.message,
      owner: this.owner,
      remediation: this.remediation,
      details: this.details,
      correlationId: this.correlationId,
    };
  }
}

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  PERMISSION: 403,
  STALE_VERSION: 409,
  CONFLICT: 409,
  NOT_FOUND: 404,
  INCOMPLETE_MAPPING: 422,
  DEPENDENCY_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  CIRCUIT_OPEN: 503,
  POLICY_DENIED: 403,
  CONFIRMATION_REQUIRED: 409,
  STEP_UP_REQUIRED: 401,
  IDEMPOTENCY_MISMATCH: 409,
  OFFER_EXPIRED: 410,
  OFFER_TAMPERED: 400,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
};
