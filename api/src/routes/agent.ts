/**
 * Agent routes — agentic schema builder.
 *
 * POST /:slug/agent — send a message, get updated YAML + explanation
 * GET  /:slug/agent/history — paginated conversation history
 * DELETE /:slug/agent/history — clear conversation
 */

import { Hono } from "hono";
import { eq, and, desc, lt } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { createProvider } from "../extract/providers";
import { resolveExtractEndpoint } from "../extract/resolve-endpoint";
import { extractKVPairs } from "../extract/kv-pairs";
import { classifyDocType, getTemplate } from "../extract/schema-templates";
import { buildAgentPrompt, parseAgentResponse, type AgentMessage } from "../extract/agent-prompt";
import { compileSchema } from "../schemas/compiler";

export const agentRouter = new Hono<Env>();

// ---------------------------------------------------------------------------
// POST /:slug/agent — send a message to the schema builder agent
// ---------------------------------------------------------------------------

agentRouter.post("/:slug/agent", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);

  const body = await c.req.json<{
    message: string;
    yaml: string;
    corpus_entry_id?: string;
  }>();

  if (!body.message) return c.json({ error: "message is required" }, 400);

  const slug = c.req.param("slug")!;

  // 1. Verify schema exists
  const [schemaRow] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1),
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  // 2. Find or create agent session
  let [session] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.agentSessions.id, status: schema.agentSessions.status })
      .from(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.context, "schema_builder"),
        eq(schema.agentSessions.contextEntityId, schemaRow.id),
        eq(schema.agentSessions.userId, principal.userId),
      ))
      .limit(1),
  );
  if (!session) {
    const [created] = await withRLS(db, tenantId, (tx) =>
      tx.insert(schema.agentSessions).values({
        tenantId,
        userId: principal.userId,
        context: "schema_builder",
        contextEntityId: schemaRow.id,
      }).returning({ id: schema.agentSessions.id, status: schema.agentSessions.status }),
    );
    session = created!;
  }

  // 3. Load conversation history (last 12 messages = 6 turns)
  const dbMessages = await withRLS(db, tenantId, (tx) =>
    tx.select({
      role: schema.agentMessages.role,
      content: schema.agentMessages.content,
    })
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.sessionId, session.id))
      .orderBy(desc(schema.agentMessages.createdAt))
      .limit(12),
  );
  const history: AgentMessage[] = dbMessages
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // 4. Load document context
  let markdown = "";
  if (body.corpus_entry_id) {
    // Try extraction_runs first (has stored markdown)
    const [run] = await withRLS(db, tenantId, (tx) =>
      tx.select({ markdownText: schema.extractionRuns.markdownText })
        .from(schema.extractionRuns)
        .where(eq(schema.extractionRuns.corpusEntryId, body.corpus_entry_id!))
        .orderBy(desc(schema.extractionRuns.createdAt))
        .limit(1),
    );
    markdown = run?.markdownText ?? "";
  }

  const markdownHead = markdown.slice(0, 2000);
  const kvPairs = markdown ? extractKVPairs(markdown).slice(0, 40) : [];

  // 5. Classify doc type on first turn
  const isFirstTurn = history.length === 0;
  let docType: string | undefined;
  let proposedYaml = body.yaml;

  if (isFirstTurn && markdown) {
    docType = classifyDocType(kvPairs, markdownHead);
    // If current YAML looks like a default/empty schema, propose template
    if (!body.yaml.trim() || body.yaml.includes("example_field") || body.yaml.trim().length < 50) {
      proposedYaml = getTemplate(docType as any);
    }
  }

  // 6. Resolve model endpoint
  let endpointPayload = null;
  try {
    const [ep] = await withRLS(db, tenantId, (tx) =>
      tx.select({ id: schema.modelEndpoints.id })
        .from(schema.modelEndpoints)
        .where(eq(schema.modelEndpoints.status, "active"))
        .limit(1),
    );
    if (ep) endpointPayload = await resolveExtractEndpoint(db, tenantId, ep.id);
  } catch {}

  const modelStr = endpointPayload?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
  const provider = createProvider(modelStr, endpointPayload);

  // 7. Build prompt and call LLM
  const prompt = buildAgentPrompt(
    history,
    body.message,
    proposedYaml,
    { markdown_head: markdownHead, kv_pairs: kvPairs, doc_type: docType },
  );

  let rawResponse: string;
  try {
    rawResponse = await provider.generate(prompt, false);
  } catch (err) {
    return c.json({ error: `Model error: ${err instanceof Error ? err.message : "Unknown"}` }, 502);
  }

  // 8. Parse response
  let parsed = parseAgentResponse(rawResponse);

  // 9. Validate YAML with compiler — retry once if invalid
  if (parsed.yaml) {
    try {
      compileSchema(parsed.yaml);
    } catch (compileErr) {
      // Feed error back to LLM for a single retry
      const retryPrompt = buildAgentPrompt(
        [...history, { role: "user", content: body.message }, { role: "assistant", content: rawResponse }],
        `Your schema had validation errors: ${compileErr instanceof Error ? compileErr.message : String(compileErr)}. Please fix the YAML and return a corrected version.`,
        parsed.yaml,
        { markdown_head: markdownHead, kv_pairs: kvPairs, doc_type: docType },
      );
      try {
        const retryResponse = await provider.generate(retryPrompt, false);
        const retryParsed = parseAgentResponse(retryResponse);
        if (retryParsed.yaml) {
          parsed = retryParsed;
          rawResponse = retryResponse;
        }
      } catch {
        // Retry failed — return original with error note
      }
    }
  }

  const finalYaml = parsed.yaml ?? proposedYaml;

  // 10. Persist messages sequentially (so created_at ordering is deterministic)
  try {
    await withRLS(db, tenantId, (tx) =>
      tx.insert(schema.agentMessages).values({ tenantId, sessionId: session.id, role: "user", content: body.message }),
    );
    await withRLS(db, tenantId, (tx) =>
      tx.insert(schema.agentMessages).values({ tenantId, sessionId: session.id, role: "assistant", content: rawResponse }),
    );
    // Update session timestamp
    await withRLS(db, tenantId, (tx) =>
      tx.update(schema.agentSessions)
        .set({ updatedAt: new Date() })
        .where(eq(schema.agentSessions.id, session.id)),
    );
  } catch (err) {
    console.warn("[agent] Failed to persist messages:", err);
  }

  return c.json({
    yaml: finalYaml,
    explanation: parsed.explanation,
    doc_type: parsed.doc_type ?? docType ?? null,
  });
});

