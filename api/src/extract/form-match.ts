/**
 * Form fingerprint matching — auto-detect incoming PDFs that match
 * a stored form mapping, enabling coordinate-based extraction
 * (skip parse + LLM entirely).
 *
 * Fingerprints are keyword sets extracted from page 1 of the sample PDF.
 * Matching is simple keyword overlap scoring — fast and good enough for
 * form detection, where layouts are highly distinctive.
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

  // Also extract the form's own identifiers, which are very high signal.
  //
  // These used to be a fixed list of insurance phrases — `acord \d+`,
  // `certificate of liability insurance`, `declarations page`. A form outside
  // that list (a CMS-1500, a W-9, a bill of lading, a building permit) got no
  // high-signal terms at all and had to be matched on frequent-word overlap
  // alone. Both signals below are structural: a form announces itself in its
  // title and in its printed form code, whatever industry it belongs to.
  const formIdentifiers = [...extractTitlePhrases(page1Text), ...extractFormCodes(page1Text)];

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
 * The form's printed identifier code — `ACORD 25`, `CMS-1500`, `W-9`,
 * `Form I-9`, `CG 00 01`. Structurally: capitalised letters bound to digits,
 * with the separators forms actually use.
 */
function extractFormCodes(page1Text: string): string[] {
  const codes = new Set<string>();
  // Two passes because the case rules differ: a bare code is capitalised by
  // construction, while the word introducing a labelled one ("Form", "No.")
  // may be in any case. Separate regexes rather than an inline flag group,
  // which the runtime rejects.
  const patterns: Array<RegExp> = [
    // ACORD 25 · CMS-1500 · CG 00 01 — capitals bound to digits.
    /\b[A-Z][A-Z&/]{1,9}(?:[-\s]?\d{1,5}){1,3}\b/g,
    // Form W-9 · No. 88213 · Number BP-2026-0043 — a code the page labels.
    /\b(?:form|no\.?|number)\s+[A-Za-z0-9][A-Za-z0-9-]{1,12}\b/gi,
  ];
  for (const pattern of patterns) {
    for (const m of page1Text.match(pattern) ?? []) {
      const code = m.toLowerCase().replace(/\s+/g, " ").trim();
      if (code.length >= 3 && code.length <= 30) codes.add(code);
    }
  }
  return [...codes].slice(0, 6);
}

/**
 * The form's title — the first substantial line(s) of page 1. A form names
 * itself at the top, and that name is the single most distinctive phrase on
 * the page whatever the document is.
 */
function extractTitlePhrases(page1Text: string): string[] {
  const titles: string[] = [];
  for (const raw of page1Text.split(/\r?\n/)) {
    if (titles.length >= 2) break;
    const line = raw.replace(/[#*|]/g, " ").replace(/\s+/g, " ").trim();
    if (line.length < 8 || line.length > 80) continue;
    if (/[.;]$/.test(line)) continue; // a sentence, not a heading
    const letters = line.replace(/[^a-z]/gi, "").length;
    if (letters < line.length * 0.6) continue; // mostly words, not a data row

    // Headings are set in caps or title case. Requiring that keeps a masthead
    // and rejects the running prose that happens to sit near the top of a page.
    const words = line.split(" ").filter((w) => /[a-z]/i.test(w));
    if (words.length < 2) continue;
    const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
    if (capitalised / words.length < 0.6) continue;

    titles.push(line.toLowerCase());
  }
  return titles;
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
