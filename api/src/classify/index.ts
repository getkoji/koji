/**
 * Document classifier — public surface.
 *
 * A config-driven, cost-cascading classifier: given a document and a
 * user-authored set of classes, return which class it is, spending the minimum
 * to reach a confident label. See ./cascade.ts and docs/document-classifier.md.
 */

export { runCascade } from "./cascade";
export type { CascadeDeps, DocumentInput, RenderPageImages } from "./cascade";
export {
  normalizeConfig,
  parseClassifierYaml,
  ClassifierConfigError,
  DEFAULTS,
} from "./config";
export type { ClassifierConfig, ClassifierClass, ScanStrategy, OnUnknown } from "./config";
export { readPdfWindow } from "./pdf-text";
export type { GetPageTexts, WindowResult } from "./pdf-text";
export { scoreClasses, scoreClass } from "./keyword-match";
export { selectWindow, densityRank, effectiveWindow } from "./window";
export { buildClassifyPrompt, buildVisionClassifyPrompt, parseClassifyResponse } from "./prompt";
export { Tier, UNKNOWN_LABEL } from "./types";
export type {
  ClassifyOutcome,
  ClassifyMethod,
  ClassScore,
  PageText,
  TierValue,
} from "./types";
