/**
 * `resolve_references` — the shared implementation behind the pipeline step.
 *
 * Both the production DAG runner and the pipeline **test** endpoint call this.
 * They used to carry separate implementations, and they diverged: test mode ran
 * only the regex scan, stamped every hit `resolved: false`, and never emitted
 * the `contradictions` key production always emits — so clicking "Test" showed
 * zero resolutions and zero contradictions no matter what the group contained,
 * while still billing for an LLM call it never made (oss-515).
 *
 * The only difference test mode is allowed is persistence: this function never
 * writes, and the DAG runner stores the result on the document row afterwards.
 */

import { and, eq, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import { createProvider } from "../extract/providers";
import type { ExtractEndpointPayload } from "../extract/resolve-endpoint";

/**
 * The only chunk fields reference resolution reads. Deliberately narrower than
 * `Chunk` so the test endpoint's lighter chunk shape satisfies it too — both
 * callers then run identical code rather than one of them reconstructing chunks.
 */
export interface ReferenceChunk {
  index: number;
  title: string;
  content: string;
}

/**
 * Connective words the reference patterns match, plus generic English function
 * words. This is grammar, not vocabulary — nothing here names a kind of
 * document, so reference matching stays industry-agnostic.
 */
const REFERENCE_STOPWORDS = new Set([
  "see", "refer", "referred", "per", "pursuant", "accordance", "defined",
  "described", "set", "forth", "the", "this", "that", "these", "those", "and",
  "for", "with", "from", "into", "under", "above", "below", "such", "any",
  "all", "each", "shall", "may", "must", "other", "same", "herein", "hereof",
  "hereto", "thereof", "attached", "provided",
]);

/** The two shapes a cross-document reference takes in practice. */
const REFERENCE_PATTERNS = [
  /(?:see|refer to|per|pursuant to|in accordance with|as (?:defined|described|set forth) in)\s+(?:the\s+)?(.{3,80}?)(?:\.|,|;|\)|\n|$)/gi,
  /(?:Section|Article|Exhibit|Schedule|Appendix|Addendum|Amendment)\s+[\d.A-Z]+/gi,
];

/**
 * Lowercase alphanumeric tokens of 3+ characters, excluding bare numbers.
 * camelCase boundaries split too, so `MasterLease-signed.docx` yields
 * "master"/"lease"/"signed" rather than one unmatchable blob.
 */
function significantTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t));
}

/** Strip one trailing "s" so "bylaws" and "bylaw" compare equal. */
function singular(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

/**
 * Resolve a detected reference to a sibling document by matching the words the
 * reference *itself* uses against the words in each filename.
 *
 * Deliberately carries no list of document types: "see the Bylaws", "refer to
 * the Bill of Lading", and "per the Lab Report" all resolve by the same rule.
 * Which words name a document is a property of the customer's corpus, not of
 * the engine.
 *
 * Returns the matching filename, or null when nothing matches.
 */
export function matchReferenceToFilename(refText: string, filenames: string[]): string | null {
  const refTokens = new Set(
    significantTokens(refText).filter(t => !REFERENCE_STOPWORDS.has(t)).map(singular),
  );
  // No early return on an empty token set: the squashed comparison below still
  // resolves references whose only distinguishing text is a punctuated
  // initialism ("CC&Rs", "W-9"), which tokenizes to nothing.
  const refSquashed = refText.toLowerCase().replace(/[^a-z0-9]/g, "");

  for (const filename of filenames) {
    const base = filename.replace(/\.[^.]+$/, "");
    if (significantTokens(base).map(singular).some(t => refTokens.has(t))) return filename;
    // Punctuation-insensitive fallback, so "CC&Rs" still finds "CCRs.pdf".
    const baseSquashed = base.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (baseSquashed.length >= 4 && refSquashed.includes(baseSquashed)) return filename;
  }
  return null;
}

/** Scan a document's chunks for cross-document reference phrases. */
export function detectReferences(chunks: ReferenceChunk[]): Array<{ text: string; chunkTitle: string; chunkIndex: number }> {
  const detected: Array<{ text: string; chunkTitle: string; chunkIndex: number }> = [];
  for (const chunk of chunks) {
    for (const pattern of REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(chunk.content)) !== null) {
        detected.push({ text: match[0].trim(), chunkTitle: chunk.title, chunkIndex: chunk.index });
      }
    }
  }
  return detected;
}

export interface ResolvedReference {
  text: string;
  source_chunk: string;
  target_filename: string | null;
  target_section: string | null;
  target_content: string | null;
  resolved: boolean;
  method: "chunk_match" | "filename_match" | "unresolved";
}

export interface GroupDocument {
  id: string;
  filename: string;
  extractionJson: Record<string, unknown> | null;
  chunksJson: ReferenceChunk[] | null;
}

/**
 * Resolve each detected reference against the sibling documents' sections, then
 * their filenames. Pure — no IO — so it is unit-testable on its own.
 */
