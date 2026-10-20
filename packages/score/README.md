# @koji/score

Koji's extraction scorer — the single implementation of expected-vs-extracted
comparison.

Every caller that scores an extraction goes through this package: the Koji API,
the `koji score` CLI command, and external benchmark harnesses. It exists because
comparison had drifted into several independent implementations that disagreed by
construction, which made numbers from different callers incomparable and made it
impossible to tell whether a scoring change was an improvement.

Dependency-free and side-effect free, so it runs anywhere — server, CLI, CI.

## Use it as a library

```ts
import { compareValues } from "@koji/score";

const result = compareValues("2026-03-26", "03/26/2026");
// { score: 1, match: true, diff: { kind: "scalar", … } }
```

`compareValues(expected, got, spec?)` walks the value structurally:

- **scalars** match tolerantly — case and whitespace, numbers with currency and
  thousands separators to a 0.01 tolerance, dates across formats, and
  punctuation-only differences
- **arrays** score as the F1 of quality-weighted precision and recall, matching
  elements by the schema's `element_key` when one is declared and by greedy
  best-overlap otherwise
- **objects** score as the mean of their scored keys, skipping `__`-prefixed
  provenance metadata and sub-fields the schema marks `informational`

The optional `spec` is the field's schema entry. Without it you still get F1
array scoring with greedy matching.

## Declared equivalence (`match:`)

Whether two values count as the same is a schema decision, not a scorer
default. A field's `spec` can declare it:

```ts
compareValues("State of Delaware", "Delaware", { match: "contains" }); // match
compareValues(1250, 1250.4, { match: { mode: "numeric", tolerance: 0.5 } }); // match
compareValues("ABC-1", "abc-1", { match: "exact" }); // no match
```

Modes: `normalized` (the default — case, whitespace, punctuation, dates and
quantities), `exact`, `contains`, `numeric` (with `tolerance`, default 0.01),
`date`, `enum` (against the spec's `options` or `mappings`).

`normalized` is the default for every type, so a spec that declares nothing
scores exactly as it did before this existed. `numeric` and `date` are
*stricter* than the default: they fail an unparseable value rather than
comparing it as text. An unrecognised mode throws, so a typo cannot look
configured while scoring differently.

## The four metrics

There is no single accuracy number, by design. One number folded four different
things into one average, and one of them was "correctly absent" — a field ground
truth says has no value, which the extraction also left empty. Counting that as
a pass gives an extraction of **nothing at all** a non-zero floor (19.2% on the
reference corpus run — 1,365 of 7,121 fields), and tightening a prompt until the
model declines more often can push the number *up* while the extraction gets
less useful.

So four are reported, over two disjoint populations of fields:

| metric | population | question |
|---|---|---|
| `presenceRecall` | ground truth HAS a value | did we produce a value at all? |
| `valueAccuracy` | …of those, the ones we produced | is it right? (partial credit) |
| `fabricationRate` | ground truth has NO value | how often did we invent one? |
| `nullAgreement` | …the same population | how often did we correctly decline? |

```ts
import { summarizeFields } from "@koji/score";

const { metrics } = summarizeFields({
  filer: { expected: "Acme Corp", got: null },
  auditor: { expected: null, got: null },
});
// presenceRecall: 0, valueAccuracy: null, fabricationRate: 0, nullAgreement: 1
```

A document that extracts nothing scores **0 presence recall**. `nullAgreement`
is reported separately and never folded into any other number — folding it in is
what produced the floor.

Each metric is `null` when its population is empty, not 0 or 1. A run with no
empty-ground-truth fields has no fabrication rate; reporting 0 would read as "it
never fabricates", which is a claim the run did not test.

`fieldOutcome(expected, got, spec?)` classifies a single field as `found` /
`missed` / `fabricated` / `agreed` and carries its `CompareResult`;
`tally` + `metricsFromCounts` aggregate over any slice, because `MetricCounts`
is additive.

## `scorer_version`

Every result is stamped with `SCORER_VERSION`. A score is only meaningful
relative to the code that produced it: the difference between two runs scored by
different versions includes whatever the scorer changed, and the two are not
separable after the fact.

```ts
import { assertComparableScorerVersion, scorerVersionMismatch } from "@koji/score";

assertComparableScorerVersion(artifact.scorer_version, "baseline run"); // throws
const warning = scorerVersionMismatch(stored.scorerVersion, "run abc");  // or returns a message
```

Use `assertComparableScorerVersion` where the whole operation IS a comparison (a
regression gate, a baseline diff) and `scorerVersionMismatch` where an old
artifact is merely being displayed. Comparability is string equality, not
semver-aware: a patch-level date-parsing fix moves numbers, which is exactly the
case the guard exists to catch.

## Use it from the command line

```bash
echo '{"fields":{"date":{"expected":"2026-03-26","got":"March 26, 2026"}}}' \
  | npx koji-score
```

Input is a JSON object on stdin (or `--input file.json`):

```json
{
  "fields": { "<name>": { "expected": …, "got": … } },
  "specs":  { "<name>": { … } }
}
```

Output carries `scorer_version`, the `metrics` block, and per-field `bucket` /
`expected_present` / `got_present` so an external harness can recompute the four
metrics over its own slices without reimplementing the classification. There is
deliberately no single `score` key. **Numbers from different scorer versions are
not comparable.**

Exit code is 0 whenever scoring completed — a mismatch is a result, not an
error — and 1 on bad usage or malformed input.

Koji users normally reach this through `koji score`, which builds the payload
from two JSON files and an optional schema. See `docs/cli.md`.

## Dates

Date comparison recognises ISO (`2026-03-26`, `2026/03/26`), numeric
(`03/26/2026`, `3/26/26`, `26.03.2026`), and month-name forms (`March 26, 2026`,
`Mar. 26 2026`, `26 March 2026`, `26th of March, 2026`).

Two deliberate choices: ambiguous numeric dates are read **month-first**, and
two-digit years use the POSIX pivot (`00`–`68` → 2000s, `69`–`99` → 1900s). A
day-first schema needs a declared per-field match policy rather than a global
guess. Impossible dates (`02/31/2026`) are rejected instead of rolling over.

Parsing is format-driven rather than `new Date(s)`, which accepts far too much
and timezone-shifts bare ISO strings into the wrong day.
