/**
 * LLM-choice — the OSS default for `select` and `adjudicate`.
 *
 * Runs on nothing but a BYO key: it constrains an ordinary chat model to pick
 * one label out of an enumerated list. No hosted service, no model weights, no
 * extra dependency. That is the point — the architectural wins of
 * candidate-selection come from the *shape*, so an operator with their own
 * OpenAI (or Ollama, or Azure, or anything OpenAI-compatible) key gets zero
 * fabrication, free provenance and per-field confidence without buying
 * anything.
 *
 * Two paths, and the difference is calibration only:
 *
 *   - **Calibrated.** When the endpoint can report token logprobs
 *     (`ModelProvider.labelProbabilities`) and the option set fits inside the
 *     logprob window, the probabilities are the model's own distribution over
 *     the label tokens. `calibrated: true`.
 *   - **Text.** Otherwise the model answers with JSON naming its label and a
 *     self-reported confidence, and the distribution is synthesized from it.
 *     `calibrated: false`, because a model's self-reported confidence is
 *     conservatively calibrated noise and the result should say so.
 *
 * Both paths return through `finalizeSelect`, so both satisfy the same
 * contract a hosted implementation does. An answer that cannot be resolved to
 * a supplied candidate abstains — it never passes the model's raw string
 * through as a value.
 */

import type { ModelProvider } from "../extract/providers";
import { MAX_LOGPROB_LABELS } from "../extract/providers";
import { assertAdjudicationAllowed } from "./adjudicate";
import { clamp01, finalizeSelect, noInformationSelect, validateSelectRequest } from "./invariants";
import { candidateNote } from "./system-one";
import {
  ABSTAIN,
  type AdjudicateField,
  type AdjudicateProvider,
  type AdjudicateResult,
  type SelectCandidate,
  type SelectOptions,
  type SelectProvider,
  type SelectResult,
  type SelectState,
  SelectNoAnswerError,
} from "./types";

/**
 * Labels handed to the model, one per option, in order. Single uppercase
 * letters so each is one token for every mainstream tokenizer — which is what
 * makes the logprob path exact. Capped at 26; past that the text path runs.
 */
const LABEL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Hard ceiling on the option set. High-cardinality choice is a known weak
 * spot for every implementation of this primitive, and an option list that
 * long is almost always a candidate-generation bug rather than a real
 * ambiguity. Callers that genuinely need more should narrow first.
 */
export const LLM_CHOICE_MAX_OPTIONS = 80;

/** Default confidence credited to a text-path answer that reported none. */
const DEFAULT_SELF_REPORTED = 0.5;

export interface LlmChoiceOptions {
  /** Override the provider name reported in traces. */
  name?: string;
  /** Cap the option set lower than the default. */
  maxOptions?: number;
  /**
   * Skip the logprob path even where the endpoint supports it. For
   * reproducing the text path in tests, and for endpoints that accept
   * `logprobs` and return nonsense.
   */
  forceTextPath?: boolean;
}

export class LlmChoiceSelectProvider implements SelectProvider {
  readonly name: string;
  readonly maxOptions: number;
  private readonly forceTextPath: boolean;

  constructor(
    private readonly model: ModelProvider,
    opts: LlmChoiceOptions = {},
  ) {
    this.name = opts.name ?? "llm-choice";
    this.maxOptions = Math.max(1, Math.min(opts.maxOptions ?? LLM_CHOICE_MAX_OPTIONS, LLM_CHOICE_MAX_OPTIONS));
    this.forceTextPath = opts.forceTextPath ?? false;
  }

