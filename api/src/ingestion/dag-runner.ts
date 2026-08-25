/**
 * `pipeline.dag.run` worker — executes a DAG pipeline for a document.
 *
 * Similar to `ingestion.process` but walks the pipeline DAG instead of
 * running the legacy single-schema extraction. Persists per-step results
 * to `pipeline_step_runs` and updates the document row with the final
 * extraction result.
 */

import { and, eq, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { compilePipeline, evaluateCondition, stepCost, type ParsedCondition } from "@koji/pipeline";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import type { QueuedJob } from "../queue/provider";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseConfig } from "../parse/factory";
import { resolveExtractEndpoint } from "../extract/resolve-endpoint";
import { resolveClassifierConfig, classifyWithConfig } from "../classify";
import { resolvePipelineSchemaVersion } from "./pipeline-schema-version";
import { resolveReferences } from "./resolve-references";
import { createProvider } from "../extract/providers";
import { extractFields } from "../extract/pipeline";
import type { TextMap } from "../extract/provenance";
import type { ParseChunk } from "../parse/chunk";
import { chunkMarkdown, type Chunk } from "../extract/chunker";
import { decrypt, getMasterKey } from "../crypto/envelope";
import { TerminalError } from "../queue/worker";
import { readParseProviderPin, markDocFailed, recordDeliveryBillableEvent } from "./process";
import { resolveParse, parseDocument } from "./seam";
import { decideDocumentOutcome, persistDocumentOutcome, type OutcomeExtraction } from "./outcome";
import { jobCounterRecompute } from "./job-counters";
import { enqueueWebhookDeliveries } from "../webhooks/emit";

let _db: Db | null = null;
let _storage: StorageProvider | null = null;
let _parseProvider: ParseProvider | null = null;
// The ParseConfig the default provider was built from. Captured at init so the
// DAG path can rebuild a per-tenant provider at call time (BYO parse), exactly
// like `handleIngestionProcess`. When absent, per-call resolution is disabled
// and the default provider is used for every tenant — identical to today.
let _parseConfig: ParseConfig | null = null;

export function initDagRunner(db: Db, storage: StorageProvider) {
  _db = db;
  _storage = storage;
}

export function setDagParseProvider(provider: ParseProvider, config?: ParseConfig) {
  _parseProvider = provider;
  _parseConfig = config ?? null;
}


/** Shared split execution — used by both main path and branch fan-out. */
async function executeSplit(
  step: { id: string; config: Record<string, unknown> },
  doc: { filename: string; storageKey: string; mimeType: string },
  documentId: string,
  pipelineId: string,
  tenantId: string,
  stepOutputs: Record<string, Record<string, unknown>>,
  db: Db,
  storage: StorageProvider,
  endpoint: any,
  /** Step IDs that follow the split in the DAG — children resume from here */
  nextStepIds?: string[],
): Promise<Record<string, unknown>> {
  if (!_parseProvider?.pageHeaders) {
    return { groups: [], error: "Parse provider does not support page headers" };
  }
  const file = await storage.getBuffer(doc.storageKey);
  if (!file) {
    return { groups: [], error: "File not found in storage" };
  }

  const method = (step.config.method as string) || "auto";
  const labels = (step.config.labels as Array<{ id: string; description?: string; keywords?: string[] }>) || [];

  // Fixed page ranges — no detection needed
  if (method === "fixed") {
    const ranges = (step.config.page_ranges as Array<{ start: number; end: number; type?: string }>) || [];
    const groups = ranges.map(r => ({ startPage: r.start, endPage: r.end, type: r.type || "document", confidence: 1.0, method: "fixed" }));
    return { groups, method: "fixed", count: groups.length };
  }

  // Use full structural analysis if available, otherwise fall back to page headers
  let groups: Array<{ startPage: number; endPage: number; type: string; confidence: number; method: string }>;

  const { detectSections } = await import("../extract/split-detect");
  if (_parseProvider.analyzePages) {
    const analysisResult = await _parseProvider.analyzePages({ fileBuffer: file.data });
    const pageData = analysisResult.data;
    let llmProvider: any = undefined;
    if (endpoint) { llmProvider = createProvider(endpoint.model, endpoint); }
    groups = await detectSections(pageData, { labels, llmProvider });
  } else {
    // Fallback: convert page headers into minimal PageAnalysis for detectSections
    const headersResult = await _parseProvider.pageHeaders({ fileBuffer: file.data });
    const pageData = headersResult.headers.map((h: { page: number; header_text: string }) => ({
      page: h.page,
      content_preview: h.header_text,
      bold_headings: [] as Array<{ text: string; y: number; size: number }>,
      form_numbers: [] as string[],
      text_density: 1,
      text_chars: 0,
      tables: [] as Array<{ y: number; h: number; cols: number; header: string }>,
      horizontal_rules: [] as number[],
      image_ratio: 0,
      blank_bottom_ratio: 0,
      table_count: 0,
      has_dollar_amounts: false,
      has_dates: false,
      page_label: null as number | null,
      page_of: null as number | null,
    }));
    let llmProvider: any = undefined;
    if (endpoint) { llmProvider = createProvider(endpoint.model, endpoint); }
    groups = await detectSections(pageData, { labels, llmProvider });
  }

  const output: Record<string, unknown> = { groups, method: method === "auto" ? "structural" : method, count: groups.length };

  // Fan-out: create child documents
  if (groups.length > 0 && _parseProvider.slicePdf) {
    const childIds: string[] = [];
    const jobId = (await withRLS(db, tenantId, (tx) =>
      tx.select({ jobId: schema.documents.jobId }).from(schema.documents)
        .where(eq(schema.documents.id, documentId)).limit(1),
    ))[0]?.jobId;

    for (const group of groups) {
      try {
        const sliced = await _parseProvider.slicePdf({ fileBuffer: file.data, startPage: group.startPage, endPage: group.endPage });
        const childKey = `${doc.storageKey.replace(/\.pdf$/i, "")}_p${group.startPage}-${group.endPage}.pdf`;
        const childBuffer = Buffer.from(sliced.pdf_base64, "base64");
        await storage.put(childKey, childBuffer, { contentType: "application/pdf" });
        const childFilename = `${doc.filename.replace(/\.pdf$/i, "")}_p${group.startPage}-${group.endPage}_${group.type}.pdf`;
        const [child] = await withRLS(db, tenantId, (tx) =>
          tx.insert(schema.documents).values({
            tenantId, jobId: jobId!, filename: childFilename, storageKey: childKey,
            fileSize: sliced.byte_size, mimeType: "application/pdf",
            contentHash: `split-${documentId}-${group.startPage}-${group.endPage}`,
            pageCount: sliced.pages, status: "pending", parentDocumentId: documentId,
            pageRange: [group.startPage, group.endPage],
          }).returning({ id: schema.documents.id }),
        );
        if (child) childIds.push(child.id);
        // Attach preview URL and child doc ID to the group
        try {
          const previewUrl = await storage.getSignedUrl(childKey, 3600);
          (group as any).previewUrl = previewUrl;
        } catch {}
        (group as any).childDocumentId = child?.id;
        console.log(`[dag-runner] split: created child doc ${childFilename} (pages ${group.startPage}-${group.endPage}, type=${group.type})`);
      } catch (err) {
        console.error(`[dag-runner] split: failed for pages ${group.startPage}-${group.endPage}:`, (err as Error).message);
      }
    }

    output.child_document_ids = childIds;
    output.fan_out = true;

    if (jobId && childIds.length > 0) {
      await withRLS(db, tenantId, (tx) =>
        tx.update(schema.jobs).set({ docsTotal: sql`docs_total + ${childIds.length}`, updatedAt: new Date() })
          .where(eq(schema.jobs.id, jobId)),
      );
    }

    const queue = (globalThis as any).__koji_queue;
    if (queue?.enqueue) {
      // Resolve next steps after split so children resume from there, not from the beginning
      const resumeStepIds = nextStepIds ?? [];
      for (let ci = 0; ci < childIds.length; ci++) {
        const group = groups[ci];
        await queue.enqueue({
          kind: "pipeline.dag.run",
          payload: {
            documentId: childIds[ci],
            pipelineId,
            // Children resume from the step(s) after split
            startStepId: resumeStepIds[0] ?? null,
            // Pass the split output so downstream steps have group context
            inheritedOutputs: {
              [step.id]: { ...output, current_group: group },
            },
          },
          tenantId,
        });
      }
    }
  }

  return output;
}

