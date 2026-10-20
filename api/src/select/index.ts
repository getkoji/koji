/**
 * The pluggable capability layer: `select`, `adjudicate`, `review`.
 *
 * Callers import from here rather than reaching into individual files, so the
 * set of capabilities and the set of implementations are both visible in one
 * place — and so adding an implementation that doesn't satisfy the contract is
 * a visible act rather than an import nobody reviews.
 *
 * See `types.ts` for the contracts and why they are contracts, and
 * `parity.test.ts` for the invariants every implementation must satisfy
 * identically.
 */

// Contracts
export type {
  SelectProvider,
  SelectCandidate,
  SelectState,
  SelectOptions,
  SelectResult,
  SelectBBox,
  SelectUsage,
  AdjudicateProvider,
  AdjudicateField,
  AdjudicateResult,
  ReviewProvider,
  ReviewItem,
  ReviewVerdict,
  ReviewDecision,
} from "./types";
export {
  ABSTAIN,
  SelectRequestError,
  SelectContractError,
  SelectNoAnswerError,
  SelectUnavailableError,
} from "./types";

// The shared invariant gate
export {
  finalizeSelect,
  noInformationSelect,
  validateSelectRequest,
  distributionConfidence,
  normalizeDistribution,
  synthesizeDistribution,
  clamp01,
} from "./invariants";
export type { RawSelectAnswer } from "./invariants";

// System-1 wire shape, shared by the hosted and local implementations
export {
  buildChoiceQuestion,
  buildEquivalenceQuestion,
  parseChoiceAnswer,
  parseNoulAnswer,
  candidateNote,
  serializeState,
  estimateStateTokens,
  QUESTION_KEY,
  CHARS_PER_TOKEN,
} from "./system-one";
export type {
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResponse,
  ChoiceQuestion,
  NoulQuestion,
  ScoreQuestion,
} from "./system-one";

// Implementations — OSS default first
export {
  LlmChoiceSelectProvider,
  LlmAdjudicateProvider,
  LLM_CHOICE_MAX_OPTIONS,
  buildChoicePrompt,
  buildAdjudicatePrompt,
  assignLabels,
  resolveToValue,
  parseChoiceText,
  parseAdjudicateText,
} from "./llm-choice";
export type { LlmChoiceOptions, LabelledOption } from "./llm-choice";

export {
  LayaSelectProvider,
  LayaAdjudicateProvider,
  loadLayaSession,
  layaInstalled,
  LAYA_PACKAGE,
  LAYA_MAX_OPTIONS,
} from "./laya";
export type { LayaOptions, LayaSession } from "./laya";

export {
  JevSelectProvider,
  JevAdjudicateProvider,
  JevHttpError,
  typesafeKeyFromEnv,
  JEV_API_URL,
  JEV_DEFAULT_MODEL,
  JEV_MAX_OPTIONS,
  JEV_STATE_TOKEN_BUDGET,
} from "./jev";
export type { JevOptions } from "./jev";

// adjudicate: the offline-only guard and the zero-dependency default
export {
  NoAdjudicateProvider,
  AdjudicationNotEnabledError,
  enableAdjudication,
  disableAdjudication,
  adjudicationEnabled,
  adjudicationContext,
  assertAdjudicationAllowed,
} from "./adjudicate";

// review
export {
  HumanQueueReviewProvider,
  AgentReviewProvider,
  AGENT_REVIEW_MIN_CONFIDENCE,
  reviewInstructions,
  valuesMatch,
} from "./review";
export type { HumanQueueOptions, AgentReviewOptions } from "./review";

// Resolution
export {
  resolveSelectProvider,
  resolveAdjudicateProvider,
  resolveReviewProvider,
  pickSelectEndpoint,
  strategyForProvider,
  strategyFromEnv,
  adjudicateStrategyFromEnv,
  SELECT_STRATEGIES,
  ADJUDICATE_STRATEGIES,
  SELECT_CAPABILITY,
} from "./resolve-select";
export type {
  SelectStrategy,
  AdjudicateStrategy,
  ReviewStrategy,
  ResolveSelectOptions,
  ResolvedSelectProvider,
  SelectEndpointRow,
} from "./resolve-select";
