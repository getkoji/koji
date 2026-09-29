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

Output carries `scorer_version` so a run artifact can record which scorer
produced it. **Numbers from different scorer versions are not comparable.**

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