export function resolveAgainstGroup(
  detected: Array<{ text: string; chunkTitle: string; chunkIndex: number }>,
  groupDocs: GroupDocument[],
): ResolvedReference[] {
  const sectionIndex: Array<{ filename: string; docId: string; title: string; content: string }> = [];
  for (const gd of groupDocs) {
    for (const c of gd.chunksJson || []) {
      sectionIndex.push({ filename: gd.filename, docId: gd.id, title: c.title, content: c.content.slice(0, 500) });
    }
  }

  const resolved: ResolvedReference[] = [];
  for (const ref of detected) {
    const refLower = ref.text.toLowerCase();
    let matched = false;

    for (const sec of sectionIndex) {
      // An empty or whitespace-only chunk title matches every reference under
      // `includes`, which would resolve the whole document to one arbitrary
      // section. Require real text before comparing.
      const title = sec.title.trim().toLowerCase();
      if (title.length < 3) continue;
      const bare = refLower.replace(/^(?:see|refer to|per|pursuant to)\s+(?:the\s+)?/i, "").trim();
      if (refLower.includes(title) || title.includes(bare)) {
        resolved.push({
          text: ref.text,
          source_chunk: ref.chunkTitle,
          target_filename: sec.filename,
          target_section: sec.title,
          target_content: sec.content.slice(0, 300),
          resolved: true,
          method: "chunk_match",
        });
        matched = true;
        break;
      }
    }

    if (!matched) {
      const targetFilename = matchReferenceToFilename(ref.text, groupDocs.map(d => d.filename));
      if (targetFilename) {
        resolved.push({
          text: ref.text,
          source_chunk: ref.chunkTitle,
          target_filename: targetFilename,
          target_section: null,
          target_content: null,
          resolved: true,
          method: "filename_match",
        });
        matched = true;
      }
    }

    if (!matched) {
      resolved.push({
        text: ref.text,
        source_chunk: ref.chunkTitle,
        target_filename: null,
        target_section: null,
        target_content: null,
        resolved: false,
        method: "unresolved",
      });
    }
  }
  return resolved;
}

export interface ResolveReferencesOptions {
  db: Db;
  tenantId: string;
  /** The document being processed. */
  filename: string;
  chunks: ReferenceChunk[];
  groupKey: string | null;
  /** Sibling documents are every doc in the group except this one. Null in test
   *  mode, where the document under test was never persisted. */
  excludeDocumentId: string | null;
  /** This document's extracted values, for contradiction detection. */
  extraction: Record<string, unknown> | null;
  endpoint: ExtractEndpointPayload | null;
}

/**
 * Run the full step: detect → resolve against the group → detect contradictions.
 * Never persists; the caller decides whether to store the result.
 */
export async function resolveReferences(opts: ResolveReferencesOptions): Promise<Record<string, unknown>> {
  const { db, tenantId, filename, chunks, groupKey, excludeDocumentId, extraction, endpoint } = opts;

  if (!groupKey) {
    return { references: [], contradictions: [], note: "No group key — skipping reference resolution" };
  }

  const groupDocs = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.documents.id,
      filename: schema.documents.filename,
      extractionJson: schema.documents.extractionJson,
      chunksJson: schema.documents.chunksJson,
    })
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.groupKey, groupKey),
        excludeDocumentId ? sql`${schema.documents.id} != ${excludeDocumentId}` : undefined,
        sql`${schema.documents.extractionJson} IS NOT NULL`,
      ),
    ),
  ) as GroupDocument[];

  if (groupDocs.length === 0) {
    return { references: [], contradictions: [], note: "No other documents in this group yet" };
  }

  const resolved = resolveAgainstGroup(detectReferences(chunks), groupDocs);

  let contradictions: Array<Record<string, unknown>> = [];
  if (endpoint && extraction) {
    try {
      const provider = createProvider(endpoint.model, endpoint);
      const otherExtractions = groupDocs
        .filter(d => d.extractionJson)
        .map(d => `${d.filename}: ${JSON.stringify(d.extractionJson).slice(0, 800)}`)
        .join("\n\n");

      const prompt = `Compare these extracted values from related documents and identify contradictions (conflicting claims about the same topic).

Current document (${filename}):
${JSON.stringify(extraction, null, 2).slice(0, 1000)}

Other documents:
${otherExtractions.slice(0, 3000)}

Only report genuine contradictions, not acceptable differences (e.g., different dates are normal). Respond JSON only:
{"contradictions": [{"topic": "what conflicts", "current_claim": "this doc says", "other_filename": "other doc", "other_claim": "other doc says", "severity": "contradiction|discrepancy"}]}`;

      const raw = await provider.generate(prompt, true);
      contradictions = JSON.parse(raw).contradictions || [];
    } catch {
      // Contradiction detection is best-effort.
    }
  }

  return {
    references: resolved,
    references_resolved: resolved.filter(r => r.resolved).length,
    references_unresolved: resolved.filter(r => !r.resolved).length,
    contradictions,
    group_key: groupKey,
    docs_in_group: groupDocs.length + 1,
  };
}
