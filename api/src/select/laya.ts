/**
 * laya — a local, open-source System-1 decision model behind `select` and
 * `adjudicate`.
 *
 * Same primitives and the same request/response shape as the hosted service,
 * run in-process through ONNX Runtime. No network call, no per-call cost, no
 * vendor. It is the answer to "what does an air-gapped install do for
 * calibrated selection".
 *
 * ## Verification status
 *
 * This adapter has been exercised end to end against the real model, not just
 * written against its types. `@receptron/laya` 0.2.0 exposes `Laya.load(opts)`
 * and `systemOne(state, questions) -> { model, answers, usage }`, with
 * `ChoiceAnswer { choice, probabilities, confidence, answer_confidence }` and
 * `NoulAnswer { noul, answer_confidence }`; with the package installed and the
 * ONNX bundle downloaded, the parity suite's live tier runs a real forward
 * pass through this code and every invariant holds — a genuine calibrated
 * distribution over the candidate set, with the chosen candidate's offset
 * intact.
 *
 * What that tier does *not* assert is accuracy, deliberately: on the parity
 * fixture the model answered with the wrong date at 0.14 confidence, which is
 * the behaviour the shape is supposed to produce (a wrong answer that routes
 * itself to review) and is not something a contract test should grade.
 *
 * The live tier skips when the package or the bundle is absent — loudly, and
 * `KOJI_PARITY_REQUIRE=1` turns that skip into a failure.
 *
 * ## Why it is an optional dependency
 *
 * `@receptron/laya` pulls in `onnxruntime-node`, a native binary of
 * considerable size, and the weights are a separate download. Making that a
 * hard dependency of the API would tax every install — including the ones that
 * never select — for a path most will not use. So it is loaded by dynamic
 * import at construction time and its absence is a `SelectUnavailableError`
 * naming the install command, not a crash and not a silent downgrade.
 *
 * Install it where you want it:
 *
 *     pnpm --filter @koji/api add @receptron/laya
 *     # weights download to $LAYA_CACHE (default ~/.cache/receptron-laya)
 *     # on first load, or point KOJI_LAYA_MODEL_DIR at an existing bundle
 *
 * It is intentionally absent from `api/package.json`, including as a
 * devDependency: a first load downloads the bundle from Hugging Face and the
 * whole tier takes ~100s, which is not a cost to put on every CI run for a
 * path a parity fixture already covers in milliseconds.
 */

