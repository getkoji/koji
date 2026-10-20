/**
 * Pluggable capability contracts: `select`, `adjudicate`, `review`.
 *
 * Why these are interfaces rather than functions
 * ----------------------------------------------
 * Everything available in commercial Koji is available in OSS. Commercial
 * sells hosting, scale, support and the corpus service — never exclusive
 * capability. Operationally that means any component needing an LLM, a local
 * decision model, or a hosted service is a **pluggable provider behind an
 * interface**, and every interface ships an implementation that runs on
 * nothing but BYO credentials or local inference.
 *
 * The architectural wins of candidate-selection do not depend on which
 * implementation answers. They fall out of the *shape*:
 *
 *   - the returned value is always one of the candidates the caller supplied,
 *     so fabrication is impossible;
 *   - the candidate carries its own offset, so provenance is free — no
 *     post-hoc string match, no faithfulness gate;
 *   - the probability distribution over candidates *is* the field confidence.
 *
 * An OSS user running LLM-choice over their own key gets all three. What a
 * local model or a hosted System-1 service add on top is calibration quality,
 * latency and unit cost. `parity.test.ts` asserts the invariants above
 * identically for every implementation, which is what keeps that claim
 * mechanical rather than aspirational.
 *
 * Nothing in this module is domain-specific: a candidate is a span of text,
 * an option set is whatever the caller enumerated, and the instructions are
 * the caller's words. Candidate *generation* (per field type) is Track C and
 * lives outside this module.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * The material a selector reasons over. A string is document text; an object
 * is a structured state (document plus windows, a table row, a header block)
 * and is serialized by whichever implementation needs text.
 *
 * Deliberately *not* "the document": state size should track the candidate
 * count, not the document length, for implementations with a hard state
 * budget.
 */
export type SelectState = string | Readonly<Record<string, unknown>>;

/**
 * A bounding box in parse coordinates, carried through so a selection can
 * highlight in the viewer without a second lookup.
 */
export interface SelectBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One option the selector may return.
 *
 * `value` is what the caller gets back. `offset` / `page` / `bbox` are the
 * provenance the caller already knew at candidate-generation time; every
 * implementation hands the chosen candidate back **by identity**, so whatever
 * provenance went in comes out. That round-trip is the provenance invariant —
 * see `parity.test.ts`.
 *
 * `offset` is optional because not every candidate set comes from the
 * document: a schema's declared `options` *are* the candidate set for an enum
 * field, and those have no position in the source.
 */
export interface SelectCandidate {
  /** Returned verbatim as `choice`. Must be unique within one request. */
  value: string;
  /** How the source writes it, if that differs from `value`. */
  raw?: string;
  /** Character offset of `raw` in the source text, when known. */
  offset?: number;
  /** 1-based page number, when the source is a paginated document. */
  page?: number;
  /** Bounding box of `raw`, when the parse supplied one. */
  bbox?: SelectBBox;
  /** Surrounding source text, for a windowed state. */
  context?: string;
  /**
   * One short line shown to the selector as this option's criteria — e.g.
   * how the document writes it. Never required.
   */
  note?: string;
}

/**
 * The reserved choice meaning "the state gives no value for this". It is not
 * a candidate and can never collide with one: a candidate whose `value` is
 * this string is rejected as a malformed request.
 *
 * Abstention is a first-class answer. A selector that cannot abstain has to
 * pick *something*, which reintroduces exactly the wrong-but-confident
 * failure the shape was supposed to remove.
 */
export const ABSTAIN = "__none__";

