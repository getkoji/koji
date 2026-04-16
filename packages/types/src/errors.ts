/**
 * Error shapes — the RFC 7807 problem detail envelope and known error codes.
 * Import from `@koji/types/errors`.
 *
 * Sources: api-endpoints.md §1.4, auth-permissioning.md §10.
 */

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  trace_id?: string;
  code?: string;
}

export const ErrorCode = {
  // Auth
  AuthMissing: "auth.missing",
  AuthInvalid: "auth.invalid",
  AuthExpired: "auth.expired",
  AuthMissingScope: "auth.missing_scope",
  AuthTenantMismatch: "auth.tenant_mismatch",

  // Resources
  NotFound: "resource.not_found",
  AlreadyExists: "resource.already_exists",
  InUse: "resource.in_use",
  Archived: "resource.archived",

  // Validation
  InvalidBody: "validation.invalid_body",
  InvalidQuery: "validation.invalid_query",
  SchemaCompileFailed: "validation.schema_compile_failed",
  PipelineCompileFailed: "validation.pipeline_compile_failed",

  // Rate limiting
  RateLimited: "rate_limit.exceeded",
  PlaygroundLimitExceeded: "rate_limit.playground_exceeded",

  // Billing
  PlanLimitReached: "billing.plan_limit_reached",
  SubscriptionRequired: "billing.subscription_required",
  PaymentFailed: "billing.payment_failed",

  // Jobs
  JobAlreadyRunning: "job.already_running",
  JobNotCancelable: "job.not_cancelable",

  // Internal
  InternalError: "internal.error",
  ServiceUnavailable: "internal.service_unavailable",
  UpstreamTimeout: "internal.upstream_timeout",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export function isProblem(value: unknown): value is Problem {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "title" in value &&
    "status" in value
  );
}