export interface TestEdge {
  from: string;
  to: string;
  /** Raw condition string (legacy YAML: `routes:[{when}]`) — evaluated with `evalCondition`. */
  when?: string;
  /** Compiler-parsed condition AST — evaluated with `@koji/pipeline` `evaluateCondition`. Wins over `when`. */
  condition?: ParsedCondition | null;
  default?: boolean;
}

export interface DagStep { id: string; type: string; config: Record<string, unknown> }

export interface DagPlan {
  steps: DagStep[];
  edges: TestEdge[];
  entryStepId: string | null;
  maxSteps: number;
  /** "compiled" = walked from compilePipeline output; "legacy" = hand-parsed yamlSource. */
  source: "compiled" | "legacy";
}

/**
 * Build the executable plan for a pipeline's yamlSource.
 *
 * The /validate endpoint compiles YAML via `@koji/pipeline` (which expands the
 * documented `on:`/`then:` sugar into conditional edges); the runner previously
 * re-parsed the raw YAML with its own edge extraction, found zero edges for
 * `on:` pipelines, and fell back to chaining ALL steps linearly — silently
 * turning a classify router into a run-everything fan-out (oss-358). Now the
 * runner executes the compiled DAG. YAML the compiler rejects keeps the legacy
 * hand-parse (routes:/next:, plus on:/then: translation) so pre-compiler
 * pipelines still run, but the linear fallback is refused when a classify step
 * is present — that shape is a router, and running it linearly is never right.
 *
 * Throws when the pipeline is not runnable; the caller fails the document.
 */
export function buildDagPlan(yamlSource: string): DagPlan {
  const compiled = compilePipeline(yamlSource);
  if (compiled.ok) {
    const p = compiled.pipeline;
    return {
      steps: p.steps.map((s) => ({ id: s.id, type: s.type, config: s.config ?? {} })),
      edges: p.edges.map((e) => ({ from: e.from, to: e.to, condition: e.condition, default: e.isDefault })),
      entryStepId: p.entryStepId,
      maxSteps: p.settings?.max_steps ?? 20,
      source: "compiled",
    };
  }
  const compileErrors = compiled.errors.map((e) => `${e.code}: ${e.message}`).join("; ");

  const parsed = parseYaml(yamlSource);
  const rawSteps: any[] = parsed?.steps || [];
  const steps: DagStep[] = rawSteps.map((s) => ({ id: s.id, type: s.type, config: s.config || {} }));
  const edges: TestEdge[] = [];
  for (const e of parsed?.edges || []) {
    if (e?.from && e?.to) edges.push({ from: e.from, to: e.to, when: e.when, default: e.default });
  }
  for (const s of rawSteps) {
    if (Array.isArray(s.routes)) {
      for (const r of s.routes) {
        if (r.goto) edges.push({ from: s.id, to: r.goto, when: r.when, default: r.default });
      }
    }
    if (s.next) edges.push({ from: s.id, to: s.next });
    if (s.then) edges.push({ from: s.id, to: s.then });
    if (s.on && typeof s.on === "object") {
      for (const [label, target] of Object.entries(s.on as Record<string, string>)) {
        if (label === "_default") edges.push({ from: s.id, to: target, default: true });
        else edges.push({ from: s.id, to: target, when: `output.label == '${label}'` });
      }
    }
  }
  if (edges.length === 0 && steps.length > 1) {
    if (steps.some((s) => s.type === "classify")) {
      throw new Error(
        `Pipeline YAML did not compile (${compileErrors}) and declares a classify step with no ` +
          `explicit edges — refusing to run every step linearly. Fix the YAML so it compiles ` +
          `(POST /api/pipelines/validate shows the errors) or declare explicit routes/edges.`,
      );
    }
    for (let i = 0; i < steps.length - 1; i++) {
      edges.push({ from: steps[i]!.id, to: steps[i + 1]!.id });
    }
  }
  const withIncoming = new Set(edges.map((e) => e.to));
  const entryStepId = steps.find((s) => !withIncoming.has(s.id))?.id ?? steps[0]?.id ?? null;
  return { steps, edges, entryStepId, maxSteps: 20, source: "legacy" };
}