export interface SelectUsage {
  inputTokens?: number;
  outputTokens?: number;
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

export interface SelectOptions {
  /** Let the selector answer `ABSTAIN`. Default true. */
  allowAbstain?: boolean;
  /** Wording for the abstain option's criteria. Default is generic. */
  abstainNote?: string;
}

export interface SelectResult {
  /** The chosen candidate's `value`, or `ABSTAIN`. Never anything else. */
  choice: string;
  /**
   * The chosen candidate, **the same object the caller supplied**, so its
   * offset / page / bbox round-trip. `null` exactly when `abstained`.
   */
  selected: SelectCandidate | null;
  /** True when `choice === ABSTAIN`. */
  abstained: boolean;
  /**
   * Probability per option value (plus `ABSTAIN` when allowed). Keys are a
   * subset of the supplied values, each in [0,1], summing to 1.
   */
  probabilities: Record<string, number>;
  /**
   * Distribution-level certainty in [0,1]: `1 - normalized entropy`. This is
   * the quantity to gate a review queue on — it falls when the selector is
   * torn between candidates, not merely when one candidate is unlikely.
   */
  confidence: number;
  /** `max(p)` — the probability of the answer actually reported. In [0,1]. */
  answerConfidence: number;
  /**
   * Whether `probabilities` came from the model's own output distribution
   * (true) or was synthesized from a self-reported number (false).
   *
   * An LLM's self-reported confidence is conservatively calibrated noise, so
   * this flag is the honest marker of which guarantee the caller has. The
   * *shape* invariants hold either way; calibration is what a local decision
   * model or a hosted System-1 service buys you.
   */
  calibrated: boolean;
  /** Which implementation answered, for the trace. */
  provider: string;
  usage?: SelectUsage;
}

/**
 * `select(state, options, instructions) -> { choice, probabilities, confidence }`
 *
 * Implementations: `LlmChoiceSelectProvider` (BYO key, the OSS default),
 * `LayaSelectProvider` (local ONNX), `JevSelectProvider` (hosted).
 */
export interface SelectProvider {
  /** Stable identifier for traces and the parity suite. */
  readonly name: string;
  /**
   * The largest option set one call may carry. Over this, `select` throws a
   * `SelectRequestError` rather than silently truncating the candidate set —
   * a truncated set can drop the answer, which looks like a model error and
   * is not one.
   */
  readonly maxOptions: number;
  select(
    state: SelectState,
    options: readonly SelectCandidate[],
    instructions: string,
    opts?: SelectOptions,
  ): Promise<SelectResult>;
}

// ---------------------------------------------------------------------------
// adjudicate
// ---------------------------------------------------------------------------

/**
 * The field a pair of values is being compared for. Enough context to judge
 * "Delaware" against "State of Delaware" without guessing what the field is.
 */
export interface AdjudicateField {
  name: string;
  description?: string;
  /** Schema type, when known: string / number / date / enum / boolean. */
  type?: string;
  /** The field's declared equivalence policy, when it has one. */
  match?: string;
}

export interface AdjudicateResult {
  /** Whether the two values mean the same thing for this field. */
  equivalent: boolean;
  /** [0,1]. Same shape, and same honesty caveat, as `SelectResult`. */
  confidence: number;
  /** Whether `confidence` is a model distribution or a self-report. */
  calibrated: boolean;
  /** One line, when the implementation gives one. Never required. */
  reason?: string;
  provider: string;
  usage?: SelectUsage;
}

/**
 * `adjudicate(expected, got, field) -> { equivalent, confidence }`
 *
 * Shares the yes/no-plus-probability shape with `select`.
 *
 * **Offline / CI only.** Adjudication exists to settle whether a scorer
 * disagreement is a real miss or a string-form variant, and to feed the queue
 * that fixes the corpus. It must never sit in the request path: that would put
 * a model call on the critical path of every extraction and make a hosted
 * dependency load-bearing for an OSS install. The guard in `./adjudicate`
 * enforces this at call time; `offline-only.test.ts` enforces it at the
 * source-tree level.
 */
export interface AdjudicateProvider {
  readonly name: string;
  adjudicate(expected: unknown, got: unknown, field: AdjudicateField): Promise<AdjudicateResult>;
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

/**
 * One thing awaiting review: a field whose confidence fell below the gate.
 *
 * When the field was extracted by selection, `options` is the candidate set it
 * was chosen from — and a reviewer (human or agent) picking among those
 * inherits the same no-fabrication property the extraction had.
 */
export interface ReviewItem {
  /** Caller-stable identifier (document id + field path, typically). */
  id: string;
  field: AdjudicateField;
  /** The value currently proposed for the field. */
  value: unknown;
  /** The extraction's confidence, when it had one. */
  confidence?: number;
  /** What the reviewer needs in order to decide. */
  state: SelectState;
  /** The candidate set, for a selection-backed field. */
  options?: readonly SelectCandidate[];
  /** Why this item is in the queue, in the pipeline's words. */
  reason?: string;
}

export type ReviewDecision = "accept" | "correct" | "reject" | "defer";

export interface ReviewVerdict {
  /** The item this verdict answers. */
  id: string;
  /**
   * - `accept`  — the proposed value stands.
   * - `correct` — replace it with `value`.
   * - `reject`  — the field has no value in this document.
   * - `defer`   — this reviewer will not decide; escalate to a human.
   */
  decision: ReviewDecision;
  /** The value after review. Unchanged on `accept`, null on `reject`. */
  value: unknown;
  /** Provenance for a corrected value, when the correction was a selection. */
  selected?: SelectCandidate | null;
  /** [0,1]. 0 on `defer` — a deferral is the absence of a judgement. */
  confidence: number;
  reason?: string;
  provider: string;
}

/**
 * `review(items) -> verdicts`
 *
 * Two kinds, and the distinction is load-bearing for the caller:
 *   - `human` parks items for a person and always defers; the queue is the
 *     product surface.
 *   - `agent` first-passes the queue before a person sees it. Non-determinism
 *     is harmless there because a human still reviews what it touched.
 */
export interface ReviewProvider {
  readonly name: string;
  readonly kind: "human" | "agent";
  review(items: readonly ReviewItem[]): Promise<ReviewVerdict[]>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The caller's request is malformed: no options, duplicate option values, an
 * option set larger than the provider allows, abstention disallowed with an
 * empty set. Deterministic, and never worth a retry.
 */
export class SelectRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectRequestError";
  }
}

/**
 * An implementation returned something the contract forbids — a value outside
 * the candidate set, a probability outside [0,1], a distribution over keys the
 * caller never supplied.
 *
 * This is always a bug in the adapter, never a model behaviour: an
 * implementation that cannot resolve a model's answer to a supplied candidate
 * must abstain, not guess. Thrown by `finalizeSelect`, which every
 * implementation returns through.
 */
export class SelectContractError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "SelectContractError";
  }
}

/**
 * The implementation ran but produced nothing resolvable, on a request that
 * did not allow abstention.
 *
 * Kept distinct from `SelectContractError` because it is not an adapter bug —
 * the model genuinely answered with something outside the option set. The
 * caller's choice is to retry, to re-ask with abstention allowed, or to record
 * the field as unresolved. What it must not do is accept an arbitrary pick,
 * which is why this throws instead of returning the first option.
 */
export class SelectNoAnswerError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "SelectNoAnswerError";
  }
}

/**
 * The implementation cannot run in this environment: a local model whose
 * weights are not on disk, a hosted service with no credential configured.
 *
 * Distinct from a failure, because the caller's correct response is different:
 * fall back to another implementation (the OSS default always runs), or tell
 * the operator what to install. Never retry.
 */
export class SelectUnavailableError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "SelectUnavailableError";
  }
}
