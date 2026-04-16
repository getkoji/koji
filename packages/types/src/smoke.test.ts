/**
 * Compile-time smoke test. This file is checked by `pnpm test` (which runs
 * `tsc --noEmit -p tsconfig.test.json`). If it compiles, all four entry
 * points resolve and the types are structurally sound.
 *
 * This is NOT a runtime test — it exists purely to catch import resolution
 * failures and type-level regressions after a spec or schema change.
 */

// 1. API types — generated from openapi.yaml
import type { paths, components } from "./api";

type HealthResponse = paths["/health"]["get"]["responses"]["200"]["content"]["application/json"];
type SchemaComponent = components["schemas"]["Schema"];

// 2. DB types — re-exported from @koji/db
import type { Document, Job, Schema as DbSchema, NewCorpusEntry } from "./db";

// 3. Domain enums
import { DocumentState, JobStatus, Role, AgentContext } from "./enums";

// 4. Error types
import type { Problem } from "./errors";
import { ErrorCode, isProblem } from "./errors";

// -- Structural assertions (compile-time only) --

const _healthOk: HealthResponse = {} as HealthResponse;
void _healthOk;

const _schema: SchemaComponent = {} as SchemaComponent;
void _schema;

const _doc: Document = {} as Document;
void _doc.status;

const _job: Job = {} as Job;
void _job.slug;

const _dbSchema: DbSchema = {} as DbSchema;
void _dbSchema.slug;

const _corpusInsert: NewCorpusEntry = {} as NewCorpusEntry;
void _corpusInsert.filename;

const _state: DocumentState = DocumentState.Emitted;
void _state;

const _role: Role = Role.SchemaWrite;
void _role;

const _ctx: AgentContext = AgentContext.Build;
void _ctx;

const _jobStatus: JobStatus = JobStatus.Running;
void _jobStatus;

const _problem: Problem = { type: "", title: "", status: 404 };
void _problem;

const _code: string = ErrorCode.NotFound;
void _code;

const _guard: boolean = isProblem({ type: "", title: "", status: 404 });
void _guard;
