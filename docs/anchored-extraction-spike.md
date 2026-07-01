# Anchored-extraction spike — is LLM source-unit citation worth building? (oss-331)

**Status:** measurement spike. Deliverable is this findings doc + a GO/NO-GO. No
production code was changed. Throwaway harness lives in
`experiments/anchored-extraction-spike/`.

**TL;DR — QUALIFIED GO, gated to the ambiguous case.** Model source-unit
citation is *reliable* on real table-heavy docs: **147/147 valid ids (0
hallucinated), 132/132 citation-correct on non-derived fields, 21/21 correct on
the repeated-value disambiguation cases, 15/15 correct "cite null" on derived
values** — across two models and three docs. The deterministic offset/chunk path
we already ship handles **21/25 (84%)** of the same fields, but scores **0/4 on
repeated-value disambiguation**, a gap neither the `offset` nor the `chunk`
provenance rung can close (both take the first textual/geometric match). So
anchoring's *unique* win is repeated-value disambiguation. It is not free — the
per-unit id/coord prefix adds ~+50–100% input tokens on a dec page and ~+18% on
a large policy (it pushed a 514 KB doc past gpt-4o-mini's 128 K window).
Recommendation: build anchoring, but as a **targeted escalation** triggered only
when a value is ambiguous (appears in ≥2 units), not as an always-on replacement
for the deterministic path.

---

## The question

We ship deterministic provenance today (`resolveProvenance`): offset lookup for
digital parses, chunk-bbox for Doc AI/Textract (`docs/parse-spine-model.md`,
`api/src/extract/provenance.ts`). "Anchored extraction" (Move B) would go
further: hand the LLM the parse units (each with an `id`, from oss-318) and ask
it to **cite the source unit id per field**, turning geometry into an id lookup.

That only pays off if two things are true:

1. **Models cite reliably** — the id exists (no hallucination) and actually
   supports the value.
2. **Anchoring beats what we already have** — the deterministic offset/chunk
   path doesn't already cover the cases that matter.

Precedent: the oss-302 JSON-native spike *measured before building* and killed
the feature when the accuracy gain didn't materialize. Same rigor here.

## Method

Mirrors the oss-302 spike (measure, small N, be honest about limits).

1. **Real parse units.** The corpus ships pre-parsed `.md` (no PDFs), so we
   can't run the live pdfjs/Doc AI/Textract canonicalizers. Instead we reverse a
   real corpus GFM table back into the **same addressable unit shape those
   canonicalizers emit** — `table_cell` units carrying `{ tableId, row, col }`
   plus line/heading units — using the **real** `assignUnitIds` and the **real**
   `spineToMarkdown` (`api/src/parse/chunk.ts`) for the projected markdown. The
   citation task (cite the unit id that supports a value) is identical regardless
   of which provider produced the units.
2. **Docs (table-heavy, where anchoring should help most):**
   `insurance_policies/{dc_ho_dec, fl_sample_dec, chubb_bop}` — homeowner and BOP
   declarations pages with real limit/premium/deductible grids.
3. **Fields with known values (N = 28):** hand-authored `field → value → correct
   source cell(s)` tuples, resolved to concrete unit ids against the parsed
   spine. Deliberately loaded with the hard cases: **4 repeated-value
   disambiguation** fields (same value string in ≥2 cells where the correct one
   is *not* the first occurrence — e.g. a `$1,000` deductible that also appears
   as a `$1,000` medical limit), duplicated limit columns (multiple acceptable
   cells), and **3 genuinely derived/summed** values that live in no single unit.
4. **Anchored run:** prompt each model with the unit list (id + page + table
   coords + text) and the field descriptions; ask for `{ value, source_unit_id }`
   per field. Models: **gpt-4o-mini** and **claude-haiku-4-5**. **3 trials** each,
   temperature 0.
5. **Deterministic baseline:** feed the *known-good* value into the **real**
   `resolveProvenance` against the projected markdown, map the returned offset
   back to the owning unit, and check whether it lands in an acceptable source
   cell. This isolates the *locate* step and compares it head-to-head with the
   model's *cite* step on identical fields.

Scoring detail: citation correctness is reported both overall and conditioned on
the model getting the value right (a citation for a wrong value isn't a fair
citation test). "Derived handled" = the model correctly returned
`source_unit_id: null`.

## Results

N = 28 fields/doc-set; anchored = 2 models × 3 trials. gpt-4o-mini completed
`dc_ho_dec` + `fl_sample_dec` (its 128 K window can't hold `chubb_bop` — see
Cost); claude-haiku-4-5 completed all three. **147 anchored observations total.**

| Metric | gpt-4o-mini | claude-haiku-4-5 | Combined |
|---|---|---|---|
| Citation validity (id exists / null) | 63/63 (100%) | 84/84 (100%) | **147/147 (100%)** |
| Hallucinated-id rate | 0/63 (0%) | 0/84 (0%) | **0/147 (0%)** |
| Citation correctness (non-derived) | 57/57 (100%) | 75/75 (100%) | **132/132 (100%)** |
| Cited unit contains the value | 57/57 (100%) | 75/75 (100%) | **100%** |
| **Disambiguation** citation-correct | 9/9 (100%) | 12/12 (100%) | **21/21 (100%)** |
| **Derived** handled (cited `null`) | 6/6 (100%) | 9/9 (100%) | **15/15 (100%)** |
| Value extracted correctly (non-derived) | 51/57 (89%)\* | 75/75 (100%) | — |

\* All 6 gpt-4o-mini "value mismatches" are the model returning the fuller cell
text (`$300,000 Each Occurrence`) instead of the requested bare amount
(`$300,000`); **the citation was correct in all 6.** Not a citation failure.

### Deterministic baseline, same fields

| Metric | Result |
|---|---|
| Correctness (non-derived) | **21/25 (84%)** |
| **Disambiguation** correctness | **0/4 (0%)** |
| Derived not-found (honest "no source") | 3/3 (100%) |

The baseline is right on every non-repeated field (21/21) and honestly returns
"not found" for summed values. Its **only** failures are the 4 repeated-value
cases: `resolveProvenance` takes the first textual match, so a `$1,000`
deductible resolves to the `$1,000` medical-limit cell, `$3,200` hurricane
deductible resolves to the `$3,200` Coverage-B cell, etc. **This is structural:**
the `chunk`-rung path (`findValueChunk`) also picks the first matching chunk, so
upgrading to structured chunk-bbox does *not* fix it either.

### Derived-value rate

3/28 fields (**11%**) are values that live in no single unit (arithmetic
totals). Anchoring structurally cannot cite these — and correctly didn't
(15/15 cited `null`). The deterministic path also correctly fails to locate
them. Neither approach invents a source; parity here.

### Cost (measured)

The anchored prompt sends every unit with an `[id] (page, table r c)` prefix.
Overhead vs. sending the plain projected markdown:

| Doc | Projected md (~tok) | Units block (~tok) | Overhead |
|---|---|---|---|
| dc_ho_dec | ~450 | ~713 | **+58%** |
| fl_sample_dec | ~779 | ~1,594 | **+105%** |
| chubb_bop (514 KB, 4,148 units) | ~124 K | ~146 K | **+18%** |

Output cost is negligible (one short id per field). The overhead is the per-unit
prefix, so it's proportionally largest on small dec pages. On `chubb_bop` the
units block hit ~146 K tokens and **exceeded gpt-4o-mini's 128 K context** — the
raw doc alone (~124 K) is already near the limit, so that doc needs chunking
regardless, but anchoring's +18% is what tipped it over in one shot.

## Failure modes observed

- **No hallucinated ids** in 147 observations. The "models will cite garbage"
  risk did not materialize on clean, coordinate-labeled units.
- **No mis-cites**, including on the repeated-value traps that break the
  deterministic path — both models used the row label / column meaning to pick
  the right cell.
- **gpt-4o-mini value verbosity** (returns `$300,000 Each Occurrence` vs
  `$300,000`) — an extraction-formatting nit, not a citation problem; the cite
  was still correct.
- **Context blowout on a large doc** — the units representation is token-heavy
  enough to matter at scale.

## Limitations (be honest about N and setup)

- **N = 28 fields, 3 docs, 2 models, 3 trials.** Modest, in line with oss-302's
  ~47 cells. Enough to see the pattern, not a benchmark.
- **Clean digital markdown, not live noisy OCR.** These are well-formed corpus
  dec pages. On garbled scans (glyph noise, broken grids) both citation *and*
  the deterministic fuzzy fallback would degrade — untested here. This is the
  single biggest caveat: the reliability numbers are an upper bound.
- **Units reversed from GFM markdown**, not produced by a live Doc AI/Textract
  run. The unit *shape* (cell-addressable, table coords) is faithful to what the
  real canonicalizers emit, but real OCR would introduce cell-segmentation noise
  we didn't measure.
- **Single-page-ish, English, insurance domain.** No multi-page id-collision
  stress (ids are page-scoped), no non-table-dense docs.

## GO / NO-GO

**QUALIFIED GO — build anchoring as a targeted escalation, not the default path.**

Reasoning: the spike answers both gating questions. (1) Citation *is* reliable —
0 hallucinated ids and 0 mis-cites across 147 observations on two models kills
the "models can't be trusted to cite" objection. (2) The deterministic path
already covers the cases that matter (84%, every non-repeated field, plus honest
not-found on derived), so anchoring is **not** a wholesale win. Its one
*non-redundant* capability is **repeated-value disambiguation** (21/21 vs the
baseline's 0/4), which neither the `offset` nor the `chunk` rung can solve
because both take the first match. That gap is real on dec pages (deductible vs
matching limit, hurricane vs coverage deductible). But it's a minority of fields,
and the always-on cost is material (+50–100% prompt tokens on typical dec pages).

So: build it, but **gate it** — detect when a value is ambiguous (its normalized
form appears in ≥2 units) and only then spend the anchored citation call /
token overhead; keep the cheap deterministic offset/chunk path for the ~86% of
fields where it's already correct. That captures the disambiguation win where the
deterministic path *provably* fails, without paying anchoring's tax on every
field of every document. A full, unconditional Move B is not justified by this
data.

## Reproduce

```bash
eval "$(kdev env)"          # exports OPENAI_API_KEY / ANTHROPIC_API_KEY
cd koji/api
npx tsx ../experiments/anchored-extraction-spike/run.ts --models=openai,anthropic --trials=3
# dry run (ground-truth resolution + deterministic baseline only, no tokens):
npx tsx ../experiments/anchored-extraction-spike/run.ts --models=none
```

Token spend for the full run above: gpt-4o-mini ~13.9 K in / ~2.0 K out (6
calls); claude-haiku-4-5 ~591 K in / ~3.4 K out (9 calls — the 3 `chubb_bop`
calls dominate at ~146 K each). Well under a dollar.