  async select(
    state: SelectState,
    options: readonly SelectCandidate[],
    instructions: string,
    opts: SelectOptions = {},
  ): Promise<SelectResult> {
    const byValue = validateSelectRequest(this.name, options, this.maxOptions);
    const allowAbstain = opts.allowAbstain ?? true;
    const labelled = assignLabels(options, allowAbstain, opts.abstainNote);

    if (this.canUseLogprobs(labelled)) {
      const result = await this.selectByLogprobs(state, labelled, instructions, byValue, allowAbstain);
      if (result) return result;
      // No distribution came back (an OpenAI-compatible server that ignores
      // the parameter). Fall through rather than fail — a working answer with
      // honest `calibrated: false` beats an error.
    }
    return this.selectByText(state, labelled, instructions, byValue, allowAbstain);
  }

  private canUseLogprobs(labelled: LabelledOption[]): boolean {
    if (this.forceTextPath) return false;
    if (typeof this.model.labelProbabilities !== "function") return false;
    return labelled.length <= MAX_LOGPROB_LABELS;
  }

  private async selectByLogprobs(
    state: SelectState,
    labelled: LabelledOption[],
    instructions: string,
    byValue: Map<string, SelectCandidate>,
    allowAbstain: boolean,
  ): Promise<SelectResult | null> {
    const labels = labelled.map((l) => l.label);
    const prompt = buildChoicePrompt(state, labelled, instructions, "label");
    const raw = await this.model.labelProbabilities!(prompt, labels);
    const entries = Object.entries(raw).filter(([, p]) => Number.isFinite(p) && p > 0);
    if (entries.length === 0) return null;

    const probabilities: Record<string, number> = {};
    for (const [label, p] of entries) {
      const option = labelled.find((l) => l.label === label);
      if (option) probabilities[option.value] = (probabilities[option.value] ?? 0) + p;
    }
    if (Object.keys(probabilities).length === 0) return null;

    const choice = Object.entries(probabilities).reduce(
      (best, entry) => (entry[1] > best[1] ? entry : best),
      ["", -1] as [string, number],
    )[0];

    return finalizeSelect({
      provider: this.name,
      byValue,
      allowAbstain,
      choice,
      probabilities,
      calibrated: true,
    });
  }

  private async selectByText(
    state: SelectState,
    labelled: LabelledOption[],
    instructions: string,
    byValue: Map<string, SelectCandidate>,
    allowAbstain: boolean,
  ): Promise<SelectResult> {
    const prompt = buildChoicePrompt(state, labelled, instructions, "json");
    const text = await this.model.generate(prompt, true);
    const parsed = parseChoiceText(text);
    const resolved = resolveToValue(parsed.choice, labelled);

    if (resolved === null) {
      // The model said something we cannot map onto a candidate. Abstaining is
      // the only honest answer: passing its string through would fabricate a
      // value, and guessing the nearest option would invent a fact.
      console.warn(
        `[koji-select] ${this.name}: could not resolve ${JSON.stringify(
          (parsed.choice ?? "").slice(0, 80),
        )} to one of ${labelled.length} options — abstaining`,
      );
      if (!allowAbstain) {
        // Abstention was not offered and there is nothing to return. Picking
        // an arbitrary option would be a fabricated selection wearing a
        // confidence number; surface it instead.
        throw new SelectNoAnswerError(
          this.name,
          `the model's answer could not be resolved to any of the ${labelled.length} options ` +
            "and this request did not allow abstention",
        );
      }
      return noInformationSelect({ provider: this.name, byValue });
    }

    return finalizeSelect({
      provider: this.name,
      byValue,
      allowAbstain,
      choice: resolved,
      selfReportedConfidence: parsed.confidence ?? DEFAULT_SELF_REPORTED,
      calibrated: false,
    });
  }
}

// ---------------------------------------------------------------------------
// adjudicate
// ---------------------------------------------------------------------------

export class LlmAdjudicateProvider implements AdjudicateProvider {
  readonly name: string;

  constructor(
    private readonly model: ModelProvider,
    opts: { name?: string } = {},
  ) {
    this.name = opts.name ?? "llm-adjudicate";
  }

