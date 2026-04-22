/**
 * Re-exported DB types from `@koji/db/schema`.
 *
 * Consumers import from `@koji/types/db` so they don't need a direct
 * dependency on the db package (which pulls in drizzle-orm, postgres, etc.).
 * Only the inferred row types are re-exported — not the table objects
 * themselves, which stay in `@koji/db`.
 */
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import {
  tenants,
  users,
  memberships,
  apiKeys,
  auditLog,
  invites,
  schemas,
  schemaVersions,
  schemaSamples,
  corpusEntries,
  corpusEntryGroundTruth,
  corpusEntryTags,
  corpusVersionResults,
  schemaRuns,
  schemaRunModels,
  pipelines,
  sources,
  ingestions,
  modelEndpoints,
  endpointUsageRollups,
  jobs,
  documents,
  traces,
  traceStages,
  reviewItems,
  agentSessions,
  agentMessages,
  agentProposedEdits,
  playgroundSessions,
  playgroundExtractions,
  playgroundRateLimits,
  webhookTargets,
  webhookDeliveries,
} from "@koji/db/schema";

// -- Select types (what you get back from a query) --

export type Tenant = InferSelectModel<typeof tenants>;
export type User = InferSelectModel<typeof users>;
export type Membership = InferSelectModel<typeof memberships>;
export type ApiKey = InferSelectModel<typeof apiKeys>;
export type AuditLogEntry = InferSelectModel<typeof auditLog>;
export type Invite = InferSelectModel<typeof invites>;

export type Schema = InferSelectModel<typeof schemas>;
export type SchemaVersion = InferSelectModel<typeof schemaVersions>;
export type SchemaSample = InferSelectModel<typeof schemaSamples>;

export type CorpusEntry = InferSelectModel<typeof corpusEntries>;
export type CorpusEntryGroundTruth = InferSelectModel<typeof corpusEntryGroundTruth>;
export type CorpusEntryTag = InferSelectModel<typeof corpusEntryTags>;
export type CorpusVersionResult = InferSelectModel<typeof corpusVersionResults>;

export type SchemaRun = InferSelectModel<typeof schemaRuns>;
export type SchemaRunModel = InferSelectModel<typeof schemaRunModels>;

export type Pipeline = InferSelectModel<typeof pipelines>;
export type Source = InferSelectModel<typeof sources>;
export type Ingestion = InferSelectModel<typeof ingestions>;

/**
 * Per-pipeline retry policy. Stored in `pipelines.retry_policy_json` as a
 * nullable jsonb column — NULL means "use platform defaults" (see
 * {@link DEFAULT_RETRY_POLICY}). Wiring into the motor + queue is a follow-up
 * after platform-53 (transient-error classifier).
 */
export interface RetryPolicy {
  /** Max delivery attempts before the job is marked terminal. */
  maxAttempts: number;
  /** Starting delay for exponential backoff, in milliseconds. */
  backoffBaseMs: number;
  /** Upper cap for the computed backoff delay, in milliseconds. */
  backoffMaxMs: number;
  /** If true, errors classified as transient are retried up to `maxAttempts`. */
  retryTransient: boolean;
}

/**
 * Defaults applied when `pipelines.retry_policy_json` is NULL. These mirror
 * the hardcoded values in `api/src/queue/postgres.ts` (retained there until
 * the motor consults this policy directly).
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 12,
  backoffBaseMs: 5_000,
  backoffMaxMs: 300_000,
  retryTransient: true,
};

export type ModelEndpoint = InferSelectModel<typeof modelEndpoints>;
export type EndpointUsageRollup = InferSelectModel<typeof endpointUsageRollups>;

export type Job = InferSelectModel<typeof jobs>;
export type Document = InferSelectModel<typeof documents>;
export type Trace = InferSelectModel<typeof traces>;
export type TraceStage = InferSelectModel<typeof traceStages>;

export type ReviewItem = InferSelectModel<typeof reviewItems>;

export type AgentSession = InferSelectModel<typeof agentSessions>;
export type AgentMessage = InferSelectModel<typeof agentMessages>;
export type AgentProposedEdit = InferSelectModel<typeof agentProposedEdits>;

export type PlaygroundSession = InferSelectModel<typeof playgroundSessions>;
export type PlaygroundExtraction = InferSelectModel<typeof playgroundExtractions>;
export type PlaygroundRateLimit = InferSelectModel<typeof playgroundRateLimits>;

export type WebhookTarget = InferSelectModel<typeof webhookTargets>;
export type WebhookDelivery = InferSelectModel<typeof webhookDeliveries>;

// -- Insert types (what you pass to an insert) --

export type NewTenant = InferInsertModel<typeof tenants>;
export type NewUser = InferInsertModel<typeof users>;
export type NewMembership = InferInsertModel<typeof memberships>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;
export type NewAuditLogEntry = InferInsertModel<typeof auditLog>;
export type NewInvite = InferInsertModel<typeof invites>;

export type NewSchema = InferInsertModel<typeof schemas>;
export type NewSchemaVersion = InferInsertModel<typeof schemaVersions>;
export type NewSchemaSample = InferInsertModel<typeof schemaSamples>;

export type NewCorpusEntry = InferInsertModel<typeof corpusEntries>;
export type NewCorpusEntryGroundTruth = InferInsertModel<typeof corpusEntryGroundTruth>;
export type NewCorpusEntryTag = InferInsertModel<typeof corpusEntryTags>;

export type NewSchemaRun = InferInsertModel<typeof schemaRuns>;

export type NewPipeline = InferInsertModel<typeof pipelines>;
export type NewSource = InferInsertModel<typeof sources>;
export type NewIngestion = InferInsertModel<typeof ingestions>;

export type NewModelEndpoint = InferInsertModel<typeof modelEndpoints>;

export type NewJob = InferInsertModel<typeof jobs>;
export type NewDocument = InferInsertModel<typeof documents>;

export type NewReviewItem = InferInsertModel<typeof reviewItems>;

export type NewAgentSession = InferInsertModel<typeof agentSessions>;
export type NewAgentMessage = InferInsertModel<typeof agentMessages>;

export type NewWebhookTarget = InferInsertModel<typeof webhookTargets>;