import { assertAdjudicationAllowed } from "./adjudicate";
import { clamp01, finalizeSelect, noInformationSelect, validateSelectRequest } from "./invariants";
import {
  QUESTION_KEY,
  buildChoiceQuestion,
  buildEquivalenceQuestion,
  parseChoiceAnswer,
  parseNoulAnswer,
  parseUsage,
  serializeState,
  type SystemOneQuestion,
  type SystemOneResponse,
} from "./system-one";
import {
  ABSTAIN,
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

/** The npm package that carries the Node port. Not a dependency of this repo. */
export const LAYA_PACKAGE = "@receptron/laya";

/**
 * Option ceiling. The model is a classification head over the option set and
 * high-cardinality choice is its documented weak spot, so this is deliberately
 * tighter than the hosted service's 255.
 */
export const LAYA_MAX_OPTIONS = 64;

/**
 * The slice of `@receptron/laya` this adapter uses. Declared locally rather
 * than imported as a type, so the API typechecks and builds whether or not the
 * optional package is installed.
 */
export interface LayaSession {
  systemOne(
    state: unknown,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneResponse>;
  close?(): Promise<void>;
}

export interface LayaOptions {
  /**
   * Directory holding `laya.onnx`, `laya.onnx.data`, `laya_config.json` and
   * `tokenizer/`. When set, nothing is downloaded.
   */
  modelDir?: string;
  /** Hugging Face repo to pull the bundle from, when `modelDir` is unset. */
  repo?: string;
  /** Local cache root for a downloaded bundle. */
  cacheDir?: string;
  name?: string;
  maxOptions?: number;
  /**
   * Inject an already-loaded session. The parity suite uses this to exercise
   * the translation layer without the weights, and a long-lived caller uses it
   * to load the model once rather than per request.
   */
  session?: LayaSession;
}

/**
 * Load the optional package and open a session.
 *
 * The dynamic import is deliberate: a static import would make
 * `onnxruntime-node` a build-time dependency of the whole API. The specifier
 * is held in a variable so bundlers do not try to resolve it eagerly.
 */
export async function loadLayaSession(opts: LayaOptions = {}): Promise<LayaSession> {
  if (opts.session) return opts.session;

  const specifier = LAYA_PACKAGE;
  let mod: { Laya?: { load(o: Record<string, unknown>): Promise<LayaSession> } };
  try {
    mod = (await import(/* @vite-ignore */ specifier)) as typeof mod;
  } catch (err) {
    throw new SelectUnavailableError(
      "laya",
      `${LAYA_PACKAGE} is not installed. Run \`pnpm --filter @koji/api add ${LAYA_PACKAGE}\` to enable local ` +
        `selection, or leave it out and use the default BYO-key selector. (${
          err instanceof Error ? err.message : String(err)
        })`,
    );
  }
  if (!mod.Laya || typeof mod.Laya.load !== "function") {
    throw new SelectUnavailableError(
      "laya",
      `${LAYA_PACKAGE} is installed but exports no Laya.load — version mismatch. ` +
        "This adapter is written against the 0.2.x shape.",
    );
  }

  const modelDir = opts.modelDir ?? process.env.KOJI_LAYA_MODEL_DIR;
  const cacheDir = opts.cacheDir ?? process.env.LAYA_CACHE;
  try {
    return await mod.Laya.load({
      ...(modelDir ? { modelDir } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(cacheDir ? { cacheDir } : {}),
    });
  } catch (err) {
    throw new SelectUnavailableError(
      "laya",
      `could not load the model bundle${modelDir ? ` from ${modelDir}` : ""}. ` +
        "Point KOJI_LAYA_MODEL_DIR at a directory holding laya.onnx, laya.onnx.data, " +
        `laya_config.json and tokenizer/, or let it download on first load. (${
          err instanceof Error ? err.message : String(err)
        })`,
    );
  }
}

export class LayaSelectProvider implements SelectProvider {
  readonly name: string;
  readonly maxOptions: number;

  constructor(
    private readonly session: LayaSession,
    opts: { name?: string; maxOptions?: number } = {},
  ) {
    this.name = opts.name ?? "laya";
    this.maxOptions = Math.max(1, Math.min(opts.maxOptions ?? LAYA_MAX_OPTIONS, LAYA_MAX_OPTIONS));
  }

  /** Load the optional package, then wrap the session. */
  static async create(opts: LayaOptions = {}): Promise<LayaSelectProvider> {
    const session = await loadLayaSession(opts);
    return new LayaSelectProvider(session, {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.maxOptions !== undefined ? { maxOptions: opts.maxOptions } : {}),
    });
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

    const question = buildChoiceQuestion(options, instructions, {
      allowAbstain,
      ...(opts.abstainNote !== undefined ? { abstainNote: opts.abstainNote } : {}),
    });
    const resp = await this.session.systemOne(serialized.state, { [QUESTION_KEY]: question });
    const parsed = parseChoiceAnswer(resp.answers?.[QUESTION_KEY]);

    const resolvable =
      parsed.choice !== null && (parsed.choice === ABSTAIN || byValue.has(parsed.choice));
    if (!resolvable) {
      console.warn(
        `[koji-select] ${this.name}: unreadable choice ${JSON.stringify(
          (parsed.choice ?? "").slice(0, 80),
        )} — abstaining`,
      );
      if (!allowAbstain) {
        throw new SelectUnavailableError(
          this.name,
          "the model returned no readable choice and this request did not allow abstention",
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

  async close(): Promise<void> {
    await this.session.close?.();
  }
}

export class LayaAdjudicateProvider implements AdjudicateProvider {
  readonly name: string;

  constructor(
    private readonly session: LayaSession,
    opts: { name?: string } = {},
  ) {
    this.name = opts.name ?? "laya-adjudicate";
  }

  static async create(opts: LayaOptions = {}): Promise<LayaAdjudicateProvider> {
    const session = await loadLayaSession(opts);
    return new LayaAdjudicateProvider(session, {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    });
  }

  async adjudicate(
    expected: unknown,
    got: unknown,
    field: AdjudicateField,
  ): Promise<AdjudicateResult> {
    assertAdjudicationAllowed(this.name);

    const question = buildEquivalenceQuestion(renderValue(expected), renderValue(got), field);
    const resp = await this.session.systemOne(
      { comparison: field.name },
      { [QUESTION_KEY]: question },
    );
    const parsed = parseNoulAnswer(resp.answers?.[QUESTION_KEY]);
    if (parsed.noul === null) {
      throw new Error(`${this.name}: response carried no probability for the equivalence question`);
    }

    const p = clamp01(parsed.noul);
    const usage = parseUsage(resp);
    return {
      equivalent: p >= 0.5,
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
 * Whether the optional package resolves in this install. Used by the parity
 * suite to skip (loudly) rather than fail when local selection isn't set up.
 */
export async function layaInstalled(): Promise<boolean> {
  try {
    await import(/* @vite-ignore */ LAYA_PACKAGE);
    return true;
  } catch {
    return false;
  }
}