  async adjudicate(
    expected: unknown,
    got: unknown,
    field: AdjudicateField,
  ): Promise<AdjudicateResult> {
    assertAdjudicationAllowed(this.name);

    const prompt = buildAdjudicatePrompt(expected, got, field);
    const text = await this.model.generate(prompt, true);
    const parsed = parseAdjudicateText(text);

    if (parsed === null) {
      // An unparseable verdict is no verdict. Reporting `equivalent: false`
      // with high confidence would silently add a scorer failure the model
      // never claimed; reporting `true` would silently erase one.
      throw new Error(
        `${this.name}: could not parse an equivalence verdict from the model response`,
      );
    }

    return {
      equivalent: parsed.equivalent,
      confidence: clamp01(parsed.confidence ?? DEFAULT_SELF_REPORTED),
      calibrated: false,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      provider: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export interface LabelledOption {
  label: string;
  value: string;
  note: string | null;
  isAbstain: boolean;
}

/**
 * Pair each option with a label. Beyond the 26-letter alphabet, labels become
 * ordinals (`27`, `28`, …) — the text path handles those fine and the logprob
 * path is already excluded by the option count.
 */
export function assignLabels(
  options: readonly SelectCandidate[],
  allowAbstain: boolean,
  abstainNote?: string,
): LabelledOption[] {
  const out: LabelledOption[] = options.map((candidate, i) => ({
    label: LABEL_ALPHABET[i] ?? String(i + 1),
    value: candidate.value,
    note: candidateNote(candidate),
    isAbstain: false,
  }));
  if (allowAbstain) {
    const i = out.length;
    out.push({
      label: LABEL_ALPHABET[i] ?? String(i + 1),
      value: ABSTAIN,
      note: abstainNote ?? "none of the options above — the source gives no value for this",
      isAbstain: true,
    });
  }
  return out;
}

function renderState(state: SelectState): string {
  return typeof state === "string" ? state : JSON.stringify(state, null, 2);
}

/**
 * The prompt. Options are listed with their label, their value and (where it
 * differs) how the source writes it. The answer format is the only thing that
 * changes between the two paths: a bare label for logprobs, JSON for text.
 */
export function buildChoicePrompt(
  state: SelectState,
  labelled: readonly LabelledOption[],
  instructions: string,
  answerFormat: "label" | "json",
): string {
  const lines = labelled.map((option) => {
    const body = option.isAbstain ? "(none of the above)" : option.value;
    return option.note ? `${option.label}. ${body} — ${option.note}` : `${option.label}. ${body}`;
  });

  const answer =
    answerFormat === "label"
      ? "Answer with the single label of the correct option and nothing else. No explanation, no punctuation."
      : 'Answer with JSON only: {"choice": "<label>", "confidence": <0.0-1.0>}. ' +
        "`confidence` is how sure you are that this label is the right one.";

  return [
    "SOURCE",
    renderState(state),
    "",
    "TASK",
    instructions.trim(),
    "",
    "Every option below is already present in the source, or is the explicit " +
      '"none" option. You must answer with one of these labels — do not write a ' +
      "value of your own, and do not combine options.",
    "",
    "OPTIONS",
    ...lines,
    "",
    answer,
  ].join("\n");
}

export function buildAdjudicatePrompt(
  expected: unknown,
  got: unknown,
  field: AdjudicateField,
): string {
  const described = field.description ? ` (${field.description})` : "";
  const typed = field.type ? `\nField type: ${field.type}` : "";
  const policy = field.match ? `\nDeclared equivalence policy: ${field.match}` : "";
  return [
    `Two values are recorded for the field "${field.name}"${described}.${typed}${policy}`,
    "",
    "REFERENCE VALUE",
    stringifyValue(expected),
    "",
    "VALUE UNDER TEST",
    stringifyValue(got),
    "",
    "Do these two mean the same thing for this field?",
    "",
    "They count as the same even when one has been reformatted, normalized, " +
      "abbreviated or expanded — a currency code for a currency symbol, a full " +
      "name for an abbreviation, a date written differently, a name without its " +
      "title, different capitalization, whitespace or punctuation. They are " +
      "different when they would mean different things to someone reading the " +
      "field, or when one is empty and the other is not.",
    "",
    'Answer with JSON only: {"equivalent": true|false, "confidence": <0.0-1.0>, "reason": "<one short line>"}',
  ].join("\n");
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "string") return value.length > 0 ? value : "(empty)";
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Strip a fenced code block, then parse the first JSON object in the text.
 * Models wrap JSON in prose and fences even under `response_format`, and an
 * unparsed answer here would abstain on a field the model actually answered.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseChoiceText(text: string): { choice: string | null; confidence?: number } {
  const obj = parseJsonObject(text);
  if (obj) {
    const raw = obj.choice ?? obj.answer ?? obj.label ?? obj.value;
    const confidence = typeof obj.confidence === "number" ? obj.confidence : undefined;
    if (typeof raw === "string") return { choice: raw, confidence };
    if (typeof raw === "number") return { choice: String(raw), confidence };
    return { choice: null, confidence };
  }
  // No JSON at all: a bare label or value is still an answer worth resolving.
  const trimmed = text.trim();
  return { choice: trimmed.length > 0 ? trimmed : null };
}

export function parseAdjudicateText(
  text: string,
): { equivalent: boolean; confidence?: number; reason?: string } | null {
  const obj = parseJsonObject(text);
  if (obj) {
    const raw = obj.equivalent ?? obj.equal ?? obj.same ?? obj.match;
    const confidence = typeof obj.confidence === "number" ? obj.confidence : undefined;
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : undefined;
    if (typeof raw === "boolean") return { equivalent: raw, confidence, reason };
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes") {
        return { equivalent: true, confidence, reason };
      }
      if (normalized === "false" || normalized === "no") {
        return { equivalent: false, confidence, reason };
      }
    }
    return null;
  }
  const normalized = text.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes") return { equivalent: true };
  if (normalized === "false" || normalized === "no") return { equivalent: false };
  return null;
}

/**
 * Resolve whatever the model said onto a candidate value, by a ladder of
 * increasingly tolerant matches. Returns null when none of them lands — and
 * the caller then abstains rather than guessing.
 *
 * The tolerance is deliberate and bounded: every rung resolves to a candidate
 * the caller supplied, so no rung can produce a value that is not in the set.
 */
export function resolveToValue(
  answer: string | null,
  labelled: readonly LabelledOption[],
): string | null {
  if (answer === null) return null;
  const trimmed = answer.trim();
  if (trimmed.length === 0) return null;

  // 1. Exact label.
  const byLabel = labelled.find((l) => l.label === trimmed);
  if (byLabel) return byLabel.value;

  // 2. Label after stripping surrounding punctuation and normalizing case
  //    ("A.", '"A"', "(a)").
  const bare = trimmed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toUpperCase();
  const byBareLabel = labelled.find((l) => l.label.toUpperCase() === bare);
  if (byBareLabel) return byBareLabel.value;

  // 3. A 1-based ordinal ("3", "option 3").
  const ordinal = /(?:^|\s)(\d{1,3})(?:\s|$|[.)])/.exec(trimmed);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    if (index >= 0 && index < labelled.length) return labelled[index]!.value;
  }

  // 4. The option's value, verbatim.
  const byValue = labelled.find((l) => l.value === trimmed);
  if (byValue) return byValue.value;

  // 5. The option's value, case- and whitespace-normalized.
  const normalized = normalizeForMatch(trimmed);
  const matches = labelled.filter((l) => normalizeForMatch(l.value) === normalized);
  if (matches.length === 1) return matches[0]!.value;

  // 6. The abstain option, named in words.
  if (/^(none|none of (the )?above|no value|n\/?a|null)$/i.test(trimmed)) {
    const abstain = labelled.find((l) => l.isAbstain);
    if (abstain) return abstain.value;
  }

  return null;
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

