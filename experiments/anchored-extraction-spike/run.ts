/**
 * THROWAWAY SPIKE HARNESS — NOT PRODUCTION CODE (oss-331).
 *
 * Measures whether LLM source-unit-id citation ("anchored extraction", Move B)
 * is reliable enough to build, vs. the deterministic offset/chunk provenance
 * path we already ship.
 *
 * For each table-heavy corpus doc:
 *   1. Build a parse spine (cell-addressable units) and its md projection.
 *   2. Ask the model to extract known fields AND cite the source unit id.
 *   3. Score citation validity / correctness / derived handling over N trials.
 *   4. Score the DETERMINISTIC baseline on the same fields: feed the known-good
 *      value into the REAL `resolveProvenance`, map its offset back to a unit,
 *      and check whether it lands in an acceptable source cell.
 *
 * Run: tsx experiments/anchored-extraction-spike/run.ts [--models=openai,anthropic] [--trials=3]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mdToSpine, annotate, unitAtOffset } from "./spine.js";
import { DOCS, acceptableUnits, valueInSingleUnit, norm } from "./groundtruth.js";
import type { Field } from "./groundtruth.js";
import { callOpenAI, callAnthropic, parseJsonObject } from "./models.js";
import { resolveProvenance } from "../../api/src/extract/provenance.js";
import type { ParseUnit } from "../../api/src/parse/chunk.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(__dir, "../../../corpus/insurance_policies/documents");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"] as const;
  }),
);
const MODELS = (args.get("models") ?? "openai,anthropic")
  .split(",")
  .filter((m) => m === "openai" || m === "anthropic");
const TRIALS = Number(args.get("trials") ?? "3");

/** Render the non-empty spine units for the prompt, with structural signals. */
function unitsBlock(units: ParseUnit[]): string {
  return units
    .filter((u) => u.text.trim())
    .map((u) => {
      const loc = u.table
        ? `page ${u.page}, table ${u.table.tableId} r${u.table.row} c${u.table.col}`
        : `page ${u.page}`;
      return `[${u.id}] (${loc}) ${u.text}`;
    })
    .join("\n");
}

function buildPrompt(units: ParseUnit[], fields: Field[]): string {
  const fieldList = fields.map((f) => `- ${f.name}: ${f.desc}`).join("\n");
  return `You are extracting structured fields from a parsed document.

The document is given as a list of PARSE UNITS. Each unit has an id, a page, and text; table cells also show their table id, row (r) and column (c).

PARSE UNITS:
${unitsBlock(units)}

FIELDS TO EXTRACT:
${fieldList}

For each field, return the extracted value AND "source_unit_id": the id of the SINGLE parse unit that contains that value. Rules:
- source_unit_id MUST be exactly one of the unit ids listed above.
- If the value does not appear verbatim in any single unit (e.g. it is a sum or computed total), set source_unit_id to null.
- When the same value appears in several units, cite the unit that is the correct source for THIS field (use the row label / column meaning to disambiguate).

Return ONLY JSON of this shape:
{"fields": {"<field_name>": {"value": <value>, "source_unit_id": "<unit id or null>"}}}`;
}

interface Obs {
  doc: string;
  field: string;
  disambig: boolean;
  derived: boolean;
  model: string;
  trial: number;
  returnedValue: string;
  returnedId: string | null;
  valueCorrect: boolean;
  idValid: boolean; // returned id exists in the unit set (or null for derived)
  citationCorrect: boolean; // id in acceptable set (or null when derived)
  citedContainsValue: boolean; // cited unit's text supports the returned value
}

const results: {
  meta: any;
  observations: Obs[];
  baseline: any[];
  usage: { model: string; inputTokens: number; outputTokens: number; calls: number }[];
} = { meta: {}, observations: [], baseline: [], usage: [] };

