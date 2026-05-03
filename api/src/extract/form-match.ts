/**
 * Form fingerprint matching — auto-detect incoming PDFs that match
 * a stored form mapping, enabling coordinate-based extraction
 * (skip parse + LLM entirely).
 *
 * Fingerprints are keyword sets extracted from page 1 of the sample PDF.
 * Matching is simple keyword overlap scoring — fast and good enough for
 * form detection where layouts are highly distinctive (ACORD 25, carrier
 * dec pages, government forms).
 */

import { eq, and, isNull } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";

interface FormMappingMatch {
  id: string;
  slug: string;
  schemaId: string;
  mappingsJson: Record<string, unknown>;
  fingerprintJson: FingerprintData;
  score: number;
}

export interface FingerprintData {
  /** Distinctive keywords from page 1 of the sample PDF */
  keywords: string[];
  /** Approximate character count of page 1 text (sanity check) */
  page1_chars: number;
}

/**
 * Generate a fingerprint from page 1 text of a PDF.
 * Called when a form mapping is activated.
 */
export function generateFingerprint(page1Text: string): FingerprintData {
  const text = page1Text.toLowerCase();

  // Extract distinctive multi-word phrases and single words.
  // Filter out very short/common words.
  const words = text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Count word frequency, keep the most distinctive ones
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  // Also extract known form identifiers (these are very high signal)
  const formIdentifiers: string[] = [];
  const identifierPatterns = [
    /acord\s*\d+/gi,
    /certificate\s+of\s+(?:liability\s+)?insurance/gi,
    /declarations?\s+page/gi,
    /schedule\s+of\s+(?:forms|coverages)/gi,
    /policy\s+declarations/gi,
  ];
  for (const pat of identifierPatterns) {
    const matches = page1Text.match(pat);
    if (matches) formIdentifiers.push(...matches.map((m) => m.toLowerCase().trim()));
  }

  // Take top 20 words by frequency (common form layout words)
  // plus any form identifiers
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);

  const keywords = [...new Set([...formIdentifiers, ...sorted])];

  return {
    keywords,
    page1_chars: text.length,
  };
}

/**
 * Match an incoming document's page 1 text against all active form
 * mappings for a given schema (or all schemas in the tenant).
 *
 * Returns the best match if the score exceeds the threshold, null otherwise.
 */
export async function matchFormMapping(
  db: Db,
  tenantId: string,
  page1Text: string,
  schemaId?: string,
): Promise<FormMappingMatch | null> {
  const conditions = [
    eq(schema.formMappings.tenantId, tenantId),
    eq(schema.formMappings.status, "active"),
    isNull(schema.formMappings.deletedAt),
  ];
  if (schemaId) {
    conditions.push(eq(schema.formMappings.schemaId, schemaId));
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.formMappings.id,
        slug: schema.formMappings.slug,
        schemaId: schema.formMappings.schemaId,
        mappingsJson: schema.formMappings.mappingsJson,
        fingerprintJson: schema.formMappings.fingerprintJson,
      })
      .from(schema.formMappings)
      .where(and(...conditions)),
  );

  if (rows.length === 0) return null;

  const incomingText = page1Text.toLowerCase();
  const incomingWords = new Set(
    incomingText
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  let bestMatch: FormMappingMatch | null = null;

  for (const row of rows) {
    const fp = row.fingerprintJson as FingerprintData | null;
    if (!fp?.keywords?.length) continue;

    // Score = fraction of fingerprint keywords found in the incoming text
    let hits = 0;
    for (const kw of fp.keywords) {
      // Multi-word keywords: check substring match
      // Single words: check word set membership
      if (kw.includes(" ")) {
        if (incomingText.includes(kw)) hits++;
      } else {
        if (incomingWords.has(kw)) hits++;
      }
    }

    const score = hits / fp.keywords.length;

    // Require at least 60% keyword match
    if (score >= 0.6 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = {
        id: row.id,
        slug: row.slug,
        schemaId: row.schemaId!,
        mappingsJson: row.mappingsJson as Record<string, unknown>,
        fingerprintJson: fp,
        score,
      };
    }
  }

  return bestMatch;
}
