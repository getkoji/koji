/**
 * Corpus pool upsert — find or create the `corpus_documents` row for a file.
 *
 * The corpus pool split (oss-449) made `corpus_entries.documentId` NOT NULL: a
 * label points at a pooled document rather than carrying the file inline. Every
 * corpus-entry write therefore first resolves the file to a pool document, one
 * per `(projectId, contentHash)`. This is that resolution, shared by every
 * write site (schema upload, review promotion, CLI upload) so they agree on the
 * dedup key and the canonical-file rule.
 *
 * During the expand/contract window the entry rows still carry the legacy file
 * columns too (writers populate both), so no read path changes yet. This only
 * adds the pool row + returns its id for `documentId`.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, withRLS, type Db, type RlsScope } from "@koji/db";

export interface CorpusDocumentInput {
  tenantId: string;
  projectId: string;
  filename: string;
  storageKey: string;
  fileSize: number;
  mimeType: string;
  contentHash: string;
  source: string;
  sourceRef?: string | null;
  addedBy: string;
}

/**
 * Return the id of the live pool document for this `(projectId, contentHash)`,
 * creating it if absent. Idempotent under the
 * `corpus_documents_project_content_idx` partial unique: a race that inserts a
 * duplicate is caught and the existing row returned, so concurrent uploads of
 * the same bytes converge on one document.
 *
 * `scope` must be project-scoped — the RESTRICTIVE policy requires it for the
 * insert's WITH CHECK, and the dedup must not span projects.
 */
export async function upsertCorpusDocument(
  db: Db,
  scope: RlsScope,
  input: CorpusDocumentInput,
): Promise<string> {
  const found = await withRLS(db, scope, (tx) =>
    tx
      .select({ id: schema.corpusDocuments.id })
      .from(schema.corpusDocuments)
      .where(
        and(
          eq(schema.corpusDocuments.projectId, input.projectId),
          eq(schema.corpusDocuments.contentHash, input.contentHash),
          isNull(schema.corpusDocuments.deletedAt),
        ),
      )
      .limit(1),
  );
  if (found[0]) return found[0].id;

  try {
    const inserted = await withRLS(db, scope, (tx) =>
      tx
        .insert(schema.corpusDocuments)
        .values({
          tenantId: input.tenantId,
          projectId: input.projectId,
          filename: input.filename,
          storageKey: input.storageKey,
          fileSize: input.fileSize,
          mimeType: input.mimeType,
          contentHash: input.contentHash,
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          addedBy: input.addedBy,
        })
        .returning({ id: schema.corpusDocuments.id }),
    );
    return inserted[0]!.id;
  } catch (err) {
    // Lost a race on the partial unique — read the winner back.
    const raced = await withRLS(db, scope, (tx) =>
      tx
        .select({ id: schema.corpusDocuments.id })
        .from(schema.corpusDocuments)
        .where(
          and(
            eq(schema.corpusDocuments.projectId, input.projectId),
            eq(schema.corpusDocuments.contentHash, input.contentHash),
            isNull(schema.corpusDocuments.deletedAt),
          ),
        )
        .limit(1),
    );
    if (raced[0]) return raced[0].id;
    throw err;
  }
}
