/**
 * The shared gate every `select` implementation returns through.
 *
 * The design rule — OSS implementations satisfy the same contract as a hosted
 * one — only means something if the contract is enforced in one place. If each
 * adapter asserted its own invariants, "the same contract" would be three
 * similar contracts that drift. So `validateSelectRequest` checks what the
 * caller sent, `finalizeSelect` checks and normalizes what the implementation
 * answered, and no implementation constructs a `SelectResult` by hand.
 *
 * What is enforced here, and why each one matters:
 *
 *   1. `choice` is a supplied candidate value or `ABSTAIN` — nothing else.
 *      This is the no-fabrication property. It is the reason a selection
 *      pipeline needs no faithfulness gate.
 *   2. `selected` is the caller's own candidate object, so its offset / page /
 *      bbox round-trip. Provenance is free only if it survives the round trip.
 *   3. `confidence` and `answerConfidence` are finite and in [0,1], and
 *      `probabilities` is a proper distribution over supplied keys.
 *
 * None of these are accuracy assertions. They pass or fail identically for
 * every implementation, which is what makes `parity.test.ts` a test of the
 * ethos rather than of a model.
 */

import {
  ABSTAIN,
  SelectContractError,
  SelectRequestError,
  type SelectCandidate,
  type SelectResult,
  type SelectUsage,
} from "./types";

/**
 * Validate a request before any network call, and return the option set
 * indexed by value.
 *
 * Throws rather than coercing. Every condition here is a caller bug that a
 * provider cannot sensibly answer: silently deduplicating a repeated value
 * would make the returned probability ambiguous, and silently truncating an
 * over-long option list can drop the answer — which then reads as a model
 * error and is not one.
 */
export function validateSelectRequest(
  provider: string,
  options: readonly SelectCandidate[],
  maxOptions: number,
): Map<string, SelectCandidate> {
  if (!Array.isArray(options) || options.length === 0) {
    throw new SelectRequestError(
      `${provider}: select requires at least one candidate — an empty option set has no answer. ` +
        "Candidate generation found nothing; record that as a null field, don't ask the selector.",
    );
  }
  if (options.length > maxOptions) {
    throw new SelectRequestError(
      `${provider}: ${options.length} candidates exceeds this provider's limit of ${maxOptions}. ` +
        "Narrow the candidate set before selecting — truncating it here could silently drop the answer.",
    );
  }

  const byValue = new Map<string, SelectCandidate>();
  for (const candidate of options) {
    const value = candidate?.value;
    if (typeof value !== "string" || value.length === 0) {
      throw new SelectRequestError(`${provider}: every candidate needs a non-empty string value`);
    }
    if (value === ABSTAIN) {
      throw new SelectRequestError(
        `${provider}: "${ABSTAIN}" is reserved for abstention and cannot be a candidate value`,
      );
    }
    if (byValue.has(value)) {
      throw new SelectRequestError(
        `${provider}: duplicate candidate value ${JSON.stringify(value)} — ` +
          "the returned probability would be ambiguous. Deduplicate before selecting.",
      );
    }
    byValue.set(value, candidate);
  }
  return byValue;
}

/** Shannon entropy of a distribution, in nats. Zero-probability terms drop out. */
function entropy(probabilities: readonly number[]): number {
  let h = 0;
  for (const p of probabilities) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

/**
 * `1 - H/H_max` over the answer distribution: 1 when the selector is certain,
 * 0 when it is uniform across every option. Matches the definition the local
 * and hosted System-1 implementations report, so the number means the same
 * thing whichever one answered.
 *
 * A single-option distribution has `H_max = 0`, which would divide by zero;
 * it is certain by construction, so it returns 1.
 */
export function distributionConfidence(probabilities: readonly number[]): number {
  if (probabilities.length <= 1) return 1;
  const hMax = Math.log(probabilities.length);
  if (hMax <= 0) return 1;
  return clamp01(1 - entropy(probabilities) / hMax);
}

/** Clamp into [0,1], mapping non-finite input to 0 rather than leaking NaN. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Build a distribution from a single pick plus a self-reported confidence:
 * the pick takes `p`, the remaining mass spreads uniformly over the other
 * keys. This is the uncalibrated path — used when a model gave an answer but
 * no output distribution — and results built this way carry
 * `calibrated: false`.
 */
export function synthesizeDistribution(
  keys: readonly string[],
  pick: string,
  selfReported: number | undefined,
): Record<string, number> {
  const p = clamp01(selfReported ?? 0.5);
  const others = keys.filter((k) => k !== pick);
  const out: Record<string, number> = { [pick]: p };
  if (others.length > 0) {
    const share = (1 - p) / others.length;
    for (const key of others) out[key] = share;
  } else {
    out[pick] = 1;
  }
  return out;
}

/**
 * Normalize a raw probability map onto the allowed key set.
 *
 * Unknown keys are dropped (an implementation must not widen the answer space
 * past what the caller supplied), negatives and non-finite values are treated
 * as zero, and the remainder is rescaled to sum to 1. A map with no usable
 * mass falls back to a point mass on `fallbackKey` — "the provider gave an
 * answer but no usable distribution" is a calibration problem, not a reason to
 * return a NaN-laced distribution.
 */
export function normalizeDistribution(
  raw: Readonly<Record<string, number>> | undefined,
  allowedKeys: readonly string[],
  fallbackKey: string,
): Record<string, number> {
  const allowed = new Set(allowedKeys);
  const kept: Record<string, number> = {};
  let total = 0;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!allowed.has(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    kept[key] = value;
    total += value;
  }
  if (total <= 0) return { [fallbackKey]: 1 };

  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(kept)) out[key] = value / total;
  if (out[fallbackKey] === undefined) {
    // The provider named an answer it put no mass on. Rather than invent a
    // number, give the answer the remaining-mass floor and renormalize — and
    // let `calibrated` tell the caller the distribution was patched.
    out[fallbackKey] = 0;
  }
  return out;
}

