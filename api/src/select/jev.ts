/**
 * Jev — TypeSafe's hosted System-1 model, behind `select` and `adjudicate`.
 *
 * `POST https://api.typesafe.ai/v1/systemone`, one question per call, Bearer
 * auth. It cannot generate text; it can only choose from options you hand it
 * or return P(true) for a proposition. That constraint is why it fits these
 * two capabilities exactly and nothing else in the engine.
 *
 * It is **not** the OSS default and nothing depends on it. Koji's default
 * `select` runs on a BYO chat key, and this adapter is one of three
 * interchangeable implementations behind the same contract — which is also the
 * answer to vendor concentration. The service is young and its own docs say
 * the rate limits move without notice; an interface makes that survivable,
 * and `parity.test.ts` is what proves the replacement is like-for-like.
 *
 * The credential is a tenant credential (`provider: "typesafe"`), resolved and
 * decrypted the same way every other model key is — see `resolve-select.ts`.
 * The env var is a local-dev / CI fallback only.
 */

import { assertAdjudicationAllowed } from "./adjudicate";
import { clamp01, finalizeSelect, noInformationSelect, validateSelectRequest } from "./invariants";
import {
  QUESTION_KEY,
  buildChoiceQuestion,
  buildEquivalenceQuestion,
  estimateStateTokens,
  parseChoiceAnswer,
  parseNoulAnswer,
  parseUsage,
  serializeState,
  type SystemOneQuestion,
  type SystemOneResponse,
} from "./system-one";
import {
  ABSTAIN,
  SelectRequestError,
  SelectUnavailableError,
  type AdjudicateField,
  type AdjudicateProvider,
  type AdjudicateResult,
  type SelectCandidate,
  type SelectOptions,
  type SelectProvider,
  type SelectResult,
  type SelectState,
} from "./types";

export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** Documented Choice option ceiling for the service. */
export const JEV_MAX_OPTIONS = 255;

/**
 * State budget, in tokens, for state plus the longest question. Enforced
 * locally so an oversized state fails as a `SelectRequestError` the caller can
 * act on (window the state, drop candidates) rather than as an opaque 4xx
 * after a round trip.
 */
export const JEV_STATE_TOKEN_BUDGET = 32_000;

/**
 * Headroom left for the question block. A Choice question carrying 80 option
 * lines is not free, and a state sized to the full budget would push the
 * request over it.
 */
const QUESTION_TOKEN_RESERVE = 4_000;

export interface JevOptions {
  apiKey: string;
  model?: string;
  apiUrl?: string;
  /** Per-call timeout. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  name?: string;
}

/** An HTTP failure from the System-1 API, carrying the status for the caller. */
export class JevHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JevHttpError";
  }
}

class JevClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  readonly model: string;

  constructor(opts: JevOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new SelectUnavailableError(
        "jev",
        "no TypeSafe credential. Add one under Settings → Model Catalog " +
          '(provider "typesafe", capability "select"), or set TYPESAFE_API_KEY for local use.',
      );
    }
    this.apiKey = opts.apiKey.trim();
    this.apiUrl = opts.apiUrl ?? JEV_API_URL;
    this.model = opts.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  async ask(state: unknown, question: SystemOneQuestion): Promise<SystemOneResponse> {
    const resp = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        model: this.model,
        questions: { [QUESTION_KEY]: question },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new JevHttpError(resp.status, `Jev ${resp.status}: ${detail.slice(0, 400)}`);
    }
    return (await resp.json()) as SystemOneResponse;
  }
}

/** Fail locally on an oversized state rather than after a round trip. */
function assertStateFits(provider: string, chars: number): void {
  const tokens = estimateStateTokens(chars);
  const budget = JEV_STATE_TOKEN_BUDGET - QUESTION_TOKEN_RESERVE;
  if (tokens > budget) {
    throw new SelectRequestError(
      `${provider}: state is ~${tokens.toLocaleString()} tokens, over the ${budget.toLocaleString()}-token ` +
        "budget. Send a windowed state (the text around each candidate) instead of the whole document — " +
        "state size should track the candidate count, not the document length.",
    );
  }
}