async function main() {
  const usageAcc = new Map<string, { i: number; o: number; c: number }>();

  // Precompute spines + ground truth per doc.
  const docState = DOCS.map((doc) => {
    const md = readFileSync(`${CORPUS}/${doc.slug}.md`, "utf8");
    const spine = annotate(mdToSpine(md));
    const idSet = new Set(spine.units.map((u) => u.id));
    const gt = new Map(
      doc.fields.map((f) => [
        f.name,
        {
          acceptable: new Set(acceptableUnits(spine, f)),
          inSingleUnit: valueInSingleUnit(spine, f.value),
        },
      ]),
    );
    return { doc, spine, idSet, gt };
  });

  // ---- Sanity: report ground-truth resolution so we trust the scoring. ----
  console.log("=== Ground-truth resolution (sanity) ===");
  for (const { doc, gt } of docState) {
    for (const f of doc.fields) {
      const g = gt.get(f.name)!;
      const tag = f.derived ? "DERIVED" : f.disambig ? "disambig" : "";
      console.log(
        `  ${doc.slug}.${f.name} -> {${[...g.acceptable].join(",") || "∅"}} inSingle=${g.inSingleUnit} ${tag}`,
      );
    }
  }

  // ---- Anchored: model citation ----
  for (const model of MODELS) {
    for (const { doc, spine, idSet, gt } of docState) {
      const prompt = buildPrompt(spine.units, doc.fields);
      for (let trial = 1; trial <= TRIALS; trial++) {
        let reply: string;
        try {
          const r =
            model === "openai" ? await callOpenAI(prompt) : await callAnthropic(prompt);
          reply = r.text;
          const u = usageAcc.get(model) ?? { i: 0, o: 0, c: 0 };
          u.i += r.usage.inputTokens;
          u.o += r.usage.outputTokens;
          u.c += 1;
          usageAcc.set(model, u);
        } catch (e) {
          console.error(`  ${model} ${doc.slug} trial ${trial} FAILED: ${e}`);
          continue;
        }
        let parsed: any;
        try {
          parsed = parseJsonObject(reply).fields ?? {};
        } catch (e) {
          console.error(`  ${model} ${doc.slug} trial ${trial} JSON parse FAILED: ${e}`);
          continue;
        }

        for (const f of doc.fields) {
          const out = parsed[f.name] ?? {};
          const returnedValue = out.value == null ? "" : String(out.value);
          const rawId = out.source_unit_id;
          const returnedId = rawId == null || rawId === "null" ? null : String(rawId);
          const g = gt.get(f.name)!;

          const valueCorrect = norm(returnedValue) === norm(f.value);
          const idValid = returnedId === null ? true : idSet.has(returnedId);
          const citationCorrect = f.derived
            ? returnedId === null
            : returnedId !== null && g.acceptable.has(returnedId);
          const citedUnit =
            returnedId != null ? spine.units.find((u) => u.id === returnedId) : undefined;
          const citedContainsValue =
            !!citedUnit && !!returnedValue && norm(citedUnit.text).includes(norm(returnedValue));

          results.observations.push({
            doc: doc.slug,
            field: f.name,
            disambig: !!f.disambig,
            derived: !!f.derived,
            model,
            trial,
            returnedValue,
            returnedId,
            valueCorrect,
            idValid,
            citationCorrect,
            citedContainsValue,
          });
        }
      }
    }
  }

  // ---- Deterministic baseline (no model): locate known value, map to unit ----
  for (const { doc, spine, gt } of docState) {
    for (const f of doc.fields) {
      const prov = resolveProvenance({ [f.name]: f.value }, spine.markdown)[f.name];
      const g = gt.get(f.name)!;
      let locatedId: string | null = null;
      if (prov) locatedId = unitAtOffset(spine, prov.offset);
      const correct = f.derived
        ? prov == null // for a summed value, the honest deterministic outcome is "not found"
        : locatedId !== null && g.acceptable.has(locatedId);
      results.baseline.push({
        doc: doc.slug,
        field: f.name,
        disambig: !!f.disambig,
        derived: !!f.derived,
        located: prov != null,
        locatedId,
        acceptable: [...g.acceptable],
        correct,
      });
    }
  }

  for (const [model, u] of usageAcc) {
    results.usage.push({ model, inputTokens: u.i, outputTokens: u.o, calls: u.c });
  }
  results.meta = {
    models: MODELS,
    trials: TRIALS,
    docs: DOCS.map((d) => d.slug),
    totalFields: DOCS.reduce((n, d) => n + d.fields.length, 0),
    generatedAt: new Date().toISOString(),
  };

  // ---- Aggregate + print ----
  summarize();

  const outPath = resolve(__dir, "results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${outPath}`);
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`;
}

function summarize() {
  const obs = results.observations;
  console.log("\n=== ANCHORED (model citation) ===");
  for (const model of MODELS) {
    const mo = obs.filter((o) => o.model === model);
    if (mo.length === 0) {
      console.log(`\n[${model}] no observations (calls failed)`);
      continue;
    }
    const nonDerived = mo.filter((o) => !o.derived);
    const derived = mo.filter((o) => o.derived);
    const disambig = mo.filter((o) => o.disambig);
    // Citation metrics conditioned on the value being extracted correctly
    // (a citation for a wrong value isn't a fair citation test).
    const vc = nonDerived.filter((o) => o.valueCorrect);

    console.log(`\n[${model}]  (N observations = ${mo.length})`);
    console.log(`  value-correct (non-derived): ${pct(nonDerived.filter((o) => o.valueCorrect).length, nonDerived.length)}`);
    console.log(`  citation validity  (id exists / null): ${pct(mo.filter((o) => o.idValid).length, mo.length)}`);
    console.log(`  hallucinated-id rate: ${pct(mo.filter((o) => !o.idValid).length, mo.length)}`);
    console.log(`  citation correctness (value-correct, non-derived): ${pct(vc.filter((o) => o.citationCorrect).length, vc.length)}`);
    console.log(`  citation correctness (ALL non-derived): ${pct(nonDerived.filter((o) => o.citationCorrect).length, nonDerived.length)}`);
    console.log(`  cited-unit-contains-value: ${pct(mo.filter((o) => o.citedContainsValue).length, mo.filter((o) => !o.derived).length)}`);
    console.log(`  DISAMBIG citation correctness: ${pct(disambig.filter((o) => o.citationCorrect).length, disambig.length)}`);
    console.log(`  DERIVED handled (cited null): ${pct(derived.filter((o) => o.citationCorrect).length, derived.length)}`);
  }

  const b = results.baseline;
  const bNon = b.filter((o) => !o.derived);
  const bDis = b.filter((o) => o.disambig);
  console.log("\n=== DETERMINISTIC BASELINE (resolveProvenance offset->unit) ===");
  console.log(`  correctness (non-derived): ${pct(bNon.filter((o) => o.correct).length, bNon.length)}`);
  console.log(`  DISAMBIG correctness: ${pct(bDis.filter((o) => o.correct).length, bDis.length)}`);
  console.log(`  DERIVED not-found (honest): ${pct(b.filter((o) => o.derived && o.correct).length, b.filter((o) => o.derived).length)}`);

  // Derived-value rate across the whole field set (structural: value in no unit).
  const allFields = DOCS.flatMap((d) => d.fields);
  const derivedCount = allFields.filter((f) => f.derived).length;
  console.log(`\nDerived-value rate (fields whose value lives in NO single unit): ${pct(derivedCount, allFields.length)}`);

  for (const u of results.usage) {
    console.log(`\n[usage ${u.model}] calls=${u.calls} in=${u.inputTokens} out=${u.outputTokens}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
