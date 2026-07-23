/**
 * Ground-truth label validation for a classifier corpus (oss-450).
 *
 * A classifier corpus label is `{ "label": "<class id>" }` — the class the
 * document *should* be assigned. The valid labels are the class ids the
 * classifier's released config declares, plus `UNKNOWN_LABEL`: "this document
 * should fall through" is a legitimate assertion (exactly what an
 * `on_unknown: reject` user needs to backtest against).
 *
 * Kept pure so the endpoint stays thin and the rule is unit-tested without a DB.
 */
import { UNKNOWN_LABEL } from "../classify";

export type LabelCheck =
  | { ok: true; label: string }
  | { ok: false; message: string };

/**
 * Validate a proposed ground-truth label against the class ids a classifier
 * declares. `classIds` is the released config's class id set. `UNKNOWN_LABEL`
 * always passes. An empty/absent label fails — a corpus entry with no label is
 * unlabeled, which callers represent by omitting the row, not by an empty one.
 */
export function validateCorpusLabel(label: unknown, classIds: readonly string[]): LabelCheck {
  if (typeof label !== "string" || label.trim() === "") {
    return { ok: false, message: "A ground-truth `label` (a class id) is required." };
  }
  const value = label.trim();
  if (value === UNKNOWN_LABEL) return { ok: true, label: value };
  if (classIds.includes(value)) return { ok: true, label: value };
  return {
    ok: false,
    message:
      `Unknown label '${value}'. Use one of the classifier's released class ids ` +
      `[${classIds.join(", ")}] or '${UNKNOWN_LABEL}'.`,
  };
}