export class JevSelectProvider implements SelectProvider {
  readonly name: string;
  readonly maxOptions = JEV_MAX_OPTIONS;
  private readonly client: JevClient;

  constructor(opts: JevOptions) {
    this.name = opts.name ?? "jev";
    this.client = new JevClient(opts);
  }

  async select(
    state: SelectState,
    options: readonly SelectCandidate[],
    instructions: string,
    opts: SelectOptions = {},
  ): Promise<SelectResult> {
    const byValue = validateSelectRequest(this.name, options, this.maxOptions);
    const allowAbstain = opts.allowAbstain ?? true;
    const serialized = serializeState(state);
    assertStateFits(this.name, serialized.chars);

    const question = buildChoiceQuestion(options, instructions, {
      allowAbstain,
      ...(opts.abstainNote !== undefined ? { abstainNote: opts.abstainNote } : {}),
    });
    const resp = await this.client.ask(serialized.state, question);
    const parsed = parseChoiceAnswer(resp.answers?.[QUESTION_KEY]);

    // A choice outside the option set, or a shape we can't read, abstains. The
    // service picks from a closed set so this should not happen; if a response
    // shape changes it must degrade to "no answer", never to a passed-through
    // string.
    const resolvable = parsed.choice !== null && (parsed.choice === ABSTAIN || byValue.has(parsed.choice));
    if (!resolvable) {
      console.warn(
        `[koji-select] ${this.name}: unreadable choice ${JSON.stringify(
          (parsed.choice ?? "").slice(0, 80),
        )} — abstaining`,
      );
      if (!allowAbstain) {
        throw new SelectUnavailableError(
          this.name,
          "the service returned no readable choice and this request did not allow abstention",
        );
      }
      return noInformationSelect({ provider: this.name, byValue });
    }

    const usage = parseUsage(resp);
    return finalizeSelect({
      provider: this.name,
      byValue,
      allowAbstain,
      choice: parsed.choice as string,
      ...(parsed.probabilities ? { probabilities: parsed.probabilities } : {}),
      ...(parsed.confidence !== undefined ? { reportedConfidence: parsed.confidence } : {}),
      calibrated: parsed.probabilities !== undefined,
      ...(usage ? { usage } : {}),
    });
  }
}

export class JevAdjudicateProvider implements AdjudicateProvider {
  readonly name: string;
  private readonly client: JevClient;

  constructor(opts: JevOptions) {
    this.name = opts.name ?? "jev-adjudicate";
    this.client = new JevClient(opts);
  }

  async adjudicate(
    expected: unknown,
    got: unknown,
    field: AdjudicateField,
  ): Promise<AdjudicateResult> {
    assertAdjudicationAllowed(this.name);

    const question = buildEquivalenceQuestion(renderValue(expected), renderValue(got), field);
    const resp = await this.client.ask({ comparison: field.name }, question);
    const parsed = parseNoulAnswer(resp.answers?.[QUESTION_KEY]);

    if (parsed.noul === null) {
      // No probability came back. Defaulting either way would invent a verdict
      // and quietly move a corpus score.
      throw new Error(`${this.name}: response carried no probability for the equivalence question`);
    }

    const p = clamp01(parsed.noul);
    const usage = parseUsage(resp);
    return {
      equivalent: p >= 0.5,
      // The confidence in the reported answer, not in "true": a 0.1 P(true) is
      // a confident "not equivalent".
      confidence: clamp01(parsed.confidence ?? Math.max(p, 1 - p)),
      calibrated: true,
      provider: this.name,
      ...(usage ? { usage } : {}),
    };
  }
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "string") return value.length > 0 ? value : "(empty)";
  return JSON.stringify(value);
}

/**
 * The TypeSafe key from the environment, for local development and CI only.
 *
 * Production resolves the tenant's own credential (encrypted at rest,
 * decrypted per call) — see `resolve-select.ts`. This exists so a self-hosted
 * operator and the parity suite can exercise the hosted implementation without
 * a database.
 */
export function typesafeKeyFromEnv(): string | null {
  const key = process.env.TYPESAFE_API_KEY ?? process.env.KOJI_TYPESAFE_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}