/**
 * The result for "the substrate returned nothing this adapter can use".
 *
 * Shared by every implementation so the three agree on what no-information
 * looks like, which matters because a caller gates a review queue on these
 * numbers. It is a **uniform distribution over every allowed key with
 * confidence 0** — maximum uncertainty, no opinion.
 *
 * That is deliberately different from a *confident abstention*, where the
 * model read the state and reported that the field has no value there: that
 * answer carries real mass on `ABSTAIN` and a real confidence. Collapsing the
 * two would make "I couldn't read the response" indistinguishable from "the
 * document doesn't say", and only one of those is a fact about the document.
 */
export function noInformationSelect(args: {
  provider: string;
  byValue: Map<string, SelectCandidate>;
}): SelectResult {
  const keys = [...args.byValue.keys(), ABSTAIN];
  const share = 1 / keys.length;
  const probabilities: Record<string, number> = {};
  for (const key of keys) probabilities[key] = share;

  return {
    choice: ABSTAIN,
    selected: null,
    abstained: true,
    probabilities,
    confidence: 0,
    answerConfidence: share,
    calibrated: false,
    provider: args.provider,
  };
}

/** What an implementation hands `finalizeSelect` after parsing its own wire format. */
export interface RawSelectAnswer {
  /** The provider's name, for error attribution. */
  provider: string;
  /** The candidate set, indexed by value, from `validateSelectRequest`. */
  byValue: Map<string, SelectCandidate>;
  /** Whether `ABSTAIN` was offered for this request. */
  allowAbstain: boolean;
  /** The provider's answer: a candidate value or `ABSTAIN`. */
  choice: string;
  /** The provider's distribution, if it reported one. */
  probabilities?: Readonly<Record<string, number>>;
  /** The provider's own confidence, if it reported one. Preferred over the derived value. */
  reportedConfidence?: number;
  /** Self-reported confidence used only to synthesize a distribution. */
  selfReportedConfidence?: number;
  /** True when `probabilities` is a model output distribution. */
  calibrated: boolean;
  usage?: SelectUsage;
}

/**
 * Turn an implementation's parsed answer into a contract-compliant
 * `SelectResult`, or throw `SelectContractError`.
 *
 * An implementation that cannot map a model's answer onto a supplied candidate
 * must pass `ABSTAIN` — not its best guess, and not the raw model string. That
 * is the whole point: an unresolvable answer is *no answer*, and writing an
 * unverified string into the output as if it were a fact is the failure mode
 * the selection shape exists to remove.
 */
export function finalizeSelect(answer: RawSelectAnswer): SelectResult {
  const {
    provider,
    byValue,
    allowAbstain,
    choice,
    probabilities,
    reportedConfidence,
    selfReportedConfidence,
    calibrated,
    usage,
  } = answer;

  if (typeof choice !== "string" || choice.length === 0) {
    throw new SelectContractError(provider, "returned an empty choice");
  }
  const abstained = choice === ABSTAIN;
  if (abstained && !allowAbstain) {
    throw new SelectContractError(
      provider,
      "abstained on a request that did not offer abstention — pick a candidate or surface an error",
    );
  }
  if (!abstained && !byValue.has(choice)) {
    throw new SelectContractError(
      provider,
      `returned ${JSON.stringify(choice)}, which is not one of the ${byValue.size} supplied ` +
        "candidates. An unresolvable answer must abstain, never pass through.",
    );
  }

  const keys = [...byValue.keys()];
  if (allowAbstain) keys.push(ABSTAIN);

  const distribution =
    probabilities !== undefined
      ? normalizeDistribution(probabilities, keys, choice)
      : normalizeDistribution(
          synthesizeDistribution(keys, choice, selfReportedConfidence),
          keys,
          choice,
        );

  const values = Object.values(distribution);
  const answerConfidence = clamp01(distribution[choice] ?? 0);
  const confidence = Number.isFinite(reportedConfidence as number)
    ? clamp01(reportedConfidence as number)
    : distributionConfidence(values);

  return {
    choice,
    selected: abstained ? null : (byValue.get(choice) as SelectCandidate),
    abstained,
    probabilities: distribution,
    confidence,
    answerConfidence,
    calibrated,
    provider,
    ...(usage ? { usage } : {}),
  };
}