// ---------------------------------------------------------------------------
// GET /:slug/agent/history — paginated conversation history
// ---------------------------------------------------------------------------

agentRouter.get("/:slug/agent/history", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const slug = c.req.param("slug")!;

  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const cursor = c.req.query("cursor"); // ISO timestamp

  // Find schema
  const [schemaRow] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1),
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  // Find session
  const [session] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.context, "schema_builder"),
        eq(schema.agentSessions.contextEntityId, schemaRow.id),
        eq(schema.agentSessions.userId, principal.userId),
      ))
      .limit(1),
  );
  if (!session) return c.json({ messages: [], has_more: false });

  // Query messages
  const conditions = [eq(schema.agentMessages.sessionId, session.id)];
  if (cursor) {
    conditions.push(lt(schema.agentMessages.createdAt, new Date(cursor)));
  }

  const messages = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.agentMessages.id,
      role: schema.agentMessages.role,
      content: schema.agentMessages.content,
      createdAt: schema.agentMessages.createdAt,
    })
      .from(schema.agentMessages)
      .where(and(...conditions))
      .orderBy(desc(schema.agentMessages.createdAt))
      .limit(limit + 1),
  );

  const hasMore = messages.length > limit;
  const page = messages.slice(0, limit).reverse(); // oldest first for display

  return c.json({
    messages: page.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.createdAt,
    })),
    has_more: hasMore,
    next_cursor: hasMore ? messages[limit]?.createdAt?.toISOString() : null,
  });
});

// ---------------------------------------------------------------------------
// DELETE /:slug/agent/history — clear conversation
// ---------------------------------------------------------------------------

agentRouter.delete("/:slug/agent/history", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const slug = c.req.param("slug")!;

  const [schemaRow] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1),
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  // Delete session (cascade deletes messages)
  await withRLS(db, tenantId, (tx) =>
    tx.delete(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.context, "schema_builder"),
        eq(schema.agentSessions.contextEntityId, schemaRow.id),
        eq(schema.agentSessions.userId, principal.userId),
      )),
  );

  return c.json({ ok: true });
});