export function evalCondition(condition: string, context: Record<string, unknown>): boolean {
  const m = condition.match(/^([\w.]+)\s*(==|!=|>=?|<=?|in)\s*(.+)$/);
  if (!m) return true;
  let current: unknown = context;
  for (const part of m[1]!.split(".")) {
    if (current == null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
  }
  const left = current;
  const raw = m[3]!.trim();
  let right: unknown;
  if (raw.startsWith("'") && raw.endsWith("'")) right = raw.slice(1, -1);
  else if (!isNaN(Number(raw))) right = Number(raw);
  else right = raw;
  switch (m[2]) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">": return (left as number) > (right as number);
    case ">=": return (left as number) >= (right as number);
    case "<": return (left as number) < (right as number);
    case "<=": return (left as number) <= (right as number);
    default: return true;
  }
}

/**
 * Explain why a configured `extract` step couldn't run, so the runner can fail
 * loudly with an actionable reason instead of stamping the document `delivered`
 * with a null extraction. The step body only proceeds when
 * `schemaSlug && docText && endpoint` all hold and the schema version resolves;
 * this maps the first missing precondition to a human-readable message. The most
 * common cause in practice is `docText === ""` — a parse that produced no text
 * (an encrypted or image-only PDF the parse provider couldn't read).
 *
 * `parseError` carries the reason the parse *threw*, when it did. Without it
 * every parse failure reads as "the document produced no extractable text",
 * which describes the symptom and buries the cause: in oss-488 the real error
 * was Doc AI rejecting a 76-page PDF with PAGE_LIMIT_EXCEEDED, visible only in
 * the runtime logs while the trace page insisted the document was empty. An
 * error the operator can act on has to survive into the persisted step.
 */
export function extractSkipReason(
  schemaSlug: string,
  docText: string | undefined,
  endpoint: unknown,
  parseError?: string,
): string {
  if (!schemaSlug) return "Extract step has no schema configured.";
  if (!docText)
    return parseError
      ? `Extraction for "${schemaSlug}" could not run: parsing the document failed — ${parseError}`
      : `Extraction for "${schemaSlug}" could not run: the document produced no extractable text (parse returned empty).`;
  if (!endpoint)
    return `Extraction for "${schemaSlug}" could not run: no model endpoint is configured for this pipeline.`;
  return `Extraction for "${schemaSlug}" could not run: the schema version could not be resolved.`;
}

function resolveNextStep(edges: TestEdge[], output: Record<string, unknown>): string | null {
  const all = resolveNextSteps(edges, output);
  return all[0] ?? null;
}

function edgeMatches(e: TestEdge, output: Record<string, unknown>): boolean {
  if (e.condition) return evaluateCondition(e.condition, { output });
  if (e.when) return evalCondition(e.when, { output });
  return true; // unconditional
}

export function resolveNextSteps(edges: TestEdge[], output: Record<string, unknown>): string[] {
  const matched: string[] = [];
  for (const e of edges) {
    if (e.default) continue;
    if (!e.when && !e.condition) { matched.push(e.to); continue; } // unconditional
    const result = edgeMatches(e, output);
    console.log(`[dag-runner] edge ${e.from} → ${e.to} ${e.when ? `when="${e.when}"` : "(compiled condition)"} result=${result}`);
    if (result) matched.push(e.to);
  }
  console.log(`[dag-runner] resolveNextSteps: ${edges.length} edges, ${matched.length} matched: [${matched.join(", ")}]`);
  if (matched.length > 0) return matched;
  // Fall back to default edge
  const def = edges.find(e => e.default);
  return def ? [def.to] : [];
}

