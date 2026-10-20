/**
 * The System-1 request/response shape, shared by the hosted and local
 * implementations.
 *
 * Both answer the same three primitives over a state:
 *   - **Choice** — pick one of an enumerated option set, with a probability
 *     over every option. This is `select`.
 *   - **Noul** — P(true) for a single proposition. This is `adjudicate`.
 *   - **Score** — an expected level over ordered bands. Not used yet; the type
 *     is here because the wire format carries it and silently dropping a
 *     primitive from the adapter is how a capability gap starts.
 *
 * Keeping the question builders and answer parsers in one module is what makes
 * "the local implementation satisfies the same contract as the hosted one"
 * cheap to hold true: the only difference between the two adapters is the
 * transport — an HTTPS POST versus an in-process ONNX forward pass.
 */

import { ABSTAIN, type SelectCandidate, type SelectState } from "./types";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option -> one-line criteria (or null for no elaboration) */
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** ordered levels, index 0 = lowest */
  criteria: string[];
}

export type SystemOneQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface SystemOneUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface SystemOneRequest {
  state: unknown;
  model?: string;
  questions: Record<string, SystemOneQuestion>;
}

export interface SystemOneResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: SystemOneUsage;
}

/** The single question key both adapters use — one question per call. */
export const QUESTION_KEY = "q0";

// ---------------------------------------------------------------------------
// Question building
// ---------------------------------------------------------------------------

/**
 * Build the Choice question for a candidate set.
 *
 * Each option's criteria names how the source writes it (and, for a windowed
 * state, that the window is above). Everything the selector needs goes inline
 * in the instructions rather than being referenced out of the state —
 * indirection is a documented weak spot for this class of model, so the
 * question states its condition outright.
 */
export function buildChoiceQuestion(
  options: readonly SelectCandidate[],
  instructions: string,
  opts: { allowAbstain: boolean; abstainNote?: string },
): ChoiceQuestion {
  const criteria: Record<string, string | null> = {};
  for (const candidate of options) {
    criteria[candidate.value] = candidateNote(candidate);
  }
  if (opts.allowAbstain) {
    criteria[ABSTAIN] =
      opts.abstainNote ?? "the state gives no value for this — none of the options above apply";
  }
  return { type: "choice", instructions, criteria };
}

/** One line of criteria for an option: the caller's note, else how the source writes it. */
export function candidateNote(candidate: SelectCandidate): string | null {
  if (candidate.note) return candidate.note;
  if (candidate.raw && candidate.raw !== candidate.value) {
    return `written in the source as "${candidate.raw}"`;
  }
  return null;
}

/**
 * Build the Noul question for an equivalence judgement.
 *
 * The criteria spell out that normalization counts as equivalent. Without
 * that, the honest answer to "does the source state this value" is *false*
 * for a correctly normalized extraction — a currency code read off a currency
 * symbol — and the judge gets punished for being right. Asking the question
 * the label actually encodes is what moved this from ranking errors to
 * agreeing with a human.
 */
export function buildEquivalenceQuestion(
  expectedText: string,
  gotText: string,
  field: { name: string; description?: string; type?: string; match?: string },
): NoulQuestion {
  const described = field.description ? ` (${field.description})` : "";
  const typed = field.type ? ` of type ${field.type}` : "";
  const policy = field.match ? `\n\nThe field declares the equivalence policy: ${field.match}.` : "";
  return {
    type: "noul",
    instructions:
      `Two values are recorded for the field "${field.name}"${described}${typed}.\n\n` +
      `Reference value:\n${expectedText}\n\n` +
      `Value under test:\n${gotText}\n\n` +
      `Do these two mean the same thing for this field?${policy}`,
    criteria: {
      true:
        "The two values mean the same thing for this field. They count as the same even when " +
        "one has been reformatted, normalized, abbreviated or expanded — a currency code for a " +
        "currency symbol, a full name for an abbreviation, a date written differently, a name " +
        "without its title, different capitalization, whitespace or punctuation.",
      false:
        "The two values mean something different for this field, or one of them is empty while " +
        "the other is not, or they differ in a way that would matter to someone reading the field.",
    },
  };
}

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

export interface ParsedChoiceAnswer {
  choice: string | null;
  probabilities: Record<string, number> | undefined;
  confidence: number | undefined;
}

/**
 * Pull a Choice answer out of a response, tolerating shape drift.
 *
 * Both implementations are young and version their response shape; accepting a
 * couple of spellings keeps a minor-version change from silently zeroing every
 * selection instead of failing loudly. A shape we genuinely cannot read
 * returns `choice: null`, and the adapter abstains — never a guess.
 */
export function parseChoiceAnswer(answer: unknown): ParsedChoiceAnswer {
  if (typeof answer === "string") {
    return { choice: answer, probabilities: undefined, confidence: undefined };
  }
  if (!isRecord(answer)) {
    return { choice: null, probabilities: undefined, confidence: undefined };
  }
  const choice = firstString(answer, ["choice", "answer", "selected", "value"]);
  const probabilities = isRecord(answer.probabilities)
    ? numericRecord(answer.probabilities)
    : undefined;
  const confidence = firstNumber(answer, ["confidence"]);
  return { choice, probabilities, confidence };
}

/**
 * Pull P(true) out of a Noul answer. Returns null when no numeric probability
 * is present — the adapter surfaces that rather than defaulting to 0.5, which
 * would read as "genuinely uncertain" when the truth is "no answer".
 */
export function parseNoulAnswer(answer: unknown): { noul: number | null; confidence: number | null } {
  if (typeof answer === "number") {
    return { noul: Number.isFinite(answer) ? answer : null, confidence: null };
  }
  if (!isRecord(answer)) return { noul: null, confidence: null };
  const noul = firstNumber(answer, ["noul", "probability", "value", "score", "p_true"]);
  const confidence = firstNumber(answer, ["answer_confidence", "confidence"]);
  return { noul: noul ?? null, confidence: confidence ?? null };
}

export function parseUsage(resp: SystemOneResponse | undefined): {
  inputTokens?: number;
  outputTokens?: number;
} | undefined {
  const usage = resp?.usage;
  if (!usage) return undefined;
  const out: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof usage.input_tokens === "number") out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") out.outputTokens = usage.output_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// State sizing
// ---------------------------------------------------------------------------

/**
 * Chars per token, measured against billed usage rather than guessed. The
 * naive 4.0 over-projected by ~27% on markdown documents.
 */
export const CHARS_PER_TOKEN = 5.09;

/** Serialize a state for transport, and report its size in characters. */
export function serializeState(state: SelectState): { state: unknown; chars: number } {
  if (typeof state === "string") return { state, chars: state.length };
  const json = JSON.stringify(state);
  return { state, chars: json.length };
}

/** Rough token count for a serialized state, for budget checks. */
export function estimateStateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function firstNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function numericRecord(obj: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
