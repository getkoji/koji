/**
 * The `review` capability — human queue (the OSS default) or agent.
 *
 * The review queue is where low-confidence extractions go, and it is a product
 * surface rather than a dead letter box: what a reviewer decides is also a
 * proposed ground-truth row, which is how a corpus grows from use.
 *
 * Two implementations behind one interface:
 *
 *   - `HumanQueueReviewProvider` — the default. Parks every item for a person
 *     and defers. Zero dependencies, works in every install.
 *   - `AgentReviewProvider` — first-passes the queue with a BYO model before a
 *     person sees it. Non-determinism is harmless here because a human still
 *     reviews what it touched.
 *
 * ## The agent's deliberate boundary
 *
 * `AgentReviewProvider` only decides items that carry a candidate set. Given
 * `options`, it selects — and so it inherits the same no-fabrication property
 * the extraction had: its correction is a span that exists in the source, with
 * the offset already attached. Given no candidate set, it defers to a human
 * rather than writing a free-form value.
 *
 * That is not a limitation to work around. An agent that can only choose
 * cannot invent a correction, and an invented correction entering the corpus as
 * ground truth is the one failure mode that poisons every later measurement.
 */

import {
  ABSTAIN,
  type ReviewItem,
  type ReviewProvider,
  type ReviewVerdict,
  type SelectProvider,
} from "./types";

export interface HumanQueueOptions {
  /**
   * Where items are parked. Injected rather than imported so this module
   * carries no database dependency — wiring it to the persisted queue is the
   * review tier's job, not this capability's.
   */
  enqueue?: (items: readonly ReviewItem[]) => Promise<void> | void;
  name?: string;
}

export class HumanQueueReviewProvider implements ReviewProvider {
  readonly name: string;
  readonly kind = "human" as const;
  private readonly enqueue: HumanQueueOptions["enqueue"];

  constructor(opts: HumanQueueOptions = {}) {
    this.name = opts.name ?? "human-queue";
    this.enqueue = opts.enqueue;
  }

  async review(items: readonly ReviewItem[]): Promise<ReviewVerdict[]> {
    if (this.enqueue && items.length > 0) await this.enqueue(items);
    return items.map((item) => ({
      id: item.id,
      decision: "defer" as const,
      value: item.value,
      // A deferral is the absence of a judgement, so it carries no
      // confidence. Reporting the extraction's own number here would make the
      // queue look like it had assessed something.
      confidence: 0,
      reason: item.reason ?? "queued for human review",
      provider: this.name,
    }));
  }
}

export interface AgentReviewOptions {
  /** The selector the agent decides with. Any `select` implementation. */
  select: SelectProvider;
  /**
   * Below this, the agent defers instead of deciding. The point of a first
   * pass is to clear the easy items, not to rubber-stamp the hard ones.
   */
  minConfidence?: number;
  name?: string;
}

/** Default gate for an agent verdict to stand on its own. */
export const AGENT_REVIEW_MIN_CONFIDENCE = 0.8;

export class AgentReviewProvider implements ReviewProvider {
  readonly name: string;
  readonly kind = "agent" as const;
  private readonly selector: SelectProvider;
  private readonly minConfidence: number;

  constructor(opts: AgentReviewOptions) {
    this.name = opts.name ?? `agent-review(${opts.select.name})`;
    this.selector = opts.select;
    this.minConfidence = opts.minConfidence ?? AGENT_REVIEW_MIN_CONFIDENCE;
  }

  async review(items: readonly ReviewItem[]): Promise<ReviewVerdict[]> {
    const out: ReviewVerdict[] = [];
    for (const item of items) out.push(await this.reviewOne(item));
    return out;
  }

  private async reviewOne(item: ReviewItem): Promise<ReviewVerdict> {
    if (!item.options || item.options.length === 0) {
      return this.defer(
        item,
        "no candidate set — an agent that can only choose cannot propose a free-form correction",
      );
    }

    let result;
    try {
      result = await this.selector.select(
        item.state,
        item.options,
        reviewInstructions(item),
        { allowAbstain: true },
      );
    } catch (err) {
      // A failed first pass is not a verdict. The item stays for a human.
      return this.defer(
        item,
        `agent review failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (result.choice === ABSTAIN) {
      // The agent read the source and found no value. That is a real
      // judgement, not a deferral — but it contradicts a non-null extraction,
      // so it only stands above the gate.
      if (result.confidence < this.minConfidence) {
        return this.defer(item, "agent found no value but was not confident enough to say so");
      }
      return {
        id: item.id,
        decision: "reject",
        value: null,
        selected: null,
        confidence: result.confidence,
        reason: "agent found no value for this field in the source",
        provider: this.name,
      };
    }

    if (result.confidence < this.minConfidence) {
      return this.defer(
        item,
        `agent confidence ${result.confidence.toFixed(2)} is below the ${this.minConfidence} gate`,
      );
    }

    const unchanged = valuesMatch(item.value, result.choice);
    return {
      id: item.id,
      decision: unchanged ? "accept" : "correct",
      value: result.choice,
      selected: result.selected,
      confidence: result.confidence,
      reason: unchanged
        ? "agent selected the same value the extraction proposed"
        : "agent selected a different candidate",
      provider: this.name,
    };
  }

  private defer(item: ReviewItem, reason: string): ReviewVerdict {
    return {
      id: item.id,
      decision: "defer",
      value: item.value,
      confidence: 0,
      reason,
      provider: this.name,
    };
  }
}

/**
 * What the agent is asked. The currently proposed value is stated so the agent
 * is confirming or overturning a specific claim rather than extracting afresh.
 */
export function reviewInstructions(item: ReviewItem): string {
  const described = item.field.description ? ` (${item.field.description})` : "";
  const proposed =
    item.value === null || item.value === undefined
      ? "no value"
      : typeof item.value === "string"
        ? item.value
        : JSON.stringify(item.value);
  return (
    `An extraction proposed "${proposed}" for the field "${item.field.name}"${described}. ` +
    "Which of the options is the correct value for that field?"
  );
}

/**
 * Whether a selected candidate matches the proposed value. String comparison
 * after trimming only — no normalization, no type coercion. Deciding that
 * "1,000" and "1000" are the same value is an equivalence policy, and that
 * belongs to the schema's `match:` declaration and the scorer, not to a
 * helper in the review path quietly having an opinion.
 */
export function valuesMatch(proposed: unknown, choice: string): boolean {
  if (typeof proposed === "string") return proposed.trim() === choice.trim();
  if (proposed === null || proposed === undefined) return false;
  return String(proposed) === choice;
}