export async function handleDagRun(job: QueuedJob): Promise<void> {
  const db = _db!;
  const storage = _storage!;
  // Wall-clock start of the run. Used for the document's total duration.
  const runStart = Date.now();
  const { documentId, pipelineId, startStepId, inheritedOutputs, skipCache } = job.payload as {
    documentId: string;
    pipelineId: string;
    startStepId?: string | null;
    inheritedOutputs?: Record<string, Record<string, unknown>>;
    /** Force a fresh parse, bypassing + refreshing the parse cache (rerun --no-cache). */
    skipCache?: boolean;
  };
  const tenantId = job.tenantId;

  // Load document
  const [doc] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.documents.id,
      jobId: schema.documents.jobId,
      filename: schema.documents.filename,
      storageKey: schema.documents.storageKey,
      mimeType: schema.documents.mimeType,
      contentHash: schema.documents.contentHash,
      fileSize: schema.documents.fileSize,
      groupKey: schema.documents.groupKey,
    })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId))
    .limit(1),
  );
  if (!doc) throw new TerminalError(`Document ${documentId} not found`);

  // Mark document as processing
  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.documents)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(schema.documents.id, documentId)),
  );

  // Load pipeline YAML
  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      yamlSource: schema.pipelines.yamlSource,
      projectId: schema.pipelines.projectId,
      modelProviderId: schema.pipelines.modelProviderId,
      configJson: schema.pipelines.configJson,
      reviewThreshold: schema.pipelines.reviewThreshold,
      schemaId: schema.pipelines.schemaId,
    })
    .from(schema.pipelines)
    .where(eq(schema.pipelines.id, pipelineId))
    .limit(1),
  );
  if (!pipeline?.yamlSource) throw new TerminalError(`Pipeline ${pipelineId} has no YAML`);

  // Build the executable plan — compiled DAG when the YAML compiles, legacy
  // hand-parse otherwise. A pipeline that can't produce a runnable plan fails
  // the document instead of running a wrong interpretation.
  let plan: DagPlan;
  try {
    plan = buildDagPlan(pipeline.yamlSource);
  } catch (err) {
    const reason = `Pipeline is not runnable: ${(err as Error).message}`;
    await markDocFailed(db, tenantId, documentId, doc.jobId, reason);
    throw new TerminalError(reason);
  }
  console.log(`[dag-runner] plan source=${plan.source}: ${plan.steps.length} steps, ${plan.edges.length} edges, entry=${plan.entryStepId}`);
  const pSteps = plan.steps;
  const pEdges = plan.edges;

  // Parse the document + chunk
  let docText: string | undefined;
  /**
   * Why the parse threw, when it did. A failed parse is not fatal on its own —
   * classify and other steps still run off the raw bytes — so the error has to
   * be carried forward to whichever step actually needs the text, instead of
   * dying in a `console.error` (oss-488).
   */
  let parseError: string | undefined;
  let pageCount: number | undefined;
  let chunks: Chunk[] = [];
  // Parse-layer provenance carried into extraction so pipeline results get bbox
  // highlights like ingestion/build/validate (oss-310). Distinct from `chunks`
  // above, which is the DAG's markdown chunking persisted to documents.chunksJson.
  let parseTextMap: TextMap | undefined;
  let parseChunks: readonly ParseChunk[] | undefined;
  /**
   * The parse provider this run actually used, hoisted so downstream steps see
   * the same provider the parse did. The classify step used to reach past this
   * to the module-level default, which meant a pipeline could classify through
   * a different provider than it parsed with (oss-489).
   */
  let effectiveParseProvider: ParseProvider | null = _parseProvider;
  try {
    if (_parseProvider) {
      // Resolve the tenant's BYO parse provider — DAG pipelines must honor the
      // tenant's configured parse engine (and a pipeline-pinned override) the
      // same way the single-doc ingestion path does. Falls back to the default
      // provider when none is configured (dormant-until-configured).
      const { provider: parseProvider, fingerprint: parseFingerprint } = await resolveParse(
        db,
        { tenantId, projectId: pipeline.projectId },
        {
          parseProviderId: readParseProviderPin(pipeline.configJson),
          defaultProvider: _parseProvider,
          parseConfig: _parseConfig,
        },
      );
      effectiveParseProvider = parseProvider;
      // Provider-aware parse cache (oss-298): keyed under the resolved provider's
      // fingerprint, so switching/editing the parse provider re-parses instead of
      // serving a stale cache from a different provider. Shared with production
      // ingestion + build mode via the same seam (`parseDocument`), which also
      // shapes the flat text_map into the nested provenance form.
      const parseResult = await parseDocument({
        db,
        storage,
        tenantId,
        document: {
          id: doc.id,
          storageKey: doc.storageKey,
          filename: doc.filename,
          mimeType: doc.mimeType,
          contentHash: doc.contentHash,
        },
        provider: parseProvider,
        fingerprint: parseFingerprint,
        skipCache,
      });
      docText = parseResult.markdown;
      pageCount = parseResult.pages ?? undefined;
      parseTextMap = parseResult.textMap;
      parseChunks = parseResult.chunks;
      // Searchable PDFs are no longer written here — see process.ts.
      // Chunk the parsed markdown and persist
      chunks = chunkMarkdown(docText);
      await withRLS(db, tenantId, (tx) =>
        tx.update(schema.documents)
          .set({ chunksJson: chunks, pageCount })
          .where(eq(schema.documents.id, documentId)),
      );
    }
  } catch (err) {
    parseError = (err as Error).message;
    console.error(`[dag-runner] Parse failed for ${doc.filename}:`, parseError);
  }

  // Resolve model endpoint
  const endpoint = await resolveExtractEndpoint(db, { tenantId, projectId: pipeline.projectId }, pipeline.modelProviderId);

  // Walk the DAG — start from startStepId (split child resume) or the plan's entry step
  let currentId: string | null = startStepId ? startStepId : plan.entryStepId;
  const stepOutputs: Record<string, Record<string, unknown>> = { ...(inheritedOutputs ?? {}) };
  let stepOrder = 0;
  let totalCost = 0;
  let finalExtraction: Record<string, unknown> | null = null;
  let finalConfidence: number | null = null;
  // Full engine result + schema of the LAST extract step — the outcome module
  // needs confidence_scores/provenance/fit and the schema for review routing.
  let finalResult: OutcomeExtraction | null = null;
  // A step that throws aborts the walk. Without this, the run fell out of the
  // loop with no extraction and the tail marked the document `delivered` — a
  // failed classify looked like a clean pass.
  let failedStep: { id: string; error: string } | null = null;
  let finalSchemaDef: Record<string, unknown> | undefined;
  let finalSchemaId: string | null = null;
  // The router picks the schema per document at extract time, so the document
  // row starts with both of these null (it inherits the pipeline's, and a
  // router pipeline has none). Carry the resolved pair to persistDocumentOutcome
  // so the finished document records what it was actually extracted with.
  let finalSchemaVersionId: string | null = null;

  while (currentId && stepOrder < plan.maxSteps) {
    const step = pSteps.find(s => s.id === currentId);
    if (!step) break;
    stepOrder++;

    const stepStart = Date.now();
    let output: Record<string, unknown> = {};
    let status = "completed";
    let error: string | undefined;
    const cost = stepCost(step.type);

    try {
      switch (step.type) {
        case "classify": {
          // A `classifier: <slug>` reference runs the registered classifier
          // through the SAME cascade as `koji classify run` / POST /api/classify
          // — no divergence between how a doc is classified standalone and how
          // the pipeline routes it. Inline `labels` remain the fallback.
          const classifierSlug = step.config.classifier as string | undefined;
          if (classifierSlug) {
            const scope = { tenantId, projectId: pipeline.projectId };
            const pin = (step.config.classifier_version as string | undefined) || undefined;
            const resolved = await resolveClassifierConfig(db, scope, classifierSlug, pin);
            if ("error" in resolved) {
              const reasoning =
                resolved.error === "no_version"
                  ? `Classifier '${classifierSlug}' has no version matching '${resolved.requested}'`
                  : `Classifier '${classifierSlug}' has no released version in this project`;
              output = { label: "unknown", confidence: 0, method: resolved.error, reasoning, classifier: classifierSlug };
              break;
            }
            const file = _storage ? await _storage.getBuffer(doc.storageKey) : null;
            if (!file) {
              output = {
                label: "unknown",
                confidence: 0,
                method: "no_file",
                reasoning: "Document bytes unavailable for classification",
                classifier: classifierSlug,
              };
              break;
            }
            const outcome = await classifyWithConfig(
              db,
              scope,
              { filename: doc.filename, mimeType: doc.mimeType, fileBuffer: file.data, text: docText ?? undefined },
              resolved.config,
              effectiveParseProvider ?? undefined,
            );
            output = {
              label: outcome.label,
              confidence: outcome.confidence,
              method: outcome.method,
              tier: outcome.tierUsed,
              evidence_page: outcome.evidencePage,
              classifier: classifierSlug,
              classifier_version: resolved.version,
              // Present only on an `unknown`: which tiers couldn't run and why.
              // Without it a default-routed document looks identical whether the
              // classifier read it and couldn't tell or never got to look.
              ...(outcome.reason ? { reasoning: outcome.reason } : {}),
            };
            break;
          }

          const labels = (step.config.labels as Array<{ id: string; description?: string; keywords?: string[] }>) || [];
          const method = (step.config.method as string) || "keyword_then_llm";
          const question = (step.config.question as string) || "What type of document is this?";
          const text = (docText || doc.filename).toLowerCase();

          // Keyword classification
          let classified = false;
          if (method !== "llm") {
            for (const label of labels) {
              if (!label.keywords?.length) continue;
              const hits = label.keywords.filter(kw => text.includes(kw.toLowerCase()));
              if (hits.length >= 2) {
                output = { label: label.id, confidence: 1.0, method: "keyword", reasoning: `Matched: ${hits.join(", ")}` };
                classified = true;
                break;
              }
            }
          }

          // LLM classification
          if (!classified && method !== "keyword" && endpoint) {
            const provider = createProvider(endpoint.model, endpoint);
            const labelDesc = labels.map(l => `- "${l.id}"${l.description ? `: ${l.description}` : ""}`).join("\n");
            const prompt = `${question}\n\nClassify into one category:\n${labelDesc}\n\nText:\n${(docText || doc.filename).slice(0, 3000)}\n\nRespond JSON only: {"label":"<id>","confidence":<0-1>,"reasoning":"<why>"}`;
            const raw = await provider.generate(prompt, true);
            try {
              const p = JSON.parse(raw);
              output = { label: p.label, confidence: p.confidence ?? 0.8, method: "llm", reasoning: p.reasoning };
            } catch {
              output = { label: labels[0]?.id || "unknown", confidence: 0.5, method: "llm", reasoning: "Failed to parse LLM response" };
            }
          } else if (!classified) {
            output = { label: labels[labels.length - 1]?.id || "unknown", confidence: 0.5, method: method === "keyword" ? "keyword" : "no_endpoint" };
          }
          break;
        }

        case "extract": {
          const schemaSlug = (step.config.schema as string) || "";
          if (schemaSlug && docText && endpoint) {
            // Resolve the schema version honoring the pipeline's versionMode
            // (auto = current live release; pinned = the pinned version).
            const ver = await resolvePipelineSchemaVersion(db, tenantId, pipelineId, schemaSlug);
            if (ver?.parsedJson) {
              const provider = createProvider(endpoint.model, endpoint);
              const result = await extractFields(docText, ver.parsedJson, provider, endpoint.model, parseTextMap, parseChunks);
              const fieldNames = Object.keys(result.extracted || {});
              const nonNull = fieldNames.filter(f => result.extracted[f] != null);
              const scores = Object.values(result.confidence_scores || {});
              const avgConf = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
              output = { schema: schemaSlug, fields: result.extracted, fieldCount: nonNull.length, totalFields: fieldNames.length, confidence: avgConf };
              finalExtraction = result.extracted;
              finalConfidence = avgConf;
              finalResult = result as OutcomeExtraction;
              finalSchemaDef = ver.parsedJson;
              finalSchemaId = ver.schemaId;
              finalSchemaVersionId = ver.versionId;
            }
          }
          if (!output.schema) {
            // Extraction was configured but couldn't run. Diagnose why so the
            // failure is actionable instead of a silent blank delivery — the
            // most common cause is a parse that produced no text (an encrypted
            // or image-only PDF the parse provider couldn't read).
            const reason = extractSkipReason(schemaSlug, docText, endpoint, parseError);
            output = { schema: schemaSlug, fields: {}, fieldCount: 0, totalFields: 0, note: reason };
            // A configured extract that can't run is a hard failure, not a
            // `delivered` blank — mark the step failed so the document is failed
            // loudly (markDocFailed) rather than stamped delivered with null
            // extraction. A schema-less extract step is a no-op, left as a note.
            if (schemaSlug) { status = "failed"; error = reason; }
          }
          break;
        }

        case "tag":
          output = { tags: (step.config.tags as Record<string, string>) || {} };
          break;

        case "filter": {
          const passed = evalCondition((step.config.condition as string) || "true", { document: doc, steps: stepOutputs });
          output = { passed };
          if (!passed && step.config.on_fail === "fail") { status = "failed"; error = "Filter blocked"; }
          break;
        }

        case "webhook": {
          const webhookUrl = step.config.url as string;
          if (webhookUrl) {
            const method = ((step.config.method as string) || "POST").toUpperCase();
            let customHeaders = (step.config.headers as Record<string, string>) || {};

            // Decrypt encrypted headers from pipeline configJson
            const masterKey = getMasterKey();
            if (masterKey) {
              const [pipelineCfg] = await withRLS(db, tenantId, (tx) =>
                tx.select({ configJson: schema.pipelines.configJson })
                  .from(schema.pipelines)
                  .where(eq(schema.pipelines.id, pipelineId))
                  .limit(1),
              );
              const cfg = pipelineCfg?.configJson as Record<string, unknown> | null;
              const encHeaders = (cfg?.encryptedHeaders as Record<string, Record<string, string>> | undefined)?.[step.id];
              if (encHeaders) {
                const decrypted: Record<string, string> = {};
                for (const [key, blob] of Object.entries(encHeaders)) {
                  try { decrypted[key] = decrypt(blob, masterKey, tenantId); } catch { /* skip if decrypt fails */ }
                }
                customHeaders = { ...customHeaders, ...decrypted };
              }
            }
            const payloadMode = (step.config.payload as string) || "result";

            // Build payload based on mode
            let payload: Record<string, unknown>;
            if (payloadMode === "document") {
              payload = { document_id: documentId, filename: doc.filename, mime_type: doc.mimeType };
            } else if (payloadMode === "metadata") {
              payload = { document_id: documentId, tenant_id: tenantId, step_outputs: stepOutputs };
            } else {
              // "result" — extraction + document info
              const extractOutput = Object.values(stepOutputs).reverse().find(o => o?.fields);
              payload = {
                document_id: documentId,
                tenant_id: tenantId,
                extraction: extractOutput || {},
                document: { filename: doc.filename, mime_type: doc.mimeType, page_count: pageCount },
              };
            }

            try {
              const resp = await fetch(webhookUrl, {
                method,
                headers: { "Content-Type": "application/json", ...customHeaders },
                body: JSON.stringify(payload),
              });
              output = { status_code: resp.status, delivered: resp.ok };
            } catch (err) {
              output = { status_code: 0, delivered: false, error: (err as Error).message };
            }
          } else {
            output = { skipped: true, reason: "No URL configured" };
          }
          break;
        }

        case "transform": {
          const ops = (step.config.operations as Array<Record<string, unknown>>) || [];
          let fields: Record<string, unknown> = {};
          for (const so of Object.values(stepOutputs)) {
            if (so?.fields && typeof so.fields === "object") {
              fields = { ...fields, ...(so.fields as Record<string, unknown>) };
            }
          }
          const applied: string[] = [];
          for (const op of ops) {
            if (op.rename && typeof op.rename === "object") {
              const { from: f, to: t } = op.rename as { from: string; to: string };
              if (f in fields) { fields[t] = fields[f]; delete fields[f]; applied.push(`rename: ${f} → ${t}`); }
            } else if (op.set && typeof op.set === "object") {
              const { field: f, value: v } = op.set as { field: string; value: unknown };
              fields[f] = typeof v === "string" ? v.replace("{{now}}", new Date().toISOString()) : v;
              applied.push(`set: ${f}`);
            } else if (op.remove && typeof op.remove === "object") {
              const { field: f } = op.remove as { field: string };
              delete fields[f]; applied.push(`remove: ${f}`);
            }
          }
          output = { fields, operations_applied: applied };
          break;
        }

        case "resolve_references": {
          output = await resolveReferences({
            db,
            tenantId,
            filename: doc.filename,
            chunks,
            groupKey: doc.groupKey as string | null,
            excludeDocumentId: documentId,
            extraction: finalExtraction,
            endpoint,
          });

          // The one thing test mode does not do: persist on the document row.
          await withRLS(db, tenantId, (tx) =>
            tx.update(schema.documents)
              .set({ referencesJson: output })
              .where(eq(schema.documents.id, documentId)),
          );
          break;
        }

        case "split": {
          // Pre-resolve next steps so executeSplit can tell children where to resume
          const splitOutEdges = pEdges.filter(e => e.from === step.id);
          const splitNextIds = splitOutEdges.filter(e => !e.when && !e.condition && !e.default).map(e => e.to);
          // If all edges are conditional, include them all — children will evaluate conditions
          const resumeIds = splitNextIds.length > 0 ? splitNextIds : splitOutEdges.map(e => e.to);
          output = await executeSplit(step, doc, documentId, pipelineId, tenantId, stepOutputs, db, storage, endpoint, resumeIds);
          break;
        }

        default:
          output = { note: `Step type "${step.type}" executed` };
      }
    } catch (err) {
      status = "failed";
      error = (err as Error).message;
    }

    const durationMs = Date.now() - stepStart;
    totalCost += cost;

    // Persist step run. Upsert, not insert: `pipeline_step_runs` is UNIQUE on
    // (document_id, step_id), and a retry re-walks the DAG from the entry step,
    // so a plain insert throws on every step the previous attempt already
    // recorded. That made retries a guaranteed failure — the attempt counter
    // burned down to max_retries and the document was stranded mid-run
    // (oss-493). The latest attempt's result wins.
    await withRLS(db, tenantId, (tx) =>
      tx.insert(schema.pipelineStepRuns).values({
        tenantId,
        documentId,
        jobId: doc.jobId,
        stepId: step.id,
        stepType: step.type,
        stepOrder,
        status,
        outputJson: output,
        errorMessage: error,
        durationMs,
        costUsd: String(cost),
        startedAt: new Date(Date.now() - durationMs),
        completedAt: new Date(),
      }).onConflictDoUpdate({
        target: [schema.pipelineStepRuns.documentId, schema.pipelineStepRuns.stepId],
        set: {
          jobId: doc.jobId,
          stepType: step.type,
          stepOrder,
          status,
          outputJson: output,
          // `?? null` matters: Drizzle omits `undefined` from the SET clause, so a
          // step that failed on attempt 1 and succeeded on attempt 2 would keep the
          // stale error text next to a `completed` status.
          errorMessage: error ?? null,
          durationMs,
          costUsd: String(cost),
          startedAt: new Date(Date.now() - durationMs),
          completedAt: new Date(),
        },
      }),
    );

    stepOutputs[step.id] = output;
    if (status === "failed") {
      failedStep = { id: step.id, error: error ?? "unknown error" };
      break;
    }

    // After a split with fan-out, stop processing the parent — children continue independently
    if (step.type === "split" && output.fan_out) {
      console.log(`[dag-runner] split fan-out: parent ${documentId} done, ${(output.child_document_ids as string[])?.length ?? 0} children queued`);
      break;
    }

    // Resolve next step(s) — may be multiple for parallel fan-out
    const outEdges = pEdges.filter(e => e.from === step.id);
    const nextSteps = resolveNextSteps(outEdges, output);

    if (nextSteps.length > 1) {
      // Parallel fan-out: run each branch independently
      for (const branchStartId of nextSteps) {
        let branchId: string | null = branchStartId;
        while (branchId && stepOrder < plan.maxSteps) {
          const branchStep = pSteps.find(s => s.id === branchId);
          if (!branchStep) break;
          stepOrder++;

          const branchStart = Date.now();
          let branchOutput: Record<string, unknown> = {};
          let branchStatus = "completed";
          let branchError: string | undefined;
          const branchCost = stepCost(branchStep.type);

          try {
            // Re-use the same step execution switch logic
            // For simplicity, delegate to a helper or inline the common cases
            switch (branchStep.type) {
              case "extract": {
                const schemaSlug = (branchStep.config.schema as string) || "";
                if (schemaSlug && docText && endpoint) {
                  // Resolve honoring the pipeline's versionMode (auto/pinned).
                  const ver = await resolvePipelineSchemaVersion(db, tenantId, pipelineId, schemaSlug);
                  if (ver?.parsedJson) {
                    const provider = createProvider(endpoint.model, endpoint);
                    const result = await extractFields(docText, ver.parsedJson, provider, endpoint.model, parseTextMap, parseChunks);
                    const fieldNames = Object.keys(result.extracted || {});
                    const nonNull = fieldNames.filter(f => result.extracted[f] != null);
                    const scores = Object.values(result.confidence_scores || {});
                    const avgConf = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
                    branchOutput = { schema: schemaSlug, fields: result.extracted, fieldCount: nonNull.length, totalFields: fieldNames.length, confidence: avgConf };
                    finalExtraction = result.extracted;
                    finalConfidence = avgConf;
                    finalResult = result as OutcomeExtraction;
                    finalSchemaDef = ver.parsedJson;
                    finalSchemaId = ver.schemaId;
                    finalSchemaVersionId = ver.versionId;
                  }
                }
                if (!branchOutput.schema) {
                  // Mirror the linear extract path: diagnose and hard-fail a
                  // configured-but-unrunnable extraction instead of silently
                  // delivering a blank (see extractSkipReason).
                  const reason = extractSkipReason(schemaSlug, docText, endpoint, parseError);
                  branchOutput = { schema: schemaSlug, fields: {}, fieldCount: 0, totalFields: 0, note: reason };
                  if (schemaSlug) { branchStatus = "failed"; branchError = reason; }
                }
                break;
              }
              case "tag":
                branchOutput = { tags: (branchStep.config.tags as Record<string, string>) || {} };
                break;
              case "webhook": {
                const webhookUrl = branchStep.config.url as string;
                if (webhookUrl) {
                  const payloadMode = (branchStep.config.payload as string) || "result";
                  const extractOutput = Object.values(stepOutputs).reverse().find(o => o?.fields);
                  const payload = payloadMode === "document"
                    ? { document_id: documentId, filename: doc.filename }
                    : { document_id: documentId, tenant_id: tenantId, extraction: extractOutput || {} };
                  try {
                    const resp = await fetch(webhookUrl, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(payload),
                    });
                    branchOutput = { status_code: resp.status, delivered: resp.ok };
                  } catch (err) {
                    branchOutput = { status_code: 0, delivered: false, error: (err as Error).message };
                  }
                }
                break;
              }
              case "filter": {
                const passed = evalCondition((branchStep.config.condition as string) || "true", { document: doc, steps: stepOutputs });
                branchOutput = { passed };
                if (!passed && branchStep.config.on_fail === "fail") { branchStatus = "failed"; branchError = "Filter blocked"; }
                break;
              }
              case "split": {
                const branchSplitEdges = pEdges.filter(e => e.from === branchStep.id);
                const branchResumeIds = branchSplitEdges.map(e => e.to);
                branchOutput = await executeSplit(branchStep, doc, documentId, pipelineId, tenantId, stepOutputs, db, storage, endpoint, branchResumeIds);
                break;
              }
              default:
                branchOutput = { note: `Step type "${branchStep.type}" executed (branch)` };
            }
          } catch (err) {
            branchStatus = "failed";
            branchError = (err as Error).message;
          }

          const branchDurationMs = Date.now() - branchStart;
          totalCost += branchCost;

          // Upsert for the same reason as the sequential path above (oss-493).
          await withRLS(db, tenantId, (tx) =>
            tx.insert(schema.pipelineStepRuns).values({
              tenantId,
              documentId,
              jobId: doc.jobId,
              stepId: branchStep.id,
              stepType: branchStep.type,
              stepOrder,
              status: branchStatus,
              outputJson: branchOutput,
              errorMessage: branchError,
              durationMs: branchDurationMs,
              costUsd: String(branchCost),
              startedAt: new Date(Date.now() - branchDurationMs),
              completedAt: new Date(),
            }).onConflictDoUpdate({
              target: [schema.pipelineStepRuns.documentId, schema.pipelineStepRuns.stepId],
              set: {
                jobId: doc.jobId,
                stepType: branchStep.type,
                stepOrder,
                status: branchStatus,
                outputJson: branchOutput,
                // See the sequential path — `undefined` would be dropped from SET.
                errorMessage: branchError ?? null,
                durationMs: branchDurationMs,
                costUsd: String(branchCost),
                startedAt: new Date(Date.now() - branchDurationMs),
                completedAt: new Date(),
              },
            }),
          );

          stepOutputs[branchStep.id] = branchOutput;
          if (branchStatus === "failed") {
            failedStep ??= { id: branchStep.id, error: branchError ?? "unknown error" };
            break;
          }

          const branchOutEdges = pEdges.filter(e => e.from === branchStep.id);
          branchId = resolveNextStep(branchOutEdges, branchOutput);
        }
      }
      currentId = null; // all branches done
    } else {
      currentId = nextSteps[0] ?? null;
    }
  }

  // ── Finalize (entrypoint parity, oss-359) ────────────────────────────────
  // A DAG document that ends on an extract step gets the SAME post-extraction
  // contract as a simple-pipeline document: engine per-field confidence scores
  // persisted, low-confidence routing to the review queue, provenance/fit JSON,
  // job counters, and the document.review_requested / document.delivered
  // webhook + notification. Previously the DAG path wrote only extractionJson
  // plus a naive average confidence and marked everything `delivered`, so DAG
  // documents silently bypassed HITL review.
  const lastOutput = stepOutputs[Object.keys(stepOutputs).pop() ?? ""];
  const wasSplit = lastOutput?.fan_out === true;
  const runDurationMs = Date.now() - runStart;

  // A step threw. The document has no trustworthy outcome — fail it loudly
  // rather than letting the tail below stamp it `delivered`.
  if (failedStep) {
    await markDocFailed(
      db,
      tenantId,
      documentId,
      doc.jobId,
      `Step "${failedStep.id}" failed: ${failedStep.error}`,
    );
    return;
  }

  if (!wasSplit && finalResult) {
    const [jobRow] = await withRLS(db, tenantId, (tx) =>
      tx.select({ id: schema.jobs.id, slug: schema.jobs.slug }).from(schema.jobs)
        .where(eq(schema.jobs.id, doc.jobId)).limit(1),
    );
    const outcome = decideDocumentOutcome({
      schemaDef: finalSchemaDef,
      extractResult: finalResult,
      reviewThreshold: pipeline.reviewThreshold,
    });
    const outcomeSchemaId = finalSchemaId ?? pipeline.schemaId ?? null;
    const prepared = await persistDocumentOutcome({
      db,
      tenantId,
      documentId,
      jobId: doc.jobId,
      jobSlug: jobRow?.slug ?? "",
      pipelineId,
      schemaId: outcomeSchemaId,
      schemaVersionId: finalSchemaVersionId,
      threshold: Number(pipeline.reviewThreshold),
      outcome,
      extractResult: finalResult,
      durationMs: runDurationMs,
      extraDocUpdates: { pageCount, costUsd: String(totalCost) },
    });
    // No trace-stage ordering to respect on this path — enqueue immediately.
    if (prepared) {
      await enqueueWebhookDeliveries(tenantId, prepared, { documentId });
    }

    // Same billing contract as the simple-pipeline path: a DAG document that
    // reaches delivered/review is billable exactly once.
    //
    // Mirror the state persistDocumentOutcome actually wrote: a below-threshold
    // document with no schema to file a review item under is *delivered*, not
    // review-routed. Disposition is `billable` either way, so this only keeps
    // the audit column honest.
    await recordDeliveryBillableEvent(tenantId, {
      documentId,
      jobId: doc.jobId,
      pipelineId,
      routeToReview: outcome.routeToReview && outcomeSchemaId !== null,
    });
    return;
  }

  // Split fan-outs and non-extract terminal steps (tag/webhook/filter) keep the
  // original minimal bookkeeping — there is no extraction outcome to score.
  const updates: Record<string, unknown> = {
    status: wasSplit ? "split" : "delivered",
    completedAt: new Date(),
    pageCount,
    costUsd: String(totalCost),
    durationMs: runDurationMs,
  };
  if (finalExtraction) {
    updates.extractionJson = finalExtraction;
    updates.confidence = String(finalConfidence ?? 0);
  }


  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.documents).set(updates).where(eq(schema.documents.id, documentId)),
  );

  // Update job stats
  const [jobRow] = await withRLS(db, tenantId, (tx) =>
    tx.select({ jobId: schema.documents.jobId }).from(schema.documents)
      .where(eq(schema.documents.id, documentId)).limit(1),
  );
  if (jobRow?.jobId) {
    // A rerun used to increment these again, so the counters drifted above the
    // number of documents that exist. Recomputing also handles the split
    // parent correctly: it counts as processed but has no outcome of its own,
    // since its children each carry theirs (oss-495).
    await withRLS(db, tenantId, (tx) =>
      tx.update(schema.jobs).set({
        status: "complete",
        ...jobCounterRecompute(jobRow.jobId),
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.jobs.id, jobRow.jobId)),
    );
  }

  // A split parent is deliberately NOT billed: it fans out into child
  // documents that each run the pipeline and bill themselves, so charging the
  // parent too would double-bill the same pages. Everything else that lands
  // here really did terminate as `delivered` and is billable.
  if (!wasSplit) {
    await recordDeliveryBillableEvent(tenantId, {
      documentId,
      jobId: doc.jobId,
      pipelineId,
      routeToReview: false,
    });
  }
}
