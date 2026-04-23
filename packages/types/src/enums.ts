/**
 * Domain enums — the single source of truth for string-union values used
 * across the API, DB, and dashboard. Import from `@koji/types/enums`.
 *
 * Convention: each enum is a `const` object (for runtime access to values) plus
 * a union type of the same name (for compile-time narrowing). Consumers use
 * whichever form they need — the runtime object for iteration/validation, the
 * type for signatures and generics.
 */

// -- Document lifecycle --

export const DocumentState = {
  Queued: "queued",
  Processing: "processing",
  Complete: "complete",
  Failed: "failed",
  Review: "review",
  Emitted: "emitted",
} as const;
export type DocumentState = (typeof DocumentState)[keyof typeof DocumentState];

// -- Job lifecycle --

export const JobStatus = {
  Queued: "queued",
  Running: "running",
  Complete: "complete",
  Failed: "failed",
  Canceled: "canceled",
  CancelRequested: "cancel_requested",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

// -- Schema run (validate / benchmark) --

export const RunType = {
  Validate: "validate",
  Benchmark: "benchmark",
  NightlyBench: "nightly_bench",
} as const;
export type RunType = (typeof RunType)[keyof typeof RunType];

export const RunStatus = {
  Queued: "queued",
  Running: "running",
  Complete: "complete",
  Failed: "failed",
  Canceled: "canceled",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

// -- Trace --

export const TraceStatus = {
  Running: "running",
  Complete: "complete",
  Failed: "failed",
} as const;
export type TraceStatus = (typeof TraceStatus)[keyof typeof TraceStatus];

export const TraceStageStatus = {
  Pending: "pending",
  Running: "running",
  Complete: "complete",
  Failed: "failed",
  Skipped: "skipped",
} as const;
export type TraceStageStatus = (typeof TraceStageStatus)[keyof typeof TraceStageStatus];

export const StageName = {
  Ingress: "ingress",
  Classify: "classify",
  Extract: "extract",
  Normalize: "normalize",
  Validate: "validate",
  Review: "review",
  Emit: "emit",
} as const;
export type StageName = (typeof StageName)[keyof typeof StageName];

// -- Pipeline / source --

export const PipelineStatus = {
  Active: "active",
  Paused: "paused",
  Errored: "errored",
} as const;
export type PipelineStatus = (typeof PipelineStatus)[keyof typeof PipelineStatus];

export const SourceType = {
  S3Watcher: "s3_watcher",
  Webhook: "webhook",
  Email: "email",
  Ftp: "ftp",
  DashboardUpload: "dashboard_upload",
} as const;
export type SourceType = (typeof SourceType)[keyof typeof SourceType];

export const SourceStatus = {
  Active: "active",
  Paused: "paused",
  Errored: "errored",
} as const;
export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus];

export const TriggerType = {
  S3Watcher: "s3_watcher",
  Webhook: "webhook",
  Scheduled: "scheduled",
  Manual: "manual",
  Email: "email",
  Ftp: "ftp",
  Api: "api",
} as const;
export type TriggerType = (typeof TriggerType)[keyof typeof TriggerType];

// -- Corpus --

export const CorpusTag = {
  Normal: "normal",
  Adversarial: "adversarial",
  Edge: "edge",
  HeldOut: "held_out",
  Regression: "regression",
} as const;
export type CorpusTag = (typeof CorpusTag)[keyof typeof CorpusTag];

export const CorpusEntrySource = {
  ManualUpload: "manual_upload",
  PromotedFromReview: "promoted_from_review",
  IngestedFromSource: "ingested_from_source",
} as const;
export type CorpusEntrySource = (typeof CorpusEntrySource)[keyof typeof CorpusEntrySource];

export const GroundTruthReviewStatus = {
  Draft: "draft",
  Reviewed: "reviewed",
  Disputed: "disputed",
} as const;
export type GroundTruthReviewStatus =
  (typeof GroundTruthReviewStatus)[keyof typeof GroundTruthReviewStatus];

// -- Review --

export const ReviewReason = {
  LowConfidence: "low_confidence",
  ValidationFailure: "validation_failure",
  ManualFlag: "manual_flag",
} as const;
export type ReviewReason = (typeof ReviewReason)[keyof typeof ReviewReason];

export const ReviewStatus = {
  Pending: "pending",
  InReview: "in_review",
  Resolved: "resolved",
  Escalated: "escalated",
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

export const ReviewResolution = {
  Accepted: "accepted",
  Overridden: "overridden",
  Skipped: "skipped",
  Escalated: "escalated",
} as const;
export type ReviewResolution = (typeof ReviewResolution)[keyof typeof ReviewResolution];

// -- Model endpoints --

export const ModelProvider = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  AzureOpenAI: "azure_openai",
  Bedrock: "bedrock",
  Ollama: "ollama",
  Vllm: "vllm",
  Custom: "custom",
} as const;
export type ModelProvider = (typeof ModelProvider)[keyof typeof ModelProvider];

export const PricingMode = {
  Default: "default",
  FlatRate: "flat_rate",
  HardwareParams: "hardware_params",
} as const;
export type PricingMode = (typeof PricingMode)[keyof typeof PricingMode];

// -- Roles and permissions (auth-permissioning.md §4) --

export const Role = {
  TenantOwner: "tenant-owner",
  ProjectAdmin: "project-admin",
  SchemaWrite: "schema-write",
  PipelineWrite: "pipeline-write",
  SourceWrite: "source-write",
  ReviewWrite: "review-write",
  ReviewAdmin: "review-admin",
  EndpointWrite: "endpoint-write",
  ProjectRead: "project-read",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

// -- Tenant plan --

export const Plan = {
  Free: "free",
  Scale: "scale",
  Enterprise: "enterprise",
} as const;
export type Plan = (typeof Plan)[keyof typeof Plan];

// -- Agent --

export const AgentContext = {
  Build: "build",
  Validate: "validate",
  Trace: "trace",
  Jobs: "jobs",
  Review: "review",
  Corpus: "corpus",
  Benchmarks: "benchmarks",
  Endpoints: "endpoints",
  Pipelines: "pipelines",
  Sources: "sources",
} as const;
export type AgentContext = (typeof AgentContext)[keyof typeof AgentContext];

export const AgentEditKind = {
  SchemaYaml: "schema_yaml",
  PipelineYaml: "pipeline_yaml",
  ValidationRule: "validation_rule",
  Config: "config",
} as const;
export type AgentEditKind = (typeof AgentEditKind)[keyof typeof AgentEditKind];

// -- Audit --

export const ActorType = {
  User: "user",
  ApiKey: "api_key",
  System: "system",
  Webhook: "webhook",
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

// -- Ingestion --

export const IngestionStatus = {
  Received: "received",
  Processing: "processing",
  Complete: "complete",
  FailedIntegrity: "failed_integrity",
  FailedProcessing: "failed_processing",
} as const;
export type IngestionStatus = (typeof IngestionStatus)[keyof typeof IngestionStatus];

// -- Auth --

export const AuthProvider = {
  Local: "local",
  Clerk: "clerk",
  Oidc: "oidc",
  Saml: "saml",
} as const;
export type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider];
